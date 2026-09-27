import { requireApiSession } from "@/lib/session";
import { refreshRuns } from "@/lib/agent/run";
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return Response.json(
    { runs: await refreshRuns(auth.session.user.id) },
    { headers: { "cache-control": "no-store" } },
  );
}
