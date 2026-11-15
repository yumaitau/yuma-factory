import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factoryApp, hexId, type FactoryApp } from './support/app';
import { STATUS_LOG_TAIL, refreshRuns } from '../lib/agent/run';
import { moveWorkCard } from '../lib/factory-control';
import { singleFlight } from '../lib/poll';
import { workLane } from '../lib/work-board';
import { workBoardCards } from '../lib/work-board-query';

const RUN = hexId('run', '1');
const OUTCOME = 'No CI registered on the PR within 30 minutes. PR left open for review; subscription released.';

/** Counts the characters the database hands back, so a test can tell a narrow read from a whole-table one. */
function reads(app: FactoryApp) {
  type Bound = { raw(): Promise<unknown>; all(): Promise<unknown>; run(): Promise<unknown> };
  const client = app.db.$client as unknown as { prepare(query: string): { bind(...params: unknown[]): Bound } };
  const prepare = client.prepare.bind(client);
  let characters = 0;
  const count = async (rows: unknown) => { characters += JSON.stringify(rows).length; return rows; };
  client.prepare = (query) => {
    const statement = prepare(query);
    return { bind: (...params) => {
      const bound = statement.bind(...params);
      return { raw: async () => count(await bound.raw()), all: async () => count(await bound.all()), run: () => bound.run() };
    } };
  };
  return { characters: () => characters, reset: () => { characters = 0; } };
}

/** Ticket #1 with a long issue body and a finished run whose log is 90,000 characters. */
function bigRun(app: FactoryApp, status = 'succeeded', start = '') {
  app.sqlite.prepare("UPDATE tickets SET body = ?, stage = 'review' WHERE id = 'ticket'").run('b'.repeat(50_000));
  app.sqlite.prepare(`INSERT INTO runs (id, ticket_id, agent_id, status, model_id, requested_by_user_id, log, pull_request_url, created_at, finished_at)
    VALUES (?, 'ticket', 'worker', ?, 'codex-default', 'user', ?, 'https://github.com/org/repo/pull/10', 5, 6)`).run(RUN, status, `${start}${'x'.repeat(90_000)}\n${OUTCOME}\n`);
}

test('the board reads the end of each run log, not the log or the issue body', async () => {
  const app = factoryApp();
  try {
    bigRun(app);
    const read = reads(app);
    const cards = await workBoardCards();
    assert.ok(read.characters() < 20_000, `read ${read.characters()} characters`);
    const card = cards.find((item) => item.id === 'ticket')!;
    assert.deepEqual([card.runStatus, card.runOutcome, card.completionPending, card.pullRequestUrl], ['succeeded', OUTCOME, false, 'https://github.com/org/repo/pull/10']);
    // A ticket that never ran has no run fields.
    const idle = cards.find((item) => item.id === 'second')!;
    assert.deepEqual([idle.runId, idle.runStatus, idle.runOutcome, idle.sessionState], [null, null, null, null]);
    assert.equal(workLane(idle), 'queued');
  } finally { app.close(); }
});

test('a running run whose log starts with the completion note shows as validating', async () => {
  const app = factoryApp();
  try {
    bigRun(app, 'running', 'CI green; updating GitHub issue, merging low-risk PRs, and applying factory:done.');
    const card = (await workBoardCards()).find((item) => item.id === 'ticket')!;
    assert.deepEqual([card.completionPending, card.runOutcome], [true, null]);
  } finally { app.close(); }
});

test('moving one card reads that card, and only if the board shows it', async () => {
  const app = factoryApp();
  try {
    bigRun(app);
    // Thirty more tickets, each with its own long log.
    const ticket = app.sqlite.prepare("INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, html_url, labels, stage, created_at, updated_at) VALUES (?, 'project', ?, ?, 'Other', 'https://github.com/org/repo/issues/9', '[]', 'review', 0, 0)");
    const run = app.sqlite.prepare("INSERT INTO runs (id, ticket_id, agent_id, status, model_id, log, created_at) VALUES (?, ?, 'worker', 'succeeded', 'm', ?, 5)");
    for (let index = 0; index < 30; index++) {
      ticket.run(`extra-${index}`, 100 + index, 100 + index);
      run.run(`run-extra-${index}`, `extra-${index}`, 'y'.repeat(50_000));
    }
    app.github('DELETE /repos/org/repo/issues/2/labels/factory%3Aready', []);
    app.github('GET /repos/org/repo/issues/2', { labels: [] });
    const read = reads(app);
    // #2 waits in Queued; a person pulls it back to Needs preparation.
    await moveWorkCard('second', 'intake');
    assert.ok(read.characters() < 10_000, `read ${read.characters()} characters`);
    assert.equal(app.row("SELECT labels FROM tickets WHERE id = 'second'")?.labels, '[]');
    assert.deepEqual(app.unexpected, []);

    // A ticket whose pull request was closed has left the board, as has one in an archived project.
    app.sqlite.exec(`UPDATE runs SET pull_request_state = 'closed' WHERE id = '${RUN}'`);
    await assert.rejects(moveWorkCard('ticket', 'intake'), /no longer on the Work board/);
    app.sqlite.exec("UPDATE projects SET status = 'archived'");
    await assert.rejects(moveWorkCard('second', 'queued'), /no longer on the Work board/);
    // The issue panel still shows both.
    assert.equal((await workBoardCards('ticket')).length, 1);
    await assert.rejects(moveWorkCard('missing', 'intake'), /no longer on the Work board/);
  } finally { app.close(); }
});

test('the status poll returns the end of each log', async () => {
  const app = factoryApp();
  try {
    bigRun(app);
    const read = reads(app);
    const rows = await refreshRuns('user', 1_000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].log.length, STATUS_LOG_TAIL);
    assert.ok(rows[0].log.trimEnd().endsWith(OUTCOME));
    assert.ok(read.characters() < 10_000, `read ${read.characters()} characters`);
    // A short log is returned whole.
    app.sqlite.exec(`UPDATE runs SET log = 'Done.' WHERE id = '${RUN}'`);
    assert.equal((await refreshRuns('user', 1_000))[0].log, 'Done.');
    assert.deepEqual(app.calls, []);
  } finally { app.close(); }
});

test('a poll still in flight is not started again', async () => {
  let started = 0;
  let finish = () => {};
  const poll = singleFlight(async () => { started++; await new Promise<void>((resolve) => { finish = resolve; }); });
  const first = poll();
  assert.equal(await poll(), false);
  assert.equal(await poll(), false);
  assert.equal(started, 1);
  finish();
  assert.equal(await first, true);
  // Once it settles the next tick runs, and a failure does not jam it.
  const failing = singleFlight(async () => { started++; throw new Error('offline'); });
  await assert.rejects(failing(), /offline/);
  await assert.rejects(failing(), /offline/);
  assert.equal(started, 3);
});
