"use server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { codexAccounts } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getDb } from "@/lib/db";
import { newId } from "@/lib/ids";
import {
  ownedAccount,
  refreshAccount,
  saveStatus,
  lockOwnedAccount,
  releaseAccount,
  setAccountEnabled,
  setAccountMaxRuns,
  accountBusy,
} from "@/lib/codex/accounts";
import { runnerRequest } from "@/lib/codex/runner";
import {
  validateAuthFile,
  validId,
  type RunResult,
  type AccountStatus,
} from "@/shared/codex";

export async function connectCodexAction(form: FormData) {
  return actionResult(async () => {
    const session = await requireSession();
    const label = String(form.get("label") ?? "").trim();
    if (!label || label.length > 80)
      throw new Error("Enter a subscription name (up to 80 characters).");
    const file = form.get("authFile");
    const auth =
      file instanceof File && file.size
        ? validateAuthFile(await file.text())
        : undefined;
    const db = await getDb();
    const id = newId("codex");
    const now = new Date();
    await db
      .insert(codexAccounts)
      .values({
        id,
        label,
        ownerUserId: session.user.id,
        shared: form.get("shared") === "on",
        enabled: form.get("enabled") === "on",
        status: "connecting",
        createdAt: now,
        updatedAt: now,
      });
    try {
      const status = await runnerRequest<AccountStatus>(
        `/accounts/${id}/connect`,
        "POST",
        { auth },
      );
      await saveStatus(id, status);
      revalidatePath("/pool");
      return { id, ...status };
    } catch (error) {
      await db
        .update(codexAccounts)
        .set({
          status: "error",
          error: "Connection failed. Reconnect to try again.",
        })
        .where(eq(codexAccounts.id, id));
      throw error;
    }
  });
}
export async function refreshCodexAction(id: string) {
  return actionResult(async () => {
    const session = await requireSession();
    const status = await refreshAccount(id, session.user.id);
    revalidatePath("/pool");
    return { id, ...status };
  });
}
export async function disconnectCodexAction(id: string) {
  return actionResult(async () => {
    const session = await requireSession();
    const account = await ownedAccount(id, session.user.id);
    if (account.activeRunId || await accountBusy(id))
      throw new Error(
        "Wait for the current run to finish before disconnecting.",
      );
    const lock = await lockOwnedAccount(id, session.user.id);
    try {
      await runnerRequest(`/accounts/${id}`, "DELETE");
      const db = await getDb();
      await db
        .update(codexAccounts)
        .set({
          status: "disconnected",
          accountKey: null,
          email: null,
          plan: null,
          limitsJson: null,
          error: null,
          shared: false,
          updatedAt: new Date(),
        })
        .where(eq(codexAccounts.id, id));
    } finally {
      await releaseAccount(id, lock);
    }
    revalidatePath("/pool");
  });
}
export async function shareCodexAction(id: string, shared: boolean) {
  return actionResult(async () => {
    const session = await requireSession();
    await ownedAccount(id, session.user.id);
    const db = await getDb();
    await db
      .update(codexAccounts)
      .set({ shared })
      .where(eq(codexAccounts.id, id));
    revalidatePath("/pool");
  });
}

export async function setCodexEnabledAction(id: string, enabled: boolean) {
  return actionResult(async () => {
    const session = await requireSession();
    await setAccountEnabled(id, session.user.id, enabled);
    revalidatePath("/pool");
    revalidatePath("/");
  });
}

export async function setCodexMaxRunsAction(id: string, maxRuns: number) {
  return actionResult(async () => {
    const session = await requireSession();
    await setAccountMaxRuns(id, session.user.id, maxRuns);
    revalidatePath("/pool");
    revalidatePath("/");
  });
}

export async function reconnectCodexAction(id: string) {
  return actionResult(async () => {
    const session = await requireSession();
    const lock = await lockOwnedAccount(id, session.user.id);
    try {
      await runnerRequest(`/accounts/${id}`, "DELETE");
      const status = await runnerRequest<AccountStatus>(
        `/accounts/${id}/connect`,
        "POST",
        {},
      );
      const db = await getDb();
      await db
        .update(codexAccounts)
        .set({ accountKey: null, status: "connecting", error: null })
        .where(eq(codexAccounts.id, id));
      await saveStatus(id, status);
      revalidatePath("/pool");
      return { id, ...status };
    } finally {
      await releaseAccount(id, lock);
    }
  });
}
export async function testCodexAction(id: string) {
  return actionResult(async () => {
    const session = await requireSession();
    const runId = newId("run");
    await lockOwnedAccount(id, session.user.id, runId, true);
    try {
      await runnerRequest(`/runs/${runId}`, "POST", {
        accountId: id,
        probe: true,
        prompt:
          "Create a small JavaScript function add(a,b) and a Node.js test asserting add(2,3) is 5. Run that test. Report the actual test result. Do not commit or access credentials.",
      });
      return { id, runId };
    } catch (error) {
      await releaseAccount(id, runId);
      throw error;
    }
  });
}
export async function testCodexStatusAction(id: string, runId: string) {
  return actionResult(async () => {
    const session = await requireSession();
    await ownedAccount(id, session.user.id);
    // runId is interpolated into the runner path; anything else could traverse to other resources.
    if (!validId(runId)) throw new Error("Invalid test run.");
    const result = await runnerRequest<RunResult>(
      `/runs/${runId}?accountId=${id}`,
    );
    if (result.status !== "running") {
      if (result.accountStatus) await saveStatus(id, result.accountStatus);
      await releaseAccount(id, runId);
      revalidatePath("/pool");
    }
    return result;
  });
}

export type ActionResult<T> =
  | { data: T; error?: never }
  | { error: string; data?: never };
async function actionResult<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await fn() };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return {
      error:
        error instanceof Error ? error.message : "Request failed. Try again.",
    };
  }
}
