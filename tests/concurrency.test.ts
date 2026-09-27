import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachConcurrent, planAssignments } from '../lib/concurrency';

test('ten tickets get distinct workers, honour assignments and respect subscription capacity', () => {
  const agents = Array.from({ length: 10 }, (_, index) => ({ id: `agent-${index}` }));
  const tickets = Array.from({ length: 20 }, (_, index) => ({ id: `ticket-${index}`, assignedAgentId: index === 12 ? 'agent-0' : null }));
  const all = planAssignments(tickets, agents, 10);
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map((job) => job.agent.id)).size, 10);
  assert.equal(new Set(all.map((job) => job.ticket.id)).size, 10);
  assert.equal(all[0].ticket.id, 'ticket-12');
  assert.equal(planAssignments(tickets, agents, 3).length, 3);
  assert.equal(planAssignments(tickets, agents, 0).length, 0);
  assert.equal(planAssignments([{ id: 'other', assignedAgentId: 'someone-else' }], agents, 10).length, 0);
});

test('bounded parallel work drains all tasks and waits for in-flight tasks on failure', async () => {
  let active = 0, maximum = 0, completed = 0;
  await forEachConcurrent(Array.from({ length: 24 }), 4, async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; completed++;
  });
  assert.equal(maximum, 4);
  assert.equal(completed, 24);
  let drained = false;
  await assert.rejects(forEachConcurrent([0, 1], 2, async (item) => {
    if (!item) throw new Error('failed');
    await new Promise((resolve) => setTimeout(resolve, 5)); drained = true;
  }), /failed/);
  assert.equal(drained, true);
});

test('invalid concurrency still drains every task instead of silently succeeding', async () => {
  for (const bad of [0, -3, Number.NaN]) {
    let completed = 0;
    await forEachConcurrent([1, 2, 3], bad, async () => { completed++; });
    assert.equal(completed, 3);
  }
  let none = 0;
  await forEachConcurrent([], 4, async () => { none++; });
  assert.equal(none, 0);
});
