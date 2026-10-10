import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPlan, claudeActivities, codexActivity } from '../sandbox-runner/scripts/output.mjs';

test('Codex events map to thoughts, ephemeral starts, completed actions and errors', () => {
  assert.deepEqual(codexActivity({ type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } }),
    { type: 'action', action: 'Running', parameter: 'pnpm test', result: null, ephemeral: true });
  const ran = codexActivity({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test', aggregated_output: `${'noise\n'.repeat(1000)}3 tests passed\n`, exit_code: 0 } });
  assert.equal(ran.action, 'Ran');
  assert.ok(ran.result.length <= 2000);
  assert.match(ran.result, /^exit 0\n…/);
  assert.match(ran.result, /3 tests passed$/);
  assert.equal(ran.ephemeral, undefined);
  assert.deepEqual(codexActivity({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'update', path: 'a.ts' }, { kind: 'add', path: 'b.ts' }] } }),
    { type: 'action', action: 'Edited', parameter: 'a.ts, b.ts', result: 'update: a.ts\nadd: b.ts' });
  assert.deepEqual(codexActivity({ type: 'item.completed', item: { type: 'agent_message', text: 'Tests pass.' } }), { type: 'thought', body: 'Tests pass.' });
  assert.equal(codexActivity({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }), null);
  assert.equal(codexActivity({ type: 'turn.completed', usage: {} }), null);
  assert.deepEqual(codexActivity({ type: 'turn.failed', error: { message: 'boom' } }), { type: 'error', body: 'boom' });
  assert.equal(codexActivity({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(9000) } }).body.length, 8000);
});

test('Claude tool calls pair with their results; thinking and TodoWrite are not activities', () => {
  const tools = new Map();
  const started = claudeActivities({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'private' },
    { type: 'text', text: 'Running the tests.' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_use', id: 't2', name: 'mcp__factory__factory_thread_read', input: {} },
    { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [] } },
  ] } }, tools);
  assert.deepEqual(started, [
    { type: 'thought', body: 'Running the tests.' },
    { type: 'action', action: 'Running', parameter: 'npm test', result: null, ephemeral: true },
    { type: 'action', action: 'Calling', parameter: 'factory/factory_thread_read', result: null, ephemeral: true },
  ]);
  const finished = claudeActivities({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(5000) }], is_error: true },
    { type: 'tool_result', tool_use_id: 't3', content: 'ok' },
  ] } }, tools);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].action, 'Ran');
  assert.equal(finished[0].result.length, 2000);
  assert.equal(tools.has('t1'), false);
  assert.deepEqual(claudeActivities({ type: 'result', is_error: true, result: 'limit reached' }), [{ type: 'error', body: 'limit reached' }]);
  assert.deepEqual(claudeActivities({ type: 'result', is_error: false, result: 'Done.' }), []);
});

test('both CLIs report their todo list as plan steps', () => {
  assert.deepEqual(agentPlan({ type: 'item.updated', item: { type: 'todo_list', items: [{ text: 'Read code', completed: true }, { text: 'Fix bug', completed: false }] } }),
    [{ content: 'Read code', status: 'completed' }, { content: 'Fix bug', status: 'pending' }]);
  assert.deepEqual(agentPlan({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
    { content: 'Fix bug', status: 'in_progress' }, { content: 'Test', status: 'pending' }] } }] } }),
  [{ content: 'Fix bug', status: 'inProgress' }, { content: 'Test', status: 'pending' }]);
  assert.equal(agentPlan({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), null);
});
