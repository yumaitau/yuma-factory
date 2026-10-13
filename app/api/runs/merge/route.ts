import { and, eq } from 'drizzle-orm';
import { runs } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { bearerToken } from '@/lib/factory-auth';
import { getGithubApp } from '@/lib/github';
import { runIdFromMergeToken } from '@/lib/run-token';
import { factoryMerge, reviewContext } from '@/lib/review-merge';

const noStore = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Runner -> app: the low-risk policy asks Factory to merge a CI-confirmed SHA. The merge is serialised
 * with people's merges and recorded as Factory's. A head that moved off that SHA is refused (409).
 */
export async function POST(request: Request) {
  // Only the root-owned bridge holds the merge token; the agent's channel token is refused here.
  const runId = runIdFromMergeToken(bearerToken(request), getEnv().SANDBOX_RUNNER_SECRET);
  if (!runId) return noStore({ error: 'Run is not active.' }, 401);
  const db = await getDb();
  const active = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.id, runId), eq(runs.status, 'running'))).get();
  if (!active) return noStore({ error: 'Run is not active.' }, 401);
  const body = await request.json().catch(() => null) as { pullRequestUrl?: unknown; sha?: unknown } | null;
  if (typeof body?.pullRequestUrl !== 'string' || typeof body.sha !== 'string' || !/^[a-f0-9]{40}$/.test(body.sha))
    return noStore({ error: 'Invalid merge request.' }, 400);
  // The bridge names the PR it supervised; the stored URL may lag runner progress. It must be in the run's repository.
  const context = await reviewContext(db, runId, body.pullRequestUrl);
  if (!context) return noStore({ error: 'Pull request does not belong to this run.' }, 400);
  try {
    const client = await getGithubApp().getInstallationOctokit(context.installationId);
    const { event } = await factoryMerge(db, client, context, body.sha);
    if (event.status === 'refused') return noStore({ error: `${event.message ?? 'PR head changed before merge.'} Ticket left open.` }, 409);
    if (event.status === 'merged' && event.headSha !== body.sha) return noStore({ error: 'PR merged at a different head. Ticket left open.' }, 409);
    const result = event.status === 'merged' ? 'merge' : event.status === 'already-merged' ? 'already-merged' : 'blocked';
    return noStore({ result, sha: event.mergeSha, message: event.message });
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : 'Merge failed.' }, 502);
  }
}
