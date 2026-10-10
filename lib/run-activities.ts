import 'server-only';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { runActivities, runs } from '@/db/schema';
import { newId } from '@/lib/ids';
import { getRun, type Db } from '@/lib/queries';
import {
  lastAgentActivity, parseRunPlan, sessionState, visibleActivities, workedForMs,
  type IncomingActivity, type PlanStep, type SessionState,
} from '@/lib/run-session';

// The next seq is read inside the insert; D1 serializes writes, and the unique index backs it up.
const nextSeq = (runId: string) => sql`(select coalesce(max(seq), 0) + 1 from run_activities where run_id = ${runId})`;

/** Idempotent: a retried runner batch carries the same source keys and inserts nothing twice. */
export async function ingestActivities(db: Db, run: { id: string; ticketId: string }, items: IncomingActivity[], plan?: PlanStep[] | null, now = new Date()) {
  const inserts = items.map((item) => db.insert(runActivities).select(sql`select
    ${newId('act')}, ${run.id}, ${run.ticketId}, ${nextSeq(run.id)}, ${item.type}, ${item.body},
    ${item.action}, ${item.parameter}, ${item.result}, ${item.ephemeral ? 1 : 0}, null, null, ${item.key}, null, ${now.getTime()}
    where not exists (select 1 from run_activities where run_id = ${run.id} and source_key = ${item.key})`));
  const planUpdate = plan ? [db.update(runs).set({ plan: JSON.stringify(plan) }).where(eq(runs.id, run.id))] : [];
  const [first, ...rest] = [...inserts, ...planUpdate];
  if (first) await db.batch([first, ...rest]);
}

/** A person's prompt. Stop signals and follow-ups that start a new run are applied immediately. */
export async function recordPrompt(db: Db, input: {
  runId: string; ticketId: string; body: string; authorUserId: string; signal?: 'stop'; delivered?: boolean;
}, now = new Date()) {
  const [row] = await db.insert(runActivities).select(sql`select
    ${newId('act')}, ${input.runId}, ${input.ticketId}, ${nextSeq(input.runId)}, 'prompt', ${input.body},
    null, null, null, 0, ${input.signal ?? null}, ${input.authorUserId}, null,
    ${input.delivered ? now.getTime() : null}, ${now.getTime()}`).returning({ seq: runActivities.seq });
  return row.seq;
}

/** Hand queued follow-ups to the runner exactly once; a crashed bridge loses them rather than replaying. */
export async function takePrompts(db: Db, runId: string, now = new Date()) {
  const taken = await db.update(runActivities).set({ deliveredAt: now })
    .where(and(eq(runActivities.runId, runId), eq(runActivities.type, 'prompt'), isNull(runActivities.signal), isNull(runActivities.deliveredAt)))
    .returning({ seq: runActivities.seq, body: runActivities.body });
  return taken.sort((a, b) => a.seq - b.seq);
}

export type PublicActivity = {
  seq: number; type: string; body: string; action: string | null; parameter: string | null; result: string | null;
  ephemeral: boolean; signal: string | null; authorUserId: string | null; deliveredAt: string | null; createdAt: string;
};

function plan(raw: string | null) {
  if (!raw) return null;
  try { return parseRunPlan(JSON.parse(raw)); } catch { return null; }
}

/**
 * One run as an agent session. `after` returns only newer activities; clients merge them
 * and apply visibleActivities themselves, since a new activity can supersede an ephemeral one.
 */
export async function getRunSession(db: Db, runId: string, after = 0, now = Date.now()) {
  const run = await getRun(runId);
  if (!run) return null;
  // Timeline stamps are small; full bodies are read only past the cursor.
  const stamps = await db.select({ seq: runActivities.seq, type: runActivities.type, ephemeral: runActivities.ephemeral, createdAt: runActivities.createdAt })
    .from(runActivities).where(eq(runActivities.runId, runId)).orderBy(asc(runActivities.seq)).all();
  const visible = new Set(visibleActivities(stamps).map((stamp) => stamp.seq));
  const rows = await db.select().from(runActivities)
    .where(and(eq(runActivities.runId, runId), gt(runActivities.seq, after))).orderBy(asc(runActivities.seq)).all();
  const activities: PublicActivity[] = rows.filter((row) => visible.has(row.seq)).map((row) => ({
    seq: row.seq, type: row.type, body: row.body, action: row.action, parameter: row.parameter, result: row.result,
    ephemeral: row.ephemeral, signal: row.signal, authorUserId: row.authorUserId,
    deliveredAt: row.deliveredAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  }));
  const state: SessionState = sessionState(run, lastAgentActivity(stamps), now);
  return {
    run: {
      id: run.id, ticketId: run.ticketId, agentId: run.agentId, status: run.status, mode: run.mode, modelId: run.modelId,
      requestedByUserId: run.requestedByUserId, waitingReason: run.waitingReason,
      pullRequestUrl: run.pullRequestUrl?.startsWith('https://github.com/') ? run.pullRequestUrl : null,
      pullRequestState: run.pullRequestState, branchName: run.branchName, parentRunId: run.parentRunId, attempt: run.attempt,
      createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    state,
    workedForMs: workedForMs(run, stamps, now),
    plan: plan(run.plan),
    activities,
    lastSeq: stamps.at(-1)?.seq ?? 0,
  };
}
export type RunSession = NonNullable<Awaited<ReturnType<typeof getRunSession>>>;

/** Every run on a ticket, oldest first, so follow-up runs read as one continuing conversation. */
export async function getTicketSessions(db: Db, ticketId: string, now = Date.now()) {
  const ids = await db.select({ id: runs.id }).from(runs).where(eq(runs.ticketId, ticketId))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(20).all();
  const sessions = await Promise.all(ids.reverse().map(({ id }) => getRunSession(db, id, 0, now)));
  return sessions.filter((session): session is RunSession => !!session);
}
