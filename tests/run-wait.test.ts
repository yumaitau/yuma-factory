import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWaitReason } from '../lib/run-wait';

const now = Date.parse('2026-09-19T03:00:00Z');
const ready = { activeRunId: null, enabled: true, status: 'ready', limitsJson: null };
const limited = { ...ready, status: 'limited', limitsJson: JSON.stringify({ primary: { usedPercent: 100, resetsAt: now / 1000 + 3600 } }) };

test('only a subscription held by this run counts as executing', () => {
  assert.equal(runWaitReason('run', { ...limited, activeRunId: 'run' }, now), null);
  assert.match(runWaitReason('run', limited, now)!, /usage limit.*Resets.*retry automatically/);
  assert.match(runWaitReason('run', { ...ready, activeRunId: 'other' }, now)!, /other operation/);
  assert.match(runWaitReason('run', ready, now)!, /automatic recovery/);
});

test('expired quota and missing subscriptions produce accurate recovery guidance', () => {
  assert.match(runWaitReason('run', limited, now + 3600001)!, /automatic recovery/);
  assert.match(runWaitReason('run', { ...ready, enabled: false }, now)!, /disabled/);
  assert.match(runWaitReason('run', { ...ready, status: 'error' }, now)!, /reconnecting/);
  assert.match(runWaitReason('run', null, now)!, /unavailable/);
});

test('corrupt subscription limits never throw and fall back to recovery guidance', () => {
  assert.match(runWaitReason('run', { ...ready, limitsJson: '{broken' }, now)!, /automatic recovery/);
});
