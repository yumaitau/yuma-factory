import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER_SECRET, factoryApp, hexId, post, webhook, type FactoryApp } from './support/app';
import { automationCandidates } from '../lib/automation-state';
import { workBoardCards } from '../lib/work-board-query';
import { workLane } from '../lib/work-board';

const RUN = hexId('run', '1');
const issue = (state: string, labels: string[] = ['factory:ready']) => ({ id: 1, number: 1, title: 'Work', body: 'Text', state,
  html_url: 'https://github.com/org/repo/issues/1', labels: labels.map((name) => ({ name })), user: { type: 'User', login: 'someone' } });
const deliver = async (action: string, state: string, labels?: string[]) => {
  const { POST } = await import('../app/api/github/webhook/route');
  return POST(webhook('issues', { action, issue: issue(state, labels), repository: { id: 1 } }));
};
/** Ticket #1 as Factory leaves it after a merged pull request: done, closed, with its finished run. */
function finished(app: FactoryApp, assigned: string | null = 'worker') {
  app.sqlite.exec(`
    INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, pull_request_state, created_at, finished_at)
      VALUES ('${RUN}', 'ticket', 'worker', 'succeeded', 'codex-default', 'https://github.com/org/repo/pull/10', 'merged', unixepoch() - 600, unixepoch() - 300);
    UPDATE tickets SET stage = 'done', github_state = 'closed', labels = '["factory:done"]', assigned_agent_id = ${assigned ? `'${assigned}'` : 'NULL'} WHERE id = 'ticket';
    UPDATE agents SET automation_slot = 1 WHERE id = 'worker';
  `);
}
const card = async () => (await workBoardCards()).find((item) => item.id === 'ticket')!;

test('an issue reopened on GitHub leaves Integrated and can be picked up again', async () => {
  const app = factoryApp();
  try {
    finished(app);
    assert.equal(workLane(await card()), 'done');
    assert.equal((await deliver('reopened', 'open')).status, 200);
    const ticket = app.row("SELECT stage, github_state AS state, requeued_at AS requeuedAt FROM tickets WHERE id = 'ticket'");
    assert.deepEqual([ticket?.stage, ticket?.state], ['assigned', 'open']);
    // The finished run no longer decides the lane or blocks a new attempt.
    assert.ok(Number(ticket?.requeuedAt) > Number(app.row('SELECT created_at AS at FROM runs')?.at));
    const reopened = await card();
    assert.deepEqual([workLane(reopened), reopened.runStatus, reopened.pullRequestUrl], ['queued', null, null]);
    assert.deepEqual((await automationCandidates(app.db, 'worker', 'factory:ready')).map((row) => [row.ticket.id, row.retryOf]), [['second', null], ['ticket', null]]);
  } finally { app.close(); }
});

test('an unassigned reopened issue returns to Needs preparation until it is labelled again', async () => {
  const app = factoryApp();
  try {
    finished(app, null);
    await deliver('reopened', 'open', ['factory:done']);
    assert.equal(app.row("SELECT stage FROM tickets WHERE id = 'ticket'")?.stage, 'intake');
    assert.equal(workLane(await card()), 'intake');
    assert.deepEqual(app.queued, []);
  } finally { app.close(); }
});

test('other issue events never move a ticket between stages', async () => {
  const app = factoryApp();
  try {
    finished(app);
    // Still closed: an edit or a label on a finished issue changes nothing.
    await deliver('edited', 'closed');
    assert.deepEqual(app.row("SELECT stage, requeued_at AS requeuedAt FROM tickets WHERE id = 'ticket'"), { stage: 'done', requeuedAt: null });
    // An open ticket in review stays in review, and its run still counts.
    app.sqlite.exec("UPDATE tickets SET stage = 'review', github_state = 'open' WHERE id = 'ticket'");
    await deliver('edited', 'open');
    assert.deepEqual(app.row("SELECT stage, requeued_at AS requeuedAt FROM tickets WHERE id = 'ticket'"), { stage: 'review', requeuedAt: null });
    // Closing an issue by hand keeps the stage; the board already shows closed issues as Integrated.
    await deliver('closed', 'closed');
    assert.equal(app.row("SELECT stage FROM tickets WHERE id = 'ticket'")?.stage, 'review');
    assert.equal(workLane(await card()), 'done');
  } finally { app.close(); }
});

test('the scheduled sync also brings back an issue whose reopen the webhook missed', async () => {
  const app = factoryApp();
  try {
    finished(app);
    app.sqlite.exec(`
      INSERT INTO automation (id, enabled, user_id, agent_id, updated_at) VALUES ('github', 1, 'user', 'worker', 0);
      UPDATE tickets SET labels = '[]' WHERE id = 'second';
    `);
    app.github('GET /repos/org/repo/issues', [{ ...issue('open', ['factory:done']), pull_request: undefined }]);
    const { POST } = await import('../app/api/automation/tick/route');
    const response = await POST(post('/api/automation/tick', {}, { 'x-runner-secret': RUNNER_SECRET, 'x-automation-mode': 'sync' }));
    assert.equal(response.status, 200);
    assert.deepEqual(app.row("SELECT stage, github_state AS state FROM tickets WHERE id = 'ticket'"), { stage: 'assigned', state: 'open' });
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('the pull request sync does not close a reopened issue again over its old merged pull request', async () => {
  const app = factoryApp();
  try {
    finished(app);
    // The runner closed the issue itself, so the sync never recorded the pull request as merged.
    app.sqlite.exec(`UPDATE runs SET pull_request_state = NULL WHERE id = '${RUN}'`);
    await deliver('reopened', 'open');
    const { syncPullRequests } = await import('../lib/pull-request-sync');
    const routes: string[] = [];
    const client = { request: async (route: string) => {
      routes.push(route.split(' ')[0]);
      if (route.includes('/pulls/')) return { data: { merged: true, state: 'closed' } };
      return { data: { state: 'closed', labels: [] } };
    } };
    await syncPullRequests(app.db, async () => client as never, Date.now() + 60_000);
    // The old pull request is recorded as merged, and nothing is written to GitHub.
    assert.deepEqual(routes, ['GET']);
    assert.equal(app.row('SELECT pull_request_state AS state FROM runs')?.state, 'merged');
    assert.deepEqual(app.row("SELECT stage, github_state AS state FROM tickets WHERE id = 'ticket'"), { stage: 'assigned', state: 'open' });
  } finally { app.close(); }
});

test('an epic reopened after its plan was applied stays open while its subtasks are closed', async () => {
  const app = factoryApp();
  try {
    const { reconcileEpics } = await import('../lib/collab-store');
    app.github('PATCH /repos/org/repo/issues/1', { state: 'closed' });
    // Epic #1 with an applied plan and one closed subtask, finished and closed.
    app.sqlite.exec(`
      INSERT INTO plans (id, ticket_id, run_id, status, summary, tasks_json, decided_at, created_at)
        VALUES ('plan', 'ticket', 'plan-run', 'applied', 'One task', '[]', unixepoch() - 900, unixepoch() - 1000);
      UPDATE tickets SET parent_ticket_id = 'ticket', github_state = 'closed' WHERE id = 'second';
      UPDATE tickets SET stage = 'done', github_state = 'closed' WHERE id = 'ticket';
    `);
    assert.equal((await deliver('reopened', 'open', [])).status, 200);
    await reconcileEpics(app.db);
    assert.deepEqual(app.githubCalls().filter((call) => call.startsWith('PATCH')), []);
    const epic = app.row("SELECT stage, github_state AS state FROM tickets WHERE id = 'ticket'");
    assert.deepEqual([epic?.stage, epic?.state], ['intake', 'open']);
    // An epic never reopened still closes once its subtasks are closed.
    app.sqlite.exec("UPDATE tickets SET requeued_at = NULL WHERE id = 'ticket'");
    await reconcileEpics(app.db);
    assert.deepEqual(app.githubCalls().filter((call) => call.startsWith('PATCH')), ['PATCH /repos/org/repo/issues/1']);
  } finally { app.close(); }
});
