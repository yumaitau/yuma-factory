'use client';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { cancelRunAction, moveTicketAction } from '@/app/actions/factory';
import { useRouter } from 'next/navigation';
import { workLane, workReason, type WorkCard } from '@/lib/work-board';
import { formatSydneyDateTime } from '@/lib/datetime';
import { ticketRisk } from '@/shared/ticket-risk';
import { LABEL_PREFIX, LABELS } from '@/lib/brand';

function riskCopy(labels: string[]) {
  const risk = ticketRisk(labels, LABEL_PREFIX);
  if (!risk) return null;
  return risk === 'low' ? 'Low risk · auto-merge' : `${risk[0].toUpperCase()}${risk.slice(1)} risk`;
}

const lanes = [
  ['intake', 'Needs preparation'], ['queued', 'Queued'], ['running', 'Running'], ['waiting', 'Waiting'],
  ['review', 'Review'], ['attention', 'Needs attention'], ['done', 'Done'],
] as const;

export function WorkBoard({ cards, refreshedAt }: { cards: WorkCard[]; refreshedAt: string }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState('');
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(Date.parse(refreshedAt));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); if (document.visibilityState === 'visible') router.refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [router]);
  const visible = cards.filter((card) => (!repo || card.repo === repo) &&
    `${card.repo} ${card.title} #${card.number} ${card.agentName ?? ''}`.toLowerCase().includes(search.toLowerCase()) &&
    (all || card.runId || card.labels.some((label) => label.toLowerCase() === LABELS.ready)));
  return <section aria-label="Factory work board" className="min-w-0">
    {error && <p role="alert" className="mb-4 text-red-700">{error}</p>}
    <div className="mb-5 flex flex-wrap items-end gap-4">
      <label className="flex min-w-0 basis-60 flex-1 flex-col gap-1 text-sm">Search work
        <input type="search" className="rounded-md border bg-background px-3 py-2" placeholder="Ticket, repository or agent…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">Repository
        <select className="w-full min-w-0 max-w-72 rounded-md border bg-background px-3 py-2" value={repo} onChange={(event) => setRepo(event.target.value)}>
          <option value="">All repositories</option>{[...new Set(cards.map((card) => card.repo))].sort().map((name) => <option key={name}>{name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} /> Include unlabelled issues</label>
    </div>
    <p className="mb-4 text-xs text-muted-foreground">{visible.length} tickets · Updates every 10 seconds · Last refreshed {formatSydneyDateTime(refreshedAt)}</p>
    <div className="flex min-w-0 gap-4 overflow-x-auto pb-5">
      {lanes.map(([id, label]) => {
        const items = visible.filter((card) => workLane(card) === id);
        return <section key={id} aria-label={`${label} tickets`} className={`w-72 max-w-full shrink-0 rounded-xl border p-3 ${id === 'running' ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
          <h2 className="mb-4 flex items-center justify-between text-sm font-semibold">{label}<span className="rounded-full bg-background px-2 py-0.5 text-xs">{items.length}</span></h2>
          <div className="space-y-3">{items.slice(0, 50).map((card) => <article key={card.id} className="min-w-0 wrap-anywhere rounded-lg border border-border bg-card p-3 shadow-sm">
            <p className="mb-1 break-all text-xs text-muted-foreground">{card.repo} #{card.number}</p>
            {card.runId ? <Link className="block text-sm font-semibold hover:underline" href={`/work/runs/${card.runId}`}>{card.title}</Link>
              : <a className="block text-sm font-semibold hover:underline" href={card.htmlUrl} target="_blank" rel="noreferrer">{card.title}</a>}
            <p className="mt-3 text-xs font-medium">{card.agentName ?? 'Awaiting assignment'}</p>
            {(id === 'running' || id === 'waiting') && card.startedAt && <p className="mt-1 text-xs text-primary" role="status">{id === 'waiting' ? 'Waiting' : card.completionPending ? 'Finalizing' : 'Running'} · {Math.max(0, Math.floor((now - Date.parse(card.startedAt)) / 60_000))} min total elapsed</p>}
            <p className="mt-2 text-xs text-muted-foreground">{workReason(card)}</p>
            {id === 'waiting' && card.runId && <div className="mt-3 space-y-2 text-xs">
              <Link href="/pool" className="block underline">Manage subscriptions</Link>
              <button type="button" disabled={pending} className="rounded border px-2 py-1 font-medium disabled:opacity-50" onClick={() => {
                setError('');
                startTransition(async () => {
                  try {
                    const result = await cancelRunAction(card.runId!);
                    if (result.error) setError(result.error);
                    else router.refresh();
                  } catch { setError('Could not stop this run. Try again.'); }
                });
              }}>{pending ? 'Stopping…' : 'Stop and return to intake'}</button>
              <p className="text-muted-foreground">Stops retries. Keeps the existing branch and PR.</p>
            </div>}
            {(id === 'attention' || card.runStatus === 'cancelled') && <div className="mt-3 space-y-2 text-xs">
              <button type="button" disabled={pending} className="rounded border px-2 py-1 font-medium disabled:opacity-50" onClick={() => {
                setError('');
                startTransition(async () => {
                  try {
                    const result = await moveTicketAction(card.id, 'intake');
                    if (result.error) setError(result.error);
                    else router.refresh();
                  } catch { setError('Could not move this ticket. Try again.'); }
                });
              }}>{pending ? 'Moving…' : 'Move to Needs preparation'}</button>
              <p className="text-muted-foreground">Clears the previous attempt. Factory picks it up again while it has {LABELS.ready}.</p>
            </div>}
            {riskCopy(card.labels) && <p className="mt-2 text-xs font-medium">{riskCopy(card.labels)}</p>}
            <div className="mt-3 flex flex-wrap gap-1">{card.labels.map((label) => <span key={label} className="min-w-0 max-w-full rounded bg-muted px-1.5 py-0.5 text-[11px]">{label}</span>)}</div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">{card.runId && <Link className="font-medium text-primary underline" href={`/work/runs/${card.runId}`}>{id === 'running' ? 'Watch live' : 'View output'}</Link>}
              <Link className="underline" href={`/projects/${card.projectId}`}>Project board</Link>
              {card.pullRequestUrl && <a className="underline" href={card.pullRequestUrl} target="_blank" rel="noreferrer">Review PR</a>}</div>
          </article>)}{!items.length && <p className="py-5 text-center text-xs text-muted-foreground">No tickets</p>}
          {items.length > 50 && <p className="text-xs text-muted-foreground">Showing first 50. Filter by repository or search to narrow results.</p>}</div>
        </section>;
      })}
    </div>
  </section>;
}
