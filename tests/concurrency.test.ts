import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAssignments, forEachConcurrent, planAssignments } from '../lib/concurrency';

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


test('rejected tickets do not waste agent slots or starve valid work later in the same check', async () => {
  const tickets = Array.from({ length: 8 }, (_, index) => ({ id: `ticket-${index}`, assignedAgentId: null }));
  const agents = [{ id: 'a' }, { id: 'b' }];
  const attempts: string[] = [], started: string[] = [];
  const count = await dispatchAssignments(tickets, agents, 2, 2, async (ticket, agent) => {
    attempts.push(ticket.id);
    if (Number(ticket.id.slice(-1)) < 4) return false;
    started.push(agent.id);
    return true;
  });
  assert.equal(count, 2);
  assert.equal(new Set(started).size, 2);
  assert.deepEqual(attempts, ['ticket-0', 'ticket-1', 'ticket-2', 'ticket-3', 'ticket-4', 'ticket-5']);
});

test('dispatch honours assignments and attempts each rejected ticket at most once', async () => {
  const tickets = [{ id: 'pinned', assignedAgentId: 'b' }, { id: 'other', assignedAgentId: 'missing' }, { id: 'free', assignedAgentId: null }];
  const seen: string[] = [];
  assert.equal(await dispatchAssignments(tickets, [{ id: 'a' }, { id: 'b' }], 2, 2, async (ticket, agent) => {
    if (ticket.id === 'pinned') assert.equal(agent.id, 'b');
    seen.push(ticket.id); return false;
  }), 0);
  assert.deepEqual(seen, ['pinned', 'free']);
});
