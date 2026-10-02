import 'server-only';
import { and, asc, eq, ne, or, isNull, sql } from 'drizzle-orm';
import { githubInstallations, projects, runs, tickets } from '@/db/schema';
import { getGithubApp } from '@/lib/github';
import { markGithubIssueDone } from '@/lib/github-completion';
import { forEachConcurrent } from '@/lib/concurrency';
import { parsePullRef } from '@/lib/work-review';
import type { Db } from '@/lib/queries';

type Client = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;

/**
 * Track the PRs of open tickets' latest finished runs. A merged PR finishes its ticket;
 * a PR closed without merging hides the ticket from the Work board.
 */
export async function syncPullRequests(db: Db, clientFor: (installationId: number) => Promise<Client>, deadline: number, limit = 30) {
  const rows = await db.select({ run: runs, ticket: tickets, repo: projects.repoFullName, installationId: githubInstallations.installationId })
    .from(runs).innerJoin(tickets, eq(runs.ticketId, tickets.id)).innerJoin(projects, eq(tickets.projectId, projects.id))
    .innerJoin(githubInstallations, eq(projects.installationId, githubInstallations.id))
    .where(and(
      eq(projects.status, 'active'), eq(tickets.githubState, 'open'), ne(runs.status, 'running'),
      sql`${runs.pullRequestUrl} is not null`, or(isNull(runs.pullRequestState), eq(runs.pullRequestState, 'open')),
      sql`${runs.id} = (select latest.id from runs latest where latest.ticket_id = ${tickets.id} order by latest.created_at desc, latest.id desc limit 1)`,
    )).orderBy(asc(runs.pullRequestCheckedAt), asc(runs.id)).limit(limit).all();
  await forEachConcurrent(rows, 4, async ({ run, ticket, repo, installationId }) => {
    if (Date.now() > deadline) return;
    const ref = parsePullRef(run.pullRequestUrl, repo);
    if (!ref) return;
    const [owner, name] = repo.split('/');
    try {
      const client = await clientFor(installationId);
      const { data: pull } = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo: name, pull_number: ref.number, request: { signal: AbortSignal.timeout(15_000) },
      });
      const state = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open';
      if (state === 'merged') {
        const labels = await markGithubIssueDone(client, owner, name, ticket.githubIssueNumber);
        await db.update(tickets).set({ stage: 'done', githubState: 'closed', labels: JSON.stringify(labels), updatedAt: new Date() })
          .where(and(eq(tickets.id, ticket.id), sql`not exists (select 1 from runs r where r.ticket_id = ${ticket.id} and r.status = 'running')`));
      }
      await db.update(runs).set({ pullRequestState: state, pullRequestCheckedAt: new Date() }).where(eq(runs.id, run.id));
    } catch {
      // Unreachable PRs are retried on a later sync, after the others.
      await db.update(runs).set({ pullRequestCheckedAt: new Date() }).where(eq(runs.id, run.id)).catch(() => {});
    }
  });
}
