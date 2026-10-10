"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { validId } from "@/shared/codex";

/**
 * Send a follow-up to a run. Returns the run that will act on it: the same run while it is
 * live, or a new follow-up run when it had finished.
 */
export async function promptRunAction(runId: string, body: string) {
  const session = await requireSession();
  try {
    if (!validId(runId)) throw new Error("Invalid run.");
    const { promptRun } = await import("@/lib/agent/run");
    const result = await promptRun(runId, session.user.id, String(body ?? ""));
    revalidatePath("/", "layout");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not send this prompt." };
  }
}

/** A stop is a prompt with the stop signal. The branch and pull request are kept. */
export async function stopRunAction(runId: string) {
  const session = await requireSession();
  try {
    if (!validId(runId)) throw new Error("Invalid run.");
    const { cancelCodexRun } = await import("@/lib/agent/run");
    await cancelCodexRun(runId, session.user.id);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not stop this run." };
  }
}
