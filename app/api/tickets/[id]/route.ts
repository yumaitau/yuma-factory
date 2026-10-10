import { requireApiSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getTicketPanel } from '@/lib/ticket-panel';
import { validId } from '@/shared/codex';

/** The issue panel: a ticket's properties and every agent session on it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return Response.json({ error: 'Invalid ticket' }, { status: 400 });
  // Factory projects and run sessions are shared with every signed-in team member.
  const panel = await getTicketPanel(await getDb(), id);
  if (!panel) return Response.json({ error: 'Ticket not found' }, { status: 404 });
  return Response.json({ ...panel, viewerId: auth.session.user.id }, { headers: { 'Cache-Control': 'private, no-store' } });
}
