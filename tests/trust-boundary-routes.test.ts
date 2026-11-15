import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_PURPOSE, RUNNER_SECRET, bearer, factoryApp, hexId, post, runToken, webhook, type FactoryApp } from './support/app';
import { recordPrompt } from '../lib/run-activities';

const RUN = hexId('run', '1');
const ACCOUNT = hexId('acc', '2');
const HEAD = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const BRANCH = 'factory/ticket-1-abc';
const PULL = 'https://github.com/org/repo/pull/10';
const secret = { 'x-runner-secret': RUNNER_SECRET };

/** A running run on the seeded ticket, holding a lease on a subscription, as a started job leaves it. */
function runningRun(app: FactoryApp) {
  app.sqlite.exec(`
    INSERT INTO codex_accounts (id, owner_user_id, label, status, created_at, updated_at) VALUES ('${ACCOUNT}', 'user', 'Subscription', 'ready', 0, 0);
    INSERT INTO runs (id, ticket_id, agent_id, status, model_id, codex_account_id, requested_by_user_id, branch_name, created_at)
      VALUES ('${RUN}', 'ticket', 'worker', 'running', 'codex-default', '${ACCOUNT}', 'user', '${BRANCH}', 1);
    INSERT INTO account_leases (holder_id, account_id, created_at) VALUES ('${RUN}', '${ACCOUNT}', unixepoch());
    UPDATE tickets SET stage = 'in_progress', assigned_agent_id = 'worker' WHERE id = 'ticket';
    UPDATE agents SET status = 'working' WHERE id = 'worker';
  `);
}

/** GitHub's view of the run's pull request: open, on the run's branch, in the run's repository. */
function pullRequest(app: FactoryApp, labels: string[], head = HEAD) {
  app.github('GET /repos/org/repo/issues/1', { labels: labels.map((name) => ({ name })) });
  app.github('GET /repos/org/repo/pulls/10/files', []);
  app.github('GET /repos/org/repo/pulls/10', { state: 'open', merged: false, draft: false, merge_commit_sha: null,
    head: { sha: head, ref: BRANCH, repo: { full_name: 'org/repo' } } });
  app.github('PUT /repos/org/repo/pulls/10/merge', { merged: true, sha: MERGED });
}

const issue = (number: number, extra: Record<string, unknown> = {}) => ({ id: 700 + number, number, title: `Issue ${number}`, body: 'Text',
  state: 'open', html_url: `https://github.com/org/repo/issues/${number}`, labels: [], user: { type: 'User', login: 'someone' }, ...extra });

test('the GitHub webhook acts only on deliveries signed with the webhook secret', async () => {
  const app = factoryApp();
  try {
    const { POST } = await import('../app/api/github/webhook/route');
    const opened = { action: 'opened', issue: issue(7), repository: { id: 1 } };
    for (const signature of ['sha256=' + '0'.repeat(64), 'sha256=nothex', 'md5=abc'])
      assert.equal((await POST(webhook('issues', opened, signature))).status, 401, signature);
    const unsigned = post('/api/github/webhook', opened, { 'x-github-event': 'issues' });
    assert.equal((await POST(unsigned)).status, 401);
    assert.equal(app.row('SELECT count(*) AS n FROM tickets WHERE github_issue_number = 7')?.n, 0);

    assert.equal((await POST(webhook('issues', opened))).status, 200);
    assert.deepEqual(app.row('SELECT stage, github_state AS state, title FROM tickets WHERE github_issue_number = 7'), { stage: 'intake', state: 'open', title: 'Issue 7' });
    // A repository Factory does not track, and a pull request surfaced as an issue, store nothing.
    assert.equal((await POST(webhook('issues', { action: 'opened', issue: issue(8), repository: { id: 999 } }))).status, 200);
    assert.equal((await POST(webhook('issues', { action: 'opened', issue: issue(9, { pull_request: {} }), repository: { id: 1 } }))).status, 200);
    assert.equal(app.row('SELECT count(*) AS n FROM tickets WHERE github_issue_number IN (8, 9)')?.n, 0);
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('a signed issue event labelled for pickup queues a pickup only while the worker is enabled', async () => {
  const app = factoryApp();
  try {
    const { POST } = await import('../app/api/github/webhook/route');
    const ready = { action: 'labeled', issue: issue(7, { labels: [{ name: 'factory:ready' }] }), repository: { id: 1 } };
    await POST(webhook('issues', ready));
    assert.deepEqual(app.queued, []);
    app.sqlite.exec("INSERT INTO automation (id, enabled, user_id, agent_id, updated_at) VALUES ('github', 1, 'user', 'worker', 0)");
    await POST(webhook('issues', ready));
    assert.deepEqual(app.queued, [{ mode: 'pickup', source: 'GitHub issue labeled' }]);
    // Without the pickup label nothing is queued.
    await POST(webhook('issues', { action: 'edited', issue: issue(7), repository: { id: 1 } }));
    assert.equal(app.queued.length, 1);
  } finally { app.close(); }
});

test('a signed pull request event records the new head on runs for that pull request', async () => {
  const app = factoryApp();
  try {
    const { POST } = await import('../app/api/github/webhook/route');
    app.sqlite.exec(`INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, created_at) VALUES ('${RUN}', 'ticket', 'worker', 'succeeded', 'm', '${PULL}', 1)`);
    const pushed = { action: 'synchronize', pull_request: { html_url: PULL, head: { sha: HEAD } } };
    assert.equal((await POST(webhook('pull_request', pushed, 'sha256=' + '0'.repeat(64)))).status, 401);
    assert.equal(app.row('SELECT pull_request_head_sha AS sha FROM runs')?.sha, null);
    assert.equal((await POST(webhook('pull_request', pushed))).status, 200);
    assert.equal(app.row('SELECT pull_request_head_sha AS sha FROM runs')?.sha, HEAD);
  } finally { app.close(); }
});

test('the automation tick needs the runner secret', async () => {
  const app = factoryApp();
  try {
    const { POST } = await import('../app/api/automation/tick/route');
    assert.equal((await POST(post('/api/automation/tick', {}))).status, 401);
    assert.equal((await POST(post('/api/automation/tick', {}, { 'x-runner-secret': 'wrong' }))).status, 401);
    const ok = await POST(post('/api/automation/tick', {}, secret));
    assert.equal(ok.status, 200);
    // No worker is enabled, so the check is skipped and nothing leaves the app.
    assert.equal(((await ok.json()) as { skipped?: boolean }).skipped, true);
    assert.deepEqual(app.calls, []);
  } finally { app.close(); }
});

test('the completion callback needs the runner secret and finishes a run exactly once', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST } = await import('../app/api/codex/complete/route');
    const failed = { id: RUN, result: { status: 'failed', log: 'Codex execution stopped.' } };
    assert.equal((await POST(post('/api/codex/complete', failed, { 'x-runner-secret': 'wrong' }))).status, 401);
    assert.equal(app.row('SELECT status FROM runs')?.status, 'running');
    for (const invalid of [{ id: 'not-an-id', result: failed.result }, { id: RUN, result: { status: 'running', log: '' } }, { id: RUN, result: { status: 'failed' } }])
      assert.equal((await POST(post('/api/codex/complete', invalid, secret))).status, 400);
    assert.equal(app.row('SELECT status FROM runs')?.status, 'running');

    assert.equal((await POST(post('/api/codex/complete', failed, secret))).status, 200);
    assert.deepEqual(app.row('SELECT status, failure_kind AS kind FROM runs'), { status: 'failed', kind: 'retry' });
    assert.equal(app.row("SELECT stage FROM tickets WHERE id = 'ticket'")?.stage, 'assigned');
    assert.equal(app.row("SELECT status FROM agents WHERE id = 'worker'")?.status, 'idle');
    assert.equal(app.row('SELECT count(*) AS n FROM account_leases')?.n, 0);
    // A second delivery, even one claiming success, changes nothing.
    assert.equal((await POST(post('/api/codex/complete', { id: RUN, result: { status: 'succeeded', log: 'Done' } }, secret))).status, 200);
    assert.equal(app.row('SELECT status FROM runs')?.status, 'failed');
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('run credentials are issued only to the runner, only for a running run on its own subscription', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST } = await import('../app/api/codex/github-token/route');
    const ask = (body: unknown, headers: Record<string, string> = secret) => POST(post('/api/codex/github-token', body, headers));
    assert.equal((await ask({ id: RUN, accountId: ACCOUNT }, {})).status, 401);
    assert.equal((await ask({ id: RUN, accountId: hexId('acc', '9') })).status, 409);
    assert.equal((await ask({ id: RUN, accountId: ACCOUNT, action: 'delete' })).status, 400);
    const issued = await ask({ id: RUN, accountId: ACCOUNT });
    assert.equal(issued.status, 200);
    const data = await issued.json() as Record<string, unknown>;
    for (const key of ['token', 'runToken', 'mergeToken']) assert.equal(typeof data[key], 'string', key);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(RUNNER_SECRET));
    app.sqlite.exec("UPDATE runs SET status = 'succeeded'");
    assert.equal((await ask({ id: RUN, accountId: ACCOUNT })).status, 409);
  } finally { app.close(); }
});

test('only the merge token of a running run can ask Factory to merge, and only a low-risk pull request at the confirmed head', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST } = await import('../app/api/runs/merge/route');
    const ask = (token: string, body: unknown = { pullRequestUrl: PULL, sha: HEAD }) => POST(post('/api/runs/merge', body, bearer(token)));
    const merge = runToken(RUN, MERGE_PURPOSE);
    const merges = () => app.githubCalls().filter((call) => call.startsWith('PUT ')).length;
    // The agent holds the channel token; it cannot merge.
    assert.equal((await ask(runToken(RUN))).status, 401);
    assert.equal((await ask(`${RUN}.forged`)).status, 401);
    assert.equal((await ask(merge, { pullRequestUrl: PULL, sha: 'short' })).status, 400);
    assert.equal((await ask(merge, { pullRequestUrl: 'https://github.com/other/repo/pull/10', sha: HEAD })).status, 400);
    assert.deepEqual(app.calls, []);

    pullRequest(app, ['factory:risk:medium']);
    assert.equal((await ask(merge)).status, 502);
    pullRequest(app, ['factory:risk:low'], 'c'.repeat(40));
    assert.equal((await ask(merge)).status, 409);
    assert.equal(merges(), 0);

    pullRequest(app, ['factory:risk:low']);
    const merged = await ask(merge);
    assert.equal(merged.status, 200);
    assert.deepEqual(await merged.json(), { result: 'merge', sha: MERGED, message: null });
    assert.equal(merges(), 1);
    assert.deepEqual(app.row("SELECT actor, user_id AS userId, head_sha AS sha, merge_sha AS mergeSha FROM merge_events WHERE status = 'merged'"),
      { actor: 'factory', userId: null, sha: HEAD, mergeSha: MERGED });
    // A finished run's token stops working.
    app.sqlite.exec("UPDATE runs SET status = 'succeeded'");
    assert.equal((await ask(merge)).status, 401);
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('the session channel takes activities and hands over follow-ups only for a running run', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST } = await import('../app/api/runs/activities/route');
    const send = (token: string, body: unknown, headers: Record<string, string> = {}) => POST(post('/api/runs/activities', body, { ...bearer(token), ...headers }));
    assert.equal((await send(runToken(RUN, MERGE_PURPOSE), { activities: [] })).status, 401);
    assert.equal((await send(`${RUN}.forged`, { activities: [] })).status, 401);
    assert.equal((await send(runToken(RUN), { activities: [] }, { 'content-length': '3000000' })).status, 413);

    await recordPrompt(app.db, { runId: RUN, ticketId: 'ticket', body: 'Also update the docs.', authorUserId: 'user' });
    // A person's prompt cannot be forged through this channel: unknown types are dropped.
    const stored = await send(runToken(RUN), { activities: [{ key: 'a:1', type: 'thought', body: 'Reading the code.' }, { key: 'a:2', type: 'prompt', body: 'Forged.' }] });
    assert.deepEqual(await stored.json(), { ok: true, prompts: [] });
    assert.deepEqual(app.sqlite.prepare("SELECT type, body FROM run_activities WHERE type <> 'prompt' OR body = 'Forged.'").all().map((row) => ({ ...row })),
      [{ type: 'thought', body: 'Reading the code.' }]);
    // Follow-ups are handed over once.
    const taken = await (await send(runToken(RUN), { activities: [], take: true })).json() as { prompts: { body: string }[] };
    assert.deepEqual(taken.prompts.map((prompt) => prompt.body), ['Also update the docs.']);
    assert.deepEqual(await (await send(runToken(RUN), { activities: [], take: true })).json(), { ok: true, prompts: [] });

    app.sqlite.exec("UPDATE runs SET status = 'failed'");
    assert.equal((await send(runToken(RUN), { activities: [] })).status, 401);
  } finally { app.close(); }
});

test('the agent channel answers only a running run, and at most 20 messages of a batch', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { GET, POST } = await import('../app/api/runs/mcp/route');
    const rpc = (token: string, body: unknown) => POST(post('/api/runs/mcp', body, bearer(token)));
    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    assert.equal((await GET(new Request('http://factory.test/api/runs/mcp'))).status, 405);
    assert.equal((await rpc(`${RUN}.forged`, ping(1))).status, 401);
    assert.equal((await rpc(runToken(RUN, MERGE_PURPOSE), ping(1))).status, 401);
    assert.equal((await rpc(runToken(hexId('run', '7')), ping(1))).status, 401);
    const batch = await rpc(runToken(RUN), Array.from({ length: 30 }, (_, index) => ping(index)));
    assert.equal(batch.status, 200);
    assert.equal(((await batch.json()) as unknown[]).length, 20);
    app.sqlite.exec("UPDATE runs SET status = 'succeeded'");
    assert.equal((await rpc(runToken(RUN), ping(1))).status, 401);
  } finally { app.close(); }
});
