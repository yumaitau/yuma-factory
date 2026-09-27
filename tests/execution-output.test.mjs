import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionOutput, jsonLines, redactOutput } from '../sandbox-runner/scripts/output.mjs';

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
