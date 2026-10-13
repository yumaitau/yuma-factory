"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getGithubApp } from "@/lib/github";
import { acceptReview, mergeReview, reviewContext } from "@/lib/review-merge";
import { requireSession } from "@/lib/session";
import { validId } from "@/shared/codex";

async function context(runId: string) {
  if (!validId(runId)) throw new Error("Invalid run.");
  const db = await getDb();
  const review = await reviewContext(db, runId);
  if (!review) throw new Error("This run has no pull request.");
  return { db, review, client: await getGithubApp().getInstallationOctokit(review.installationId) };
}

/** Accept review: records you, the head SHA you reviewed, and the time. It does not merge. */
export async function acceptReviewAction(runId: string, headSha: string) {
  const session = await requireSession();
  try {
    if (!/^[a-f0-9]{40}$/.test(String(headSha))) throw new Error("Invalid commit.");
    const { db, review, client } = await context(runId);
    const acceptance = await acceptReview(db, client, review, session.user.id, headSha);
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
    const { db, review, client } = await context(runId);
    const { event, joined } = await mergeReview(db, client, review, session.user.id);
    revalidatePath("/", "layout");
    if (event.status === "merged") return { ok: true as const, message: `${joined ? "Already merged" : "Merged"} ${event.headSha.slice(0, 7)}. Merging does not deploy.` };
    if (event.status === "pending") return { ok: true as const, message: "Another merge of this pull request is still running. Its result will appear in the history." };
    return { error: event.message ?? "GitHub did not merge this pull request." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not merge this pull request." };
  }
}
