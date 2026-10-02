import type { RunResult } from '../../shared/codex';

export type RunRequest = {
  accountId: string;
  repoFullName: string;
  defaultBranch: string;
  branchName: string;
  prompt: string;
  prTitle: string;
  issueNumber: number;
  model?: string;
  // Plan runs propose a work breakdown; they never publish code.
  mode?: 'implement' | 'plan';
};
export type DurableJob = {
  accountId: string;
  request: RunRequest;
  attempt: number;
  retryAt?: number;
  leaseUntil?: number;
  progress?: RunResult;
  cancelRequested?: boolean;
  stoppingResult?: RunResult;
  terminalResult?: RunResult;
};
type Operations = {
  inspect(stopping?: boolean): Promise<{ running: boolean; result: RunResult | null; progress: RunResult | null }>;
  start(request: RunRequest, recovering: boolean): Promise<void>;
  pause?(result: RunResult | null): Promise<void>;
};
// Codex is killed after 45 minutes, so a coding phase silent this long has lost its supervisor.
export const SILENT_CODING_MS = 60 * 60_000;
export const retryDelay = (attempt: number) => Math.min(15 * 60_000, 60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 4));

/** Optional evidence/credential reads must not prevent stopping an unhealthy sandbox. */
export async function beforeStop<T>(operation: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => { timer = setTimeout(resolve, 10_000); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A wedged container never answers; without a bound, every check holds the lease and the run never moves.
export const INSPECT_TIMEOUT_MS = 60_000;
async function inspectWithin(ops: Operations, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  try {
    return await Promise.race([
      ops.inspect(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** R2 conditional writes serialize cron/UI polls, including after Worker restarts. */
export async function recoverJob(bucket: R2Bucket, id: string, accountId: string, ops: Operations, now = Date.now(), cancel = false): Promise<RunResult> {
  const key = `jobs/${id}`;
  const saved = await bucket.get(key);
  if (!saved) throw new Error('Durable job unavailable.');
  const job = await saved.json<DurableJob>();
  if (job.accountId !== accountId) throw new Error('Account does not own this run.');
  if (job.terminalResult) return job.terminalResult;
  const waiting = (): RunResult => ({ ...job.progress, status: 'running', log: job.progress?.log ?? 'Waiting for runner startup.' });
  if (job.leaseUntil && job.leaseUntil > now) return waiting();
  job.leaseUntil = now + 15 * 60_000;
  let lease = await bucket.put(key, JSON.stringify(job), { onlyIf: { etagMatches: saved.etag } });
  if (!lease) return waiting();
  const save = async () => {
    const updated = await bucket.put(key, JSON.stringify(job), { onlyIf: { etagMatches: lease!.etag } });
    if (!updated) throw new Error('Recovery lease changed.');
    lease = updated;
  };
  try {
    if (cancel) {
      // Persist intent before stopping: a crashed request must never resume coding.
      job.cancelRequested = true;
      await save();
    }
    if (job.cancelRequested || job.stoppingResult) {
      if (!ops.pause) throw new Error('Runner cannot safely stop this job.');
      if (!job.stoppingResult) {
        const state = await beforeStop(() => ops.inspect(true));
        job.stoppingResult = state?.result?.status === 'succeeded' ? state.result : {
          status: 'cancelled',
          log: `${state?.result?.log ?? job.progress?.log ?? ''}\nStopped by user. Automatic recovery disabled. Existing branch and PR preserved.`,
          pullRequestUrl: state?.result?.pullRequestUrl ?? job.progress?.pullRequestUrl,
          ...(state?.result?.accountStatus ? { accountStatus: state.result.accountStatus } : {}),
        };
        // Preserve completion evidence even if the request crashes after destruction.
        await save();
      }
      await ops.pause(job.stoppingResult);
      job.terminalResult = job.stoppingResult;
      return job.terminalResult;
    }
    if (!job.request) throw new Error('Legacy run has no durable recovery request.');
    if (job.retryAt && job.retryAt > now) return waiting();
    if (job.attempt) {
      const state = await inspectWithin(ops, INSPECT_TIMEOUT_MS) ?? {
        running: false, progress: null,
        result: { ...job.progress, status: 'failed' as const, log: `${job.progress?.log ?? ''}\nRunner sandbox stopped responding. Restarting on a fresh runner.` },
      };
      if (state.result?.status === 'succeeded') {
        // Keep completion evidence under the recovery lease before sandbox destruction.
        job.stoppingResult = state.result;
        await save();
        await ops.pause?.(state.result);
        job.terminalResult = state.result;
        return state.result;
      }
      // Running containers keep their installed scripts across deployments.
      // Enforce the same deadline for legacy supervisors using their last
      // deduplicated main-CI progress message, never unrelated coding output.
      const lastProgress = state.progress?.log.trim().split('\n').at(-1) ?? '';
      if (state.running && !state.result && /^Waiting for the main pipeline[.:]/.test(lastProgress) &&
        state.progress?.outputUpdatedAt && now - Date.parse(state.progress.outputUpdatedAt) >= 30 * 60_000) {
        state.result = { ...state.progress, status: 'failed', retryable: false,
          log: `${state.progress.log}\nMain pipeline did not complete within 30 minutes. Check workflow triggers and pending checks before retrying. Ticket left open; subscription released.` };
      }
      // Before a PR exists, the bridge always reports new output within Codex's time limit.
      // Silence past it means a wedged supervisor; restart it on a fresh sandbox.
      if (state.running && !state.result && !state.progress?.pullRequestUrl && state.progress?.outputUpdatedAt &&
        now - Date.parse(state.progress.outputUpdatedAt) >= SILENT_CODING_MS) {
        state.result = { ...state.progress, status: 'failed',
          log: `${state.progress.log}\nNo output for 60 minutes while coding. Restarting on a fresh runner.` };
      }
      // Repeating coding cannot grant a GitHub App permission. Preserve the PR
      // and surface the failed run instead of reserving this account indefinitely.
      if (state.result?.status === 'failed' && /refusing to allow a GitHub App to create or update workflow [^\n]+ without `workflows` permission/.test(state.result.log)) {
        state.result = { ...state.result, retryable: false,
          log: `${state.result.log}\nGitHub App Workflows write permission is required. Update the installation before retrying. Ticket and existing PR remain open.` };
      }
      if (state.result?.status === 'cancelled' || (state.result?.status === 'failed' && state.result.retryable === false)) {
        job.stoppingResult = state.result;
        await save();
        await ops.pause?.(state.result);
        job.terminalResult = state.result;
        return state.result;
      }
      if (state.running && !state.result) {
        delete job.retryAt;
        job.progress = state.progress ?? waiting();
        return waiting();
      }
      await ops.pause?.(state.result);
      if (!job.retryAt) {
        job.retryAt = now + retryDelay(job.attempt);
        job.progress = {
          ...state.result, ...state.progress, status: 'running',
          log: `${state.result?.log ?? 'Runner interrupted.'}\nAutomatic recovery scheduled for ${new Date(job.retryAt).toISOString()}. Existing branch and PR will be reused.`,
        };
        return waiting();
      }
    }
    const recovering = job.attempt > 0;
    job.attempt++;
    delete job.retryAt;
    job.progress = { ...job.progress, status: 'running', log: `Starting attempt ${job.attempt}; recovering the same branch and PR when present.` };
    // Record intent before effects so a Worker crash cannot lose the job.
    await save();
    try {
      await ops.start(job.request, recovering);
    } catch {
      // A failed start may have reached the sandbox. Release the account only
      // after confirming no process is running; an uncertain response is retried.
      try {
        const state = await ops.inspect();
        if (!state.running) await ops.pause?.(state.result);
      } catch { /* Next poll reconciles an unreachable sandbox. */ }
      job.retryAt = now + retryDelay(job.attempt);
      job.progress = { ...job.progress, status: 'running', log: `Runner/account/GitHub unavailable. Automatic retry at ${new Date(job.retryAt).toISOString()}; ticket remains open.` };
    }
    return waiting();
  } finally {
    delete job.leaseUntil;
    await save();
  }
}
