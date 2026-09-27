import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicRunOutput, runOutputStream, type RunOutput } from '../lib/run-output';

const initial: RunOutput = { status: 'running', log: 'Starting', pullRequestUrl: null, outputUpdatedAt: null };
test('output exposes only log metadata, never subscription identity or credentials', () => {
  const value = publicRunOutput({ ...initial, accountStatus: { email: 'private@example.test' }, secret: 'hidden' } as typeof initial);
  assert.deepEqual(Object.keys(value).sort(), ['log', 'outputUpdatedAt', 'pullRequestUrl', 'status']);
  assert.equal(publicRunOutput({ ...initial, log: 'x'.repeat(70000), pullRequestUrl: 'javascript:alert(1)' }).log.length, 60000);
  assert.equal(publicRunOutput({ ...initial, pullRequestUrl: 'javascript:alert(1)' }).pullRequestUrl, null);
});
test('SSE delivers output before completion and terminates after final snapshot', async () => {
  let calls = 0;
  const stream = runOutputStream(initial, async () => ({ ...initial, status: ++calls === 1 ? 'running' : 'succeeded', log: `output ${calls}` }), new AbortController().signal, { interval: 1, lifetime: 1000 });
  const reader = stream.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /Starting/);
  let output = '';
  while (true) { const next = await reader.read(); if (next.done) break; output += new TextDecoder().decode(next.value); }
  assert.match(output, /output 1/);
  assert.match(output, /output 2/);
  assert.match(output, /event: done/);
  assert.equal(calls, 2);
});
test('transient errors preserve initial output and emit reconnect status', async () => {
  const stream = runOutputStream(initial, async () => { throw new Error('secret upstream details'); }, new AbortController().signal);
  const result = await new Response(stream).text();
  assert.match(result, /Starting/);
  assert.match(result, /event: unavailable/);
  assert.doesNotMatch(result, /secret upstream/);
});
test('disconnect cancels upstream work and no further reads occur', async () => {
  let upstream: AbortSignal | undefined;
  let calls = 0;
  const reader = runOutputStream(initial, async (signal) => {
    upstream = signal; calls++;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return initial;
  }, new AbortController().signal).getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstream?.aborted, true);
  assert.equal(calls, 1);
});
test('finished logs never poll the runner', async () => {
  const text = await new Response(runOutputStream({ ...initial, status: 'succeeded' }, async () => assert.fail('polled'), new AbortController().signal)).text();
  assert.match(text, /event: done/);
});
