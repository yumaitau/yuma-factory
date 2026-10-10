import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRun } from '../lib/run-lifecycle';
import { ingestActivities, recordPrompt, takePrompts } from '../lib/run-activities';
import {
  ACTIVITY_LIMITS, IDLE_CAP_MS, STALE_AFTER_MS, lastAgentActivity, normalizeActivity, parseRunPlan,
  sessionState, visibleActivities, workedForMs,
} from '../lib/run-session';
import * as schema from '../db/schema';
import { lifecycleDatabase } from './support/d1';

const at = (ms: number) => new Date(ms);
const now = 10 * STALE_AFTER_MS;

test('session state follows run status first, then the latest agent activity', () => {
  const running = { status: 'running' };
  assert.equal(sessionState(running, null, now), 'pending');
  assert.equal(sessionState(running, { type: 'thought', createdAt: at(now - 1000) }, now), 'active');
  assert.equal(sessionState(running, { type: 'action', createdAt: at(now - STALE_AFTER_MS) }, now), 'stale');
  assert.equal(sessionState(running, { type: 'elicitation', createdAt: at(now - STALE_AFTER_MS) }, now), 'awaitingInput');
  assert.equal(sessionState(running, { type: 'error', createdAt: at(now) }, now), 'error');
  assert.equal(sessionState(running, { type: 'response', createdAt: at(now) }, now), 'complete');
  assert.equal(sessionState({ status: 'succeeded' }, null, now), 'complete');
  assert.equal(sessionState({ status: 'failed' }, { type: 'thought', createdAt: at(now) }, now), 'error');
  assert.equal(sessionState({ status: 'cancelled' }, { type: 'response', createdAt: at(now) }, now), 'stopped');
  // A person's prompt never counts as agent activity.
  const timeline = [{ type: 'elicitation', createdAt: at(1) }, { type: 'prompt', createdAt: at(2) }];
  assert.equal(lastAgentActivity(timeline)?.type, 'elicitation');
});

test('an ephemeral activity is superseded by the next agent activity, not by a prompt', () => {
  const list = [
    { seq: 1, type: 'action', ephemeral: true },
    { seq: 2, type: 'action', ephemeral: false },
    { seq: 3, type: 'thought', ephemeral: true },
    { seq: 4, type: 'prompt', ephemeral: false },
  ];
  assert.deepEqual(visibleActivities(list).map((item) => item.seq), [2, 3, 4]);
  assert.deepEqual(visibleActivities([...list, { seq: 5, type: 'response', ephemeral: false }]).map((item) => item.seq), [2, 4, 5]);
});

test('worked time caps every idle gap', () => {
  const run = { status: 'succeeded', startedAt: at(0), finishedAt: at(60 * 60_000) };
  assert.equal(workedForMs(run, [{ createdAt: at(60_000) }, { createdAt: at(120_000) }], now), 120_000 + IDLE_CAP_MS);
  assert.equal(workedForMs({ status: 'running', startedAt: at(now - 30_000) }, [], now), 30_000);
  assert.equal(workedForMs({ status: 'failed', startedAt: null }, [], now), 0);
});

test('runner activities are validated and truncated before storage', () => {
  const long = normalizeActivity({ key: 'k:1', type: 'action', action: 'Ran', parameter: 'x'.repeat(900), result: 'y'.repeat(9000), body: 'ignored', ephemeral: true });
  assert.equal(long?.parameter?.length, ACTIVITY_LIMITS.parameter);
  assert.equal(long?.result?.length, ACTIVITY_LIMITS.result);
  assert.equal(long?.body, '');
  assert.equal(long?.ephemeral, true);
  assert.equal(normalizeActivity({ key: 'k:2', type: 'thought', body: 'z'.repeat(20_000) })?.body.length, ACTIVITY_LIMITS.body);
  assert.equal(normalizeActivity({ key: 'k:3', type: 'response', body: 'done', ephemeral: true })?.ephemeral, false);
  for (const bad of [null, { type: 'thought', body: 'no key' }, { key: 'k', type: 'prompt', body: 'spoofed' },
    { key: 'k', type: 'thought', body: '  ' }, { key: 'k', type: 'action' }, { key: 'x'.repeat(81), type: 'thought', body: 'b' }])
    assert.equal(normalizeActivity(bad), null);
  assert.deepEqual(parseRunPlan([{ content: 'Write tests', status: 'inProgress' }, { content: 'x', status: 'bogus' }, 'junk']),
    [{ content: 'Write tests', status: 'inProgress' }]);
  assert.equal(parseRunPlan({ steps: [] }), null);
});

test('ingest is idempotent by source key, numbers seq per run, and prompts are taken once', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await db.insert(schema.accountLeases).values({ holderId: 'run', accountId: 'account', createdAt: new Date() });
    assert.equal(await claimRun(db, { id: 'run', ticketId: 'ticket', agentId: 'worker', userId: 'user', accountId: 'account',
      modelId: 'codex-default', mode: 'implement', branchName: 'factory/ticket-1-run' }), true);
    const run = { id: 'run', ticketId: 'ticket' };
    const item = (key: string, body: string) => ({ key, type: 'thought' as const, body, action: null, parameter: null, result: null, ephemeral: false });
    await ingestActivities(db, run, [item('a:1', 'first'), item('a:2', 'second')], [{ content: 'Plan', status: 'pending' }]);
    // A retried batch after a lost response, plus one new activity.
    await ingestActivities(db, run, [item('a:2', 'second'), item('a:3', 'third')]);
    assert.equal(await recordPrompt(db, { runId: 'run', ticketId: 'ticket', body: 'Also add docs', authorUserId: 'user' }), 4);
    await ingestActivities(db, run, [item('b:1', 'next attempt')]);
    const rows = sqlite.prepare("SELECT seq, type, body FROM run_activities WHERE run_id='run' ORDER BY seq").all();
    assert.deepEqual(rows.map((row) => [row.seq, row.type, row.body]),
      [[1, 'thought', 'first'], [2, 'thought', 'second'], [3, 'thought', 'third'], [4, 'prompt', 'Also add docs'], [5, 'thought', 'next attempt']]);
    assert.equal(sqlite.prepare("SELECT plan FROM runs WHERE id='run'").get()?.plan, '[{"content":"Plan","status":"pending"}]');
    assert.equal(sqlite.prepare("SELECT branch_name FROM runs WHERE id='run'").get()?.branch_name, 'factory/ticket-1-run');
    assert.deepEqual(await takePrompts(db, 'run'), [{ seq: 4, body: 'Also add docs' }]);
    assert.deepEqual(await takePrompts(db, 'run'), []);
    // A stop is applied by the app, so the runner never receives it.
    await recordPrompt(db, { runId: 'run', ticketId: 'ticket', body: 'Stop', authorUserId: 'user', signal: 'stop', delivered: true });
    assert.deepEqual(await takePrompts(db, 'run'), []);
  } finally { sqlite.close(); }
});
