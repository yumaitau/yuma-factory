import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, evidenceGate, NO_CI_NOTE } from '../lib/review-evidence';
import { runEvidenceGate, syncHeadEvidence } from '../lib/review-evidence-store';
import { syncPullRequests } from '../lib/pull-request-sync';
import { workLane, workReason, type WorkCard } from '../lib/work-board';
import { lifecycleDatabase } from './support/d1';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const green = { name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-13T01:00:00Z', completed_at: '2026-10-13T01:05:00Z',
  html_url: 'https://github.com/org/repo/runs/1', app: { slug: 'github-actions' } };
const card: WorkCard = { id: 'ticket', title: 'Fix', number: 1, repo: 'org/repo', projectId: 'project', htmlUrl: 'https://github.com/org/repo/issues/1',
  stage: 'review', githubState: 'open', labels: [], assignedAgentId: null, agentName: null, automationSlot: null,
  runStatus: 'succeeded', runId: 'run', startedAt: null, finishedAt: null, pullRequestUrl: 'https://github.com/org/repo/pull/10', runMode: 'implement' };

/** GitHub stub: check runs per commit, and the PR's current head. */
function github(checks: Record<string, unknown[]>, head: () => string) {
  return { request: async (route: string, params: { ref?: string; pull_number?: number }) => {
    if (route.includes('/check-runs')) return { data: { check_runs: checks[params.ref!] ?? [] } };
    if (route.endsWith('/status')) return { data: { statuses: [] } };
    if (route.includes('/pulls/')) return { data: { merged: false, state: 'open', head: { sha: head() } } };
    throw new Error(`unexpected ${route}`);
  } } as never;
}

test('a green check on the head is shown with its name, time and SHA, and makes the run ready for review', () => {
  const records = checkEvidence(A, [green, { ...green, name: 'CodeRabbit', app: { slug: 'coderabbitai' } }], []);
  assert.deepEqual(records, [{ kind: 'check', name: 'test', sourceSha: A, environment: 'github-actions', startedAt: '2026-10-13T01:00:00.000Z',
    finishedAt: '2026-10-13T01:05:00.000Z', result: 'passed', url: 'https://github.com/org/repo/runs/1', logKey: null }]);
  const gate = evidenceGate(records, A);
  assert.equal(gate.state, 'ready');
  assert.equal(gate.current.length, 1);
  assert.match(gate.reason, /1 check passed on aaaaaaa/);
  assert.equal(workLane({ ...card, evidence: gate }), 'review');
  assert.match(workReason({ ...card, evidence: gate }), /passed on aaaaaaa/);
});

test('a new head makes earlier checks stale; the run is not ready for review until the new head has its own result', () => {
  const onA = checkEvidence(A, [green], []);
  const drifted = evidenceGate(onA, B);
  assert.equal(drifted.state, 'missing');
  assert.deepEqual(drifted.current, []);
  assert.equal(drifted.stale[0].sourceSha, A);
  assert.match(drifted.reason, /aaaaaaa, which is stale\. The head is now bbbbbbb/);
  assert.equal(workLane({ ...card, evidence: drifted }), 'attention');
  const running = evidenceGate([...onA, ...checkEvidence(B, [{ ...green, status: 'in_progress', conclusion: null }], [])], B);
  assert.equal(running.state, 'pending');
  assert.equal(workLane({ ...card, evidence: running }), 'waiting');
  const failed = evidenceGate(checkEvidence(B, [{ ...green, conclusion: 'failure' }], []), B);
  assert.equal(workLane({ ...card, evidence: failed }), 'attention');
  assert.match(workReason({ ...card, evidence: failed }), /test failed on bbbbbbb/);
});

test('a run with no checks stays out of Ready for review, with the reason visible', () => {
  const none = evidenceGate([], A);
  assert.equal(none.state, 'missing');
  assert.equal(workLane({ ...card, evidence: none }), 'attention');
  assert.match(workReason({ ...card, evidence: none }), /No checks reported on aaaaaaa/);
  assert.match(workReason({ ...card, evidence: none, runOutcome: 'No CI registered on the PR within 30 minutes.' }), /No CI on this repository/);
  // A log that says success, with no head read yet, is not evidence either.
  assert.equal(workLane({ ...card, runOutcome: 'Run succeeded.' }), 'waiting');
  assert.equal(evidenceGate(checkEvidence(A, [{ ...green, conclusion: 'skipped' }], []), A).state, 'missing');
  // Plans and runs without a pull request have no revision to check.
  assert.equal(workLane({ ...card, runMode: 'plan' }), 'review');
  assert.equal(workLane({ ...card, pullRequestUrl: null }), 'review');
});

test('stored evidence follows the PR head: a matching SHA, a drifted SHA, and a head with no checks', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    sqlite.exec(`INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, created_at)
      VALUES ('run', 'ticket', 'worker', 'succeeded', 'm', 'https://github.com/org/repo/pull/10', 1)`);
    let head = A;
    const client = github({ [A]: [green] }, () => head);
    const input = { runId: 'run', ticketId: 'ticket', owner: 'org', repo: 'repo' };
    assert.equal((await syncHeadEvidence(db, client, { ...input, headSha: A })).state, 'ready');
    // An unchanged check is not rewritten.
    await syncHeadEvidence(db, client, { ...input, headSha: A });
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM run_evidence').get()?.n, 1);
    head = B;
    await syncPullRequests(db, async () => client, Date.now() + 60_000);
    assert.equal(sqlite.prepare("SELECT pull_request_head_sha AS sha FROM runs WHERE id = 'run'").get()?.sha, B);
    const gate = await runEvidenceGate(db, 'run', B);
    assert.equal(gate.state, 'missing');
    assert.equal(gate.stale.length, 1);
    assert.equal(gate.stale[0].sourceSha, A);
    const fresh = await syncHeadEvidence(db, github({ [B]: [{ ...green, completed_at: '2026-10-13T02:00:00Z' }] }, () => B), { ...input, headSha: B });
    assert.equal(fresh.state, 'ready');
    assert.equal(fresh.current[0].sourceSha, B);
    assert.equal(fresh.stale[0].sourceSha, A);
  } finally { sqlite.close(); }
});


test('confirmed absence of CI permits review without claiming green checks; new heads and real checks override it', () => {
  const note = { kind: 'note' as const, name: NO_CI_NOTE, sourceSha: A, environment: 'github', startedAt: null,
    finishedAt: null, result: 'skipped' as const, url: null, logKey: null };
  const noCI = evidenceGate([note], A);
  assert.equal(noCI.state, 'no_ci');
  assert.equal(workLane({ ...card, evidence: noCI }), 'review');
  assert.match(workReason({ ...card, evidence: noCI }), /without automated checks/);
  assert.equal(evidenceGate([note], B).state, 'missing');
  assert.equal(evidenceGate([note, ...checkEvidence(A, [{ ...green, conclusion: 'failure' }], [])], A).state, 'failed');
  assert.equal(evidenceGate([note, ...checkEvidence(A, [{ ...green, status: 'queued', conclusion: null }], [])], A).state, 'pending');
});

test('CI absence is recorded only after workflow and branch policies are readable and empty', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    sqlite.exec(`INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, created_at)
      VALUES ('run', 'ticket', 'worker', 'succeeded', 'm', 'https://github.com/org/repo/pull/10', 1)`);
    let workflows = 0;
    let required = false;
    let unavailable = false;
    let active = 0;
    let whileRefreshing: (() => Promise<void>) | undefined;
    const client = { request: async (route: string) => {
      if (route.includes('/check-runs')) return { data: { check_runs: [] } };
      if (route.endsWith('/status')) return { data: { statuses: [] } };
      if (route.endsWith('/actions/workflows')) {
        await whileRefreshing?.();
        return { data: { total_count: workflows } };
      }
      if (route.endsWith('/actions/runs')) return { data: { total_count: active } };
      if (route.endsWith('/protection')) {
        if (unavailable) throw Object.assign(new Error('Denied'), { status: 403 });
        return { data: { required_status_checks: { contexts: required ? ['test'] : [] } } };
      }
      if (route.includes('/rules/branches/')) return { data: [] };
      return { data: {} };
    } } as never;
    const input = { runId: 'run', ticketId: 'ticket', owner: 'org', repo: 'repo', headSha: A, baseBranch: 'main' };
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'no_ci');
    whileRefreshing = async () => { assert.equal((await runEvidenceGate(db, 'run', A)).state, 'no_ci'); };
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'no_ci');
    whileRefreshing = undefined;
    required = true;
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'missing');
    required = false;
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'no_ci');
    unavailable = true;
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'missing');
    unavailable = false;
    workflows = 1;
    assert.equal((await syncHeadEvidence(db, client, input)).state, 'missing');
    const expired = { ...input, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() };
    assert.equal((await syncHeadEvidence(db, client, expired)).state, 'no_ci');
    active = 1;
    assert.equal((await syncHeadEvidence(db, client, expired)).state, 'missing');
    active = 0;
    required = true;
    assert.equal((await syncHeadEvidence(db, client, expired)).state, 'missing');
    required = false;
    assert.equal((await syncHeadEvidence(db, client, { ...expired, updatedAt: new Date().toISOString() })).state, 'missing');
  } finally { sqlite.close(); }
});
