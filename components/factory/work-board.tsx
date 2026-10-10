'use client';
import Link from 'next/link';
import { startTransition, useEffect, useOptimistic, useRef, useState } from 'react';
import { GitPullRequest, RotateCcw, Square } from 'lucide-react';
import { cancelRunAction, moveWorkCardAction } from '@/app/actions/factory';
import { useRouter } from 'next/navigation';
import { ciLabel, deliveryState, executionState, riskLabel, WORK_LANES, workLane, workReason, type WorkCard } from '@/lib/work-board';
import { movedCard, workDragBlocked, workMove } from '@/lib/board-moves';
import { formatSydneyDateTime } from '@/lib/datetime';
import { parseRiskLabel } from '@/shared/ticket-risk';
import { LABEL_PREFIX, LABELS } from '@/lib/brand';
import { BoardCard, BoardColumn, BoardDnd } from '@/components/factory/board-dnd';
import { LANE_ICONS as laneIcon, PR_ICONS as pullRequestIcon, StatusIcon, prColor, type StatusKind } from '@/components/factory/status-icon';
import { AgentAvatar } from '@/components/factory/agent-avatar';
import { IssuePanel, issueLinkProps, openIssue } from '@/components/factory/issue-panel';
import { cardSessionBadge } from '@/lib/session-view';
import { cn } from '@/lib/utils';

const executionIcon: Record<string, { kind: StatusKind; progress?: number; color: string }> = {
  running: laneIcon.running, waiting: laneIcon.waiting,
  validating: { kind: 'started', progress: 0.5, color: 'text-status-running' },
  queued: laneIcon.queued, failed: laneIcon.attention,
  cancelled: { kind: 'cancelled', color: 'text-muted-foreground' },
  completed: { kind: 'done', color: 'text-status-review' },
  idle: laneIcon.intake,
};

const chip = 'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded border border-border bg-card px-1.5 text-[11px] leading-none text-muted-foreground';
const action = 'inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50';
const isReady = (label: string) => label.toLowerCase() === LABELS.ready;

export function WorkBoard({ cards, refreshedAt }: { cards: WorkCard[]; refreshedAt: string }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState('');
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(Date.parse(refreshedAt));
  // Per-card, so one slow action never locks every other card's buttons.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<{ card: string; message: string } | null>(null);
  // A drop that removes the ready label must not make the card vanish under the default filter.
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  // The optimistic move sits on top of each fresh server render until its action settles.
  const [shown, showMove] = useOptimistic(cards, (state, { id, lane }: { id: string; lane: string }) =>
    state.map((card) => card.id === id ? movedCard(card, lane) : card));
  const dragging = useRef(false);
  // The action's revalidatePath already returns the refreshed board; no extra router.refresh().
  async function act(cardId: string, run: () => Promise<{ error?: string }>, failure: string) {
    setError(null);
    setBusy((ids) => new Set(ids).add(cardId));
    try {
      const result = await run();
      if (result.error) setError({ card: cardId, message: result.error });
    } catch { setError({ card: cardId, message: failure }); }
    finally { setBusy((ids) => { const next = new Set(ids); next.delete(cardId); return next; }); }
  }
  function move(id: string, lane: string) {
    setError(null);
    setMoved((ids) => new Set(ids).add(id));
    startTransition(async () => {
      showMove({ id, lane });
      try {
        const result = await moveWorkCardAction(id, lane);
        if (result.error) setError({ card: id, message: result.error });
      } catch { setError({ card: id, message: 'Could not move this task. Try again.' }); }
    });
  }
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      // A refresh mid-drag would move cards under the pointer.
      if (document.visibilityState === 'visible' && !dragging.current) router.refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [router]);
  const byId = new Map(shown.map((card) => [card.id, card]));
  const visible = shown.filter((card) => (!repo || card.repo === repo) &&
    `${card.repo} ${card.title} #${card.number} ${card.agentName ?? ''}`.toLowerCase().includes(search.toLowerCase()) &&
    (all || card.runId || card.labels.some(isReady) || moved.has(card.id)));
  const laneLabel = (lane: string) => WORK_LANES.find(([id]) => id === lane)?.[1] ?? lane;
  return <section aria-label="Factory work board" className="min-w-0">
    <div className="mb-3 flex flex-wrap items-end gap-3 text-[13px]">
      <label className="flex min-w-0 basis-60 flex-1 flex-col gap-1 text-xs text-muted-foreground">Search work
        <input type="search" className="h-8 rounded-md border bg-card px-2.5 text-[13px] text-foreground" placeholder="Ticket, repository or agent…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground">Repository
        <select className="h-8 w-full min-w-0 max-w-72 rounded-md border bg-card px-2 text-[13px] text-foreground" value={repo} onChange={(event) => setRepo(event.target.value)}>
          <option value="">All repositories</option>{[...new Set(cards.map((card) => card.repo))].sort().map((name) => <option key={name}>{name}</option>)}
        </select>
      </label>
      <label className="flex h-8 items-center gap-2"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} /> Include unlabelled issues</label>
    </div>
    <p className="mb-3 text-xs text-muted-foreground">{visible.length} tickets · Updates every 10 seconds · Last refreshed {formatSydneyDateTime(refreshedAt)} · Drag a task between Needs preparation and Queued</p>
    <BoardDnd id="work-board"
      columnOf={(id) => { const card = byId.get(id); return card && workLane(card); }}
      canDrop={(id, lane) => { const card = byId.get(id); return !!card && !('error' in workMove(card, lane)); }}
      onMove={move}
      onDragging={(value) => { dragging.current = value; }}
      cardLabel={(id) => { const card = byId.get(id); return card ? `${card.repo}#${card.number} ${card.title}` : 'task'; }}
      columnLabel={laneLabel}
      overlay={(id) => { const card = byId.get(id); return card && <div className="w-[17rem] cursor-grabbing rounded-md border border-border bg-card p-2.5 text-[13px] shadow-lg">
        <p className="truncate text-xs text-muted-foreground">{card.repo}#{card.number}</p>
        <p className="mt-1 line-clamp-2 font-medium leading-snug">{card.title}</p>
      </div>; }}>
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-4">
        {WORK_LANES.map(([id, label]) => {
          const items = visible.filter((card) => workLane(card) === id);
          const icon = laneIcon[id];
          return <BoardColumn key={id} id={id} aria-label={`${label} tickets`}
            className={cn('flex w-72 max-w-full shrink-0 flex-col rounded-lg p-1.5', id === 'attention' && items.length ? 'bg-status-attention/5' : 'bg-muted/50')}>
            <h2 className="flex items-center gap-2 px-1.5 pb-2 pt-1 text-[13px] font-medium">
              <StatusIcon kind={icon.kind} progress={icon.progress} className={icon.color} />{label}
              <span className="font-normal tabular-nums text-muted-foreground">{items.length}</span>
            </h2>
            <div className="flex flex-col gap-1.5">{items.slice(0, 50).map((card) => {
              const execution = executionState(card);
              const exec = executionIcon[execution.id] ?? laneIcon.intake;
              const live = id === 'running' || id === 'waiting';
              const reason = workReason(card);
              const ci = ciLabel(card);
              const risk = riskLabel(card.labels);
              const session = cardSessionBadge(card.sessionState);
              const labels = card.labels.filter((name) => !parseRiskLabel(name, LABEL_PREFIX));
              const prState = (card.pullRequestState ?? 'open') as keyof typeof pullRequestIcon;
              const PrIcon = pullRequestIcon[prState] ?? GitPullRequest;
              return <BoardCard key={card.id} id={card.id} label={`${card.repo}#${card.number}`} blocked={workDragBlocked(card)} onOpen={() => openIssue(card.id)}
                className="min-w-0 wrap-anywhere rounded-md border border-border bg-card p-2.5 text-[13px] shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors duration-150 ease-out hover:border-foreground/20">
                {(handle) => <>
                  <div className="flex min-w-0 items-center gap-1.5">
                    {handle}
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{card.repo}#{card.number}</span>
                    <AgentAvatar name={card.agentName} color={card.agentColor} className="ml-auto"
                      live={id === 'running' && !card.completionPending && (!card.sessionState || card.sessionState === 'active' || card.sessionState === 'pending')} />
                  </div>
                  <a draggable={false} className="mt-1 line-clamp-3 font-medium leading-snug hover:underline" {...issueLinkProps(card.id)}>{card.title}</a>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className={chip} title={`${execution.label} · ${deliveryState(card).label}`} role={live ? 'status' : undefined}>
                      <StatusIcon kind={exec.kind} progress={exec.progress} className={cn('size-3', exec.color)} />
                      {execution.label}{live && card.startedAt ? ` · ${Math.max(0, Math.floor((now - Date.parse(card.startedAt)) / 60_000))} min` : ''}
                    </span>
                    {session && <span className={cn(chip, session.tone === 'attention' ? 'border-status-attention/40 text-status-attention' : session.tone === 'review' && 'border-status-review/40 text-status-review')}>{session.label}</span>}
                    {card.pullRequestUrl && <a draggable={false} className={cn(chip, 'hover:bg-muted hover:text-foreground')} href={card.pullRequestUrl} target="_blank" rel="noreferrer" aria-label={`Review PR (${prState})`}>
                      <PrIcon className={cn('size-3', prColor(prState))} aria-hidden />PR {prState}
                    </a>}
                    {ci && <span className={chip}>{ci}</span>}
                    {risk && <span className={chip}>{risk}</span>}
                    {labels.slice(0, 3).map((name) => <span key={name} className={chip} title={name}>
                      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', isReady(name) ? 'bg-primary' : 'bg-muted-foreground/50')} />
                      <span className="truncate">{name}</span>
                    </span>)}
                    {labels.length > 3 && <span className={chip} title={labels.slice(3).join(', ')}>+{labels.length - 3}</span>}
                  </div>
                  <p className="mt-1.5 truncate text-xs text-muted-foreground" title={reason}>{reason}</p>
                  {error?.card === card.id && <p role="alert" className="mt-1.5 text-xs text-status-attention">{error.message}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
                    {card.runId && <Link className="font-medium text-primary hover:underline" href={`/work/runs/${card.runId}`}>{id === 'running' ? 'Watch live' : 'View output'}</Link>}
                    <Link className="text-muted-foreground hover:text-foreground hover:underline" href={`/projects/${card.projectId}`}>Project board</Link>
                    {id === 'waiting' && card.runId && <Link href="/pool" className="text-muted-foreground hover:text-foreground hover:underline">Manage subscriptions</Link>}
                    {id === 'waiting' && card.runId && <button type="button" disabled={busy.has(card.id)} className={cn(action, 'ml-auto')}
                      aria-label="Stop execution and keep changes" title="Stops this run and keeps the branch and pull request. The task returns to Needs preparation."
                      onClick={() => act(card.id, () => cancelRunAction(card.runId!), 'Could not stop this run. Try again.')}>
                      <Square className="size-3" aria-hidden />{busy.has(card.id) ? 'Stopping…' : 'Stop'}</button>}
                    {(id === 'attention' || card.runStatus === 'cancelled') && !('error' in workMove(card, 'queued')) && <button type="button" disabled={busy.has(card.id)} className={cn(action, 'ml-auto')}
                      title={`Clears the previous attempt and queues it with ${LABELS.ready}, the same as dragging it to Queued.`}
                      onClick={() => act(card.id, () => moveWorkCardAction(card.id, 'queued'), 'Could not retry this task. Try again.')}>
                      <RotateCcw className="size-3" aria-hidden />{busy.has(card.id) ? 'Retrying…' : 'Retry'}</button>}
                  </div>
                </>}
              </BoardCard>;
            })}{!items.length && <p className="py-5 text-center text-xs text-muted-foreground">No tickets</p>}
            {items.length > 50 && <p className="px-1.5 py-1 text-xs text-muted-foreground">Showing first 50. Filter by repository or search to narrow results.</p>}</div>
          </BoardColumn>;
        })}
      </div>
    </BoardDnd>
    <IssuePanel />
  </section>;
}
