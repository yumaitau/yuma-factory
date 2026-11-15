import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_PURPOSE, RUNNER_SECRET, bearer, factoryApp, hexId, post, runToken, type FactoryApp } from './support/app';
import { recordPrompt } from '../lib/run-activities';
import { runOwnsPull } from '../lib/review-merge';
import { mintAgentToken, mintMergeToken, mintRunToken, runIdFromAgentToken, runIdFromMergeToken, runIdFromToken } from '../lib/run-token';

const RUN = hexId('run', '1');
const ACCOUNT = hexId('acc', '2');
const HEAD = 'a'.repeat(40);
const BRANCH = 'factory/ticket-1-abc';
const AGENT_PURPOSE = 'factory-run-agent:v1:';

function runningRun(app: FactoryApp) {
  app.sqlite.exec(`
    INSERT INTO codex_accounts (id, owner_user_id, label, status, created_at, updated_at) VALUES ('${ACCOUNT}', 'user', 'Subscription', 'ready', 0, 0);
    INSERT INTO runs (id, ticket_id, agent_id, status, model_id, codex_account_id, requested_by_user_id, branch_name, created_at)
      VALUES ('${RUN}', 'ticket', 'worker', 'running', 'codex-default', '${ACCOUNT}', 'user', '${BRANCH}', 1);
    INSERT INTO account_leases (holder_id, account_id, created_at) VALUES ('${RUN}', '${ACCOUNT}', unixepoch());
  `);
}
/** A low-risk pull request in the run's repository whose head is `ref`, on `repo`. */
function pullRequest(app: FactoryApp, number: number, ref: string, repo = 'org/repo') {
  app.github('GET /repos/org/repo/issues/1', { labels: [{ name: 'factory:risk:low' }] });
  app.github(`GET /repos/org/repo/pulls/${number}/files`, []);
  app.github(`GET /repos/org/repo/pulls/${number}`, { state: 'open', merged: false, draft: false, merge_commit_sha: null, head: { sha: HEAD, ref, repo: { full_name: repo } } });
  app.github(`PUT /repos/org/repo/pulls/${number}/merge`, { merged: true, sha: 'b'.repeat(40) });
}

test('each run token opens one door: the agent token reaches the agent tools and nothing else', () => {
  const [channel, merge, agent] = [mintRunToken(RUN, RUNNER_SECRET), mintMergeToken(RUN, RUNNER_SECRET), mintAgentToken(RUN, RUNNER_SECRET)];
  assert.equal(new Set([channel, merge, agent]).size, 3);
  assert.equal(agent, runToken(RUN, AGENT_PURPOSE));
  assert.deepEqual([runIdFromToken(channel, RUNNER_SECRET), runIdFromToken(agent, RUNNER_SECRET), runIdFromToken(merge, RUNNER_SECRET)], [RUN, null, null]);
  assert.deepEqual([runIdFromMergeToken(merge, RUNNER_SECRET), runIdFromMergeToken(agent, RUNNER_SECRET), runIdFromMergeToken(channel, RUNNER_SECRET)], [RUN, null, null]);
  // The agent tools also take the bridge's channel token, for jobs started before agent tokens existed.
  assert.deepEqual([runIdFromAgentToken(agent, RUNNER_SECRET), runIdFromAgentToken(channel, RUNNER_SECRET), runIdFromAgentToken(merge, RUNNER_SECRET)], [RUN, RUN, null]);
  assert.equal(runIdFromAgentToken(agent, 'another-secret'), null);
});

test('the runner is issued an agent token, and the agent token cannot write the session or take follow-ups', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST: issue } = await import('../app/api/codex/github-token/route');
    const issued = await (await issue(post('/api/codex/github-token', { id: RUN, accountId: ACCOUNT }, { 'x-runner-secret': RUNNER_SECRET }))).json() as Record<string, string>;
    assert.equal(issued.agentToken, runToken(RUN, AGENT_PURPOSE));
    assert.equal(issued.runToken, runToken(RUN));

    const { POST: activities } = await import('../app/api/runs/activities/route');
    await recordPrompt(app.db, { runId: RUN, ticketId: 'ticket', body: 'Also update the docs.', authorUserId: 'user' });
    const forged = await activities(post('/api/runs/activities', { activities: [{ key: 'x:1', type: 'response', body: 'All done.' }], take: true }, bearer(issued.agentToken)));
    assert.equal(forged.status, 401);
    assert.equal(app.row("SELECT count(*) AS n FROM run_activities WHERE type <> 'prompt'")?.n, 0);
    assert.equal(app.row("SELECT delivered_at AS at FROM run_activities WHERE type = 'prompt'")?.at, null);
    // The bridge's token still works, and the follow-up reaches the bridge.
    const taken = await (await activities(post('/api/runs/activities', { activities: [], take: true }, bearer(issued.runToken)))).json() as { prompts: { body: string }[] };
    assert.deepEqual(taken.prompts.map((prompt) => prompt.body), ['Also update the docs.']);

    const { POST: tools } = await import('../app/api/runs/mcp/route');
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal((await tools(post('/api/runs/mcp', list, bearer(issued.agentToken)))).status, 200);
    assert.equal((await tools(post('/api/runs/mcp', list, bearer(issued.runToken)))).status, 200);
    assert.equal((await tools(post('/api/runs/mcp', list, bearer(issued.mergeToken)))).status, 401);
    const { POST: merge } = await import('../app/api/runs/merge/route');
    assert.equal((await merge(post('/api/runs/merge', { pullRequestUrl: 'https://github.com/org/repo/pull/10', sha: HEAD }, bearer(issued.agentToken)))).status, 401);
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('a run can merge only a pull request it published', async () => {
  const app = factoryApp();
  try {
    runningRun(app);
    const { POST } = await import('../app/api/runs/merge/route');
    const ask = (number: number) => POST(post('/api/runs/merge', { pullRequestUrl: `https://github.com/org/repo/pull/${number}`, sha: HEAD }, bearer(runToken(RUN, MERGE_PURPOSE))));
    const merges = () => app.githubCalls().filter((call) => call.startsWith('PUT ')).length;
    // Another ticket's pull request, a look-alike branch and a fork with the same branch name are refused.
    pullRequest(app, 11, 'factory/ticket-2-def');
    pullRequest(app, 12, `${BRANCH}-extra`);
    pullRequest(app, 13, `${BRANCH}-main-x`);
    pullRequest(app, 14, BRANCH, 'someone/repo');
    for (const number of [11, 12, 13, 14]) {
      const refused = await ask(number);
      assert.equal(refused.status, 400, `pull ${number}`);
      assert.deepEqual(await refused.json(), { error: 'Pull request does not belong to this run.' });
    }
    assert.equal(merges(), 0);
    assert.equal(app.row('SELECT count(*) AS n FROM merge_events')?.n, 0);
    // Its own pull request, and the repair pull request it opened after a merge, are merged.
    pullRequest(app, 10, BRANCH);
    pullRequest(app, 15, `${BRANCH}-main-2`);
    assert.equal((await ask(10)).status, 200);
    assert.equal((await ask(15)).status, 200);
    assert.equal(merges(), 2);
    // A run with no recorded branch owns nothing.
    app.sqlite.exec('UPDATE runs SET branch_name = NULL');
    pullRequest(app, 16, BRANCH);
    assert.equal((await ask(16)).status, 400);
    assert.deepEqual(app.unexpected, []);
  } finally { app.close(); }
});

test('pull request ownership is decided by branch and repository', () => {
  const head = (ref: string, repo = 'org/repo') => ({ ref, repo: { full_name: repo } });
  assert.equal(runOwnsPull(BRANCH, 'org/repo', head(BRANCH)), true);
  assert.equal(runOwnsPull(BRANCH, 'Org/Repo', head(BRANCH)), true);
  assert.equal(runOwnsPull(BRANCH, 'org/repo', head(`${BRANCH}-main-12`)), true);
  for (const other of [head(`${BRANCH}-main-`), head(`${BRANCH}-main-1a`), head(`x${BRANCH}`), head(BRANCH, 'fork/repo'), { ref: BRANCH, repo: null }, null, undefined])
    assert.equal(runOwnsPull(BRANCH, 'org/repo', other), false, JSON.stringify(other));
  assert.equal(runOwnsPull(null, 'org/repo', head(BRANCH)), false);
  assert.equal(runOwnsPull('', 'org/repo', head('')), false);
});
