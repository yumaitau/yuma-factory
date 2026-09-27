import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workLane, workReason, type WorkCard } from '../lib/work-board';
const card: WorkCard = { id: 'ticket', title: 'Fix', number: 1, repo: 'org/repo', projectId: 'project', htmlUrl: 'https://github.com/org/repo/issues/1',
  stage: 'intake', githubState: 'open', labels: ['factory:ready'], assignedAgentId: null, agentName: null, automationSlot: null,
  runStatus: null, runId: null, startedAt: null, finishedAt: null, pullRequestUrl: null };
test('work board distinguishes queued, working, failed, review and unlabelled tickets', () => {
  assert.equal(workLane(card), 'queued');
  assert.equal(workLane({ ...card, runStatus: 'running', runId: 'run' }), 'running');
  assert.equal(workLane({ ...card, runStatus: 'failed', runId: 'run', stage: 'assigned' }), 'attention');
  assert.equal(workLane({ ...card, runStatus: 'succeeded', runId: 'run' }), 'review');
  assert.equal(workLane({ ...card, githubState: 'closed' }), 'done');
  assert.equal(workLane({ ...card, labels: [] }), 'intake');
  assert.match(workReason({ ...card, labels: [] }), /Add factory:ready/);
  assert.equal(workLane({ ...card, assignedAgentId: 'manual' }), 'intake');
  assert.equal(workLane({ ...card, assignedAgentId: 'automatic', automationSlot: 2 }), 'queued');
});

test('queued attempts show queued; stopped attempts require a manual decision', () => {
  assert.equal(workLane({ ...card, runStatus: 'queued', runId: 'run' }), 'queued');
  assert.equal(workLane({ ...card, runStatus: 'cancelled', runId: 'run' }), 'intake');
  assert.match(workReason({ ...card, runStatus: 'cancelled', runId: 'run' }), /Run stopped/);
  assert.equal(workLane({ ...card, runStatus: 'cancelled', runId: 'run', labels: [] }), 'intake');
});

test('running PR reports CI monitoring and completion remains gated', () => {
  const running = { ...card, runStatus: 'running', runId: 'run', pullRequestUrl: 'https://github.com/org/repo/pull/1' };
  assert.equal(workLane(running), 'running');
  assert.match(workReason(running), /Monitoring CI and fixing failures/);
  assert.match(workReason({ ...running, completionPending: true }), /CI green/);
  assert.match(workReason({ ...running, labels: ['factory:ready', 'risk:low'] }), /default branch pipeline/);
  assert.match(workReason({ ...running, labels: ['factory:ready', 'severity:low'], completionPending: true }), /Merging low-risk PR/);
});


test('recovering runs stay pending but do not appear to be executing', () => {
  const waiting = { ...card, runStatus: 'running', stage: 'in_progress', runId: 'run', waitingReason: 'Subscription usage limit reached.' };
  assert.equal(workLane(waiting), 'waiting');
  assert.equal(workReason(waiting), waiting.waitingReason);
  assert.equal(workLane({ ...waiting, waitingReason: null }), 'running');
  assert.equal(workLane({ ...waiting, runStatus: 'succeeded', stage: 'review' }), 'review');
});

test('plan proposals and blocked subtasks explain what they wait for', () => {
  assert.match(workReason({ ...card, runStatus: 'succeeded', runId: 'run', stage: 'review', runMode: 'plan' }), /Plan proposed/);
  assert.equal(workLane({ ...card, blockedBy: [4] }), 'queued');
  assert.match(workReason({ ...card, blockedBy: [4, 5] }), /Waiting for #4, #5 to close/);
});

test('finished runs explain their own outcome', () => {
  assert.equal(workReason({ ...card, runStatus: 'failed', runId: 'run', stage: 'assigned', runOutcome: 'GitHub App Workflows write permission is required.' }),
    'Run failed: GitHub App Workflows write permission is required.');
  assert.match(workReason({ ...card, runStatus: 'failed', runId: 'run', stage: 'assigned' }), /restart manually/);
  assert.match(workReason({ ...card, runStatus: 'succeeded', runId: 'run', stage: 'review', runOutcome: 'No CI registered on the PR within 30 minutes.' }), /No CI on this repository/);
});
