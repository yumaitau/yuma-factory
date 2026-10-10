// Pure rules for retrying failed runs automatically. No database access.
// The runner already restarts interrupted runs; these cover runs that ended `failed`.
import type { RunResult } from '@/shared/codex';

/** A failed ticket is retried up to this many times, so it gets at most four attempts. */
export const MAX_AUTO_RETRIES = 3;
/** Wait before retry 1, 2 and 3, counted from the failed run's finish. */
export const RETRY_BACKOFF_MINUTES = [5, 20, 60] as const;
/** How much of the failed run's log the retry prompt carries. */
export const FAILURE_TAIL = 1500;

/**
 * retry: worth another attempt with the failure in the prompt.
 * retry_once: the agent produced nothing; one fresh attempt, then a person decides.
 * human: only a person can fix the cause, such as billing, permissions, CI configuration or a closed PR.
 */
export const FAILURE_KINDS = ['retry', 'retry_once', 'human'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
export const RETRY_BUDGET: Record<FailureKind, number> = { retry: MAX_AUTO_RETRIES, retry_once: 1, human: 0 };

// Bad planner output is model output, and a plan run never publishes, so a retry is safe.
const PLANNER_OUTPUT = /Planner did not write a valid plan file|Planner returned an invalid proposal/;
// Rerunning rarely changes these, often because the work already landed. One fresh look, no more.
const NOTHING_PRODUCED = /produced no file changes|CI still failing after \d+ repairs that changed nothing/;

/** Classify a finished run. The runner marks failures it must not repeat `retryable: false`. */
export function failureKind(result: Pick<RunResult, 'status' | 'retryable' | 'log' | 'accountStatus'>, mode: string): FailureKind | null {
  if (result.status !== 'failed') return null;
  // A signed-out or broken subscription needs its owner, not another attempt.
  if (result.accountStatus?.status === 'disconnected' || result.accountStatus?.status === 'error') return 'human';
  const tail = result.log.slice(-FAILURE_TAIL);
  if (mode === 'plan' && PLANNER_OUTPUT.test(tail)) return 'retry';
  if (mode !== 'plan' && NOTHING_PRODUCED.test(tail)) return 'retry_once';
  return result.retryable === false ? 'human' : 'retry';
}

export type RetryRun = {
  status: string; attempt: number; failureKind: string | null;
  // A person's follow-up prompt; its failure goes back to them.
  followUp: boolean; finishedAt: Date | null;
};

const isFailureKind = (value: string | null): value is FailureKind => FAILURE_KINDS.includes(value as FailureKind);

/** A follow-up continues a run at attempt 1; an automatic retry always has attempt 2 or more. */
export const isFollowUp = (run: { parentRunId: string | null; attempt: number }) => !!run.parentRunId && run.attempt === 1;

/** Retry n (1-based) waits this long after the failure. */
export const retryDelayMs = (retry: number) =>
  RETRY_BACKOFF_MINUTES[Math.min(Math.max(retry, 1), RETRY_BACKOFF_MINUTES.length) - 1] * 60_000;

/** The automatic retry a failed run earns, or null when a person must decide. Mirrors retryDue() in SQL. */
export function nextRetry(run: RetryRun): { number: number; of: number; at: Date } | null {
  if (run.status !== 'failed' || run.followUp || !run.finishedAt || !isFailureKind(run.failureKind)) return null;
  const of = RETRY_BUDGET[run.failureKind];
  // attempt 1 failed, so this is retry 1.
  const number = run.attempt;
  if (number > of) return null;
  return { number, of, at: new Date(run.finishedAt.getTime() + retryDelayMs(number)) };
}

export function failureTail(log: string) {
  const trimmed = log.trimEnd();
  return trimmed.length > FAILURE_TAIL ? `…${trimmed.slice(-FAILURE_TAIL)}` : trimmed;
}

/**
 * What a retry takes from the failed run: the next attempt number, its failure, and its branch while
 * the PR can still take commits, so the retry continues that PR instead of opening another.
 */
export function retryFrom(run: { id: string; attempt: number; mode: string; branchName: string | null; pullRequestState: string | null; log: string }) {
  const continuing = run.mode === 'implement' && !!run.branchName && !['merged', 'closed'].includes(run.pullRequestState ?? '');
  return { parentRunId: run.id, attempt: run.attempt + 1, branchName: continuing ? run.branchName : null, failure: failureTail(run.log) };
}
export type RetryRequest = ReturnType<typeof retryFrom>;
