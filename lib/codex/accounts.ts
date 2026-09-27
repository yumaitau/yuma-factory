import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { codexAccounts, runs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getDb } from "@/lib/db";
import { parseLimits } from "@/lib/run-wait";
import { runnerRequest } from "./runner";
import { hasCapacity, type AccountStatus } from "@/shared/codex";

// A paused sandbox releases its lock, but its durable job still needs this
// subscription. New work must not repeatedly take it before recovery resumes.
const noRecoveringRun = () => sql`not exists (select 1 from ${runs}
  where ${runs.codexAccountId} = ${codexAccounts.id} and ${runs.status} = 'running')`;

export async function ownedAccount(id: string, userId: string) {
  const db = await getDb();
  const row = await db
    .select()
    .from(codexAccounts)
    .where(and(eq(codexAccounts.id, id), eq(codexAccounts.ownerUserId, userId)))
    .get();
  if (!row) throw new Error("Subscription not found.");
  return row;
}
export async function saveStatus(id: string, status: AccountStatus) {
  const db = await getDb();
  if (status.accountKey) {
    const existing = await db
      .select()
      .from(codexAccounts)
      .where(eq(codexAccounts.accountKey, status.accountKey))
      .get();
    if (existing && existing.id !== id) {
      await runnerRequest(`/accounts/${id}`, "DELETE");
      await db
        .update(codexAccounts)
        .set({
          status: "error",
          error: "This subscription is already connected.",
          updatedAt: new Date(),
        })
        .where(eq(codexAccounts.id, id));
      throw new Error("This subscription is already connected.");
    }
  }
  await db
    .update(codexAccounts)
    .set({
      status: status.status,
      email: status.email,
      plan: status.plan,
      accountKey: status.accountKey,
      limitsJson: status.limits ? JSON.stringify(status.limits) : null,
      error: status.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(codexAccounts.id, id));
}
export async function refreshAccount(id: string, userId: string) {
  const row = await ownedAccount(id, userId);
  if (row.activeRunId) return { status: "busy" };
  const lock = await lockOwnedAccount(id, userId);
  try {
    const status = await runnerRequest<AccountStatus>(`/accounts/${id}`);
    await saveStatus(id, status);
    return status;
  } finally {
    await releaseAccount(id, lock);
  }
}
export async function visibleAccounts(userId: string) {
  const db = await getDb();
  return db
    .select()
    .from(codexAccounts)
    .where(
      or(eq(codexAccounts.ownerUserId, userId), eq(codexAccounts.shared, true)),
    )
    .orderBy(asc(codexAccounts.createdAt))
    .all();
}
export async function availableAccounts(
  userId: string,
  database?: Awaited<ReturnType<typeof getDb>>,
) {
  const db = database ?? (await getDb());
  const rows = await db
    .select()
    .from(codexAccounts)
    .where(
      and(
        eq(codexAccounts.enabled, true),
        or(
          eq(codexAccounts.ownerUserId, userId),
          eq(codexAccounts.shared, true),
        ),
        or(
          eq(codexAccounts.status, "ready"),
          eq(codexAccounts.status, "limited"),
        ),
        isNull(codexAccounts.activeRunId),
        noRecoveringRun(),
      ),
    )
    .orderBy(asc(codexAccounts.lastUsedAt))
    .all();
  return rows.filter((row) => hasCapacity(parseLimits(row.limitsJson)));
}

export async function claimAccount(userId: string, runId: string, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? (await getDb());
  for (const row of await availableAccounts(userId, db)) {
    const claimed = await db
      .update(codexAccounts)
      .set({ activeRunId: runId, lastUsedAt: new Date() })
      .where(
        and(
          eq(codexAccounts.id, row.id),
          eq(codexAccounts.enabled, true),
          isNull(codexAccounts.activeRunId),
          noRecoveringRun(),
          or(
            eq(codexAccounts.status, "ready"),
            eq(codexAccounts.status, "limited"),
          ),
          or(
            eq(codexAccounts.ownerUserId, userId),
            eq(codexAccounts.shared, true),
          ),
        ),
      )
      .returning({ id: codexAccounts.id });
    if (claimed.length) return row;
  }
  throw new Error(
    "No available Codex subscription. Connect, enable or refresh an account in Codex subscriptions, or wait for its current run to finish.",
  );
}

export async function setAccountEnabled(id: string, userId: string, enabled: boolean, database?: Awaited<ReturnType<typeof getDb>>) {
  if (typeof enabled !== "boolean") throw new Error("Invalid subscription setting.");
  const db = database ?? (await getDb());
  const changed = await db.update(codexAccounts).set({ enabled, updatedAt: new Date() })
    .where(and(eq(codexAccounts.id, id),
      or(eq(codexAccounts.ownerUserId, userId), eq(codexAccounts.shared, true))))
    .returning({ id: codexAccounts.id });
  if (!changed.length) throw new Error("Subscription not found.");
}
export async function releaseAccount(id: string, runId: string) {
  const db = await getDb();
  await db
    .update(codexAccounts)
    .set({ activeRunId: null, updatedAt: new Date() })
    .where(and(eq(codexAccounts.id, id), eq(codexAccounts.activeRunId, runId)));
}

export async function lockOwnedAccount(
  id: string,
  userId: string,
  lockId = newId("maintenance"),
  requireEnabled = false,
) {
  await ownedAccount(id, userId);
  const db = await getDb();
  const claimed = await db
    .update(codexAccounts)
    .set({ activeRunId: lockId })
    .where(
      and(
        eq(codexAccounts.id, id),
        eq(codexAccounts.ownerUserId, userId),
        ...(requireEnabled ? [eq(codexAccounts.enabled, true)] : []),
        isNull(codexAccounts.activeRunId),
      ),
    )
    .returning({ id: codexAccounts.id });
  if (!claimed.length)
    throw new Error(
      "This subscription is busy or disabled. Enable it and wait for its current operation to finish.",
    );
  return lockId;
}

/** Reclaim only the original subscription; never steal a reconnect/other-run lock. */
export async function reserveRunAccount(id: string, userId: string, runId: string, resume: boolean, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? await getDb();
  const claimed = await db.update(codexAccounts).set({ activeRunId: runId, updatedAt: new Date() })
    .where(and(eq(codexAccounts.id, id),
      or(eq(codexAccounts.activeRunId, runId), ...(resume ? [and(
        isNull(codexAccounts.activeRunId), eq(codexAccounts.enabled, true),
        inArray(codexAccounts.status, ["ready", "limited"]),
        or(eq(codexAccounts.ownerUserId, userId), eq(codexAccounts.shared, true)),
      )] : [])),
    )).returning({ id: codexAccounts.id });
  return claimed.length > 0;
}
