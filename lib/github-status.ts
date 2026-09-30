import 'server-only';
import type { getGithubApp } from '@/lib/github';
import { APP_NAME } from '@/lib/brand';
import type { RunResult } from '@/shared/codex';
import { parsePullRef } from '@/lib/work-review';

type GithubClient = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;
export type IssueRunStatus = {
  runId: string;
  status: RunResult['status'];
  issueClosed?: boolean;
  pullRequestUrl?: string | null;
};

/** One comment per run preserves attempt history without adding completion comments. */
export async function updateGithubIssueStatus(
  client: GithubClient, owner: string, repo: string, issueNumber: number, run: IssueRunStatus,
) {
  const marker = `<!-- factory-run-status:${run.runId} -->`;
  const status = run.status === 'running' ? 'In progress'
    : run.status === 'failed' ? 'Failed — needs attention'
    : run.status === 'cancelled' ? 'Cancelled'
    : run.issueClosed ? 'Completed' : 'Awaiting review';
  const pull = parsePullRef(run.pullRequestUrl ?? null, `${owner}/${repo}`);
  // Deliberately exclude raw logs, which can contain private execution output.
  const body = `${marker}\n### ${APP_NAME} status\n\n**${status}**\n\nRun: \`${run.runId}\`` +
    (pull ? `\n\n[Pull request #${pull.number}](https://github.com/${owner}/${repo}/pull/${pull.number})` : '');
  const params = { owner, repo, issue_number: issueNumber, request: { signal: AbortSignal.timeout(20_000) } };
  for (let page = 1; ; page++) {
    const { data } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      ...params, per_page: 100, page,
    });
    const existing = data.find((comment) => comment.user?.type === 'Bot' && comment.body?.startsWith(`${marker}\n`));
    if (existing) {
      if (existing.body !== body) {
        await client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...params, comment_id: existing.id, body });
      }
      return;
    }
    if (data.length < 100) break;
  }
  await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...params, body });
}
