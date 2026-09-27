import 'server-only';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { githubInstallations, projects, runs, tickets } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getGithubApp } from '@/lib/github';
import { forEachConcurrent } from '@/lib/concurrency';
import { matchOpenPulls, uniquePullCandidates, type CompletedWork, type ReviewQueue } from '@/lib/work-review';

export async function recentlyCompletedWork(): Promise<CompletedWork[]> {
  const db = await getDb();
  const rows = await db.select({ runId: runs.id, title: tickets.title, repo: projects.repoFullName,
    issueNumber: tickets.githubIssueNumber, finishedAt: runs.finishedAt, pullRequestUrl: runs.pullRequestUrl })
    .from(runs).innerJoin(tickets, eq(runs.ticketId, tickets.id)).innerJoin(projects, eq(tickets.projectId, projects.id))
    .where(and(eq(runs.status, 'succeeded'), isNotNull(runs.finishedAt)))
    .orderBy(desc(runs.finishedAt), desc(runs.id)).limit(20).all();
  return rows.map((row) => ({ ...row, finishedAt: row.finishedAt!.toISOString() }));
}

export async function outstandingPullRequests(): Promise<ReviewQueue> {
  const db = await getDb();
  const rows = await db.select({ runId: runs.id, repo: projects.repoFullName, status: runs.status,
    pullRequestUrl: runs.pullRequestUrl, installationId: githubInstallations.installationId })
    .from(runs).innerJoin(tickets, eq(runs.ticketId, tickets.id)).innerJoin(projects, eq(tickets.projectId, projects.id))
    .innerJoin(githubInstallations, eq(projects.installationId, githubInstallations.id))
    // Bound the scan: the table grows monotonically and every call fans out to GitHub per repo.
    .where(isNotNull(runs.pullRequestUrl)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(200).all();
  const candidates = uniquePullCandidates(rows);
  const groups = Map.groupBy(candidates, (row) => `${row.installationId}:${row.repo}`);
  const queue: ReviewQueue = { pulls: [], unavailableRepos: [], checkedAt: new Date().toISOString() };
  if (!candidates.length) return queue;
  const app = getGithubApp();
  await forEachConcurrent([...groups.values()], 4, async (group) => {
    const { repo: fullName, installationId } = group[0];
    try {
      const client = await app.getInstallationOctokit(installationId);
      const [owner, repo] = fullName.split('/');
      const pulls = await client.paginate(client.rest.pulls.list, {
        owner, repo, state: 'open', per_page: 100, sort: 'updated', direction: 'desc',
        request: { signal: AbortSignal.timeout(15_000) },
      });
      queue.pulls.push(...matchOpenPulls(group, pulls));
    } catch { queue.unavailableRepos.push(fullName); }
  });
  queue.pulls.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return queue;
}
