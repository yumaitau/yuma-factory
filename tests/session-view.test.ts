import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicActivity, RunSession } from '../lib/run-activities';
import {
  SESSION_BADGES, cardSessionBadge, collapsedSteps, composerPlaceholder, formatWorkedFor, isLiveSession, isLongText, liveActivity, mergeSession,
} from '../lib/session-view';

const activity = (seq: number, type: string, ephemeral = false): PublicActivity => ({
  seq, type, body: `${type} ${seq}`, action: type === 'action' ? 'Ran' : null, parameter: null, result: null,
  ephemeral, signal: null, authorUserId: null, deliveredAt: null, createdAt: new Date(seq * 1000).toISOString(),
});
const session = (state: RunSession['state'], activities: PublicActivity[]) => ({
  run: { id: 'run' }, state, workedForMs: 0, plan: null, activities, lastSeq: activities.at(-1)?.seq ?? 0,
}) as unknown as RunSession;

test('session states map to Linear-style badges, and only some reach the board card', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SESSION_BADGES).map(([state, badge]) => [state, badge.label])), {
    pending: 'Starting', active: 'Working', awaitingInput: 'Needs input', complete: 'Done', error: 'Error', stale: 'No activity', stopped: 'Stopped',
  });
  for (const state of ['pending', 'active', 'awaitingInput', 'stale'] as const) assert.equal(isLiveSession(state), true);
  for (const state of ['complete', 'error', 'stopped'] as const) assert.equal(isLiveSession(state), false);
  assert.equal(cardSessionBadge('awaitingInput')?.label, 'Needs input');
  assert.equal(cardSessionBadge('stale')?.label, 'No activity');
  assert.equal(cardSessionBadge('error')?.label, 'Error');
  for (const quiet of ['active', 'pending', 'complete', 'stopped', null, undefined] as const) assert.equal(cardSessionBadge(quiet), null);
});

test('a poll merges newer activities and drops the ephemeral one they supersede', () => {
  const current = session('active', [activity(1, 'thought'), activity(2, 'action', true)]);
  const polled = session('complete', [activity(3, 'prompt'), activity(4, 'response')]);
  const merged = mergeSession(current, polled);
  assert.deepEqual(merged.activities.map((item) => item.seq), [1, 3, 4]);
  assert.equal(merged.state, 'complete');
  assert.equal(merged.lastSeq, 4);
  // A repeated poll changes nothing, and a prompt alone does not supersede the live line.
  assert.deepEqual(mergeSession(merged, polled).activities.map((item) => item.seq), [1, 3, 4]);
  assert.deepEqual(mergeSession(current, session('active', [activity(3, 'prompt')])).activities.map((item) => item.seq), [1, 2, 3]);
});

test('complete sessions fold their steps; the latest ephemeral step is live only while working', () => {
  const list = [activity(1, 'prompt'), activity(2, 'thought'), activity(3, 'action'), activity(4, 'response')];
  assert.equal(collapsedSteps(list, 'complete'), 2);
  assert.equal(collapsedSteps(list, 'active'), 0);
  assert.equal(collapsedSteps(list, 'error'), 0);
  const working = [activity(1, 'thought'), activity(2, 'action', true), activity(3, 'prompt')];
  assert.equal(liveActivity(working, 'active')?.seq, 2);
  assert.equal(liveActivity(working, 'stale'), null);
  assert.equal(liveActivity([activity(1, 'thought')], 'active'), null);
});

test('worked-for time, composer copy and long thoughts', () => {
  assert.equal(formatWorkedFor(0), 'Worked for <1m');
  assert.equal(formatWorkedFor(59_999), 'Worked for <1m');
  assert.equal(formatWorkedFor(12 * 60_000 + 30_000), 'Worked for 12m');
  assert.equal(formatWorkedFor(65 * 60_000), 'Worked for 1h 5m');
  assert.equal(composerPlaceholder('active'), 'Agent will pick this up after its current step');
  assert.equal(composerPlaceholder('complete'), 'Continue this work…');
  assert.equal(isLongText('short'), false);
  assert.equal(isLongText('x'.repeat(601)), true);
  assert.equal(isLongText('a\n'.repeat(9)), true);
});
