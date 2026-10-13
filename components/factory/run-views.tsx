'use client';
import { useMemo, useState } from 'react';
import { stopRunAction } from '@/app/actions/session';
import type { RunSession } from '@/lib/run-activities';
import type { RunOutput } from '@/lib/run-output';
import { RunOutputView } from '@/components/factory/run-output';
import { SessionCard, useLiveSessions, type SessionAgent } from '@/components/factory/session-card';
import { cn } from '@/lib/utils';

const tab = 'rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The run as an agent session, beside its transcript (the raw log). Session leads once the run has recorded activity. */
export function RunViews({ runId, initial, session, agent, people, viewerId }: {
  runId: string; initial: RunOutput; session: RunSession; agent: SessionAgent | null; people: Record<string, string>; viewerId: string;
}) {
  const [view, setView] = useState<'session' | 'log'>(session.activities.length ? 'session' : 'log');
  // The action's revalidatePath re-renders this page with a fresh session, which replaces the polled one.
  const [live] = useLiveSessions(useMemo(() => [session], [session]));
  const authorName = (userId: string | null) => !userId ? 'Member' : userId === viewerId ? 'You' : people[userId] ?? 'Member';
  return <div>
    <div role="tablist" aria-label="Run views" className="mb-4 inline-flex gap-1 rounded-lg bg-muted p-1">
      {(['session', 'log'] as const).map((id) => <button key={id} type="button" role="tab" id={`run-tab-${id}`} aria-controls={`run-panel-${id}`} aria-selected={view === id}
        onClick={() => setView(id)} className={cn(tab, view === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
        {id === 'session' ? 'Session' : 'Transcript'}
      </button>)}
    </div>
    <div role="tabpanel" id="run-panel-session" aria-labelledby="run-tab-session" hidden={view !== 'session'} className="max-w-3xl">
      <SessionCard session={live} agent={agent} authorName={authorName} rawLog={false} onStop={async () => {
        const result = await stopRunAction(runId);
        return 'error' in result ? result.error ?? 'Could not stop this run. Try again.' : null;
      }} />
    </div>
    <div role="tabpanel" id="run-panel-log" aria-labelledby="run-tab-log" hidden={view !== 'log'}>
      <RunOutputView runId={runId} initial={initial} />
    </div>
  </div>;
}
