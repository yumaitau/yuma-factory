import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryCost, rankMemories } from '../lib/memory';
import {
  eventActor, eventSummary, filterMemories, memoryInclusion, scopeOptions, selectionSize, sourceLabel, statusCounts, trackRecord,
} from '../lib/memory-view';

const memory = (id: string, extra: Partial<{ pinned: boolean; status: string; weight: number; content: string; projectId: string | null }> = {}) => ({
  id, kind: 'convention', content: `Memory ${id}`, pinned: false, status: 'active', weight: 50, successes: 0, failures: 0, projectId: 'prj', ...extra,
});

test('inclusion says whether a memory reaches runs, using the ranking runs use', () => {
  const pinned = memory('pin', { pinned: true });
  const fits = memory('fits', { weight: 90 });
  const left = memory('left', { weight: 10, content: 'x'.repeat(200) });
  const typical = new Set(rankMemories([pinned, fits, left], '', memoryCost(pinned) + memoryCost(fits)).map((item) => item.id));
  assert.equal(memoryInclusion(pinned, typical).label, 'Always included');
  assert.equal(memoryInclusion(fits, typical).label, 'Included by default');
  assert.equal(memoryInclusion(left, typical).label, 'Only when relevant');
  assert.equal(memoryInclusion(memory('big', { pinned: true }), new Set()).label, 'Pinned, over budget');
  // Without a project there is no single budget to measure against.
  assert.equal(memoryInclusion(pinned).label, 'Always included');
  assert.equal(memoryInclusion(fits).label, 'Included when relevant');
  assert.equal(memoryInclusion(memory('s', { status: 'suggested' }), typical).label, 'Not used until accepted');
  assert.equal(memoryInclusion(memory('a', { status: 'archived', pinned: true })).label, 'Not used');
});

test('track record reads as plain outcomes', () => {
  assert.equal(trackRecord({ uses: 0, successes: 0, failures: 0 }), 'Not used in a run yet');
  assert.equal(trackRecord({ uses: 1, successes: 0, failures: 0 }), 'Used in 1 run');
  assert.equal(trackRecord({ uses: 7, successes: 5, failures: 1 }), 'Used in 7 runs · 5 green · 1 failed');
  assert.equal(trackRecord({ uses: 3, successes: 0, failures: 2 }), 'Used in 3 runs · 2 failed');
});

test('sources and history actors are named for people', () => {
  assert.equal(sourceLabel('human'), 'Added by the team');
  assert.equal(sourceLabel('agent'), 'Learned by an agent');
  assert.deepEqual(eventActor('run:run_1'), { label: 'an agent run', runId: 'run_1' });
  assert.deepEqual(eventActor('user:usr_1'), { label: 'a team member' });
  assert.deepEqual(eventActor('system'), { label: 'Factory' });
  assert.equal(eventSummary('{"status":"archived","weight":75,"pinned":true}'), 'status: archived, priority: 75, always included: yes');
  assert.equal(eventSummary(JSON.stringify({ content: 'y'.repeat(100) })).length, 'content: '.length + 80);
  assert.equal(eventSummary(null), '');
  assert.equal(eventSummary('not json'), 'not json');
});

test('scope picker lists projects with memories first, review queues before the rest', () => {
  const counts = [
    { projectId: null, status: 'active', count: 4 },
    { projectId: 'b', status: 'active', count: 2 },
    { projectId: 'c', status: 'active', count: 9 },
    { projectId: 'd', status: 'suggested', count: 1 },
    { projectId: 'd', status: 'archived', count: 3 },
  ];
  const projects = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, repoFullName: `acme/${id}` }));
  assert.deepEqual(scopeOptions(projects, counts).map((option) => [option.id, option.active, option.review]),
    [['d', 0, 1], ['c', 9, 0], ['b', 2, 0], ['a', 0, 0], ['e', 0, 0]]);
  assert.deepEqual(statusCounts(counts, null), { active: 4, suggested: 0, archived: 0 });
  assert.deepEqual(statusCounts(counts, 'd'), { active: 0, suggested: 1, archived: 3 });
});

test('filters match kind and content text', () => {
  const rows = [memory('a', { content: 'Run pnpm test' }), { ...memory('b', { content: 'Billing webhooks' }), kind: 'gotcha' }];
  assert.deepEqual(filterMemories(rows, { text: ' PNPM ' }).map((row) => row.id), ['a']);
  assert.deepEqual(filterMemories(rows, { kind: 'gotcha' }).map((row) => row.id), ['b']);
  assert.deepEqual(filterMemories(rows, {}).map((row) => row.id), ['a', 'b']);
  assert.equal(selectionSize(rows), memoryCost(rows[0]) + memoryCost(rows[1]));
});
