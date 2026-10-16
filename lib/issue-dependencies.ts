import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { ticketDependencies, tickets } from '@/db/schema';
import type { getGithubApp } from '@/lib/github';
import type { Db } from '@/lib/queries';

type Client = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;

const DEPENDS_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:depends on|blocked by|waits on)\b(?:\*\*)?(.*)$/gim;

/** Same-repository issue numbers a body names on lines such as `Depends on #12` or `Blocked by: #3, #4`. */
export function bodyBlockers(body: string | null | undefined) {
  const numbers = new Set<number>();
  for (const [, rest] of (body ?? '').matchAll(DEPENDS_LINE))
    for (const [, number] of rest.matchAll(/(?<![\w/])#(\d+)\b/g)) numbers.add(Number(number));
  return [...numbers];
}

/**
 * Open issues a ticket waits on, from GitHub's "blocked by" links and its body. Blockers that are tickets here
 * are recorded as dependencies, so the board shows the wait and later checks skip the ticket until they close.
 */
export async function openBlockers(db: Db, client: Client, owner: string, repo: string,
  ticket: { id: string; projectId: string; githubIssueNumber: number },
  issue: { body?: string | null; issue_dependencies_summary?: { blocked_by: number } }) {
  const open = new Set<string>();
  const numbers = new Set(bodyBlockers(issue.body));
  // The summary counts open blockers, so an unblocked issue costs no extra request.
  if (issue.issue_dependencies_summary?.blocked_by) {
    const { data } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
      owner, repo, issue_number: ticket.githubIssueNumber, per_page: 100, request: { signal: AbortSignal.timeout(20_000) },
    });
    for (const blocker of data) {
      const sameRepo = blocker.repository_url.toLowerCase().endsWith(`/repos/${owner}/${repo}`.toLowerCase());
      if (sameRepo) numbers.add(blocker.number);
      // GitHub's state is current; another repository's issue has no ticket here but still blocks.
      if (blocker.state === 'open') open.add(sameRepo ? `#${blocker.number}` : blocker.html_url);
    }
  }
  numbers.delete(ticket.githubIssueNumber);
  const known = numbers.size ? await db.select({ id: tickets.id, number: tickets.githubIssueNumber, state: tickets.githubState }).from(tickets)
    .where(and(eq(tickets.projectId, ticket.projectId), inArray(tickets.githubIssueNumber, [...numbers]))).all() : [];
  // Forty rows keep each statement below D1's bound-parameter limit.
  for (let offset = 0; offset < known.length; offset += 40) {
    await db.insert(ticketDependencies).values(known.slice(offset, offset + 40)
      .map((blocker) => ({ ticketId: ticket.id, dependsOnTicketId: blocker.id }))).onConflictDoNothing();
  }
  for (const blocker of known) if (blocker.state === 'open') open.add(`#${blocker.number}`);
  return [...open];
}
