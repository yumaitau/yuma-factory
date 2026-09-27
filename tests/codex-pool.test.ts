import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { readFileSync, readdirSync } from "node:fs";
import { availableAccounts, claimAccount, setAccountEnabled, reserveRunAccount } from "../lib/codex/accounts";
import * as schema from "../db/schema";

test("pool enforces private ownership, exhausted windows and exclusive concurrent claims", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort())
    sqlite.exec(
      readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"),
    );
  let afterSelect: (() => void) | undefined;
  const binding = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async raw() {
              stmt.setReturnArrays(true);
              const rows = stmt.all(...(params as never[]));
              if (query.startsWith('select') && afterSelect) {
                const callback = afterSelect;
                afterSelect = undefined;
                callback();
              }
              return rows;
            },
            async all() {
              return { results: stmt.all(...(params as never[])) };
            },
            async run() {
              stmt.run(...(params as never[]));
              return { success: true };
            },
          };
        },
      };
    },
  };
  const db = drizzle(binding as unknown as D1Database, { schema });
  const now = new Date();
  await db.insert(schema.users).values([
    {
      id: "a",
      name: "A",
      email: "a@example.com",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b",
      name: "B",
      email: "b@example.com",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.codexAccounts).values([
    {
      id: "foreign",
      ownerUserId: "b",
      label: "Private",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "limited",
      ownerUserId: "a",
      label: "Exhausted",
      status: "limited",
      limitsJson: JSON.stringify({
        primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 },
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "shared",
      ownerUserId: "b",
      label: "Shared",
      status: "ready",
      shared: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const competing = await Promise.allSettled([
    claimAccount("a", "run-one", db),
    claimAccount("a", "run-two", db),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  const winner = competing.find((r) => r.status === "fulfilled");
  assert.equal(winner?.status === "fulfilled" && winner.value.id, "shared");
  await assert.rejects(claimAccount("a", "run-three", db), /No available/);
  assert.equal((await claimAccount("b", "run-four", db)).id, "foreign");

  // Disabling retains credentials, visibility and any already-running job.
  await assert.rejects(setAccountEnabled('foreign', 'a', false, db), /not found/);
  await setAccountEnabled('shared', 'a', false, db);
  const disabled = sqlite.prepare("SELECT enabled, active_run_id, status, shared FROM codex_accounts WHERE id = 'shared'").get();
  assert.equal(disabled?.enabled, 0);
  assert.ok(disabled?.active_run_id);
  assert.equal(disabled?.status, 'ready');
  assert.equal(disabled?.shared, 1);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared'");
  await assert.rejects(claimAccount('a', 'disabled-run', db), /No available/);
  await setAccountEnabled('shared', 'a', true, db);

  // Disable after candidate selection but before the atomic claim.
  afterSelect = () => sqlite.exec("UPDATE codex_accounts SET enabled = 0 WHERE id = 'shared'");
  await assert.rejects(claimAccount('a', 'racing-run', db), /No available/);
  await setAccountEnabled('shared', 'b', true, db);
  assert.equal((await claimAccount('a', 'reenabled-run', db)).id, 'shared');
  sqlite.exec("UPDATE codex_accounts SET shared = 0 WHERE id = 'shared'");
  await assert.rejects(setAccountEnabled('shared', 'a', false, db), /not found/);
  assert.equal(sqlite.prepare("SELECT enabled FROM codex_accounts WHERE id = 'shared'").get()?.enabled, 1);
  // Recovery may renew its own lock, but cannot steal another run or reconnect.
  assert.equal(await reserveRunAccount('shared', 'a', 'reenabled-run', false, db), true);
  assert.equal(await reserveRunAccount('shared', 'a', 'recovery', true, db), false);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared'");
  assert.equal(await reserveRunAccount('shared', 'a', 'recovery', true, db), false); // sharing revoked
  sqlite.exec("UPDATE codex_accounts SET shared = 1, status = 'error' WHERE id = 'shared'");
  assert.equal(await reserveRunAccount('shared', 'a', 'recovery', true, db), false);
  sqlite.exec("UPDATE codex_accounts SET status = 'ready', active_run_id = 'maintenance' WHERE id = 'shared'");
  assert.equal(await reserveRunAccount('shared', 'a', 'recovery', true, db), false);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared'");
  assert.equal(await reserveRunAccount('shared', 'a', 'recovery', false, db), false); // renewal cannot acquire
  const resumed = await Promise.all([
    reserveRunAccount('shared', 'a', 'recovery-one', true, db),
    reserveRunAccount('shared', 'a', 'recovery-two', true, db),
  ]);
  assert.equal(resumed.filter(Boolean).length, 1);

  // Released locks still belong to unfinished durable jobs. New pickups must
  // leave capacity available for recovery, including a selection/claim race.
  sqlite.exec(`
    INSERT INTO agents (id, owner_user_id, name, created_at, updated_at) VALUES ('worker', 'a', 'Worker', 0, 0);
    INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at)
      VALUES ('installation', 1, 'org', 'Organization', 'a', 0, 0);
    INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at)
      VALUES ('project', 'installation', 'org/repo', 1, 0, 0);
    INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, html_url, created_at, updated_at)
      VALUES ('ticket', 'project', 1, 1, 'Recover me', 'https://github.com/org/repo/issues/1', 0, 0);
    INSERT INTO runs (id, ticket_id, agent_id, codex_account_id, requested_by_user_id, status, model_id, created_at)
      VALUES ('waiting', 'ticket', 'worker', 'shared', 'a', 'running', 'codex-default', 0);
    UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared';
  `);
  assert.deepEqual(await availableAccounts('a', db), []);
  await assert.rejects(claimAccount('a', 'new-pickup', db), /No available/);
  assert.equal(await reserveRunAccount('shared', 'a', 'waiting', true, db), true);
  sqlite.exec("UPDATE codex_accounts SET active_run_id = NULL WHERE id = 'shared'; UPDATE runs SET status = 'succeeded' WHERE id = 'waiting'");
  assert.equal((await availableAccounts('a', db))[0]?.id, 'shared');
  afterSelect = () => sqlite.exec("UPDATE runs SET status = 'running' WHERE id = 'waiting'");
  await assert.rejects(claimAccount('a', 'racing-pickup', db), /No available/);
  sqlite.exec("UPDATE runs SET status = 'cancelled' WHERE id = 'waiting'");
  assert.equal((await claimAccount('a', 'after-stop', db)).id, 'shared');
  sqlite.close();
});
