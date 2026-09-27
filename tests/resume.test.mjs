import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingRun } from '../sandbox-runner/scripts/resume.mjs';
const req = { repoFullName: 'owner/repo', branchName: 'factory/ticket-1', defaultBranch: 'main', issueNumber: 1 };
const pr = { number: 42, state: 'open', head: { ref: req.branchName, repo: { full_name: req.repoFullName } } };
const branch = { object: { sha: 'a'.repeat(40) } };
const missing = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };

test('recovery finds same PR; crash after push but before PR creation reuses branch', async () => {
  const same = { pr, branch, cloneBranch: req.branchName, publishBranch: req.branchName, resumeMain: false };
  assert.deepEqual(await findExistingRun(req, async () => branch, async () => [pr]), same);
  assert.deepEqual(await findExistingRun(req, async () => branch, async () => []), { ...same, pr: undefined });
  assert.deepEqual(await findExistingRun(req, missing, async () => []), { pr: undefined, branch: null, cloneBranch: req.defaultBranch, publishBranch: req.branchName, resumeMain: false });
});
test('closed PR, deleted branch and API outages never become a fresh run', async () => {
  await assert.rejects(findExistingRun(req, async () => branch, async () => [{ ...pr, state: 'closed' }]), { retryable: false });
  await assert.rejects(findExistingRun(req, missing, async () => [pr]), { retryable: false });
  await assert.rejects(findExistingRun(req, async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); }, async () => []), /Unavailable/);
});
test('merged PR with an open issue resumes main or the follow-up pull request', async () => {
  const merged = { ...pr, state: 'closed', merged: true, merge_commit_sha: 'm'.repeat(40), html_url: 'https://example/pull/42' };
  const follow = { number: 43, state: 'open', html_url: 'https://example/pull/43', head: { ref: `${req.branchName}-main-1`, sha: 'f'.repeat(40), repo: { full_name: req.repoFullName } } };
  const github = async (path) => String(path).startsWith('/issues/') ? { state: 'open' } : branch;
  const pages = async (path) => String(path).includes('state=open') ? [] : [merged];
  assert.deepEqual(await findExistingRun(req, github, pages), {
    pr: merged, branch: null, cloneBranch: 'main', publishBranch: req.branchName, resumeMain: true,
  });
  assert.equal((await findExistingRun(req, github, async (path) => String(path).includes('state=open') ? [follow] : [merged])).cloneBranch, follow.head.ref);
  await assert.rejects(findExistingRun(req, async (path) => String(path).startsWith('/issues/') ? { state: 'closed' } : branch, pages), { retryable: false });
  await assert.rejects(findExistingRun(req, github, async () => [{ ...merged, merge_commit_sha: '' }]), { retryable: false });
});
