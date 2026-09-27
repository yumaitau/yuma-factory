import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { claimAutomation, automationCandidates, ensureAutomationAgents } from '../lib/automation-state';
import * as schema from '../db/schema';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  sqlite.exec(`
    INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('user', 'User', 'user@example.com', 0, 0);
    INSERT INTO agents (id, owner_user_id, name, created_at, updated_at) VALUES ('worker', 'user', 'Worker', 0, 0), ('other', 'user', 'Other', 0, 0);
    INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at)
      VALUES ('installation', 1, 'org', 'Organization', 'user', 0, 0);
  `);
  const binding = {
    prepare(query: string) {
      return { bind(...params: unknown[]) {
        const statement = sqlite.prepare(query);
        return {
          async raw() { statement.setReturnArrays(true); return statement.all(...params as never[]); },
          async all() { return { results: statement.all(...params as never[]) }; },
          async run() { statement.run(...params as never[]); return { success: true }; },
        };
      } };
    },
  };
  return { db: drizzle(binding as unknown as D1Database, { schema }), sqlite };
}

test('scheduler leases exclude overlapping checks, respect pause, and recover expired work', async () => {
  const { db, sqlite } = database();
  try {
    const now = new Date('2026-09-18T02:00:00Z');
    await db.insert(schema.automation).values({ id: 'github', enabled: true, userId: 'user', agentId: 'worker', updatedAt: now });
    const claims = await Promise.all([claimAutomation(db, 'one', now), claimAutomation(db, 'two', now)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await claimAutomation(db, 'three', new Date(now.getTime() + 60_000)), undefined);
    const recovered = await claimAutomation(db, 'recovered', new Date(now.getTime() + 11 * 60_000));
    assert.equal(recovered?.leaseId, 'recovered');
    await db.update(schema.automation).set({ enabled: false, leaseUntil: null }).where(eq(schema.automation.id, 'github'));
    assert.equal(await claimAutomation(db, 'paused', new Date(now.getTime() + 12 * 60_000)), undefined);
    // A previous process finishing late cannot overwrite the new owner's status.
    const stale = await db.update(schema.automation).set({ summary: 'stale' })
      .where(eq(schema.automation.leaseId, 'one')).returning();
    assert.equal(stale.length, 0);
  } finally { sqlite.close(); }
});

test('automation provisions ten unique agents, preserves the working agent and scales safely to twenty', async () => {
  const { db, sqlite } = database();
  try {
    await db.update(schema.agents).set({ status: 'working' }).where(eq(schema.agents.id, 'worker'));
    const settings = { userId: 'user', agentId: 'worker', targetAgents: 10 };
    const first = await ensureAutomationAgents(db, settings);
    assert.equal(first.length, 10);
    assert.equal(first[0].id, 'worker');
    assert.equal(first[0].status, 'working');
    await Promise.all([ensureAutomationAgents(db, settings), ensureAutomationAgents(db, settings)]);
    assert.equal((await ensureAutomationAgents(db, settings)).length, 10);
    assert.equal((await ensureAutomationAgents(db, { ...settings, targetAgents: 20 })).length, 20);
    assert.equal((await ensureAutomationAgents(db, settings)).length, 10);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM agents WHERE automation_slot IS NOT NULL').get()?.n, 20);
    await assert.rejects(ensureAutomationAgents(db, { ...settings, targetAgents: 100 }), /10 and 20/);
  } finally { sqlite.close(); }
});

test('automatic pickup requires exact label, open active board, free assignment and no previous attempt', async () => {
  const { db, sqlite } = database();
  try {
    const now = new Date();
    await db.insert(schema.projects).values([
      { id: 'active', installationId: 'installation', repoFullName: 'org/repo', repoId: 1, createdAt: now, updatedAt: now },
      { id: 'archived', installationId: 'installation', repoFullName: 'org/archive', repoId: 2, status: 'archived', createdAt: now, updatedAt: now },
    ]);
    const cases = [
      { id: 'eligible', labels: '["factory:ready"]' },
      { id: 'case', labels: '["factory:READY"]', stage: 'assigned', assignedAgentId: 'worker' },
      { id: 'unlabelled', labels: '[]' },
      { id: 'substring', labels: '["not-factory:ready"]' },
      { id: 'invalid-json', labels: '{broken' },
      { id: 'closed', labels: '["factory:ready"]', githubState: 'closed' },
      { id: 'review', labels: '["factory:ready"]', stage: 'review' },
      { id: 'working', labels: '["factory:ready"]', stage: 'in_progress' },
      { id: 'other-agent', labels: '["factory:ready"]', assignedAgentId: 'other' },
      { id: 'archived', labels: '["factory:ready"]', projectId: 'archived' },
      { id: 'failed', labels: '["factory:ready"]' },
      { id: 'succeeded', labels: '["factory:ready"]' },
    ];
    for (const [index, item] of cases.entries()) {
      await db.insert(schema.tickets).values({ projectId: 'active', githubIssueId: index + 1,
        githubIssueNumber: index + 1, title: item.id, htmlUrl: 'https://github.com/org/repo/issues/1',
        createdAt: now, updatedAt: now, ...item });
    }
    for (const status of ['failed', 'succeeded']) await db.insert(schema.runs).values({
      id: `run-${status}`, ticketId: status, agentId: 'worker', modelId: 'codex-default', status, createdAt: now,
    });
    const result = await automationCandidates(db, 'worker', 'factory:ready');
    assert.deepEqual(result.map((row) => row.ticket.id).sort(), ['case', 'eligible']);
  } finally { sqlite.close(); }
});
