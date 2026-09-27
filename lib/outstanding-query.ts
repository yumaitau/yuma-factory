import 'server-only';

import { appUrl } from '@/lib/env';
import { groupOutstanding, type OutstandingSnapshot } from '@/lib/outstanding';
import { workBoardCards } from '@/lib/work-board-query';
import { outstandingPullRequests } from '@/lib/work-review-query';

export async function outstandingSnapshot(now = new Date()): Promise<OutstandingSnapshot> {
  const [cards, review] = await Promise.all([workBoardCards(), outstandingPullRequests()]);
  const boardUrl = `${appUrl()}/work`;
  return groupOutstanding(cards, review, now, boardUrl);
}