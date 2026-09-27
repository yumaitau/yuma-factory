import { workLane, workReason, type WorkCard } from '@/lib/work-board';
import { sydneyCalendarDate } from '@/lib/datetime';
import type { ReviewPullRequest } from '@/lib/work-review';

export const OUTSTANDING_LANES = ['attention', 'review', 'running', 'waiting', 'queued', 'intake'] as const;
export type OutstandingLane = (typeof OUTSTANDING_LANES)[number];

export const LANE_LABELS: Record<OutstandingLane, string> = {
  attention: 'Needs attention',
  review: 'Review',
  running: 'Running',
  waiting: 'Waiting',
  queued: 'Queued',
  intake: 'Needs preparation',
};

export type OutstandingItem = {
  id: string;
  title: string;
  number: number;
  repo: string;
  htmlUrl: string;
  lane: OutstandingLane;
  reason: string;
  agentName: string | null;
  pullRequestUrl: string | null;
};

export type OutstandingSnapshot = {
  generatedAt: string;
  sydneyDate: string;
  boardUrl: string;
  counts: Record<OutstandingLane, number> & { pulls: number };
  lanes: Record<OutstandingLane, OutstandingItem[]>;
  pulls: ReviewPullRequest[];
  unavailableRepos: string[];
  total: number;
};

const LANE_SET = new Set<string>(OUTSTANDING_LANES);

export function groupOutstanding(
  cards: WorkCard[],
  review: { pulls: ReviewPullRequest[]; unavailableRepos: string[] },
  now = new Date(),
  boardUrl = '/work',
): OutstandingSnapshot {
  const lanes = Object.fromEntries(OUTSTANDING_LANES.map((lane) => [lane, [] as OutstandingItem[]])) as Record<OutstandingLane, OutstandingItem[]>;
  for (const card of cards) {
    const lane = workLane(card);
    if (!LANE_SET.has(lane)) continue;
    const key = lane as OutstandingLane;
    lanes[key].push({
      id: card.id,
      title: card.title,
      number: card.number,
      repo: card.repo,
      htmlUrl: card.htmlUrl,
      lane: key,
      reason: workReason(card),
      agentName: card.agentName,
      pullRequestUrl: card.pullRequestUrl,
    });
  }
  const counts = Object.fromEntries(OUTSTANDING_LANES.map((lane) => [lane, lanes[lane].length])) as Record<OutstandingLane, number> & { pulls: number };
  counts.pulls = review.pulls.length;
  const total = OUTSTANDING_LANES.reduce((sum, lane) => sum + counts[lane], 0) + counts.pulls;
  return {
    generatedAt: now.toISOString(),
    sydneyDate: sydneyCalendarDate(now),
    boardUrl,
    counts,
    lanes,
    pulls: review.pulls,
    unavailableRepos: review.unavailableRepos,
    total,
  };
}