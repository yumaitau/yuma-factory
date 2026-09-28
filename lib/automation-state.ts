import 'server-only';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { agents, automation, codexAccounts, projects, runs, tickets } from '@/db/schema';
import { getDb } from '@/lib/db';
import type { Db } from '@/lib/queries';
import { newId } from '@/lib/ids';
import { runWaitReason } from '@/lib/run-wait';
import { availableAccounts } from '@/lib/codex/accounts';
import { LABELS } from '@/lib/brand';

export const AUTOMATION_ID = 'github';

export async function ensureAutomationAgents(db: Db, settings: { userId: string; agentId: string; targetAgents: number }) {
  if (!Number.isInteger(settings.targetAgents) || settings.targetAgents < 10 || settings.targetAgents > 20) throw new Error('Choose between 10 and 20 agents.');
  await db.update(agents).set({ automationSlot: 1 }).where(and(eq(agents.id, settings.agentId), eq(agents.ownerUserId, settings.userId)));
  const now = new Date();
  // Chunk inserts stay below D1's bound parameter limit, and slot uniqueness makes retries safe.
  for (let slot = 2; slot <= settings.targetAgents; slot += 5) {
    await db.insert(agents).values(Array.from({ length: Math.min(5, settings.targetAgents - slot + 1) }, (_, offset) => ({
      id: newId('agt'), ownerUserId: settings.userId, name: `Factory worker ${slot + offset}`,
      automationSlot: slot + offset, color: '#d74c2f', status: 'idle', createdAt: now, updatedAt: now,
    }))).onConflictDoNothing({ target: agents.automationSlot });
  }
  return db.select().from(agents).where(and(eq(agents.ownerUserId, settings.userId), lte(agents.automationSlot, settings.targetAgents)))
    .orderBy(asc(agents.automationSlot)).all();
}

export async function claimAutomation(db: Db, leaseId: string, now = new Date()) {
  const [row] = await db.update(automation).set({
    leaseId,
    leaseUntil: new Date(now.getTime() + 10 * 60_000),
    lastStartedAt: now,
    summary: 'Checking GitHub for new and changed issues.',
    error: null,
    reposSynced: 0,
    issuesSynced: 0,
    runsStarted: 0,
    updatedAt: now,
  }).where(and(
    eq(automation.id, AUTOMATION_ID), eq(automation.enabled, true),
    or(isNull(automation.leaseUntil), lt(automation.leaseUntil, now)),
  )).returning();
  return row;
}

export async function automationCandidates(db: Db, agentId: string | string[], label: string, limit = 200) {
  const agentIds = typeof agentId === 'string' ? [agentId] : agentId;
  return db.select({ ticket: tickets, project: projects }).from(tickets)
    .innerJoin(projects, eq(tickets.projectId, projects.id))
    .where(and(
      eq(projects.status, 'active'), eq(tickets.githubState, 'open'),
      or(eq(tickets.stage, 'intake'), eq(tickets.stage, 'assigned')),
      or(isNull(tickets.assignedAgentId), agentIds.length ? inArray(tickets.assignedAgentId, agentIds) : sql`0`),
      // Pickup label implements; plan label asks the planner to carve the ticket into subtasks.
      sql`exists (select 1 from json_each(case when json_valid(${tickets.labels}) then ${tickets.labels} else '[]' end) where lower(value) in (lower(${label}), ${LABELS.plan}))`,
      // Subtasks wait until every ticket they build on is closed.
      sql`not exists (select 1 from ticket_dependencies d join tickets blocker on blocker.id = d.depends_on_ticket_id where d.ticket_id = ${tickets.id} and blocker.github_state = 'open')`,
      // A failed attempt needs human review; a successful attempt must not make a second PR.
      // A human requeue clears earlier attempts.
      sql`not exists (select 1 from ${runs} where ${runs.ticketId} = ${tickets.id} and (${tickets.requeuedAt} is null or ${runs.createdAt} >= ${tickets.requeuedAt}))`,
    )).orderBy(asc(tickets.createdAt), asc(tickets.id)).limit(limit).all();
}

export async function automationStatus() {
  const db = await getDb();
  const row = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (!row) return null;
  const pool = await db.select().from(agents).where(and(eq(agents.ownerUserId, row.userId),
    or(eq(agents.id, row.agentId), sql`${agents.automationSlot} is not null`))).all();
  const poolIds = pool.map((agent) => agent.id);
  const queued = await automationCandidates(db, pool.filter((agent) => (agent.automationSlot ?? 1) <= row.targetAgents).map((agent) => agent.id), row.label, 1000);
  const active = await db.select({ run: runs, account: codexAccounts }).from(runs)
    .leftJoin(codexAccounts, eq(runs.codexAccountId, codexAccounts.id))
    .where(and(poolIds.length ? inArray(runs.agentId, poolIds) : sql`0`, eq(runs.status, 'running')));
  const waitingRuns = active.filter(({ run, account }) => run.codexAccountId && runWaitReason(run.id, account)).length;
  const available = await availableAccounts(row.userId, db);
  const interrupted = !!row.leaseUntil && row.leaseUntil.getTime() <= Date.now();
  return {
    enabled: row.enabled, userId: row.userId, label: row.label,
    running: !!row.leaseUntil && row.leaseUntil.getTime() > Date.now(),
    interrupted, heartbeatAt: row.updatedAt.toISOString(), boardsTotal: row.boardsTotal,
    lastEventAt: row.lastEventAt?.toISOString() ?? null, lastEvent: row.lastEvent,
    targetAgents: row.targetAgents, totalAgents: pool.length,
    idleAgents: pool.filter((agent) => agent.status === 'idle' && (agent.automationSlot ?? 1) <= row.targetAgents).length,
    availableSubscriptions: available.length,
    lastStartedAt: row.lastStartedAt?.toISOString() ?? null,
    lastFinishedAt: row.lastFinishedAt?.toISOString() ?? null,
    lastScheduledAt: row.lastScheduledAt?.toISOString() ?? null,
    summary: row.summary, error: row.error,
    reposSynced: row.reposSynced, issuesSynced: row.issuesSynced, runsStarted: row.runsStarted,
    queued: queued.length, activeRuns: active.length - waitingRuns, waitingRuns,
  };
}

export type AutomationStatus = Awaited<ReturnType<typeof automationStatus>>;
