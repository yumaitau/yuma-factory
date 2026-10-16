import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { FAILURE_TAIL, MAX_AUTO_RETRIES, failureKind, failureTail, isFollowUp, nextRetry, retryDelayMs, retryFrom } from '../lib/run-retry';
import { buildRunPrompt } from '../lib/run-prompt';
import { executionState, workLane, workReason, type WorkCard } from '../lib/work-board';
import { movedCard, workMove } from '../lib/board-moves';
import { claimRun, moveTicket } from '../lib/run-lifecycle';
import { automationCandidates } from '../lib/automation-state';
import * as schema from '../db/schema';
import { lifecycleDatabase } from './support/d1';

const failed = (log: string, extra: object = {}) => ({ status: 'failed' as const, log, ...extra });

test('runner failures that need a person are never retried; agent output failures are', () => {
  // Every retryable:false site in the runner and app, by its message.
  for (const log of [
    'Existing PR is closed. Recovery will not create another PR or reopen the ticket.',
    'Merged PR has no merge commit. Ticket left open.',
    'Existing PR branch is unavailable. Ticket left open.',
    'The previous pull request already merged, so this follow-up cannot continue it. Ticket left open.',
    'Codex changed GitHub Actions workflows or actions. Factory does not publish CI configuration.',
    "GitHub did not start CI jobs: the account's Actions billing or spending limit is blocking them.",
    'Follow-up PR has no CI to verify the main pipeline fix. PR left for review; ticket left open.',
    'Main pipeline did not complete within 2 hours. Check workflow triggers and pending checks before retrying.',
    'refusing to allow a GitHub App to create or update workflow x without `workflows` permission\nGitHub App Workflows write permission is required.',
  ]) assert.equal(failureKind(failed(log, { retryable: false }), 'implement'), 'human', log);
  assert.equal(failureKind(failed('Codex produced no file changes. See summary for details.', { retryable: false }), 'implement'), 'retry_once');
  assert.equal(failureKind(failed('CI still failing after 3 repairs that changed nothing. PR left open for review; ticket left open.', { retryable: false }), 'implement'), 'human');
  assert.equal(failureKind(failed('Planner did not write a valid plan file.', { retryable: false }), 'plan'), 'retry');
  assert.equal(failureKind(failed('ok\nPlanner returned an invalid proposal: too many tasks. Move the ticket to intake to retry.', { retryable: false }), 'plan'), 'retry');
  // Legacy failures the runner did not classify keep the full budget.
  assert.equal(failureKind(failed('Codex sandbox stopped before completing the run. Retry the ticket.'), 'implement'), 'retry');
  // Subscription and auth problems need their owner.
  assert.equal(failureKind(failed('Codex execution stopped.', { accountStatus: { status: 'error', error: 'Codex session needs reconnecting.' } }), 'implement'), 'human');
  assert.equal(failureKind(failed('Codex execution stopped.', { accountStatus: { status: 'disconnected' } }), 'implement'), 'human');
  assert.equal(failureKind(failed('Codex produced no file changes.', { retryable: false, accountStatus: { status: 'disconnected' } }), 'implement'), 'human');
  // Stopped and finished runs are never failures.
  assert.equal(failureKind({ status: 'cancelled', log: 'Stopped by user.' }, 'implement'), null);
  assert.equal(failureKind({ status: 'succeeded', log: 'Done' }, 'implement'), null);
  // GitHub refusing to run CI is re-checked later, not repaired and not left for a person.
  assert.equal(failureKind(failed('GitHub did not run CI jobs: the repository\'s Actions artifact storage quota is full. Fix it in GitHub settings.', { retryable: false }), 'implement'), 'wait');
  assert.equal(failureKind(failed('GitHub did not run CI jobs: budget.', { retryable: false, accountStatus: { status: 'disconnected' } }), 'implement'), 'human');
  assert.equal(failureKind(failed('CI cannot be fixed from this repository: needs a workflow change. PR left open for review; ticket left open.', { retryable: false }), 'implement'), 'human');
  // Only the end of the log decides; an old line earlier in a long log does not.
  assert.equal(failureKind(failed(`Codex produced no file changes.${'x'.repeat(FAILURE_TAIL)}\nBilling blocked.`, { retryable: false }), 'implement'), 'human');
});

test('the messages failureKind matches still exist in the runner', () => {
  const runner = ['bridge.mjs', 'ci.mjs'].map((file) => readFileSync(new URL(`../sandbox-runner/scripts/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.match(runner, /produced no file changes/);
  assert.match(runner, /CI still failing after \$\{MAX_IDLE_REPAIRS\} repairs that changed nothing/);
  assert.match(runner, /Planner did not write a valid plan file/);
  assert.match(runner, /GitHub did not run CI jobs: \$\{block\}/);
  assert.match(readFileSync(new URL('../lib/agent/run.ts', import.meta.url), 'utf8'), /Planner returned an invalid proposal/);
});

test('a failure gets three retries at 5, 20 and 60 minutes, so at most four attempts', () => {
  const finishedAt = new Date('2026-10-10T03:00:00Z');
  const run = { status: 'failed', attempt: 1, failureKind: 'retry', followUp: false, finishedAt };
  assert.equal(MAX_AUTO_RETRIES, 3);
  assert.deepEqual([1, 2, 3, 9].map((n) => retryDelayMs(n)), [5 * 60_000, 20 * 60_000, 60 * 60_000, 60 * 60_000]);
  assert.deepEqual(nextRetry(run), { number: 1, of: 3, at: new Date(finishedAt.getTime() + 5 * 60_000) });
  assert.deepEqual(nextRetry({ ...run, attempt: 2 }), { number: 2, of: 3, at: new Date(finishedAt.getTime() + 20 * 60_000) });
  assert.deepEqual(nextRetry({ ...run, attempt: 3 })?.number, 3);
  assert.equal(nextRetry({ ...run, attempt: 4 }), null);
  // No file changes earns one retry only.
  assert.deepEqual(nextRetry({ ...run, failureKind: 'retry_once' })?.of, 1);
  assert.equal(nextRetry({ ...run, failureKind: 'retry_once', attempt: 2 }), null);
  // A GitHub block is re-checked six times over about three days.
  assert.deepEqual(nextRetry({ ...run, failureKind: 'wait' }), { number: 1, of: 6, at: new Date(finishedAt.getTime() + 60 * 60_000) });
  assert.deepEqual(nextRetry({ ...run, failureKind: 'wait', attempt: 6 })?.at, new Date(finishedAt.getTime() + 24 * 60 * 60_000));
  assert.equal(nextRetry({ ...run, failureKind: 'wait', attempt: 7 }), null);
  for (const blocked of [{ failureKind: 'human' }, { failureKind: null }, { failureKind: 'unknown' }, { followUp: true },
    { status: 'cancelled' }, { status: 'succeeded' }, { finishedAt: null }])
    assert.equal(nextRetry({ ...run, ...blocked }), null, JSON.stringify(blocked));
  assert.equal(isFollowUp({ parentRunId: 'run', attempt: 1 }), true);
  assert.equal(isFollowUp({ parentRunId: 'run', attempt: 2 }), false);
  assert.equal(isFollowUp({ parentRunId: null, attempt: 1 }), false);
});

test('a retry continues the open PR branch and carries the end of the failure', () => {
  const run = { id: 'run_1', attempt: 1, mode: 'implement', branchName: 'factory/ticket-1-abc', pullRequestState: 'open', log: `${'a'.repeat(5000)}\nCI still failing.` };
  const retry = retryFrom(run);
  assert.deepEqual({ ...retry, failure: undefined }, { parentRunId: 'run_1', attempt: 2, branchName: 'factory/ticket-1-abc', failure: undefined, recheck: false });
  // A GitHub block only re-checks the open PR; with no PR to continue, the agent works afresh.
  assert.equal(retryFrom({ ...run, failureKind: 'wait' }).recheck, true);
  assert.equal(retryFrom({ ...run, failureKind: 'wait', pullRequestState: 'closed' }).recheck, false);
  assert.ok(retry.failure.endsWith('CI still failing.') && retry.failure.length === FAILURE_TAIL + 1);
  assert.equal(failureTail('short\n'), 'short');
  // A branch without a PR is reused too: the runner starts it fresh when it was never pushed.
  assert.equal(retryFrom({ ...run, pullRequestState: null }).branchName, 'factory/ticket-1-abc');
  for (const fresh of [{ pullRequestState: 'merged' }, { pullRequestState: 'closed' }, { mode: 'plan' }, { branchName: null }])
    assert.equal(retryFrom({ ...run, ...fresh }).branchName, null, JSON.stringify(fresh));
  const base = { mode: 'implement' as const, issueNumber: 1, title: 'Fix', body: 'Body', agentPrompt: null, memoryBlock: '' };
  const prompt = buildRunPrompt({ ...base, retry: { attempt: 2, failure: retry.failure, continuing: true } });
  assert.match(prompt, /This is attempt 2; the previous attempt at this issue failed\. This checkout is that attempt's branch/);
  assert.match(prompt, /Avoid repeating the failure below[\s\S]*CI still failing\./);
  assert.ok(prompt.indexOf('attempt 2') < prompt.indexOf('Inspect the repository'));
  assert.doesNotMatch(buildRunPrompt({ ...base, retry: { attempt: 2, failure: 'x', continuing: false } }), /This checkout is that attempt's branch/);
  assert.doesNotMatch(buildRunPrompt(base), /previous attempt/);
});

const card: WorkCard = { id: 'ticket', title: 'Fix', number: 1, repo: 'org/repo', projectId: 'project', htmlUrl: 'https://github.com/org/repo/issues/1',
  stage: 'assigned', githubState: 'open', labels: ['factory:ready'], assignedAgentId: 'worker', agentName: 'Worker', automationSlot: 1,
  runStatus: 'failed', runId: 'run', startedAt: null, finishedAt: '2026-10-10T03:00:00.000Z', pullRequestUrl: null,
  runOutcome: 'Codex execution stopped.', runAttempt: 2, runFailureKind: 'retry', runFollowUp: false };

test('a pending retry waits in Queued with its schedule; an exhausted one needs attention', () => {
  assert.equal(workLane(card), 'queued');
  // 03:00Z + 20 minutes is 14:20 in Sydney daylight time.
  assert.equal(workReason(card), 'Retry 2 of 3 at 14:20. Last attempt failed: Codex execution stopped.');
  assert.deepEqual(executionState(card), { id: 'queued', label: 'Retry scheduled' });
  const exhausted = { ...card, runAttempt: 4 };
  assert.equal(workLane(exhausted), 'attention');
  assert.equal(workReason(exhausted), 'Failed after 4 attempts: Codex execution stopped.');
  assert.deepEqual(executionState(exhausted), { id: 'failed', label: 'Failed' });
  const human = { ...card, runAttempt: 1, runFailureKind: 'human', runOutcome: 'Billing blocked.' };
  assert.equal(workLane(human), 'attention');
  assert.equal(workReason(human), 'Run failed: Billing blocked.');
  // Only tickets automation would pick up are retried; rows from before this feature never are.
  for (const manual of [{ labels: [] }, { automationSlot: null }, { runFollowUp: true }, { runFailureKind: undefined }, { githubState: 'closed' }])
    assert.notEqual(workLane({ ...card, ...manual }), 'queued', JSON.stringify(manual));
  assert.equal(workLane({ ...card, labels: ['factory:plan'] }), 'queued');
});

test('dragging a failed card back resets its retry budget', () => {
  assert.deepEqual(workMove({ ...card, runAttempt: 4 }, 'queued'), { requeue: true });
  // Pulling a pending retry back to preparation cancels the retry and the pickup label.
  assert.deepEqual(workMove(card, 'intake'), { requeue: true, ready: false });
  assert.equal(workLane(movedCard(card, 'intake')), 'intake');
  assert.ok('error' in workMove(card, 'queued'));
});

test('automation retries a due failure through claimRun, within budget, and a requeue resets it', async () => {
  const { db, sqlite } = lifecycleDatabase();
  const options = { automationLabel: 'factory:ready', automationLeaseId: 'lease' };
  const input = { ticketId: 'ticket', agentId: 'worker', userId: 'user', accountId: 'account', modelId: 'codex-default', mode: 'implement' as const };
  const reserve = (id: string) => db.insert(schema.accountLeases).values({ holderId: id, accountId: 'account', createdAt: new Date() });
  const candidate = async () => (await automationCandidates(db, 'worker', 'factory:ready')).find((row) => row.ticket.id === 'ticket');
  const minutesAgo = (minutes: number) => new Date(Math.floor(Date.now() / 1000 - minutes * 60) * 1000);
  try {
    await db.insert(schema.automation).values({ id: 'github', enabled: true, userId: 'user', agentId: 'worker', leaseId: 'lease', leaseUntil: new Date(Date.now() + 60_000), updatedAt: new Date() });
    sqlite.exec("UPDATE agents SET automation_slot=1 WHERE id='worker'; UPDATE tickets SET stage='assigned', assigned_agent_id='worker' WHERE id='ticket'");
    await db.insert(schema.runs).values({ id: 'first', ticketId: 'ticket', agentId: 'worker', modelId: 'codex-default', status: 'failed',
      failureKind: 'retry', createdAt: minutesAgo(30), finishedAt: minutesAgo(2), branchName: 'factory/ticket-1-first', log: 'boom' });
    // Inside the five-minute backoff neither the scan nor a direct claim retries it.
    assert.equal(await candidate(), undefined);
    await reserve('early');
    assert.equal(await claimRun(db, { ...input, id: 'early', parentRunId: 'first', attempt: 2 }, options), false);
    await db.update(schema.runs).set({ finishedAt: minutesAgo(6) }).where(eq(schema.runs.id, 'first'));
    assert.equal((await candidate())?.retryOf?.id, 'first');
    // A claim must name the latest failed run with the next attempt number.
    await reserve('wrong');
    assert.equal(await claimRun(db, { ...input, id: 'wrong', parentRunId: 'first', attempt: 3 }, options), false);
    assert.equal(await claimRun(db, { ...input, id: 'wrong' }, options), false);
    await reserve('second');
    assert.equal(await claimRun(db, { ...input, id: 'second', parentRunId: 'first', attempt: 2, branchName: 'factory/ticket-1-first' }, options), true);
    const second = await db.select().from(schema.runs).where(eq(schema.runs.id, 'second')).get();
    assert.deepEqual([second?.attempt, second?.parentRunId, second?.branchName], [2, 'first', 'factory/ticket-1-first']);
    assert.equal(await candidate(), undefined);
    // Attempt 4 has used all three retries.
    sqlite.exec("UPDATE agents SET status='idle'; UPDATE tickets SET stage='assigned' WHERE id='ticket'");
    await db.update(schema.runs).set({ status: 'failed', failureKind: 'retry', attempt: 4, finishedAt: minutesAgo(120) }).where(eq(schema.runs.id, 'second'));
    assert.equal(await candidate(), undefined);
    for (const blocked of [{ attempt: 2, failureKind: 'human' }, { attempt: 2, failureKind: null }, { attempt: 2, failureKind: 'retry_once' }, { attempt: 1, failureKind: 'retry' }]) {
      await db.update(schema.runs).set(blocked).where(eq(schema.runs.id, 'second'));
      assert.equal(await candidate(), undefined, JSON.stringify(blocked));
    }
    await db.update(schema.runs).set({ attempt: 3, failureKind: 'retry' }).where(eq(schema.runs.id, 'second'));
    assert.equal((await candidate())?.retryOf?.id, 'second');
    // A GitHub block waits its own longer schedule: retry 3 is due after six hours, and it gets six re-checks.
    await db.update(schema.runs).set({ failureKind: 'wait' }).where(eq(schema.runs.id, 'second'));
    assert.equal(await candidate(), undefined);
    await db.update(schema.runs).set({ attempt: 6, finishedAt: minutesAgo(1441) }).where(eq(schema.runs.id, 'second'));
    assert.equal((await candidate())?.retryOf?.id, 'second');
    await db.update(schema.runs).set({ attempt: 7 }).where(eq(schema.runs.id, 'second'));
    assert.equal(await candidate(), undefined);
    await db.update(schema.runs).set({ attempt: 3, failureKind: 'retry', finishedAt: minutesAgo(120) }).where(eq(schema.runs.id, 'second'));
    // A person's requeue starts a fresh attempt at 1.
    await db.update(schema.runs).set({ attempt: 4 }).where(eq(schema.runs.id, 'second'));
    await moveTicket(db, 'ticket', 'intake', true);
    assert.equal((await candidate())?.retryOf, null);
    await reserve('fresh');
    assert.equal(await claimRun(db, { ...input, id: 'fresh' }, options), true);
    assert.equal((await db.select().from(schema.runs).where(eq(schema.runs.id, 'fresh')).get())?.attempt, 1);
  } finally { sqlite.close(); }
});
