import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movedCard, stageMoveError, workDragBlocked, workMove } from '../lib/board-moves';
import { workLane, type WorkCard } from '../lib/work-board';
const card: WorkCard = { id: 'ticket', title: 'Fix', number: 1, repo: 'org/repo', projectId: 'project', htmlUrl: 'https://github.com/org/repo/issues/1',
  stage: 'intake', githubState: 'open', labels: ['factory:ready'], assignedAgentId: null, agentName: null, automationSlot: null,
  runStatus: null, runId: null, startedAt: null, finishedAt: null, pullRequestUrl: null };
const failed = { ...card, stage: 'assigned', runStatus: 'failed', runId: 'run' };
const stopped = { ...card, runStatus: 'cancelled', runId: 'run' };

test('people move tasks only between Needs preparation and Queued', () => {
  assert.deepEqual(workMove({ ...card, labels: [] }, 'queued'), { requeue: false, ready: true });
  assert.deepEqual(workMove(card, 'intake'), { requeue: false, ready: false });
  assert.deepEqual(workMove(failed, 'queued'), { requeue: true });
  assert.deepEqual(workMove(failed, 'intake'), { requeue: true, ready: false });
  assert.deepEqual(workMove(stopped, 'queued'), { requeue: true });
  for (const lane of ['attention', 'review', 'running', 'waiting', 'done', 'nope']) assert.ok('error' in workMove(card, lane), lane);
  assert.match((workMove(card, 'done') as { error: string }).error, /integrated automatically/);
  assert.ok('error' in workMove(card, 'queued'), 'already queued');
});

test('cards owned by a run or already finished cannot be dragged', () => {
  assert.match(workDragBlocked({ ...card, runStatus: 'running', runId: 'run' })!, /Stop the active run/);
  assert.match(workDragBlocked({ ...card, runStatus: 'running', runId: 'run', waitingReason: 'Limit' })!, /Stop the active run/);
  assert.match(workDragBlocked({ ...card, runStatus: 'succeeded', runId: 'run' })!, /Review its pull request/);
  assert.match(workDragBlocked({ ...card, githubState: 'closed' })!, /Reopen the issue/);
  assert.equal(workDragBlocked(failed), null);
  assert.ok('error' in workMove({ ...card, runStatus: 'running', runId: 'run' }, 'intake'));
});

test('queueing refuses agents that automation will not pick up for', () => {
  assert.match((workMove({ ...card, labels: [], assignedAgentId: 'manual' }, 'queued') as { error: string }).error, /Unassign/);
  assert.deepEqual(workMove({ ...card, labels: [], assignedAgentId: 'auto', automationSlot: 1 }, 'queued'), { requeue: false, ready: true });
});

test('the optimistic card lands in the lane it was dropped on', () => {
  const drops: [WorkCard, string][] = [[{ ...card, labels: [] }, 'queued'], [card, 'intake'], [failed, 'queued'], [failed, 'intake'], [stopped, 'queued']];
  for (const [from, target] of drops) {
    assert.equal(workLane(movedCard(from, target)), target);
  }
  assert.deepEqual(movedCard({ ...card, labels: ['Factory:Ready', 'bug'] }, 'intake').labels, ['bug']);
  assert.equal(movedCard({ ...card, runStatus: 'running', runId: 'run' }, 'intake').runStatus, 'running');
});

test('project board stage moves mirror the server guards', () => {
  assert.equal(stageMoveError('intake', 'assigned'), null);
  assert.equal(stageMoveError('review', 'intake'), null);
  assert.equal(stageMoveError('done', 'intake'), null);
  assert.match(stageMoveError('intake', 'done')!, /completed automatically/);
  assert.match(stageMoveError('intake', 'in_progress')!, /Start a run/);
  assert.match(stageMoveError('in_progress', 'review')!, /Stop the active run/);
  assert.ok(stageMoveError('review', 'review'));
});


test('finished attempts blocked on evidence can be moved to preparation without retaining their old lane', () => {
  const evidence = { state: 'pending' as const, headSha: 'a'.repeat(40), reason: 'Runner offline', current: [], stale: [] };
  for (const state of ['pending', 'failed'] as const) {
    const blocked = { ...card, stage: 'review', runStatus: 'succeeded', runId: 'run',
      pullRequestUrl: 'https://github.com/org/repo/pull/2', evidence: { ...evidence, state } };
    assert.equal(workDragBlocked(blocked), null);
    assert.deepEqual(workMove(blocked, 'intake'), { requeue: true, ready: false });
    assert.equal(workLane(movedCard(blocked, 'intake')), 'intake');
  }
});
