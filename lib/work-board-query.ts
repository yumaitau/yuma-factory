import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, codexAccounts, projects, runs, ticketDependencies, tickets } from '@/db/schema';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '@/lib/db';
import { runWaitReason } from '@/lib/run-wait';
import { runLeased } from '@/lib/codex/accounts';
import type { WorkCard } from '@/lib/work-board';
import { sessionState, type SessionState } from '@/lib/run-session';
import { isFollowUp } from '@/lib/run-retry';
import { evidenceFromRow, latestRunEvidence } from '@/lib/review-evidence-store';
import { evidenceGate } from '@/lib/review-evidence';

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

// Latest agent activity of the card's run; people's prompts do not change session state.
const lastActivity = sql<string | null>`(select type || ':' || created_at from run_activities a
  where a.run_id = ${runs.id} and a.type <> 'prompt' order by a.seq desc limit 1)`;

// A card needs a few columns. An issue body can hold 60,000 characters and a run log 100,000, so neither is read whole.
const cardTicket = { id: tickets.id, title: tickets.title, githubIssueNumber: tickets.githubIssueNumber, projectId: tickets.projectId, htmlUrl: tickets.htmlUrl,
  stage: tickets.stage, githubState: tickets.githubState, labels: tickets.labels, assignedAgentId: tickets.assignedAgentId, requeuedAt: tickets.requeuedAt };
/** How much of a log's end is read to find its last line. */
export const LOG_TAIL = 4_000;
const cardRun = { id: runs.id, status: runs.status, mode: runs.mode, attempt: runs.attempt, failureKind: runs.failureKind, parentRunId: runs.parentRunId,
  createdAt: runs.createdAt, startedAt: runs.startedAt, finishedAt: runs.finishedAt,
  pullRequestUrl: runs.pullRequestUrl, pullRequestState: runs.pullRequestState, pullRequestHeadSha: runs.pullRequestHeadSha,
  // The start says whether completion is under way ('CI green;'); the end holds the supervisor's last line.
  logStart: sql<string>`substr(${runs.log}, 1, 9)`, logEnd: sql<string>`substr(${runs.log}, ${-LOG_TAIL})` };

/**
 * The whole board, or one ticket's card. Alone, a ticket's card is for the issue panel, which also shows archived
 * and closed-PR tickets; with `onBoard` it is returned only if the Work board shows it.
 */
export async function workBoardCards(ticketId?: string, onBoard = false): Promise<(WorkCard & { sessionState: SessionState | null })[]> {
  const db = await getDb();
  const now = Date.now();
  const board = !ticketId || onBoard;
  const rows = await db.select({ ticket: cardTicket, repo: projects.repoFullName, agent: agents, run: cardRun, account: codexAccounts, leased: runLeased(sql`${runs.id}`), activity: lastActivity })
    .from(tickets).innerJoin(projects, eq(tickets.projectId, projects.id))
    .leftJoin(agents, eq(tickets.assignedAgentId, agents.id))
    .leftJoin(runs, sql`${runs.id} = (select latest.id from runs latest where latest.ticket_id = ${tickets.id} order by latest.created_at desc, latest.id desc limit 1)`)
    .leftJoin(codexAccounts, eq(runs.codexAccountId, codexAccounts.id))
    .where(and(ticketId ? eq(tickets.id, ticketId) : undefined, board ? eq(projects.status, 'active') : undefined)).orderBy(desc(tickets.updatedAt)).all();
  const blocker = alias(tickets, 'blocker');
  const blocks = await db.select({ ticketId: ticketDependencies.ticketId, number: blocker.githubIssueNumber }).from(ticketDependencies)
    .innerJoin(blocker, eq(ticketDependencies.dependsOnTicketId, blocker.id))
    .where(and(eq(blocker.githubState, 'open'), ticketId ? eq(ticketDependencies.ticketId, ticketId) : undefined)).all();
  const evidence = await latestRunEvidence(db, ticketId);
  // A PR closed without merging ends that attempt; the ticket leaves the board until requeued.
  return rows.filter(({ ticket, run }) => !board || !(run?.pullRequestState === 'closed' && !(ticket.requeuedAt && ticket.requeuedAt > run.createdAt)))
    .map(({ ticket, repo, agent, run: latest, account, leased, activity }) => {
    // Runs from before a human requeue no longer decide the ticket's lane.
    const run = latest && !(ticket.requeuedAt && ticket.requeuedAt > latest.createdAt) ? latest : null;
    const [type, at] = activity?.split(':') ?? [];
    return {
      id: ticket.id, title: ticket.title, number: ticket.githubIssueNumber, repo, projectId: ticket.projectId,
      htmlUrl: ticket.htmlUrl, stage: ticket.stage, githubState: ticket.githubState,
      labels: parseLabels(ticket.labels), assignedAgentId: ticket.assignedAgentId,
      agentName: agent?.name ?? null, agentColor: agent?.color ?? null, automationSlot: agent?.automationSlot ?? null,
      runStatus: run?.status ?? null, runId: run?.id ?? null,
      waitingReason: run?.status === 'running' ? runWaitReason(run.id, account && { ...account, leased: !!leased }) : null,
      completionPending: run?.status === 'running' && run.logStart === 'CI green;',
      startedAt: run?.startedAt?.toISOString() ?? null, finishedAt: run?.finishedAt?.toISOString() ?? null,
      pullRequestUrl: run?.pullRequestUrl ?? null, pullRequestState: run?.pullRequestState ?? null,
      runMode: run?.mode ?? null,
      runOutcome: run && run.status !== 'running' ? lastLine(run.logEnd) : null,
      blockedBy: blocks.filter((block) => block.ticketId === ticket.id).map((block) => block.number),
      sessionState: run ? sessionState(run, type ? { type, createdAt: new Date(Number(at)) } : null, now) : null,
      runAttempt: run?.attempt ?? 1, runFailureKind: run?.failureKind ?? null, runFollowUp: !!run && isFollowUp(run),
      evidence: run?.pullRequestUrl ? evidenceGate((evidence.get(run.id) ?? []).map(evidenceFromRow), run.pullRequestHeadSha) : null,
    };
  });
}
