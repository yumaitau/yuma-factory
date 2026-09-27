import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniquePullCandidates, matchOpenPulls, parsePullRef } from '../lib/work-review';

test('review queue retains older attempts and deduplicates resumed PRs', () => {
  const candidates = uniquePullCandidates([
    { runId: 'new', repo: 'org/repo', status: 'running', pullRequestUrl: 'https://github.com/org/repo/pull/2' },
    { runId: 'older', repo: 'org/repo', status: 'succeeded', pullRequestUrl: 'https://github.com/org/repo/pull/1' },
    { runId: 'duplicate', repo: 'org/repo', status: 'failed', pullRequestUrl: 'https://github.com/org/repo/pull/2' },
    { runId: 'foreign', repo: 'org/repo', status: 'succeeded', pullRequestUrl: 'https://github.com/other/repo/pull/3' },
  ]);
  assert.deepEqual(candidates.map((c) => c.runId), ['new', 'older']);
  const pulls = matchOpenPulls(candidates, [
    { number: 1, state: 'open', title: 'Completed work awaiting merge', html_url: 'https://github.com/org/repo/pull/1', updated_at: '2026-09-19', draft: false },
    { number: 2, state: 'closed', title: 'Merged', html_url: 'https://github.com/org/repo/pull/2', updated_at: '2026-09-19' },
    { number: 3, state: 'open', title: 'Unrelated', html_url: 'https://github.com/org/repo/pull/3', updated_at: '2026-09-19' },
  ]);
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].runId, 'older');
  assert.equal(pulls[0].running, false);
});

test('PR matching compares repo and number and tolerates URL suffixes', () => {
  assert.deepEqual(parsePullRef('https://github.com/org/repo/pull/12/', 'org/repo'), { repo: 'org/repo', number: 12 });
  assert.deepEqual(parsePullRef('https://github.com/org/repo/pull/12/files', 'org/repo'), { repo: 'org/repo', number: 12 });
  assert.deepEqual(parsePullRef('https://github.com/ORG/REPO/pull/12?x=1#y', 'org/repo'), { repo: 'org/repo', number: 12 });
  assert.equal(parsePullRef('https://github.com/other/repo/pull/12', 'org/repo'), null);
  assert.equal(parsePullRef('not a url', 'org/repo'), null);
  const candidates = uniquePullCandidates([
    { runId: 'ours', repo: 'org/repo', status: 'succeeded', pullRequestUrl: 'https://github.com/org/repo/pull/7/' },
    { runId: 'theirs', repo: 'other/repo', status: 'succeeded', pullRequestUrl: 'https://github.com/other/repo/pull/7' },
  ]);
  assert.equal(candidates.length, 2);
  const ours = candidates.filter((c) => c.repo === 'org/repo');
  const pulls = matchOpenPulls(ours, [
    { number: 7, state: 'open', title: 'Ours', html_url: 'https://github.com/org/repo/pull/7', updated_at: '2026-09-19' },
  ]);
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].runId, 'ours');
  // A same-numbered PR from another repo must not attach to our run.
  const cross = matchOpenPulls(ours, [
    { number: 9, state: 'open', title: 'Other', html_url: 'https://github.com/org/repo/pull/9', updated_at: '2026-09-19' },
  ]);
  assert.equal(cross.length, 0);
});
