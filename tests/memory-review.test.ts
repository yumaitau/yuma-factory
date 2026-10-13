import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { captureLearnings, memoriesForTicket, memorySourceTickets, setProjectMemorySettings, updateMemory } from '../lib/memory-store';
import { memoryContentKey } from '../lib/memory';
import { buildRunPrompt } from '../lib/run-prompt';
import { lifecycleDatabase } from './support/d1';

type Db = ReturnType<typeof lifecycleDatabase>['db'];
const lesson = 'Checkout totals are computed in lib/pricing.ts, never in the route handler.';
const learn = (db: Db, runId: string, content = lesson, projectId = 'project', ticketId = 'ticket') =>
  captureLearnings(db, { projectId, runId, ticketId, raw: [{ kind: 'gotcha', content }] });
const prompt = async (db: Db, projectId = 'project') => buildRunPrompt({
  mode: 'implement', issueNumber: 2, title: 'Fix checkout totals', body: null, agentPrompt: null,
  memoryBlock: (await memoriesForTicket(db, projectId, 'Fix checkout totals in pricing')).block,
});
const byContent = (db: Db, content = lesson) => db.select().from(schema.memories).where(eq(schema.memories.content, content)).get();
const events = (db: Db, memoryId: string) => db.select().from(schema.memoryEvents).where(eq(schema.memoryEvents.memoryId, memoryId)).all();

function secondProject(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES ('neighbour', 'installation', 'org/neighbour', 2, 0, 0);
    INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, html_url, created_at, updated_at)
      VALUES ('neighbour-ticket', 'neighbour', 1, 3, 'Neighbour', 'https://github.com/org/neighbour/issues/1', 0, 0);
  `);
}

test('by default a finished run suggests its lesson, and the next prompt leaves it out', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const project = await db.select().from(schema.projects).where(eq(schema.projects.id, 'project')).get();
    assert.equal(project?.activateLearnings, false);
    assert.equal(await learn(db, 'run-1'), 1);
    const memory = await byContent(db);
    assert.equal(memory?.status, 'suggested');
    assert.equal(memory?.sourceRunId, 'run-1');
    assert.equal(memory?.sourceTicketId, 'ticket');
    assert.doesNotMatch(await prompt(db), /lib\/pricing\.ts/);
    // The reviewer can open the run and the ticket that produced it.
    assert.deepEqual(await memorySourceTickets(db, [memory!.sourceTicketId!]),
      [{ id: 'ticket', number: 1, title: 'Work', url: 'https://github.com/org/repo/issues/1' }]);
    // Rediscovery by a later run reinforces it but does not activate it.
    await learn(db, 'run-2');
    assert.equal((await byContent(db))?.status, 'suggested');
  } finally { sqlite.close(); }
});

test('accepting a suggestion is audited and lets later prompts use it', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await learn(db, 'run-1');
    const memory = (await byContent(db))!;
    await updateMemory(db, memory.id, { status: 'active' }, 'user:user');
    assert.equal((await byContent(db))?.status, 'active');
    const accepted = (await events(db, memory.id)).find((event) => event.action === 'accepted');
    assert.equal(accepted?.actor, 'user:user');
    assert.deepEqual(JSON.parse(accepted!.before!), { status: 'suggested' });
    assert.deepEqual(JSON.parse(accepted!.after!), { status: 'active' });
    assert.match(await prompt(db), /\[gotcha\] Checkout totals are computed in lib\/pricing\.ts/);
  } finally { sqlite.close(); }
});

test('archiving a suggestion keeps it out of prompts', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await learn(db, 'run-1');
    const memory = (await byContent(db))!;
    await updateMemory(db, memory.id, { status: 'archived' }, 'user:user');
    assert.equal((await byContent(db))?.status, 'archived');
    assert.ok((await events(db, memory.id)).some((event) => event.action === 'dismissed'));
    assert.doesNotMatch(await prompt(db), /lib\/pricing\.ts/);
    // A later run rediscovering it does not bring it back.
    await learn(db, 'run-2');
    assert.equal((await byContent(db))?.status, 'archived');
    assert.doesNotMatch(await prompt(db), /lib\/pricing\.ts/);
  } finally { sqlite.close(); }
});

test('an opted-in project uses its own agent learnings at once, and only that project', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    secondProject(sqlite);
    await setProjectMemorySettings(db, 'project', { activateLearnings: true });
    await learn(db, 'run-1');
    const memory = await byContent(db);
    assert.equal(memory?.status, 'active');
    assert.equal(memory?.projectId, 'project');
    assert.match(await prompt(db), /lib\/pricing\.ts/);
    assert.doesNotMatch(await prompt(db, 'neighbour'), /lib\/pricing\.ts/);
    // The opt-in is per project: the neighbour still holds its lessons for review.
    const other = 'Neighbour deploys need the staging flag set before migrations run.';
    await learn(db, 'run-2', other, 'neighbour', 'neighbour-ticket');
    assert.equal((await byContent(db, other))?.status, 'suggested');
    assert.equal((await byContent(db, other))?.projectId, 'neighbour');
  } finally { sqlite.close(); }
});

test('two projects never receive each other\'s project memories', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    secondProject(sqlite);
    await setProjectMemorySettings(db, 'project', { activateLearnings: true });
    await setProjectMemorySettings(db, 'neighbour', { activateLearnings: true });
    const mine = 'Pricing changes need the checkout snapshot tests updated too.';
    const theirs = 'Checkout pricing in the neighbour repo is owned by the billing team.';
    await learn(db, 'run-1', mine);
    await learn(db, 'run-2', theirs, 'neighbour', 'neighbour-ticket');
    const own = (await memoriesForTicket(db, 'project', 'checkout pricing')).selected.map((memory) => memory.content);
    const neighbours = (await memoriesForTicket(db, 'neighbour', 'checkout pricing')).selected.map((memory) => memory.content);
    assert.deepEqual(own, [mine]);
    assert.deepEqual(neighbours, [theirs]);
  } finally { sqlite.close(); }
});

test('the migration leaves existing active agent memories active and every project opted out', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../drizzle/', import.meta.url);
    const files = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
    const apply = (name: string) => sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    const gate = files.findIndex((name) => name.startsWith('0017_'));
    assert.ok(gate > 0);
    files.slice(0, gate).forEach(apply);
    sqlite.exec(`
      INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('user', 'User', 'user@example.com', 0, 0);
      INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at)
        VALUES ('installation', 1, 'org', 'Organization', 'user', 0, 0);
      INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES ('project', 'installation', 'org/repo', 1, 0, 0);
      INSERT INTO memories (id, project_id, scope_key, content_key, kind, content, status, source, weight, created_at, updated_at)
        VALUES ('mem', 'project', 'project', 'key', 'gotcha', 'Learned before review existed.', 'active', 'agent', 20, 0, 0);
    `);
    assert.equal(sqlite.prepare("SELECT auto_learn FROM projects WHERE id = 'project'").get()?.auto_learn, 1);
    files.slice(gate).forEach(apply);
    assert.equal(sqlite.prepare("SELECT status FROM memories WHERE id = 'mem'").get()?.status, 'active');
    assert.equal(sqlite.prepare("SELECT activate_learnings FROM projects WHERE id = 'project'").get()?.activate_learnings, 0);
  } finally { sqlite.close(); }
});

test('an active agent memory stays active and in prompts when a run rediscovers it', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const now = new Date();
    await db.insert(schema.memories).values({
      id: 'mem-old', projectId: 'project', scopeKey: 'project', contentKey: memoryContentKey(lesson),
      kind: 'gotcha', content: lesson, status: 'active', source: 'agent', sourceRunId: 'run-0', weight: 20, createdAt: now, updatedAt: now,
    });
    await learn(db, 'run-1');
    assert.equal((await byContent(db))?.status, 'active');
    assert.match(await prompt(db), /lib\/pricing\.ts/);
  } finally { sqlite.close(); }
});
