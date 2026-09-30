import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { readFileSync, readdirSync } from "node:fs";
import { accountBusy, expireMaintenanceLocks, availableAccounts, availableSlots, claimAccount, releaseAccount, reserveRunAccount, setAccountEnabled, setAccountMaxRuns } from "../lib/codex/accounts";
import * as schema from "../db/schema";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  const hook: { afterSelect?: () => void } = {};
  const binding = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async raw() {
              stmt.setReturnArrays(true);
              const rows = stmt.all(...(params as never[]));
              if (query.startsWith('select') && hook.afterSelect) {
                const callback = hook.afterSelect;
                hook.afterSelect = undefined;
                callback();
              }
              return rows;
            },
            async all() { return { results: stmt.all(...(params as never[])) }; },
            async run() { stmt.run(...(params as never[])); return { success: true }; },
          };
        },
      };
    },
  };
  sqlite.exec(`
    INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('a', 'A', 'a@example.com', 0, 0), ('b', 'B', 'b@example.com', 0, 0);
    INSERT INTO agents (id, owner_user_id, name, created_at, updated_at) VALUES ('worker', 'a', 'Worker', 0, 0);
    INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at)
      VALUES ('installation', 1, 'org', 'Organization', 'a', 0, 0);
    INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at)
      VALUES ('project', 'installation', 'org/repo', 1, 0, 0);
    INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, html_url, created_at, updated_at)
      VALUES ('ticket', 'project', 1, 1, 'Work', 'https://github.com/org/repo/issues/1', 0, 0);
  `);
  const run = (id: string, account: string, status = 'running') => sqlite.exec(`INSERT INTO runs
    (id, ticket_id, agent_id, codex_account_id, requested_by_user_id, status, model_id, created_at)
    VALUES ('${id}', 'ticket', 'worker', '${account}', 'a', '${status}', 'codex-default', 0)`);
  return { sqlite, hook, run, db: drizzle(binding as unknown as D1Database, { schema }) };
}

function account(id: string, ownerUserId: string, extra: Partial<typeof schema.codexAccounts.$inferInsert> = {}) {
  const now = new Date();
  return { id, ownerUserId, label: id, status: "ready", createdAt: now, updatedAt: now, ...extra };
}

test("pool enforces private ownership and exhausted windows", async () => {
  const { db, sqlite } = database();
  await db.insert(schema.codexAccounts).values([
    account("foreign", "b"),
    account("limited", "a", { status: "limited", limitsJson: JSON.stringify({ primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } }) }),
    account("shared", "b", { shared: true, maxRuns: 2 }),
  ]);
  assert.deepEqual((await availableAccounts("a", db)).map((row) => [row.id, row.freeSlots]), [["shared", 2]]);
  assert.equal(await availableSlots("b", db), 5);
  sqlite.close();
});

test("one subscription runs several tickets at once, never beyond its limit", async () => {
  const { db, sqlite, run } = database();
  await db.insert(schema.codexAccounts).values([account("solo", "a", { maxRuns: 2 })]);
  const competing = await Promise.allSettled(["one", "two", "three"].map((id) => claimAccount("a", id, db)));
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(await availableSlots("a", db), 0);
  // The started runs keep their slots; a released claim frees one.
  const [first, second] = sqlite.prepare("SELECT holder_id FROM account_leases ORDER BY holder_id").all().map((row) => row.holder_id as string);
  run(first, "solo");
  run(second, "solo");
  await assert.rejects(claimAccount("a", "four", db), /No available/);
  sqlite.exec(`UPDATE runs SET status = 'succeeded' WHERE id = '${first}'`);
  await releaseAccount("solo", first, db);
  assert.equal((await claimAccount("a", "four", db)).id, "solo");
  await setAccountMaxRuns("solo", "a", 3, db);
  assert.equal(await availableSlots("a", db), 1);
  await assert.rejects(setAccountMaxRuns("solo", "a", 6, db), /between 1 and 5/);
  await assert.rejects(setAccountMaxRuns("solo", "b", 2, db), /not found/);
  sqlite.close();
});

test("work spreads across subscriptions before doubling up", async () => {
  const { db, sqlite } = database();
  await db.insert(schema.codexAccounts).values([account("x", "a"), account("y", "a")]);
  const picked = [];
  for (const id of ["r1", "r2", "r3", "r4"]) picked.push((await claimAccount("a", id, db)).id);
  assert.deepEqual(picked.slice(0, 2).sort(), ["x", "y"]);
  assert.deepEqual(picked.slice(2).sort(), ["x", "y"]);
  sqlite.close();
});

test("disabling and maintenance stop new claims; abandoned claims expire", async () => {
  const { db, sqlite, hook } = database();
  await db.insert(schema.codexAccounts).values([account("shared", "b", { shared: true, maxRuns: 2 })]);
  await setAccountEnabled("shared", "a", false, db);
  await assert.rejects(claimAccount("a", "disabled-run", db), /No available/);
  await setAccountEnabled("shared", "a", true, db);
  // Disable after candidate selection but before the atomic claim.
  hook.afterSelect = () => sqlite.exec("UPDATE codex_accounts SET enabled = 0 WHERE id = 'shared'");
  await assert.rejects(claimAccount("a", "racing-run", db), /No available/);
  await setAccountEnabled("shared", "b", true, db);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = 'maintenance' WHERE id = 'shared'");
  await assert.rejects(claimAccount("a", "during-maintenance", db), /No available/);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared'");
  // A claim whose run never started stops counting after ten minutes.
  sqlite.exec("INSERT INTO account_leases (holder_id, account_id, created_at) VALUES ('fresh', 'shared', unixepoch()), ('stale', 'shared', unixepoch() - 3600)");
  assert.equal(await availableSlots("a", db), 1);
  assert.equal(await accountBusy("shared", db), true);
  sqlite.exec("DELETE FROM account_leases WHERE holder_id = 'fresh'");
  assert.equal(await accountBusy("shared", db), false);
  sqlite.close();
});

test("paused runs keep their slot and resume only onto a usable subscription", async () => {
  const { db, sqlite, run } = database();
  await db.insert(schema.codexAccounts).values([account("shared", "b", { shared: true, maxRuns: 1 })]);
  // A paused run holds no lease but still owns the only slot.
  run("waiting", "shared");
  assert.deepEqual(await availableAccounts("a", db), []);
  await assert.rejects(claimAccount("a", "new-pickup", db), /No available/);
  assert.equal(await accountBusy("shared", db), false); // reconnect can proceed while paused
  assert.equal(await reserveRunAccount("shared", "a", "waiting", false, db), false); // renewal cannot acquire
  sqlite.exec("UPDATE codex_accounts SET active_run_id = 'maintenance' WHERE id = 'shared'");
  assert.equal(await reserveRunAccount("shared", "a", "waiting", true, db), false);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL, status = 'error' WHERE id = 'shared'");
  assert.equal(await reserveRunAccount("shared", "a", "waiting", true, db), false);
  sqlite.exec("UPDATE codex_accounts SET status = 'ready', shared = 0 WHERE id = 'shared'");
  assert.equal(await reserveRunAccount("shared", "a", "waiting", true, db), false); // sharing revoked
  sqlite.exec("UPDATE codex_accounts SET shared = 1 WHERE id = 'shared'");
  assert.equal(await reserveRunAccount("shared", "a", "waiting", true, db), true);
  assert.equal(await reserveRunAccount("shared", "a", "waiting", false, db), true); // renewal keeps its lease
  assert.equal(await accountBusy("shared", db), true);
  // Executing leases never exceed max_runs, even for runs already counted.
  run("other", "shared");
  assert.equal(await reserveRunAccount("shared", "a", "other", true, db), false);
  // A finished run's leftover lease no longer counts.
  sqlite.exec("UPDATE runs SET status = 'succeeded' WHERE id = 'waiting'");
  assert.equal(await reserveRunAccount("shared", "a", "other", true, db), true);
  sqlite.exec("UPDATE runs SET status = 'cancelled'");
  assert.equal((await claimAccount("a", "after-stop", db)).id, "shared");
  sqlite.close();
});

test("agents pinned to a provider only claim that provider's subscriptions", async () => {
  const { db, sqlite } = database();
  await db.insert(schema.codexAccounts).values([account("codex_one", "a"), account("claude_one", "a", { provider: "claude" })]);
  assert.equal((await claimAccount("a", "claude-run", db, "claude")).id, "claude_one");
  assert.equal((await claimAccount("a", "codex-run", db, "codex")).id, "codex_one");
  await setAccountEnabled("claude_one", "a", false, db);
  await assert.rejects(claimAccount("a", "claude-run-2", db, "claude"), /No available Claude subscription/);
  assert.equal((await claimAccount("a", "any-run", db)).id, "codex_one");
  sqlite.close();
});


test('expired maintenance locks release capacity without unlocking fresh operations or running jobs', async () => {
  const { db, sqlite, run } = database();
  try {
    const now = new Date();
    const expired = new Date(now.getTime() - 16 * 60_000);
    await db.insert(schema.codexAccounts).values([
      account('abandoned', 'a', { activeRunId: 'maintenance_abandoned', updatedAt: expired }),
      account('fresh', 'a', { activeRunId: 'maintenance_fresh', updatedAt: now }),
      account('probe', 'a', { activeRunId: 'run_probe', updatedAt: expired }),
      account('executing', 'a', { activeRunId: 'maintenance_old', updatedAt: expired }),
    ]);
    run('live', 'executing');
    await db.insert(schema.accountLeases).values({ holderId: 'live', accountId: 'executing', createdAt: now });
    await expireMaintenanceLocks(db, now);
    assert.equal(sqlite.prepare("SELECT active_run_id FROM codex_accounts WHERE id='abandoned'").get()?.active_run_id, null);
    for (const id of ['fresh', 'probe', 'executing']) assert.ok(sqlite.prepare('SELECT active_run_id FROM codex_accounts WHERE id=?').get(id)?.active_run_id);
    assert.deepEqual((await availableAccounts('a', db)).map(row => row.id), ['abandoned']);
  } finally { sqlite.close(); }
});


test('legacy executing runs can renew their own lock but cannot borrow another run lock', async () => {
  const { db, sqlite, run } = database();
  try {
    await db.insert(schema.codexAccounts).values(account('legacy', 'a', { activeRunId: 'old-run' }));
    run('old-run', 'legacy');
    assert.equal(await reserveRunAccount('legacy', 'a', 'old-run', false, db), true);
    assert.equal(await reserveRunAccount('legacy', 'b', 'old-run', true, db), false);
    assert.equal(await reserveRunAccount('legacy', 'a', 'other-run', true, db), false);
    assert.equal(sqlite.prepare("SELECT active_run_id FROM codex_accounts WHERE id='legacy'").get()?.active_run_id, 'old-run');
    sqlite.exec("UPDATE runs SET status='succeeded' WHERE id='old-run'");
    assert.equal(await reserveRunAccount('legacy', 'a', 'old-run', true, db), false);
  } finally { sqlite.close(); }
});
