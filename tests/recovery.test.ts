import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverJob, retryDelay, type DurableJob } from '../sandbox-runner/src/recovery';
import type { RunResult } from '../shared/codex';

const request = { accountId: 'account', repoFullName: 'owner/repo', defaultBranch: 'main', branchName: 'factory/ticket-1', prompt: 'Fix bug', prTitle: 'Fix bug', issueNumber: 1 };

test('stopping during backoff persists cancellation and never starts another attempt', async () => {
  const f = fixture(3);
  f.job().retryAt = 100_000;
  f.job().progress = { status: 'running', log: 'Waiting', pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  let stops = 0;
  const ops = {
    inspect: async (stopping?: boolean) => {
      assert.equal(stopping, true);
      assert.equal(f.job().cancelRequested, true);
      return { running: false, result: null, progress: null };
    },
    pause: async () => { stops++; },
    start: async () => { assert.fail('A cancelled job must not start'); },
  };
  const result = await recoverJob(f.bucket, 'run', 'account', ops, 1000, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.pullRequestUrl, 'https://github.com/owner/repo/pull/1');
  assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 200_000), result);
  assert.equal(stops, 1);
});

test('failed stop retains durable intent and the next poll retries stopping, not coding', async () => {
  const f = fixture(1);
  let failed = true;
  const ops = {
    inspect: async () => ({ running: true, result: null, progress: null }),
    pause: async () => { if (failed) throw new Error('Sandbox unreachable'); },
    start: async () => { assert.fail('Must finish cancellation first'); },
  };
  await assert.rejects(recoverJob(f.bucket, 'run', 'account', ops, 1000, true), /unreachable/);
  assert.equal(f.job().cancelRequested, true);
  assert.equal(f.job().terminalResult, undefined);
  failed = false;
  assert.equal((await recoverJob(f.bucket, 'run', 'account', ops, 2000)).status, 'cancelled');
});

test('unresponsive inspection cannot prevent cancellation, but destruction must finish first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(1);
  f.job().progress = { status: 'running', log: 'Last durable output', pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  let finishStop!: () => void;
  let stopping = false;
  const result = recoverJob(f.bucket, 'run', 'account', {
    inspect: () => new Promise(() => {}),
    pause: async () => {
      stopping = true;
      await new Promise<void>((resolve) => { finishStop = resolve; });
    },
    start: async () => assert.fail('Cancellation must not start another attempt'),
  }, 1000, true);
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(stopping, true);
  assert.equal(f.job().terminalResult, undefined);
  assert.equal(f.job().stoppingResult?.status, 'cancelled');
  finishStop();
  const stopped = await result;
  assert.equal(stopped.status, 'cancelled');
  assert.match(stopped.log, /Last durable output/);
  assert.equal(stopped.pullRequestUrl, 'https://github.com/owner/repo/pull/1');
});

test('inspection errors do not prevent stopping, and failed destruction keeps the job recoverable', async () => {
  const f = fixture(1);
  const ops = {
    inspect: async () => { throw new Error('Sandbox unresponsive'); },
    pause: async () => { throw new Error('Destruction failed'); },
    start: async () => assert.fail('Cancellation must not start another attempt'),
  };
  await assert.rejects(recoverJob(f.bucket, 'run', 'account', ops, 1000, true), /Destruction failed/);
  assert.equal(f.job().cancelRequested, true);
  assert.equal(f.job().terminalResult, undefined);
  assert.equal((await recoverJob(f.bucket, 'run', 'account', { ...ops, pause: async () => {} }, 2000)).status, 'cancelled');
});

test('stop respects account ownership and a live recovery lease', async () => {
  const f = fixture();
  const ops = {
    inspect: async () => { assert.fail('Lease must prevent inspection'); },
    pause: async () => { assert.fail('Lease must prevent stopping'); },
    start: async () => { assert.fail('Lease must prevent starting'); },
  };
  await assert.rejects(recoverJob(f.bucket, 'run', 'other-account', ops, 1000, true), /does not own/);
  f.job().leaseUntil = 5000;
  assert.equal((await recoverJob(f.bucket, 'run', 'account', ops, 1000, true)).status, 'running');
  assert.equal(f.job().cancelRequested, undefined);
});

test('completion evidence survives destruction followed by a failed release callback', async () => {
  const f = fixture(1);
  const result: RunResult = { status: 'succeeded', log: 'CI green', issueClosed: true, ciHeadSha: 'a'.repeat(40), pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  let destroyed = false;
  const ops = {
    inspect: async () => ({ running: false, result: destroyed ? null : result, progress: null }),
    pause: async () => { if (!destroyed) { destroyed = true; throw new Error('Release callback failed'); } },
    start: async () => { assert.fail('Completed work must not restart'); },
  };
  await assert.rejects(recoverJob(f.bucket, 'run', 'account', ops, 1000, true), /callback failed/);
  assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 2000), result);
});

test('closed PR failures terminate recovery; completed work wins over a stop request', async () => {
  for (const status of ['failed', 'succeeded'] as const) {
    const f = fixture(1);
    const result: RunResult = { status, log: 'Terminal result', retryable: false, pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
    const ops = {
      inspect: async () => ({ running: false, result, progress: null }),
      pause: async () => {},
      start: async () => { assert.fail('Terminal work must not restart'); },
    };
    assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 1000, status === 'succeeded'), result);
    assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 2000), result);
  }
});
function fixture(attempt = 0) {
  let job: DurableJob = { accountId: 'account', request, attempt };
  let version = 1;
  const bucket = {
    get: async () => {
      const snapshot = structuredClone(job), etag = String(version);
      return { etag, json: async () => snapshot };
    },
    put: async (_key: string, value: string, options: { onlyIf: { etagMatches: string } }) => {
      if (options.onlyIf.etagMatches !== String(version)) return null;
      job = JSON.parse(value);
      return { etag: String(++version) };
    },
  } as unknown as R2Bucket;
  return { bucket, job: () => job };
}

test('workflow permission rejection stops recovery and releases the subscription once', async () => {
  const f = fixture(1);
  let stopped = 0;
  const ops = {
    inspect: async () => ({ running: false, progress: null, result: {
      status: 'failed' as const,
      log: 'git failed: remote rejected (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
    } }),
    start: async () => assert.fail('Permissions cannot be repaired by rerunning coding'),
    pause: async () => { stopped++; },
  };
  const result = await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.pullRequestUrl, 'https://github.com/owner/repo/pull/1');
  assert.match(result.log, /Update the installation before retrying/);
  assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 2000), result);
  assert.equal(stopped, 1);
});

test('deployed recovery stops expired legacy main-CI waits without touching active coding', async () => {
  for (const [log, age, expired] of [
    ['Waiting for the main pipeline. Ticket stays open.', 31 * 60_000, true],
    ['Waiting for the main pipeline: deploy. Ticket stays open.', 31 * 60_000, true],
    ['Waiting for the main pipeline. Ticket stays open.', 29 * 60_000, false],
    ['Running tests', 31 * 60_000, false],
    ['Waiting for the main pipeline. Ticket stays open.\nRepairing CI', 31 * 60_000, false],
  ] as const) {
    const f = fixture(1);
    let stopped = 0;
    const result = await recoverJob(f.bucket, 'run', 'account', {
      inspect: async () => ({ running: true, result: null, progress: {
        status: 'running', log, outputUpdatedAt: new Date(0).toISOString(),
        pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      } }),
      pause: async () => { stopped++; },
      start: async () => assert.fail('Active work must not restart'),
    }, age);
    assert.equal(result.status, expired ? 'failed' : 'running');
    assert.equal(stopped, expired ? 1 : 0);
    assert.equal(result.pullRequestUrl, 'https://github.com/owner/repo/pull/1');
  }
});

test('failed repair remains running and resumes same request after durable backoff', async () => {
  const f = fixture(1);
  const started: unknown[] = [];
  const failed: RunResult = { status: 'failed', log: 'GitHub temporary failure', pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  const ops = {
    inspect: async () => ({ running: false, result: failed, progress: null }),
    start: async (req: unknown, recovering: boolean) => { started.push({ req, recovering }); },
  };
  const result = await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  assert.equal(result.status, 'running');
  assert.equal(result.pullRequestUrl, failed.pullRequestUrl);
  assert.equal(f.job().retryAt, 61000);
  await recoverJob(f.bucket, 'run', 'account', ops, 60000);
  assert.equal(started.length, 0);
  // New call represents a new Worker instance; all recovery state lives in R2.
  await recoverJob(f.bucket, 'run', 'account', ops, 61000);
  assert.deepEqual(started, [{ req: request, recovering: true }]);
  assert.equal(f.job().attempt, 2);
});

test('container loss schedules recovery; concurrent polls start only one attempt', async () => {
  const f = fixture(1);
  let started = 0;
  const ops = { inspect: async () => ({ running: false, result: null, progress: null }), start: async () => { started++; } };
  await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  await Promise.all(Array.from({ length: 8 }, () => recoverJob(f.bucket, 'run', 'account', ops, 61000)));
  assert.equal(started, 1);
});

test('lost startup response does not restart a process that is still running', async () => {
  const f = fixture();
  let started = 0;
  const ops = {
    inspect: async () => ({ running: true, result: null, progress: { status: 'running', log: 'CI running' } as RunResult }),
    start: async () => { started++; throw new Error('Response lost after start'); },
  };
  await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  assert.equal(f.job().retryAt, 61000);
  const result = await recoverJob(f.bucket, 'run', 'account', ops, 61000);
  assert.equal(result.log, 'CI running');
  assert.equal(started, 1);
  assert.equal(f.job().retryAt, undefined);
});

test('temporary auth failure retries automatically without a retry-count limit', async () => {
  const f = fixture();
  let available = false;
  const ops = {
    inspect: async () => ({ running: false, result: null, progress: null }),
    start: async () => { if (!available) throw new Error('Token unavailable'); },
  };
  let now = 1000;
  for (let i = 0; i < 12; i++) {
    const result = await recoverJob(f.bucket, 'run', 'account', ops, now);
    assert.equal(result.status, 'running');
    now = f.job().retryAt!;
  }
  assert.equal(f.job().attempt, 12);
  assert.equal(retryDelay(12), 15 * 60_000);
  available = true;
  await recoverJob(f.bucket, 'run', 'account', ops, now);
  assert.equal(f.job().retryAt, undefined);
  assert.equal(f.job().attempt, 13);
});

test('expired crash lease recovers, live lease and wrong account cannot start work', async () => {
  const f = fixture();
  f.job().leaseUntil = 10000;
  let starts = 0;
  const ops = { inspect: async () => ({ running: false, result: null, progress: null }), start: async () => { starts++; } };
  await assert.rejects(recoverJob(f.bucket, 'run', 'other', ops, 1000), /does not own/);
  await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  assert.equal(starts, 0);
  await recoverJob(f.bucket, 'run', 'account', ops, 10001);
  assert.equal(starts, 1);
});

test('successful completion is returned unchanged without another attempt', async () => {
  const f = fixture(2);
  const done: RunResult = { status: 'succeeded', log: 'CI green', issueClosed: true, ciHeadSha: 'a'.repeat(40), pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  const result = await recoverJob(f.bucket, 'run', 'account', {
    inspect: async () => ({ running: false, result: done, progress: null }),
    start: async () => assert.fail('Must not restart completed work'),
  }, 1000);
  assert.deepEqual(result, done);
});

test('stopped attempts release subscription before restarting; active ones keep their lock', async () => {
  const f = fixture(1), events: string[] = [];
  const ops = {
    inspect: async () => ({ running: false, result: null, progress: null }),
    pause: async () => { events.push('destroy then release'); },
    start: async () => { events.push('claim then start'); },
  };
  await recoverJob(f.bucket, 'run', 'account', ops, 1000);
  assert.deepEqual(events, ['destroy then release']);
  await recoverJob(f.bucket, 'run', 'account', ops, 61000);
  assert.deepEqual(events, ['destroy then release', 'destroy then release', 'claim then start']);
  await recoverJob(f.bucket, 'run', 'account', { ...ops, inspect: async () => ({ running: true, result: null, progress: null }) }, 62000);
  assert.equal(events.length, 3);
});

test('startup authentication errors release stopped subscription for reconnect', async () => {
  const f = fixture();
  let released = 0;
  const result = await recoverJob(f.bucket, 'run', 'account', {
    inspect: async () => ({ running: false, result: null, progress: null }),
    pause: async () => { released++; },
    start: async () => { throw new Error('Reconnect required'); },
  }, 1000);
  assert.equal(result.status, 'running');
  assert.equal(released, 1);
});

test('ordinary successful completion survives destruction and a failed release callback', async () => {
  const f = fixture(1);
  const result: RunResult = { status: 'succeeded', log: 'Completed', pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  let destroyed = false;
  const ops = {
    inspect: async () => ({ running: false, result: destroyed ? null : result, progress: null }),
    pause: async () => { if (!destroyed) { destroyed = true; throw new Error('Release callback failed'); } },
    start: async () => assert.fail('Completed work must not restart'),
  };
  await assert.rejects(recoverJob(f.bucket, 'run', 'account', ops, 1000), /callback failed/);
  assert.equal(f.job().stoppingResult?.status, 'succeeded');
  assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 2000), result);
  assert.equal(f.job().terminalResult?.status, 'succeeded');
  assert.deepEqual(await recoverJob(f.bucket, 'run', 'account', ops, 3000), result);
});

test('a coding run silent past Codex\'s time limit restarts; a silent CI wait does not', async () => {
  const silent = '2026-01-01T00:00:00.000Z';
  const after = Date.parse(silent) + 61 * 60_000;
  const f = fixture(1);
  let paused = 0;
  const ops = {
    inspect: async () => ({ running: true, result: null, progress: { status: 'running' as const, log: 'Command completed (exit 0)', outputUpdatedAt: silent } }),
    pause: async () => { paused++; },
    start: async () => assert.fail('Restart waits for the backoff'),
  };
  await recoverJob(f.bucket, 'run', 'account', ops, after);
  assert.equal(paused, 1);
  assert.ok(f.job().retryAt);
  assert.match(f.job().progress?.log ?? '', /No output for 60 minutes/);

  const waiting = fixture(1);
  await recoverJob(waiting.bucket, 'run', 'account', {
    inspect: async () => ({ running: true, result: null, progress: { status: 'running' as const, log: 'Waiting for CI on the current PR head.',
      pullRequestUrl: 'https://github.com/owner/repo/pull/1', outputUpdatedAt: silent } }),
    pause: async () => assert.fail('CI waits are legitimately quiet'),
    start: async () => assert.fail('Still running'),
  }, after);
  assert.equal(waiting.job().retryAt, undefined);
});

test('an unresponsive sandbox is treated as interrupted instead of holding the lease forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(1);
  f.job().progress = { status: 'running', log: 'Coding' };
  let paused = 0;
  const result = recoverJob(f.bucket, 'run', 'account', {
    inspect: () => new Promise(() => {}),
    pause: async () => { paused++; },
    start: async () => assert.fail('Restart waits for the backoff'),
  }, 1000);
  await new Promise(setImmediate);
  t.mock.timers.tick(60_000);
  assert.equal((await result).status, 'running');
  assert.equal(paused, 1);
  assert.ok(f.job().retryAt);
  assert.equal(f.job().leaseUntil, undefined);
  assert.match(f.job().progress?.log ?? '', /stopped responding/);
});
