import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptReview, factoryMerge, mergeOnce, mergeReview, reviewContext, reviewState } from '../lib/review-merge';
import { observePullHead } from '../lib/review-evidence-store';
import { deployControl, mergeDecision } from '../lib/review-actions';
import { lifecycleDatabase } from './support/d1';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const MERGED = 'm'.repeat(40);
const URL = 'https://github.com/org/repo/pull/10';
const fast = { wait: () => new Promise((resolve) => setTimeout(resolve, 2)) };

/** A GitHub pull request whose head, labels and merge latency the test controls. */
function github(options: { labels?: string[]; mergeable?: string; delay?: number; files?: { filename: string; patch?: string }[] } = {}) {
  const pr = { head: A, merged: false, mergeSha: null as string | null };
  const calls: string[] = [];
  const client = { request: async (route: string, params: { sha?: string }) => {
    calls.push(route.split(' ')[0]);
    if (route.startsWith('PUT') && route.endsWith('/merge')) {
      await new Promise((resolve) => setTimeout(resolve, options.delay ?? 0));
      if (params.sha !== pr.head) throw { status: 409 };
      Object.assign(pr, { merged: true, mergeSha: MERGED });
      return { data: { merged: true, sha: MERGED } };
    }
    if (route.endsWith('/files')) return { data: options.files ?? [] };
    if (route.includes('/pulls/{pull_number}')) return { data: { state: pr.merged ? 'closed' : 'open', merged: pr.merged, draft: false,
      head: { sha: pr.head }, mergeable_state: options.mergeable ?? 'clean', merge_commit_sha: pr.mergeSha } };
    if (route.includes('/issues/{issue_number}')) return { data: { labels: (options.labels ?? []).map((name) => ({ name })) } };
    throw new Error(`unexpected ${route}`);
  } } as never;
  return { pr, calls, client, merges: () => calls.filter((verb) => verb === 'PUT').length };
}

function database(labels: string[] = [], deploymentTarget: string | null = null) {
  const { db, sqlite } = lifecycleDatabase();
  sqlite.exec(`
    INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@example.com', 0, 0);
    INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, created_at) VALUES ('run', 'ticket', 'worker', 'succeeded', 'm', '${URL}', 1);
  `);
  sqlite.prepare("UPDATE tickets SET labels = ? WHERE id = 'ticket'").run(JSON.stringify(labels));
  sqlite.prepare("UPDATE projects SET deployment_target = ? WHERE id = 'project'").run(deploymentTarget);
  const count = (table: string) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
  return { db, sqlite, count, context: async () => (await reviewContext(db, 'run'))! };
}

test('accepting SHA A records the user, the head and the time, and does not merge', async () => {
  const { db, sqlite, count, context } = database();
  try {
    const gh = github();
    const acceptance = await acceptReview(db, gh.client, await context(), 'user', A);
    assert.equal(acceptance.headSha, A);
    assert.equal(acceptance.userId, 'user');
    assert.ok(acceptance.createdAt instanceof Date);
    assert.equal(gh.merges(), 0);
    assert.equal(count('merge_events'), 0);
    // A reviewer who saw an older head cannot accept the new one by mistake.
    gh.pr.head = B;
    await assert.rejects(acceptReview(db, gh.client, await context(), 'other', A), /head is now bbbbbbb; you reviewed aaaaaaa/);
  } finally { sqlite.close(); }
});

test('merge is refused when the head is no longer SHA A; the push supersedes the acceptance and keeps it in history', async () => {
  const { db, sqlite, count, context } = database();
  try {
    const gh = github();
    await acceptReview(db, gh.client, await context(), 'user', A);
    gh.pr.head = B;
    await observePullHead(db, URL, B);
    assert.deepEqual({ ...sqlite.prepare('SELECT status, head_sha AS sha FROM review_acceptances').get() }, { status: 'superseded', sha: A });
    await assert.rejects(mergeReview(db, gh.client, await context(), 'user', fast), /Accept the review of bbbbbbb/);
    assert.equal(gh.merges(), 0);
    const state = await reviewState(db, gh.client, await context(), 'user');
    assert.equal(state.merge.allowed, false);
    assert.match(state.history[0].text, /You accepted the review of aaaaaaa\. Superseded/);
    assert.equal(count('merge_events'), 0);
  } finally { sqlite.close(); }
});

test('the low-risk path refuses a drifted head too, and records the refusal as Factory’s', async () => {
  const { db, sqlite, context } = database(['factory:risk:low']);
  try {
    const gh = github({ labels: ['factory:risk:low'] });
    gh.pr.head = B;
    const { event } = await factoryMerge(db, gh.client, await context(), A, fast);
    assert.equal(event.status, 'refused');
    assert.equal(gh.merges(), 0);
    assert.deepEqual({ ...sqlite.prepare('SELECT actor, user_id AS userId, head_sha AS sha FROM merge_events').get() }, { actor: 'factory', userId: null, sha: A });
    // Not low risk: Factory never merges on its own.
    await assert.rejects(factoryMerge(db, github().client, await context(), B, fast), /Only low-risk tickets/);
  } finally { sqlite.close(); }
});

test('the low-risk path leaves a Next or OpenNext version change for a person', async () => {
  const { db, sqlite, count, context } = database(['factory:risk:low']);
  try {
    const bump = { filename: 'apps/web/package.json', patch: '@@ -2,3 +2,3 @@\n-    "next": "16.3.8",\n+    "next": "16.4.1",' };
    const gh = github({ labels: ['factory:risk:low'], files: [{ filename: 'README.md', patch: '+next' }, bump] });
    await assert.rejects(factoryMerge(db, gh.client, await context(), A, fast), /apps\/web\/package\.json changes the Next or OpenNext version/);
    // A package.json too large for GitHub to send a patch is treated as one.
    await assert.rejects(factoryMerge(db, github({ labels: ['factory:risk:low'], files: [{ filename: 'package.json' }] }).client, await context(), A, fast), /changes the Next/);
    assert.equal(gh.merges(), 0);
    assert.equal(count('merge_events'), 0);
    // Other dependency changes still merge.
    const other = github({ labels: ['factory:risk:low'], files: [{ filename: 'package.json', patch: '-    "zod": "4.1.0",\n+    "zod": "4.1.1",\n     "next-auth": "5.0.0"' }] });
    assert.equal((await factoryMerge(db, other.client, await context(), A, fast)).event.status, 'merged');
  } finally { sqlite.close(); }
});

test('two concurrent merge requests produce one GitHub merge and one recorded result that both see', async () => {
  const { db, sqlite, count, context } = database();
  try {
    const gh = github({ delay: 30 });
    await acceptReview(db, gh.client, await context(), 'user', A);
    const [first, second] = await Promise.all([
      mergeReview(db, gh.client, await context(), 'user', fast),
      mergeReview(db, gh.client, await context(), 'other', fast),
    ]);
    assert.equal(gh.merges(), 1);
    assert.equal(count('merge_events'), 1);
    assert.equal(first.event.id, second.event.id);
    assert.deepEqual([first.event.status, second.event.status], ['merged', 'merged']);
    assert.equal(first.event.mergeSha, MERGED);
    assert.deepEqual([first.joined, second.joined].sort(), [false, true]);
    // A later click sees the same merge, without a second GitHub call.
    const later = await mergeReview(db, gh.client, await context(), 'other', fast);
    assert.equal(later.event.id, first.event.id);
    assert.equal(gh.merges(), 1);
  } finally { sqlite.close(); }
});

test('a merge claim abandoned mid-request is released after two minutes', async () => {
  const { db, sqlite, context } = database();
  try {
    sqlite.exec(`INSERT INTO merge_events (id, run_id, ticket_id, pull_request_url, head_sha, actor, status, created_at)
      VALUES ('stuck', 'run', 'ticket', '${URL}', '${A}', 'factory', 'pending', ${Math.floor(Date.now() / 1000) - 600})`);
    const gh = github();
    const { event, joined } = await mergeOnce(db, gh.client, await context(), A, { actor: 'factory' }, fast);
    assert.equal(joined, false);
    assert.equal(event.status, 'merged');
    assert.equal(sqlite.prepare("SELECT status FROM merge_events WHERE id = 'stuck'").get()?.status, 'abandoned');
  } finally { sqlite.close(); }
});

test('a project with no deployment target shows no Deploy control', async () => {
  assert.equal(deployControl(null, true), null);
  assert.equal(deployControl('https://deploy.example.com', false), null);
  assert.deepEqual(deployControl('https://deploy.example.com', true), { target: 'https://deploy.example.com' });
  const { db, sqlite, context } = database(['factory:risk:low']);
  try {
    const gh = github({ labels: ['factory:risk:low'] });
    await factoryMerge(db, gh.client, await context(), A, fast);
    assert.equal((await reviewState(db, gh.client, await context(), 'user')).deploy, null);
  } finally { sqlite.close(); }
  const targeted = database([], 'https://deploy.example.com');
  try {
    const gh = github();
    gh.pr.merged = true;
    assert.deepEqual((await reviewState(targeted.db, gh.client, await targeted.context(), 'user')).deploy, { target: 'https://deploy.example.com' });
  } finally { targeted.sqlite.close(); }
});

test('after a low-risk auto-merge, history shows Factory merged a named SHA and no person accepted the review', async () => {
  const { db, sqlite, count, context } = database(['factory:risk:low']);
  try {
    const gh = github({ labels: ['factory:risk:low'] });
    const { event } = await factoryMerge(db, gh.client, await context(), A, fast);
    assert.equal(event.status, 'merged');
    assert.equal(count('review_acceptances'), 0);
    const { history } = await reviewState(db, gh.client, await context(), 'user');
    assert.equal(history.length, 1);
    assert.match(history[0].text, /^Factory merged aaaaaaa under the low-risk policy as mmmmmmm/);
    assert.equal(history.some((entry) => /accepted/i.test(entry.text)), false);
  } finally { sqlite.close(); }
});

test('merge needs acceptance of the current head, repository rules that allow it, and a risk policy that allows this user', () => {
  const pull = { open: true, merged: false, draft: false, headSha: A, mergeableState: 'clean' };
  const accepted = { id: 'acc', headSha: A, userId: 'user' };
  assert.equal(mergeDecision(pull, null, null, 'user').allowed, false);
  assert.equal(mergeDecision(pull, accepted, null, 'user').allowed, true);
  assert.match(mergeDecision({ ...pull, mergeableState: 'blocked' }, accepted, null, 'user').reason, /Repository rules block/);
  assert.match(mergeDecision({ ...pull, mergeableState: 'dirty' }, accepted, null, 'user').reason, /conflicts/);
  assert.match(mergeDecision(pull, accepted, 'high', 'user').reason, /second person/);
  assert.equal(mergeDecision(pull, accepted, 'high', 'other').allowed, true);
  assert.equal(mergeDecision({ ...pull, headSha: B }, accepted, null, 'user').allowed, false);
});
