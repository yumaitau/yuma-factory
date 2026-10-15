"use server";

import { revalidatePath } from "next/cache";
import { acceptRunReview, mergeRunReview } from "@/lib/factory-control";
import { requireSession } from "@/lib/session";

/** Accept review: records you, the head SHA you reviewed, and the time. It does not merge. */
export async function acceptReviewAction(runId: string, headSha: string) {
  const session = await requireSession();
  try {
    const acceptance = await acceptRunReview(session.user.id, runId, headSha);
    revalidatePath("/", "layout");
    return { ok: true as const, message: `Accepted ${acceptance.headSha.slice(0, 7)}. Nothing was merged.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not accept this review." };
  }
}

/** Merge: one GitHub merge of the accepted current head. A concurrent merge returns that same result. */
export async function mergeReviewAction(runId: string) {
  const session = await requireSession();
  try {
    const { event, joined } = await mergeRunReview(session.user.id, runId);
    revalidatePath("/", "layout");
    if (event.status === "merged") return { ok: true as const, message: `${joined ? "Already merged" : "Merged"} ${event.headSha.slice(0, 7)}. Merging does not deploy.` };
    if (event.status === "pending") return { ok: true as const, message: "Another merge of this pull request is still running. Its result will appear in the history." };
    return { error: event.message ?? "GitHub did not merge this pull request." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not merge this pull request." };
  }
}
