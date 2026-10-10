import { requireApiSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getRunSession } from '@/lib/run-activities';
import { validId } from '@/shared/codex';

/** Poll a run's agent session. `?after=<seq>` returns only newer activities. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return Response.json({ error: 'Invalid run' }, { status: 400 });
  const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
  // Factory projects and run sessions are shared with every signed-in team member.
  const session = await getRunSession(await getDb(), id, Number.isSafeInteger(after) && after > 0 ? after : 0);
  if (!session) return Response.json({ error: 'Run not found' }, { status: 404 });
  return Response.json(session, { headers: { 'Cache-Control': 'private, no-store' } });
}
