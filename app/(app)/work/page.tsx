import { connection } from 'next/server';
import { Suspense } from 'react';
import { PageLoading } from '@/components/factory/page-loading';
import { AppShell } from '@/components/factory/app-shell';
import { AutomationPanel } from '@/components/factory/automation-panel';
import { DecisionSummary } from '@/components/factory/decision-summary';
import { WorkBoard } from '@/components/factory/work-board';
import { WorkReview } from '@/components/factory/work-review';
import { recentlyCompletedWork } from '@/lib/work-review-query';
import { automationStatus } from '@/lib/automation-state';
import { workBoardCards } from '@/lib/work-board-query';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'Work' };
export default function WorkPage() { return <Suspense fallback={<PageLoading label="Loading work board…" />}><Work /></Suspense>; }
async function Work() {
  await connection();
  const session = await requireSession();
  const [status, cards, completed] = await Promise.all([automationStatus(), workBoardCards(), recentlyCompletedWork()]);
  return <AppShell wide>
    <div className="mb-6"><h1 className="text-2xl font-semibold">Work</h1>
      <p className="mt-1 text-sm text-muted-foreground">Needs attention, work in progress, and items ready for review. A finished run, a merged pull request, and a release stay separate.</p></div>
    <DecisionSummary cards={cards} />
    <WorkBoard cards={cards} refreshedAt={new Date().toISOString()} />
    <WorkReview completed={completed} />
    <AutomationPanel status={status} userId={session.user.id} />
  </AppShell>;
}
