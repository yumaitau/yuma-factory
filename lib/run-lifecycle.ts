import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { agents, runs, tickets } from '@/db/schema';
import { LABELS } from '@/lib/brand';
import type { Db, TicketStage } from '@/lib/queries';
import { FAILURE_KINDS, RETRY_BACKOFF_MINUTES, RETRY_BUDGET, WAIT_BACKOFF_MINUTES } from '@/lib/run-retry';

/** Applying plans are not runnable until all dependency edges have been saved. */
export const planReady = () => sql`(${tickets.planTask} is null or exists (
  select 1 from plans p where p.id = substr(${tickets.planTask}, 1, instr(${tickets.planTask}, ':') - 1)
  and p.status = 'applied'))`;

/**
 * SQL twin of nextRetry() for a `runs` row in scope: a failed run since the ticket's requeue
 * watermark, not a person's follow-up, within its retry budget and past its backoff.
 */
export function retryDue() {
  const budget = sql.join(FAILURE_KINDS.map((kind) => sql`when ${kind} then ${RETRY_BUDGET[kind]}`), sql` `);
  const delay = (schedule: readonly number[]) => sql`case ${runs.attempt} ${sql.join(schedule.map((minutes, index) =>
    sql`when ${index + 1} then ${minutes * 60}`), sql` `)} else ${schedule.at(-1)! * 60} end`;
  return sql`(${runs.status} = 'failed'
    and (${tickets.requeuedAt} is null or ${runs.createdAt} >= ${tickets.requeuedAt})
    and not (${runs.parentRunId} is not null and ${runs.attempt} = 1)
    and ${runs.attempt} <= (case ${runs.failureKind} ${budget} else 0 end)
    and ${runs.finishedAt} <= unixepoch() - (case when ${runs.failureKind} = 'wait'
      then (${delay(WAIT_BACKOFF_MINUTES)}) else (${delay(RETRY_BACKOFF_MINUTES)}) end))`;
}

/** One transaction creates the run and claims both resources, or changes neither. */
export async function claimRun(db: Db, input: {
  id: string; ticketId: string; agentId: string; userId: string; accountId: string;
  modelId: string; mode: 'implement' | 'plan'; branchName?: string; parentRunId?: string; attempt?: number;
}, options?: { automationLabel: string; automationLeaseId: string }) {
  const { id, ticketId, agentId, userId, accountId, modelId, mode, branchName = null, parentRunId = null, attempt = 1 } = input;
  const eligible = and(
    eq(tickets.id, ticketId), eq(tickets.githubState, 'open'),
    sql`${tickets.stage} in ('intake', 'assigned', 'review')`,
    planReady(),
    sql`exists (select 1 from projects p where p.id = ${tickets.projectId} and p.status = 'active')`,
    sql`exists (select 1 from agents a where a.id = ${agentId} and a.status = 'idle')`,
    sql`exists (select 1 from account_leases l where l.holder_id = ${id} and l.account_id = ${accountId} and l.created_at > unixepoch() - 600)`,
    sql`not exists (select 1 from runs r where r.status = 'running' and (r.ticket_id = ${ticketId} or r.agent_id = ${agentId}))`,
    sql`not exists (select 1 from ticket_dependencies d join tickets blocker on blocker.id = d.depends_on_ticket_id where d.ticket_id = ${ticketId} and blocker.github_state = 'open')`,
    ...(options ? [
      sql`${tickets.stage} in ('intake', 'assigned')`,
      sql`(${tickets.assignedAgentId} is null or ${tickets.assignedAgentId} = ${agentId})`,
      // A fresh attempt needs no runs since the requeue; a retry needs its failed parent to be the latest, and due.
      attempt > 1 && parentRunId
        ? sql`exists (select 1 from runs where runs.id = ${parentRunId} and runs.ticket_id = ${ticketId} and runs.attempt = ${attempt - 1}
          and runs.id = (select latest.id from runs latest where latest.ticket_id = ${ticketId} order by latest.created_at desc, latest.id desc limit 1)
          and ${retryDue()})`
        : sql`not exists (select 1 from runs r where r.ticket_id = ${ticketId} and (${tickets.requeuedAt} is null or r.created_at >= ${tickets.requeuedAt}))`,
      sql`exists (select 1 from json_each(case when json_valid(${tickets.labels}) then ${tickets.labels} else '[]' end) where lower(value) in (lower(${options.automationLabel}), ${LABELS.plan}))`,
      sql`exists (select 1 from automation a join agents worker on worker.id = ${agentId} where a.id = 'github' and a.enabled = 1 and a.user_id = ${userId} and a.lease_id = ${options.automationLeaseId} and a.lease_until > unixepoch() and worker.owner_user_id = a.user_id and worker.automation_slot between 1 and a.target_agents)`,
    ] : []),
  );
  const ownsRun = sql`exists (select 1 from runs where id = ${id} and status = 'running')`;
  // Retry watermarks use whole seconds. A new run must be on or after that watermark.
  const createdAt = sql<number>`max(unixepoch(), coalesce(${tickets.requeuedAt}, 0))`;
  const [claimed] = await db.batch([
    db.insert(runs).select(sql`select
      ${id}, ${ticketId}, ${agentId}, 'running', null, ${accountId}, ${userId},
      ${modelId}, ${mode}, '', null, null, null, null, 0, 0, ${createdAt}, null, ${createdAt},
      ${branchName}, ${parentRunId}, null, ${attempt}, null, null
      from ${tickets} where ${eligible}`).returning({ id: runs.id }),
    db.update(agents).set({ status: 'working', updatedAt: new Date() }).where(and(eq(agents.id, agentId), ownsRun)),
    db.update(tickets).set({ stage: 'in_progress', assignedAgentId: agentId, updatedAt: new Date() })
      .where(and(eq(tickets.id, ticketId), ownsRun)),
  ]);
  return claimed.length > 0;
}

export async function moveTicket(db: Db, ticketId: string, stage: TicketStage, requeue = false, now = new Date()) {
  if (stage === 'in_progress') throw new Error('Start a run to move this ticket into progress.');
  // Strictly exceed the failed attempt, even when retrying within its creation second.
  const requeuedAt = sql`case when (select status from runs where ticket_id = ${ticketId} order by created_at desc, id desc limit 1)
    in ('failed', 'cancelled') then max(${Math.floor(now.getTime() / 1000)},
      (select max(created_at) + 1 from runs where ticket_id = ${ticketId})) else ${tickets.requeuedAt} end`;
  const changed = await db.update(tickets).set({ stage, updatedAt: now, ...(requeue ? { requeuedAt } : {}) })
    .where(and(eq(tickets.id, ticketId), sql`not exists (select 1 from runs where ticket_id = ${ticketId} and status = 'running')`))
    .returning({ id: tickets.id });
  if (!changed.length) throw new Error('Stop the active run on Work before moving this task.');
}


/** Repair claims abandoned by older non-transactional startup, without touching live runs. */
export async function reconcileAbandonedClaims(db: Db, now = new Date()) {
  const cutoff = Math.floor(now.getTime() / 1000) - 15 * 60;
  await db.batch([
    db.update(agents).set({ status: 'idle', updatedAt: now }).where(and(eq(agents.status, 'working'),
      sql`${agents.updatedAt} < ${cutoff}`,
      sql`not exists (select 1 from runs r where r.agent_id = ${agents.id} and r.status in ('queued', 'running'))`)),
    db.update(tickets).set({
      stage: sql`case when ${tickets.githubState} = 'closed' then 'done'
        when exists (select 1 from runs r where r.ticket_id = ${tickets.id} and r.status = 'succeeded') then 'review'
        when ${tickets.assignedAgentId} is null then 'intake' else 'assigned' end`, updatedAt: now,
    }).where(and(eq(tickets.stage, 'in_progress'), sql`${tickets.updatedAt} < ${cutoff}`,
      sql`not exists (select 1 from runs r where r.ticket_id = ${tickets.id} and r.status in ('queued', 'running'))`)),
  ]);
}
