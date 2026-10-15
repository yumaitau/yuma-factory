'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { automation } from '@/db/schema';
import { getDb } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { AUTOMATION_ID } from '@/lib/automation-state';
import { setAutomationEnabled, setAutomationSize } from '@/lib/factory-control';
import { enqueuePickup } from '@/lib/automation-queue';

export async function setAutomationEnabledAction(enabled: boolean) {
  const session = await requireSession();
  if (typeof enabled !== 'boolean') throw new Error('Invalid worker setting.');
  await setAutomationEnabled(session.user.id, enabled);
  revalidatePath('/');
  revalidatePath('/agents');
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
  await setAutomationSize(session.user.id, targetAgents);
  revalidatePath('/', 'layout');
}
