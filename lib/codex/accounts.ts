import "server-only";
import { and, asc, eq, getTableColumns, isNull, or, sql, type SQL } from "drizzle-orm";
import { accountLeases, codexAccounts } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getDb } from "@/lib/db";
import { parseLimits } from "@/lib/run-wait";
import { runnerRequest } from "./runner";
import { hasCapacity, MAX_PARALLEL_RUNS, type AccountStatus } from "@/shared/codex";

// A claim reserves its lease before the run row exists; an abandoned claim expires.
const pendingClaim = (lease: string) => sql.raw(`not exists (select 1 from runs r where r.id = ${lease}.holder_id) and ${lease}.created_at > unixepoch() - 600`);
// A paused run releases its lease, but its durable job still needs a slot on
// this subscription. New work must not take that slot before recovery resumes.
const occupied = (account: SQL) => sql`((select count(*) from runs where runs.codex_account_id = ${account} and runs.status = 'running')
  + (select count(*) from account_leases l where l.account_id = ${account} and ${pendingClaim("l")}))`;
/** Leases held by executing runs or fresh claims; maintenance must wait for none. */
const liveLeases = (account: SQL) => sql`select 1 from account_leases l where l.account_id = ${account}
  and (exists (select 1 from runs r where r.id = l.holder_id and r.status = 'running') or ${pendingClaim("l")})`;
const noLiveLease = (account: SQL) => sql`not exists (${liveLeases(account)})`;
const accountId = sql`${codexAccounts.id}`;
/** Select alongside a run: whether it holds a lease, i.e. is executing rather than paused. */
export const runLeased = (runId: SQL) => sql<number>`exists (select 1 from account_leases where holder_id = ${runId})`;

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
  if (row.activeRunId || await accountBusy(id)) return { status: "busy" };
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
    .select({ ...getTableColumns(codexAccounts), runningRuns: sql<number>`(select count(*) from account_leases l
      where l.account_id = ${codexAccounts.id} and exists (select 1 from runs r where r.id = l.holder_id and r.status = 'running'))` })
    .from(codexAccounts)
    .where(
      or(eq(codexAccounts.ownerUserId, userId), eq(codexAccounts.shared, true)),
    )
    .orderBy(asc(codexAccounts.createdAt))
    .all();
}
/** Subscriptions with a free parallel slot. */
export async function availableAccounts(
  userId: string,
  database?: Awaited<ReturnType<typeof getDb>>,
) {
  const db = database ?? (await getDb());
  const rows = await db
    .select({ ...getTableColumns(codexAccounts), used: sql<number>`${occupied(accountId)}` })
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
        sql`${occupied(accountId)} < ${codexAccounts.maxRuns}`,
      ),
    )
    // Least loaded first, then least recently used, so tickets spread across subscriptions.
    .orderBy(sql`${occupied(accountId)}`, asc(codexAccounts.lastUsedAt))
    .all();
  return rows
    .filter((row) => hasCapacity(parseLimits(row.limitsJson)))
    .map(({ used, ...row }) => ({ ...row, freeSlots: row.maxRuns - used }));
}

/** Free parallel slots across every usable subscription. */
export async function availableSlots(userId: string, database?: Awaited<ReturnType<typeof getDb>>) {
  return (await availableAccounts(userId, database)).reduce((total, row) => total + row.freeSlots, 0);
}

export async function claimAccount(userId: string, runId: string, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? (await getDb());
  for (const row of await availableAccounts(userId, db)) {
    // One INSERT...SELECT re-checks every condition, so racing claims cannot overfill a subscription.
    const claimed = await db.all(sql`insert into account_leases (holder_id, account_id, created_at)
      select ${runId}, id, unixepoch() from codex_accounts
      where id = ${row.id} and enabled = 1 and active_run_id is null and status in ('ready', 'limited')
        and (owner_user_id = ${userId} or shared = 1) and ${occupied(sql`codex_accounts.id`)} < max_runs
      returning holder_id`);
    if (claimed.length) {
      await db.update(codexAccounts).set({ lastUsedAt: new Date() }).where(eq(codexAccounts.id, row.id));
      return row;
    }
  }
  throw new Error(
    "No available Codex subscription. Connect, enable or refresh an account in Codex subscriptions, or wait for a parallel run slot to free up.",
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
/** Release a run's lease or a maintenance lock held by `holderId`. */
export async function releaseAccount(id: string, holderId: string, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? (await getDb());
  await db.delete(accountLeases).where(and(eq(accountLeases.accountId, id), eq(accountLeases.holderId, holderId)));
  await db
    .update(codexAccounts)
    .set({ activeRunId: null, updatedAt: new Date() })
    .where(and(eq(codexAccounts.id, id), eq(codexAccounts.activeRunId, holderId)));
}

/** True while any run is executing on the subscription. */
export async function accountBusy(id: string, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? (await getDb());
  return !(await db.select({ id: codexAccounts.id }).from(codexAccounts)
    .where(and(eq(codexAccounts.id, id), noLiveLease(accountId))).get());
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
        noLiveLease(accountId),
      ),
    )
    .returning({ id: codexAccounts.id });
  if (!claimed.length)
    throw new Error(
      "This subscription is busy or disabled. Enable it and wait for its current runs and operations to finish.",
    );
  return lockId;
}

/** Renew or resume a run's lease on its original subscription; never while maintenance holds it. */
export async function reserveRunAccount(id: string, userId: string, runId: string, resume: boolean, database?: Awaited<ReturnType<typeof getDb>>) {
  const db = database ?? await getDb();
  const held = await db.select({ id: accountLeases.holderId }).from(accountLeases)
    .where(and(eq(accountLeases.accountId, id), eq(accountLeases.holderId, runId))).get();
  if (held) return true;
  if (!resume) return false;
  // Paused runs already count toward the subscription's slots; executing leases stay within max_runs.
  const claimed = await db.all(sql`insert into account_leases (holder_id, account_id, created_at)
    select ${runId}, id, unixepoch() from codex_accounts
    where id = ${id} and enabled = 1 and active_run_id is null and status in ('ready', 'limited')
      and (owner_user_id = ${userId} or shared = 1)
      and (select count(*) from (${liveLeases(sql`codex_accounts.id`)})) < max_runs
    on conflict do nothing
    returning holder_id`);
  return claimed.length > 0;
}

export async function setAccountMaxRuns(id: string, userId: string, maxRuns: number, database?: Awaited<ReturnType<typeof getDb>>) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_PARALLEL_RUNS)
    throw new Error(`Choose between 1 and ${MAX_PARALLEL_RUNS} parallel runs.`);
  const db = database ?? (await getDb());
  const changed = await db.update(codexAccounts).set({ maxRuns, updatedAt: new Date() })
    .where(and(eq(codexAccounts.id, id), eq(codexAccounts.ownerUserId, userId)))
    .returning({ id: codexAccounts.id });
  if (!changed.length) throw new Error("Subscription not found.");
}
