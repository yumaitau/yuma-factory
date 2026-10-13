import Link from 'next/link';
import { Suspense } from 'react';
import { PageLoading } from '@/components/factory/page-loading';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/factory/app-shell';
import { RunViews } from '@/components/factory/run-views';
import { getRun, getTicketWithContext } from '@/lib/queries';
import { getDb } from '@/lib/db';
import { getRunSession } from '@/lib/run-activities';
import { sessionPeople } from '@/lib/ticket-panel';
import { requireSession } from '@/lib/session';
import { publicRunOutput } from '@/lib/run-output';
import { validId } from '@/shared/codex';
import { formatSydneyDateTime } from '@/lib/datetime';

export const metadata = { title: 'Codex run output' };
export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<PageLoading label="Loading run output…" />}><Run params={params} /></Suspense>;
}
async function Run({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const session = await requireSession();
  const { id } = await params;
  if (!validId(id)) notFound();
  const run = await getRun(id);
  if (!run) notFound();
  const db = await getDb();
  const [context, runSession] = await Promise.all([getTicketWithContext(run.ticketId), getRunSession(db, id)]);
  if (!context || !runSession) notFound();
  const { agents, people } = await sessionPeople(db, [runSession]);
  return <AppShell>
    <Link className="text-sm underline" href="/work">Back to work board</Link>
    <div className="my-6"><p className="break-all text-sm text-muted-foreground">{context.project.repoFullName} #{context.ticket.githubIssueNumber}</p>
      <h1 className="mt-2 wrap-anywhere text-2xl font-semibold">{context.ticket.title}</h1>
      <p className="mt-2 text-xs text-muted-foreground">{run.modelId}{run.startedAt ? ` · Started ${formatSydneyDateTime(run.startedAt.toISOString())}` : ''}</p>
    </div>
    <RunViews runId={id} initial={publicRunOutput({ ...run, outputUpdatedAt: run.finishedAt?.toISOString() ?? null })}
      session={runSession} agent={agents[run.agentId] ?? null} people={people} viewerId={session.user.id} />
  </AppShell>;
}
