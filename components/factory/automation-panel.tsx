'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { checkAutomationNowAction, setAutomationEnabledAction, setAutomationSizeAction } from '@/app/actions/automation';
import type { AutomationStatus } from '@/lib/automation-state';
import { formatSydneyDateTime } from '@/lib/datetime';
import { LABELS } from '@/lib/brand';

const time = (value: string | null) => value ? formatSydneyDateTime(value) : 'Not yet';

export function AutomationPanel({ status, userId }: { status: AutomationStatus; userId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [nextCheck, setNextCheck] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const canManage = !status || status.userId === userId;
  useEffect(() => {
    const update = () => { setNow(Date.now()); setNextCheck(new Date((Math.floor(Date.now() / 300_000) + 1) * 300_000).toISOString()); };
    update();
    const timer = setInterval(() => {
      update();
      if (status?.enabled && document.visibilityState === 'visible') router.refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [status?.enabled, router]);

  function act(action: () => Promise<unknown>) {
    setError('');
    startTransition(async () => {
      try { await action(); router.refresh(); }
      catch (error) { setError(error instanceof Error ? error.message : 'Worker request failed.'); }
    });
  }

  return (
    <section aria-label="Background worker" className="mb-6 rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">Background worker</h2>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium" role="status">
              {!status?.enabled ? 'Paused' : status.interrupted ? 'Interrupted' : status.running ? 'Checking' : status.error ? 'Needs attention' : 'Listening for GitHub events'}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            GitHub pushes new work automatically. Open issues labelled{' '}
            <code className="font-semibold text-foreground">{status?.label ?? LABELS.ready}</code> enter a pool of {status?.targetAgents ?? 10} agents.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">One isolated worker per run, one run per available subscription. Every 5 minutes, refreshes 24 boards as a fallback. Previous attempts need manual review.</p>
        </div>
        {canManage && <div className="flex flex-wrap gap-2">
          {status?.enabled && <Button variant="outline" size="sm" disabled={pending || status.running}
            onClick={() => act(checkAutomationNowAction)}>{pending ? 'Queuing…' : 'Check now'}</Button>}
          {status && <label className="flex items-center gap-2 text-xs">Agents
            <select aria-label="Worker agent count" className="rounded border bg-background p-2" value={status.targetAgents} disabled={pending}
              onChange={(event) => act(() => setAutomationSizeAction(Number(event.target.value)))}>
              {[10, 15, 20].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>}
          <Button variant={status?.enabled ? 'ghost' : 'default'} size="sm" disabled={pending}
            onClick={() => act(() => setAutomationEnabledAction(!status?.enabled))}>
            {status?.enabled ? 'Pause worker' : 'Enable worker'}
          </Button>
        </div>}
      </div>
      {status && <div className="mt-4 border-t border-border pt-3">
        <dl className="flex flex-wrap gap-x-7 gap-y-2 text-xs">
          <div><dt className="text-muted-foreground">Last check (Sydney)</dt><dd className="mt-1">{time(status.lastFinishedAt)}</dd></div>
          <div><dt className="text-muted-foreground">Next fallback check (Sydney)</dt><dd className="mt-1">{status.enabled ? time(nextCheck) : 'Paused'}</dd></div>
          <div><dt className="text-muted-foreground">Board refresh</dt><dd className="mt-1">{status.reposSynced}/{status.boardsTotal} boards · {status.issuesSynced} issues</dd></div>
          <div><dt className="text-muted-foreground">Work</dt><dd className="mt-1">{status.queued} queued · {status.activeRuns} running · {status.waitingRuns} waiting</dd></div>
          <div><dt className="text-muted-foreground">Capacity</dt><dd className="mt-1">{status.idleAgents}/{status.targetAgents} agents idle · {status.availableSubscriptions} subscriptions free</dd></div>
        </dl>
        {status.running && now && status.lastStartedAt && <p role="status" className="mt-3 text-xs">
          Checking for {Math.max(0, Math.floor((now - Date.parse(status.lastStartedAt)) / 1000))}s · last progress {time(status.heartbeatAt)}
          {now - Date.parse(status.heartbeatAt) > 150_000 ? ' · No recent progress. Interrupted checks automatically retry after the lock expires.' : ''}
        </p>}
        {status.interrupted && <p role="alert" className="mt-3 text-sm">Previous check was interrupted. Check now can safely retry; scheduled recovery is automatic.</p>}
        <p className="mt-3 text-sm">{status.summary}</p>
        {status.lastEventAt && <p className="mt-1 text-xs text-muted-foreground">Last push: {status.lastEvent} · {time(status.lastEventAt)}</p>}
        {!status.lastScheduledAt && status.enabled && <p className="mt-1 text-xs text-muted-foreground">Waiting for first scheduled heartbeat. New schedules can take up to 15 minutes to activate.</p>}
        {status.error && <p role="alert" className="mt-2 whitespace-pre-line text-sm text-primary">{status.error}</p>}
        {!status.enabled && <p className="mt-1 text-xs text-muted-foreground">Pausing stops new pickup; existing Codex runs continue.</p>}
        <div className="mt-3 flex gap-4 text-xs">
          <Link className="underline" href="/work">Live work board</Link>
          <Link className="underline" href="/agents">Worker agents</Link>
          <Link className="underline" href="/pool">Codex subscriptions</Link>
        </div>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-primary">{error}</p>}
    </section>
  );
}
