import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/factory/app-shell';
import { RunOutputView } from '@/components/factory/run-output';
import { getRun, getTicketWithContext } from '@/lib/queries';
import { requireSession } from '@/lib/session';
import { publicRunOutput } from '@/lib/run-output';
import { validId } from '@/shared/codex';
import { formatSydneyDateTime } from '@/lib/datetime';

export const metadata = { title: 'Codex run output' };
export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<p className="p-6">Loading run output…</p>}><Run params={params} /></Suspense>;
}
async function Run({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const session = await requireSession();
  const { id } = await params;
  if (!validId(id)) notFound();
  const run = await getRun(id);
  if (!run) notFound();
  const context = await getTicketWithContext(run.ticketId);
  if (!context) notFound();
  return <AppShell email={session.user.email}>
    <Link className="text-sm underline" href="/work">Back to work board</Link>
    <div className="my-6"><p className="break-all text-sm text-muted-foreground">{context.project.repoFullName} #{context.ticket.githubIssueNumber}</p>
      <h1 className="mt-2 wrap-anywhere text-2xl font-semibold">{context.ticket.title}</h1>
      <p className="mt-2 text-xs text-muted-foreground">{run.modelId}{run.startedAt ? ` · Started ${formatSydneyDateTime(run.startedAt.toISOString())}` : ''}</p>
    </div>
    <RunOutputView runId={id} initial={publicRunOutput({ ...run, outputUpdatedAt: run.finishedAt?.toISOString() ?? null })} />
  </AppShell>;
}
