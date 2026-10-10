import { LABEL_PREFIX, LABELS } from '@/lib/brand';
import { isLowRisk as isLowRiskFor, ticketRisk } from '@/shared/ticket-risk';
import type { SessionState } from '@/lib/run-session';
import { nextRetry } from '@/lib/run-retry';
import { formatSydneyTime } from '@/lib/datetime';

const isLowRisk = (labels: string[]) => isLowRiskFor(labels, LABEL_PREFIX);

export type WorkCard = {
  id: string; title: string; number: number; repo: string; projectId: string; htmlUrl: string;
  stage: string; githubState: string; labels: string[]; assignedAgentId: string | null;
  agentName: string | null; automationSlot: number | null; runStatus: string | null;
  runId: string | null; startedAt: string | null; finishedAt: string | null; pullRequestUrl: string | null;
  agentColor?: string | null;
  // open, merged or closed once the PR sync has seen it.
  pullRequestState?: string | null;
  completionPending?: boolean;
  waitingReason?: string | null;
  runMode?: string | null;
  // Final line of a finished run's log: the supervisor's own verdict.
  runOutcome?: string | null;
  // Open tickets this subtask builds on.
  blockedBy?: number[];
  sessionState?: SessionState | null;
  // Automatic retry state of the latest run (lib/run-retry.ts).
  runAttempt?: number;
  runFailureKind?: string | null;
  runFollowUp?: boolean;
};

// Attention and review lead. Integrated is last so a closed issue is not the headline.
export const WORK_LANES = [
  ['attention', 'Needs attention'],
  ['review', 'Ready for review'],
  ['running', 'Running'],
  ['waiting', 'Waiting'],
  ['queued', 'Queued'],
  ['intake', 'Needs preparation'],
  ['done', 'Integrated'],
] as const;

/** The retry automation will start for a failed card, while the ticket stays eligible for automatic pickup. */
export function scheduledRetry(card: WorkCard) {
  if (card.stage === 'done' || card.githubState !== 'open') return null;
  if (!card.labels.some((label) => [LABELS.ready, LABELS.plan].includes(label.toLowerCase()))) return null;
  if (card.assignedAgentId && !card.automationSlot) return null;
  return nextRetry({ status: card.runStatus ?? '', attempt: card.runAttempt ?? 1, failureKind: card.runFailureKind ?? null,
    followUp: !!card.runFollowUp, finishedAt: card.finishedAt ? new Date(card.finishedAt) : null });
}

export function executionState(card: WorkCard): { id: string; label: string } {
  if ((card.runStatus === 'running' || card.stage === 'in_progress') && card.waitingReason) return { id: 'waiting', label: 'Waiting' };
  if (card.runStatus === 'running' || card.stage === 'in_progress') return card.completionPending
    ? { id: 'validating', label: 'Validating' }
    : { id: 'running', label: 'Running' };
  if (card.runStatus === 'queued') return { id: 'queued', label: 'Queued' };
  if (card.runStatus === 'failed') return scheduledRetry(card) ? { id: 'queued', label: 'Retry scheduled' } : { id: 'failed', label: 'Failed' };
  if (card.runStatus === 'cancelled') return { id: 'cancelled', label: 'Stopped' };
  if (card.runStatus === 'succeeded') return { id: 'completed', label: 'Run completed' };
  return { id: 'idle', label: 'Not started' };
}

// A closed issue is integration. It is not review acceptance, and it is not a release.
export function deliveryState(card: WorkCard): { id: string; label: string } {
  if (card.stage === 'done' || card.githubState !== 'open') return { id: 'integrated', label: 'Integrated' };
  if (card.stage === 'review' || card.runStatus === 'succeeded') return { id: 'in_review', label: 'In review' };
  if (card.pullRequestUrl) return { id: 'pull_request', label: 'Pull request open' };
  return { id: 'open', label: 'Open' };
}

export function workLane(card: WorkCard) {
  if (card.runStatus === 'running' || card.stage === 'in_progress') return card.waitingReason ? 'waiting' : 'running';
  if (card.stage === 'done' || card.githubState !== 'open') return 'done';
  // A failure waits in Queued while it has automatic retries left.
  if (card.runStatus === 'failed') return scheduledRetry(card) ? 'queued' : 'attention';
  if (card.stage === 'review' || card.runStatus === 'succeeded') return 'review';
  // Stopped attempts require a manual decision, just like automationCandidates.
  if (card.runStatus === 'cancelled') return 'intake';
  // A queued attempt is queued.
  const blockingRun = card.runId && card.runStatus !== 'cancelled' && card.runStatus !== 'queued';
  if (card.labels.some((label) => label.toLowerCase() === LABELS.ready) && ['intake', 'assigned'].includes(card.stage) && !blockingRun && (!card.assignedAgentId || card.automationSlot)) return 'queued';
  return 'intake';
}
export function riskLabel(labels: string[]) {
  const risk = ticketRisk(labels, LABEL_PREFIX);
  if (!risk) return null;
  return risk === 'low' ? 'Low risk · auto-merge' : `${risk[0].toUpperCase()}${risk.slice(1)} risk`;
}

/** CI or validation, when the run says anything about it. */
export function ciLabel(card: WorkCard) {
  if (card.completionPending) return 'CI green';
  if (workLane(card) === 'running' && card.pullRequestUrl) return 'CI running';
  if (card.runOutcome?.startsWith('No CI registered')) return 'No CI';
  return null;
}

export function workReason(card: WorkCard) {
  const lane = workLane(card);
  if (lane === 'waiting') return card.waitingReason!;
  if (lane === 'running') return card.completionPending
    ? (isLowRisk(card.labels) ? 'CI green. Merging low-risk PR and closing GitHub issue.' : `CI green. Syncing ${LABELS.done} and closing GitHub issue.`)
    : (card.pullRequestUrl
      ? (isLowRisk(card.labels) ? 'PR ready. Monitoring CI. Low risk merges when green, then watches the default branch pipeline.' : 'PR ready. Monitoring CI and fixing failures before closing the ticket.')
      : 'Codex is working in an isolated worker.');
  if (lane === 'attention') {
    const attempts = card.runAttempt ?? 1;
    if (attempts > 1) return `Failed after ${attempts} attempts: ${card.runOutcome ?? 'review the output, then move it to Needs preparation to retry.'}`;
    return card.runOutcome ? `Run failed: ${card.runOutcome}` : 'Previous run failed. Review the output, then move it to Needs preparation to retry.';
  }
  if (lane === 'review' && card.runOutcome?.startsWith('No CI registered')) return 'No CI on this repository, so Factory did not merge. Review the pull request yourself. Reviewing it does not deploy.';
  if (lane === 'review' && card.runMode === 'plan') return 'Plan proposed. Approve it on the Plans page to create subtasks. That approval does not merge or deploy.';
  if (lane === 'review') return isLowRisk(card.labels)
    ? 'Run completed. The low-risk merge did not finish. Review the pull request. Reviewing it does not deploy.'
    : 'Run completed. Review the change. Merging and deploying are separate decisions.';
  if (lane === 'done') return card.githubState === 'closed'
    ? 'GitHub issue closed. That records integration, not a release and not product acceptance.'
    : 'Marked integrated. Confirm the pull request and any release separately.';
  const retry = scheduledRetry(card);
  if (retry) return `Retry ${retry.number} of ${retry.of} at ${formatSydneyTime(retry.at)}.${card.runOutcome ? ` Last attempt failed: ${card.runOutcome}` : ''}`;
  if (card.runStatus === 'cancelled') return 'Run stopped. Automatic recovery disabled. Move it to Needs preparation to retry.';
  if (!card.labels.some((label) => label.toLowerCase() === LABELS.ready)) return `Add ${LABELS.ready} on GitHub to request automatic pickup.`;
  if (card.assignedAgentId && !card.automationSlot) return 'Assigned to another agent. Start manually or unassign for automatic pickup.';
  if (card.blockedBy?.length) return `Waiting for ${card.blockedBy.map((number) => `#${number}`).join(', ')} to close.`;
  return 'Waiting for an available Factory agent and enabled subscription.';
}
