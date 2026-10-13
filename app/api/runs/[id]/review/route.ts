import { requireApiSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getGithubApp } from '@/lib/github';
import { reviewContext, reviewState } from '@/lib/review-merge';
import { validId } from '@/shared/codex';

/** Accept, merge and deploy for a run's pull request, each with its own check against GitHub's current head. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return Response.json({ error: 'Invalid run' }, { status: 400 });
  const db = await getDb();
  const context = await reviewContext(db, id);
  if (!context) return Response.json({ error: 'This run has no pull request.' }, { status: 404 });
  try {
    const client = await getGithubApp().getInstallationOctokit(context.installationId);
    return Response.json(await reviewState(db, client, context, auth.session.user.id), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Could not read the pull request from GitHub. Try again.' }, { status: 503 });
  }
}
