import { getEnv } from "@/lib/env";
import { completeCodexRun } from "@/lib/agent/run";
import { validId, type RunResult } from "@/shared/codex";
import { enqueuePickup } from '@/lib/automation-queue';
export async function POST(request: Request) {
  const env = await getEnv();
  if (
    !env.SANDBOX_RUNNER_SECRET ||
    request.headers.get("x-runner-secret") !== env.SANDBOX_RUNNER_SECRET
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const data = (await request.json()) as { id: string; result: RunResult };
  if (
    !validId(data.id) ||
    !["succeeded", "failed", "cancelled"].includes(data.result?.status) ||
    typeof data.result.log !== "string"
  )
    return Response.json({ error: "Invalid result" }, { status: 400 });
  await completeCodexRun(data.id, data.result);
  await enqueuePickup('Run completed');
  return Response.json({ ok: true });
}
