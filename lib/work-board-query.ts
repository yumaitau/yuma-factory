import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { agents, codexAccounts, projects, runs, ticketDependencies, tickets } from '@/db/schema';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '@/lib/db';
import { runWaitReason } from '@/lib/run-wait';
import { runLeased } from '@/lib/codex/accounts';
import type { WorkCard } from '@/lib/work-board';

/** One malformed labels row must not break the whole board. */
function parseLabels(labels: string | null): string[] {
  if (!labels) return [];
  try {
    const parsed: unknown = JSON.parse(labels);
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

function lastLine(log: string | null) {
  const line = log?.trimEnd().split('\n').at(-1)?.trim();
  return line ? line.slice(0, 300) : null;
}

export async function workBoardCards(): Promise<WorkCard[]> {
  const db = await getDb();
  const rows = await db.select({ ticket: tickets, repo: projects.repoFullName, agent: agents, run: runs, account: codexAccounts, leased: runLeased(sql`${runs.id}`) })
    .from(tickets).innerJoin(projects, eq(tickets.projectId, projects.id))
    .leftJoin(agents, eq(tickets.assignedAgentId, agents.id))
    .leftJoin(runs, sql`${runs.id} = (select latest.id from runs latest where latest.ticket_id = ${tickets.id} order by latest.created_at desc, latest.id desc limit 1)`)
    .leftJoin(codexAccounts, eq(runs.codexAccountId, codexAccounts.id))
    .where(eq(projects.status, 'active')).orderBy(desc(tickets.updatedAt)).all();
  const blocker = alias(tickets, 'blocker');
  const blocks = await db.select({ ticketId: ticketDependencies.ticketId, number: blocker.githubIssueNumber }).from(ticketDependencies)
    .innerJoin(blocker, eq(ticketDependencies.dependsOnTicketId, blocker.id)).where(eq(blocker.githubState, 'open')).all();
  // A PR closed without merging ends that attempt; the ticket leaves the board until requeued.
  return rows.filter(({ ticket, run }) => !(run?.pullRequestState === 'closed' && !(ticket.requeuedAt && ticket.requeuedAt > run.createdAt)))
    .map(({ ticket, repo, agent, run: latest, account, leased }) => {
    // Runs from before a human requeue no longer decide the ticket's lane.
    const run = latest && !(ticket.requeuedAt && ticket.requeuedAt > latest.createdAt) ? latest : null;
    return {
      id: ticket.id, title: ticket.title, number: ticket.githubIssueNumber, repo, projectId: ticket.projectId,
      htmlUrl: ticket.htmlUrl, stage: ticket.stage, githubState: ticket.githubState,
      labels: parseLabels(ticket.labels), assignedAgentId: ticket.assignedAgentId,
      agentName: agent?.name ?? null, automationSlot: agent?.automationSlot ?? null,
      runStatus: run?.status ?? null, runId: run?.id ?? null,
      waitingReason: run?.status === 'running' ? runWaitReason(run.id, account && { ...account, leased: !!leased }) : null,
      completionPending: run?.status === 'running' && !!run.log?.startsWith('CI green;'),
      startedAt: run?.startedAt?.toISOString() ?? null, finishedAt: run?.finishedAt?.toISOString() ?? null,
      pullRequestUrl: run?.pullRequestUrl ?? null,
      runMode: run?.mode ?? null,
      runOutcome: run && run.status !== 'running' ? lastLine(run.log) : null,
      blockedBy: blocks.filter((block) => block.ticketId === ticket.id).map((block) => block.number),
    };
  });
}
