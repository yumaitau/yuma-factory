import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLimits, claudeOutput, executionOutput, jsonLines, redactOutput } from '../sandbox-runner/scripts/output.mjs';

test('commands stream at start, output and file changes at completion', () => {
  assert.equal(executionOutput({ type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } }), '$ pnpm test');
  assert.match(executionOutput({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '3 tests passed', status: 'completed', exit_code: 0 } }), /3 tests passed\nCommand completed \(exit 0\)/);
  assert.equal(executionOutput({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'update', path: 'app/page.tsx' }] } }), 'update: app/page.tsx');
  assert.equal(executionOutput({ type: 'item.completed', item: { type: 'agent_message', text: 'Tests passed.' } }), 'Tests passed.');
  assert.equal(executionOutput({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }), null);
  assert.equal(executionOutput({ type: 'unknown', tokens: 'private' }), null);
});
test('chunked JSONL handles multiple lines, malformed and oversized events', () => {
  const events = [];
  const parser = jsonLines((e) => events.push(e), 100);
  parser.push('{"type":'); parser.push('"turn.started"}\ninvalid\n{"type":"turn.completed"}\n');
  parser.push('x'.repeat(101)); parser.push('\n{"type":"error"}'); parser.end();
  assert.deepEqual(events.map((e) => e.type), ['turn.started', 'turn.completed', 'error']);
});
test('redaction covers refreshed credentials, GitHub tokens and JWTs', () => {
  const secrets = new Set(['old-token', 'fresh-token']);
  const value = redactOutput('old-token fresh-token ghp_abcdef github_pat_abcdef sk-abcdef eyJhbGciOiJ.testpart.signature', secrets);
  assert.equal(value, '[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]');
});

test('Claude events render commands, edits and results without thinking', () => {
  assert.equal(claudeOutput({ type: 'system', subtype: 'init' }), 'Claude started working.');
  assert.equal(claudeOutput({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'secret' },
    { type: 'text', text: 'Fixing it.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/repo/a.js' } },
    { type: 'tool_use', name: 'mcp__factory__search_memory', input: {} },
  ] } }), 'Fixing it.\n$ npm test\nedit: /workspace/repo/a.js\nCalling factory/search_memory');
  assert.equal(claudeOutput({ type: 'user', message: { content: [
    { type: 'tool_result', content: [{ type: 'text', text: 'ok' }], is_error: true },
  ] } }), 'ok\nTool failed');
  assert.equal(claudeOutput({ type: 'result', is_error: false, result: 'done' }), null);
  assert.equal(claudeOutput({ type: 'result', is_error: true, result: 'Usage limit' }), 'Claude error: Usage limit');
});

test('Claude rate limit events map to usage windows', () => {
  assert.deepEqual(claudeLimits({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.08, resetsAt: 100 }, seven_day: { utilization: 0.5, resetsAt: 200 },
  } }), {
    primary: { usedPercent: 8, resetsAt: 100, windowDurationMins: 300 },
    secondary: { usedPercent: 50, resetsAt: 200, windowDurationMins: 10080 },
  });
  assert.equal(claudeLimits({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 300 }).secondary.usedPercent, 100);
  assert.equal(claudeLimits({}), null);
});
