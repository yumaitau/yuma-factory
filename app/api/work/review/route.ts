import { requireApiSession } from '@/lib/session';
import { outstandingPullRequests } from '@/lib/work-review-query';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    return Response.json(await outstandingPullRequests(), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Could not check GitHub pull requests. Try again.' }, { status: 503 });
  }
}
