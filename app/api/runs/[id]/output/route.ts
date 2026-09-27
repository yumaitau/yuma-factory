import { requireApiSession } from '@/lib/session';
import { getRun } from '@/lib/queries';
import { validId, type RunResult } from '@/shared/codex';
import { runnerRequest } from '@/lib/codex/runner';
import { publicRunOutput, runOutputStream } from '@/lib/run-output';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return Response.json({ error: 'Invalid run' }, { status: 400 });
  // Factory projects and run logs are shared with every signed-in team member.
  const run = await getRun(id);
  if (!run) return Response.json({ error: 'Run not found' }, { status: 404 });
  const initial = publicRunOutput({ ...run, outputUpdatedAt: run.finishedAt?.toISOString() ?? null });
  return new Response(runOutputStream(initial, async (signal) => {
    const current = await getRun(id);
    if (!current) throw new Error('Run unavailable');
    if (current.status !== 'running' || !current.codexAccountId)
      return publicRunOutput({ ...current, outputUpdatedAt: current.finishedAt?.toISOString() ?? null });
    const result = await runnerRequest<RunResult>(`/runs/${id}/output?accountId=${encodeURIComponent(current.codexAccountId)}`,
      'GET', undefined, 10_000, signal);
    return publicRunOutput({ ...result, waitingReason: current.waitingReason });
  }, request.signal), { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  } });
}
