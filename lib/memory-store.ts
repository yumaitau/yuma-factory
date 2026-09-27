import 'server-only';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { memories, memoryEvents, projects, runMemories } from '@/db/schema';
import { newId } from '@/lib/ids';
import type { Db } from '@/lib/queries';
import {
  AGENT_MAX_WEIGHT,
  AGENT_WEIGHT,
  HUMAN_WEIGHT,
  REINFORCE_STEP,
  clampWeight,
  memoryContentKey,
  memoryKind,
  normalizeMemory,
  parseLearnings,
  rankMemories,
  renderMemoryBlock,
  shouldRetire,
} from '@/lib/memory';

export type Memory = typeof memories.$inferSelect;
export const MEMORY_STATUSES = ['active', 'suggested', 'archived'] as const;

async function logEvent(db: Db, memoryId: string, actor: string, action: string, before?: unknown, after?: unknown) {
  await db.insert(memoryEvents).values({
    id: newId('mev'), memoryId, actor, action,
    before: before === undefined ? null : JSON.stringify(before),
    after: after === undefined ? null : JSON.stringify(after),
    createdAt: new Date(),
  });
}

/** Pre-run hydrate: the ranked memory a ticket would receive, and the rendered prompt block. */
export async function memoriesForTicket(db: Db, projectId: string, ticketText: string) {
  const project = await db.select({ budget: projects.memoryBudget }).from(projects).where(eq(projects.id, projectId)).get();
  const candidates = await db.select().from(memories)
    .where(and(eq(memories.status, 'active'), or(eq(memories.projectId, projectId), isNull(memories.projectId)))).all();
  const selected = rankMemories(candidates, ticketText, project?.budget ?? 6000);
  return { selected, block: renderMemoryBlock(selected) };
}

export async function recordRunMemories(db: Db, runId: string, memoryIds: string[]) {
  // Chunks stay below D1's bound-parameter limit.
  for (let offset = 0; offset < memoryIds.length; offset += 40) {
    const chunk = memoryIds.slice(offset, offset + 40);
    await db.insert(runMemories).values(chunk.map((memoryId) => ({ runId, memoryId }))).onConflictDoNothing();
    await db.update(memories).set({ uses: sql`${memories.uses} + 1`, lastUsedAt: new Date() }).where(inArray(memories.id, chunk));
  }
}

/** Post-run capture. Agent learnings are always project-scoped, so one repo cannot steer another. */
export async function captureLearnings(db: Db, input: { projectId: string; runId: string; ticketId: string; raw: unknown }) {
  const learnings = parseLearnings(input.raw);
  if (!learnings.length) return 0;
  const project = await db.select({ autoLearn: projects.autoLearn }).from(projects).where(eq(projects.id, input.projectId)).get();
  const status = project?.autoLearn === false ? 'suggested' : 'active';
  for (const learning of learnings) {
    const now = new Date();
    const [row] = await db.insert(memories).values({
      id: newId('mem'), projectId: input.projectId, scopeKey: input.projectId, contentKey: memoryContentKey(learning.content),
      kind: learning.kind, content: learning.content, status, source: 'agent',
      sourceRunId: input.runId, sourceTicketId: input.ticketId, weight: AGENT_WEIGHT, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [memories.scopeKey, memories.contentKey],
      // Rediscovery reinforces agent memories; people's weights and archive decisions stand.
      set: {
        weight: sql`case when ${memories.source} = 'human' then ${memories.weight} else min(max(${memories.weight}, ${AGENT_MAX_WEIGHT}), ${memories.weight} + ${REINFORCE_STEP}) end`,
        updatedAt: now,
      },
    }).returning({ id: memories.id, createdAt: memories.createdAt, weight: memories.weight });
    if (row) await logEvent(db, row.id, `run:${input.runId}`, row.createdAt.getTime() === now.getTime() ? 'learned' : 'reinforced', undefined, { weight: row.weight });
  }
  return learnings.length;
}

/** Outcome feedback: green CI reinforces the memories a run used; failure penalises them. */
export async function applyRunOutcome(db: Db, runId: string, success: boolean) {
  const used = sql`${memories.id} in (select memory_id from run_memories where run_id = ${runId})`;
  const changed = await db.update(memories).set(success
    ? { successes: sql`${memories.successes} + 1`, updatedAt: new Date() }
    : { failures: sql`${memories.failures} + 1`, updatedAt: new Date() })
    .where(and(used, eq(memories.status, 'active'))).returning();
  for (const memory of changed.filter(shouldRetire)) {
    await db.update(memories).set({ status: 'archived', updatedAt: new Date() }).where(eq(memories.id, memory.id));
    await logEvent(db, memory.id, 'system', 'retired', { status: 'active' }, { status: 'archived', successes: memory.successes, failures: memory.failures });
  }
}

export async function listMemories(db: Db, filter: { projectId?: string | null; status?: string } = {}) {
  const scope = filter.projectId === undefined ? undefined
    : filter.projectId === null ? isNull(memories.projectId) : eq(memories.projectId, filter.projectId);
  return db.select().from(memories)
    .where(and(scope, filter.status ? eq(memories.status, filter.status) : undefined))
    .orderBy(desc(memories.pinned), desc(memories.weight), desc(memories.updatedAt)).limit(500).all();
}

export async function memoryHistory(db: Db, memoryIds: string[]) {
  if (!memoryIds.length) return [];
  const rows = [];
  for (let offset = 0; offset < memoryIds.length; offset += 90)
    rows.push(...await db.select().from(memoryEvents).where(inArray(memoryEvents.memoryId, memoryIds.slice(offset, offset + 90)))
      .orderBy(desc(memoryEvents.createdAt)).limit(1000).all());
  return rows;
}

export async function createMemory(db: Db, input: { projectId: string | null; kind?: string; content: string; weight?: number; pinned?: boolean }, actor: string, userId?: string) {
  const content = normalizeMemory(input.content).slice(0, 2000);
  if (content.length < 3) throw new Error('Memory content is required.');
  const now = new Date();
  const row = {
    id: newId('mem'), projectId: input.projectId, scopeKey: input.projectId ?? 'global', contentKey: memoryContentKey(content),
    kind: memoryKind(input.kind), content, status: 'active', source: 'human', createdByUserId: userId ?? null,
    weight: clampWeight(input.weight ?? HUMAN_WEIGHT), pinned: !!input.pinned, createdAt: now, updatedAt: now,
  };
  const [created] = await db.insert(memories).values(row).onConflictDoNothing().returning();
  if (!created) throw new Error('An identical memory already exists in this scope.');
  await logEvent(db, created.id, actor, 'created', undefined, { content, weight: created.weight, pinned: created.pinned });
  return created;
}

export type MemoryPatch = { content?: string; kind?: string; weight?: number; pinned?: boolean; status?: string };

export async function updateMemory(db: Db, id: string, patch: MemoryPatch, actor: string) {
  const current = await db.select().from(memories).where(eq(memories.id, id)).get();
  if (!current) throw new Error('Memory not found.');
  const next: Partial<Memory> = {};
  if (patch.content !== undefined) {
    const content = normalizeMemory(patch.content).slice(0, 2000);
    if (content.length < 3) throw new Error('Memory content is required.');
    next.content = content;
    next.contentKey = memoryContentKey(content);
  }
  if (patch.kind !== undefined) next.kind = memoryKind(patch.kind);
  if (patch.weight !== undefined) next.weight = clampWeight(patch.weight);
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.status !== undefined) {
    if (!(MEMORY_STATUSES as readonly string[]).includes(patch.status)) throw new Error('Invalid memory status.');
    next.status = patch.status;
  }
  // Forms resubmit every field; audit only what actually changed.
  const keys = (Object.keys(next) as (keyof Memory)[]).filter((key) => key !== 'contentKey' && next[key] !== current[key]);
  if (!keys.length) return current;
  if (!keys.includes('content')) delete next.contentKey;
  const before = Object.fromEntries(keys.map((key) => [key, current[key]]));
  const after = Object.fromEntries(keys.map((key) => [key, next[key]]));
  const changes = Object.fromEntries([...keys, ...(next.contentKey ? ['contentKey' as const] : [])].map((key) => [key, next[key]]));
  const [updated] = await db.update(memories).set({ ...changes, updatedAt: new Date() }).where(eq(memories.id, id)).returning();
  await logEvent(db, id, actor, 'edited', before, after);
  return updated;
}

/** Roll a memory back to the values it had before one audited edit. */
export async function revertMemoryEvent(db: Db, eventId: string, actor: string) {
  const event = await db.select().from(memoryEvents).where(eq(memoryEvents.id, eventId)).get();
  if (!event?.before) throw new Error('This change cannot be reverted.');
  return updateMemory(db, event.memoryId, JSON.parse(event.before) as MemoryPatch, actor);
}

export async function setProjectMemorySettings(db: Db, projectId: string, settings: { memoryBudget?: number; autoLearn?: boolean; autoApprovePlans?: boolean }) {
  const next: Partial<typeof projects.$inferInsert> = {};
  if (settings.memoryBudget !== undefined) next.memoryBudget = Math.max(0, Math.min(20_000, Math.round(settings.memoryBudget) || 0));
  if (settings.autoLearn !== undefined) next.autoLearn = settings.autoLearn;
  if (settings.autoApprovePlans !== undefined) next.autoApprovePlans = settings.autoApprovePlans;
  if (!Object.keys(next).length) return;
  await db.update(projects).set({ ...next, updatedAt: new Date() }).where(eq(projects.id, projectId));
}
