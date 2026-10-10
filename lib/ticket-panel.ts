import 'server-only';
import { inArray } from 'drizzle-orm';
import { agents, users } from '@/db/schema';
import type { Db } from '@/lib/queries';
import { getTicketSessions, type RunSession } from '@/lib/run-activities';
import { workBoardCards } from '@/lib/work-board-query';

/** Names behind a session list: each run's agent, and the people who requested runs or wrote prompts. */
export async function sessionPeople(db: Db, sessions: RunSession[]) {
  const agentIds = [...new Set(sessions.map((session) => session.run.agentId))];
  const userIds = [...new Set(sessions.flatMap((session) => [session.run.requestedByUserId, ...session.activities.map((activity) => activity.authorUserId)])
    .filter((id): id is string => !!id))];
  const [agentRows, userRows] = await Promise.all([
    agentIds.length ? db.select({ id: agents.id, name: agents.name, color: agents.color }).from(agents).where(inArray(agents.id, agentIds)).all() : [],
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)).all() : [],
  ]);
  return {
    agents: Object.fromEntries(agentRows.map((agent) => [agent.id, { name: agent.name, color: agent.color }])),
    people: Object.fromEntries(userRows.map((user) => [user.id, user.name])),
  };
}

/** Everything the issue panel shows: the ticket's board card, its branch, and every session on it. */
export async function getTicketPanel(db: Db, ticketId: string) {
  const [[card], sessions] = await Promise.all([workBoardCards(ticketId), getTicketSessions(db, ticketId)]);
  if (!card) return null;
  const latest = sessions.at(-1)?.run;
  return { card, branchName: latest?.branchName ?? null, requestedByUserId: latest?.requestedByUserId ?? null, sessions, ...await sessionPeople(db, sessions) };
}
export type TicketPanel = NonNullable<Awaited<ReturnType<typeof getTicketPanel>>>;
