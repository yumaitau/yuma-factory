import { and, eq } from 'drizzle-orm';
import { runs } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { bearerToken } from '@/lib/factory-auth';
import { runIdFromToken } from '@/lib/run-token';
import { ingestActivities, takePrompts } from '@/lib/run-activities';
import { ACTIVITY_LIMITS, normalizeActivity, parseRunPlan, type IncomingActivity } from '@/lib/run-session';

const noStore = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/** Runner -> app session channel, authenticated by the run token. Returns follow-ups when the runner can apply them. */
export async function POST(request: Request) {
  const runId = runIdFromToken(bearerToken(request), getEnv().SANDBOX_RUNNER_SECRET);
  if (!runId) return noStore({ error: 'Run is not active.' }, 401);
  const db = await getDb();
  const run = await db.select({ id: runs.id, ticketId: runs.ticketId }).from(runs)
    .where(and(eq(runs.id, runId), eq(runs.status, 'running'))).get();
  if (!run) return noStore({ error: 'Run is not active.' }, 401);
  if (Number(request.headers.get('content-length') ?? 0) > 2_000_000) return noStore({ error: 'Request is too large.' }, 413);
  const body = await request.json().catch(() => null) as { activities?: unknown; plan?: unknown; take?: unknown } | null;
  if (!body || typeof body !== 'object') return noStore({ error: 'Invalid activities.' }, 400);
  const activities = (Array.isArray(body.activities) ? body.activities.slice(0, ACTIVITY_LIMITS.batch) : [])
    .map(normalizeActivity).filter((item): item is IncomingActivity => !!item);
  await ingestActivities(db, run, activities, body.plan === undefined ? undefined : parseRunPlan(body.plan));
  return noStore({ ok: true, prompts: body.take === true ? await takePrompts(db, run.id) : [] });
}
