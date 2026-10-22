import { LABELS } from '@/lib/brand';
import { workLane, type WorkCard } from '@/lib/work-board';

const hasReady = (labels: string[]) => labels.some((label) => label.toLowerCase() === LABELS.ready);

/**
 * Work board drops. People own Needs preparation and Queued; every other lane is set by runs.
 * `requeue` clears a failed or stopped attempt; `ready` adds or removes the pickup label.
 */
export type WorkMove = { error: string } | { requeue: boolean; ready?: boolean };

/** Why a card cannot be dragged at all, or null when it can. */
export function workDragBlocked(card: WorkCard): string | null {
  const from = workLane(card);
  if (card.runStatus === 'running' || card.stage === 'in_progress') return 'Stop the active run on Work before moving this task.';
  if (from === 'review') return 'This run finished. Review its pull request instead of running it again.';
  if (from === 'done') return 'Integrated tasks stay closed. Reopen the issue on GitHub to work on it again.';
  return null;
}

export function workMove(card: WorkCard, target: string): WorkMove {
  const blocked = workDragBlocked(card);
  if (blocked) return { error: blocked };
  if (workLane(card) === target) return { error: 'The task is already here.' };
  if (target === 'attention') return { error: 'Factory moves a task here when its run fails.' };
  if (target === 'review') return { error: 'Factory moves a task here when its run finishes.' };
  if (target === 'running' || target === 'waiting') return { error: 'Factory moves a task here when a run starts.' };
  if (target === 'done') return { error: "Tasks are integrated automatically after the PR's CI is green." };
  if (target !== 'intake' && target !== 'queued') return { error: 'Unknown lane.' };
  if (target === 'queued' && card.assignedAgentId && !card.automationSlot)
    return { error: 'Assigned to an agent that automation does not use. Unassign it on the project board first.' };
  const requeue = ['failed', 'cancelled', 'succeeded'].includes(card.runStatus ?? '');
  const ready = target === 'queued';
  return hasReady(card.labels) === ready ? { requeue } : { requeue, ready };
}

/** The card as it will look once the move succeeds, for optimistic rendering. */
export function movedCard(card: WorkCard, target: string): WorkCard {
  const move = workMove(card, target);
  if ('error' in move) return card;
  return {
    ...card,
    ...(move.requeue ? { stage: 'intake', runStatus: null, runId: null, runMode: null, runOutcome: null, pullRequestUrl: null, pullRequestState: null, startedAt: null, finishedAt: null } : {}),
    ...(move.ready === undefined ? {} : { labels: move.ready ? [...card.labels, LABELS.ready] : card.labels.filter((label) => label.toLowerCase() !== LABELS.ready) }),
  };
}

/** Project board drops between raw stages. Mirrors moveTicketAction and moveTicket's guards. */
export function stageMoveError(from: string, to: string): string | null {
  if (from === to) return 'The ticket is already here.';
  if (from === 'in_progress') return 'Stop the active run on Work before moving this task.';
  if (to === 'in_progress') return 'Start a run to move this ticket into progress.';
  if (to === 'done') return "Tickets are completed automatically after the PR's CI is green.";
  return null;
}
