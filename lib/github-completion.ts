import 'server-only';
import { getGithubApp } from '@/lib/github';
import { APP_NAME, LABEL_PREFIX, LABELS } from '@/lib/brand';
import { isLowRisk, riskLabel, type TicketRisk } from '@/shared/ticket-risk';
type GithubClient = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;
const statusOf = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;
const RISK_COLORS: Record<TicketRisk, { color: string; description: string }> = {
  low: { color: '2DA44E', description: 'Low risk. Factory merges after green CI.' },
  medium: { color: 'D4A72C', description: 'Medium risk. Factory leaves the PR for review.' },
  high: { color: 'CF222E', description: 'High risk. Factory leaves the PR for review.' },
};

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => typeof label === 'string' ? label : label && typeof label === 'object' && 'name' in label && typeof (label as { name: unknown }).name === 'string' ? (label as { name: string }).name : null).filter((name): name is string => !!name);
}

export async function ensureRepoLabel(client: GithubClient, params: { owner: string; repo: string; request: { signal: AbortSignal } }, name: string, color: string, description: string) {
  try {
    await client.request('GET /repos/{owner}/{repo}/labels/{name}', { ...params, name });
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    try {
      await client.request('POST /repos/{owner}/{repo}/labels', { ...params, name, color, description });
    } catch (createError) {
      if (statusOf(createError) !== 422) throw createError;
      await client.request('GET /repos/{owner}/{repo}/labels/{name}', { ...params, name });
    }
  }
}

async function mergeGreenPullRequest(client: GithubClient, owner: string, repo: string, pullNumber: number, sha: string) {
  const params = { owner, repo, pull_number: pullNumber, request: { signal: AbortSignal.timeout(20_000) } };
  const { data: pr } = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', params);
  if (pr.merged) return 'already-merged' as const;
  if (pr.state !== 'open') throw new Error('Pull request closed before merge. Ticket left open.');
  if (pr.head.sha !== sha) throw new Error('PR head changed before merge. Ticket left open.');
  for (const merge_method of ['squash', 'merge'] as const) {
    try {
      const { data } = await client.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...params, sha, merge_method });
      if (data.merged) return merge_method;
    } catch (error) {
      const message = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
      if (statusOf(error) === 409) throw new Error('PR head changed before merge. Ticket left open.');
      if (statusOf(error) === 405 && /merge method/i.test(message)) continue;
      if (statusOf(error) === 405 || statusOf(error) === 422) return 'blocked' as const;
      throw error;
    }
  }
  return 'blocked' as const;
}

/** Replace Factory-owned <prefix>:risk:* labels. Human severity/risk labels stay. */
export async function setGithubIssueRisk(client: GithubClient, owner: string, repo: string, issueNumber: number, risk: TicketRisk | null) {
  const params = { owner, repo, issue_number: issueNumber, request: { signal: AbortSignal.timeout(20_000) } };
  if (risk) {
    const meta = RISK_COLORS[risk];
    await ensureRepoLabel(client, params, riskLabel(risk, LABEL_PREFIX), meta.color, meta.description);
  }
  const { data: issue } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params);
  const current = labelNames(issue.labels);
  for (const name of current) {
    if (!name.toLowerCase().startsWith(LABELS.riskPrefix)) continue;
    if (risk && name.toLowerCase() === riskLabel(risk, LABEL_PREFIX)) continue;
    try {
      await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...params, name });
    } catch (error) { if (statusOf(error) !== 404) throw error; }
  }
  if (risk) await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...params, labels: [riskLabel(risk, LABEL_PREFIX)] });
  const { data: updated } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params);
  return labelNames(updated.labels);
}

/** Idempotent: retries retain unrelated labels and only close after the done label is applied. */
export async function markGithubIssueDone(client: GithubClient, owner: string, repo: string, issueNumber: number, options?: { pullNumber?: number; sha?: string }) {
  const params = { owner, repo, issue_number: issueNumber, request: { signal: AbortSignal.timeout(20_000) } };
  await ensureRepoLabel(client, params, LABELS.done, '2DA44E', `Completed by ${APP_NAME}`);
  await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...params, labels: [LABELS.done] });
  try {
    await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...params, name: LABELS.ready });
  } catch (error) { if (statusOf(error) !== 404) throw error; }
  const { data: issue } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params);
  const { data } = await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...params, state: 'closed', state_reason: 'completed' });
  if (data.state !== 'closed') throw new Error('GitHub did not confirm issue closure.');
  if (isLowRisk(labelNames(issue.labels), LABEL_PREFIX) && options?.pullNumber && options.sha) {
    try {
      await mergeGreenPullRequest(client, owner, repo, options.pullNumber, options.sha);
    } catch {
      // Issue closure already succeeded; a blocked or drifted PR stays in review.
    }
  }
  return labelNames(data.labels);
}
