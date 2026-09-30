import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { agents, runs, tickets } from '@/db/schema';
import { LABELS } from '@/lib/brand';
import type { Db, TicketStage } from '@/lib/queries';

/** Applying plans are not runnable until all dependency edges have been saved. */
export const planReady = () => sql`(${tickets.planTask} is null or exists (
  select 1 from plans p where p.id = substr(${tickets.planTask}, 1, instr(${tickets.planTask}, ':') - 1)
  and p.status = 'applied'))`;

/** One transaction creates the run and claims both resources, or changes neither. */
export async function claimRun(db: Db, input: {
  id: string; ticketId: string; agentId: string; userId: string; accountId: string;
  modelId: string; mode: 'implement' | 'plan';
}, options?: { automationLabel: string; automationLeaseId: string }) {
  const { id, ticketId, agentId, userId, accountId, modelId, mode } = input;
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
      sql`not exists (select 1 from runs r where r.ticket_id = ${ticketId} and (${tickets.requeuedAt} is null or r.created_at >= ${tickets.requeuedAt}))`,
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
      ${modelId}, ${mode}, '', null, null, 0, 0, ${createdAt}, null, ${createdAt}
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
  if (!changed.length) throw new Error('Stop the active run on the Work board before moving this ticket.');
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
