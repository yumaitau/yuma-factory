'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { agents, automation, githubInstallations } from '@/db/schema';
import { getDb } from '@/lib/db';
import { newId } from '@/lib/ids';
import { requireSession } from '@/lib/session';
import { AUTOMATION_ID, ensureAutomationAgents } from '@/lib/automation-state';
import { enqueuePickup } from '@/lib/automation-queue';
import { LABELS } from '@/lib/brand';

export async function setAutomationEnabledAction(enabled: boolean) {
  const session = await requireSession();
  if (typeof enabled !== 'boolean') throw new Error('Invalid worker setting.');
  const db = await getDb();
  const existing = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (existing && existing.userId !== session.user.id) throw new Error('Only the user who enabled this worker can change it.');
  if (!existing) {
    if (!enabled) return;
    if (!(await db.select({ id: githubInstallations.id }).from(githubInstallations).limit(1)).length)
      throw new Error('Connect GitHub before enabling the worker.');
    const now = new Date();
    const agentId = newId('agt');
    await db.batch([
      db.insert(agents).values({ id: agentId, ownerUserId: session.user.id, name: 'Factory worker',
        color: '#d74c2f', status: 'idle', createdAt: now, updatedAt: now }),
      db.insert(automation).values({ id: AUTOMATION_ID, enabled: true, userId: session.user.id,
        agentId, label: LABELS.ready, updatedAt: now }),
    ]);
  } else {
    // Clearing the lease stops status reporting running:true while disabled
    // and lets the next enable claim a fresh lease immediately.
    await db.update(automation).set(enabled
      ? { enabled, updatedAt: new Date() }
      : { enabled, leaseId: null, leaseUntil: null, updatedAt: new Date() }).where(eq(automation.id, AUTOMATION_ID));
  }
  revalidatePath('/');
  revalidatePath('/agents');
  if (enabled) await enqueuePickup('Worker enabled');
}

export async function checkAutomationNowAction() {
  const session = await requireSession();
  const db = await getDb();
  const row = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (!row?.enabled || row.userId !== session.user.id) throw new Error('Enable your worker before running a check.');
  await enqueuePickup('Manual check');
  revalidatePath('/', 'layout');
}

export async function setAutomationSizeAction(targetAgents: number) {
  const session = await requireSession();
  if (!Number.isInteger(targetAgents) || targetAgents < 10 || targetAgents > 20) throw new Error('Choose 10 to 20 agents.');
  const db = await getDb();
  const row = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (!row || row.userId !== session.user.id) throw new Error('Only the worker owner can resize the pool.');
  await ensureAutomationAgents(db, { ...row, targetAgents });
  await db.update(automation).set({ targetAgents }).where(eq(automation.id, AUTOMATION_ID));
  await enqueuePickup('Agent pool resized');
  revalidatePath('/', 'layout');
}
