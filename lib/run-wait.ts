import { hasCapacity, type AccountStatus } from '@/shared/codex';
import { formatSydneyDateTime } from '@/lib/datetime';

type Subscription = {
  // Maintenance lock only; an executing run holds a lease instead.
  activeRunId: string | null;
  // This run holds a lease on the subscription, so it is executing.
  leased: boolean;
  enabled: boolean;
  status: string;
  limitsJson: string | null;
};

/** One corrupt limitsJson row must not 500 status and automation endpoints. */
export function parseLimits(limitsJson: string | null): AccountStatus['limits'] {
  if (!limitsJson) return null;
  try {
    return JSON.parse(limitsJson);
  } catch {
    return null;
  }
}

/** A released subscription is waiting for recovery, not executing this run. */
export function runWaitReason(runId: string, account: Subscription | null, now = Date.now()): string | null {
  if (account?.leased) return null;
  if (!account) return 'Subscription unavailable. Reconnect it to resume this run.';
  if (!account.enabled) return 'Subscription disabled. Enable it to resume this run.';
  if (account.activeRunId) return 'Waiting for the subscription to finish its other operation.';
  if (!['ready', 'limited'].includes(account.status)) return 'Subscription needs reconnecting before this run can resume.';
  const limits: AccountStatus['limits'] = parseLimits(account.limitsJson);
  if (!hasCapacity(limits, now / 1000)) {
    const windows = [limits?.primary, limits?.secondary].filter((w) => w && w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt * 1000 > now));
    const reset = windows.every((w) => w?.resetsAt) ? Math.max(...windows.map((w) => w!.resetsAt!)) : null;
    return `Subscription usage limit reached.${reset ? ` Resets ${formatSydneyDateTime(new Date(reset * 1000).toISOString())}.` : ''} This run will retry automatically.`;
  }
  return 'Waiting for automatic recovery. The existing branch and pull request will be reused.';
}
