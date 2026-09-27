import { connection } from 'next/server';
import { Suspense } from 'react';
import { AppShell } from '@/components/factory/app-shell';
import { AutomationPanel } from '@/components/factory/automation-panel';
import { WorkBoard } from '@/components/factory/work-board';
import { WorkReview } from '@/components/factory/work-review';
import { recentlyCompletedWork } from '@/lib/work-review-query';
import { automationStatus } from '@/lib/automation-state';
import { workBoardCards } from '@/lib/work-board-query';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'Live work board' };
export default function WorkPage() { return <Suspense fallback={<p className="p-6">Loading work board…</p>}><Work /></Suspense>; }
async function Work() {
  await connection();
  const session = await requireSession();
  const [status, cards, completed] = await Promise.all([automationStatus(), workBoardCards(), recentlyCompletedWork()]);
  return <AppShell email={session.user.email} wide>
    <div className="mb-6"><h1 className="text-2xl font-semibold">Live work board</h1>
      <p className="mt-1 text-sm text-muted-foreground">See what is queued, what agents are doing, and what needs your attention.</p></div>
    <AutomationPanel status={status} userId={session.user.id} />
    <WorkReview completed={completed} />
    <WorkBoard cards={cards} refreshedAt={new Date().toISOString()} />
  </AppShell>;
}
