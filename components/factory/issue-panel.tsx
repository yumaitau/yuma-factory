'use client';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { GitBranch } from 'lucide-react';
import { promptRunAction, stopRunAction } from '@/app/actions/session';
import type { TicketPanel } from '@/lib/ticket-panel';
import { ciLabel, riskLabel, WORK_LANES, workLane } from '@/lib/work-board';
import { composerPlaceholder } from '@/lib/session-view';
import { parseRiskLabel } from '@/shared/ticket-risk';
import { LABEL_PREFIX } from '@/lib/brand';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/factory/agent-avatar';
import { PromptBubble, SessionCard, useLiveSessions } from '@/components/factory/session-card';
import { LANE_ICONS, PR_ICONS, StatusIcon, prColor } from '@/components/factory/status-icon';
import { cn } from '@/lib/utils';

type Panel = TicketPanel & { viewerId: string };

// The panel lives in the URL so it can be linked; history.pushState updates useSearchParams without a server round trip.
function setIssue(id: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (id) params.set('issue', id); else params.delete('issue');
  const query = params.toString();
  window.history.pushState(null, '', query ? `?${query}` : window.location.pathname);
}
export const openIssue = (id: string) => setIssue(id);

/** A plain left click opens the panel in place; modified clicks keep the link's new-tab behaviour. */
export function issueLinkProps(id: string) {
  return {
    href: `?issue=${id}`,
    onClick: (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openIssue(id);
    },
  };
}

/** Linear-style issue panel, opened by `?issue=<ticketId>`. Esc closes it and returns focus to the card. */
export function IssuePanel() {
  const id = useSearchParams().get('issue');
  const [lastId, setLastId] = useState(id);
  if (id && id !== lastId) setLastId(id);
  return <Sheet open={!!id} onOpenChange={(open) => { if (!open) setIssue(null); }}>
    <SheetContent aria-describedby={undefined} onCloseAutoFocus={(event) => {
      const card = lastId && document.querySelector<HTMLElement>(`[data-card="${CSS.escape(lastId)}"]`);
      if (card) { event.preventDefault(); card.focus(); }
    }}>
      {id && <PanelBody key={id} id={id} />}
    </SheetContent>
  </Sheet>;
}

async function fetchPanel(id: string, signal?: AbortSignal) {
  const response = await fetch(`/api/tickets/${id}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 404 ? 'This ticket no longer exists.' : 'Could not load this ticket. Try again.');
  return await response.json() as Panel;
}

function PanelBody({ id }: { id: string }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState('');
  const failed = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load this ticket. Try again.');
  const load = useCallback(() => fetchPanel(id).then((next) => { setPanel(next); setError(''); }, failed), [id]);
  useEffect(() => {
    const controller = new AbortController();
    fetchPanel(id, controller.signal).then(setPanel, (cause) => { if (!controller.signal.aborted) failed(cause); });
    return () => controller.abort();
  }, [id]);
  if (!panel) return <div className="p-5">
    <SheetTitle className="text-base font-semibold">{error ? 'Ticket unavailable' : 'Loading ticket…'}</SheetTitle>
    {error && <p role="alert" className="mt-2 text-sm text-status-attention">{error}</p>}
  </div>;
  return <IssueView panel={panel} reload={load} />;
}

const chip = 'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded border border-border bg-card px-1.5 text-[11px] leading-none text-muted-foreground';

function Property({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="pt-0.5 text-xs text-muted-foreground">{label}</dt><dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd></>;
}

function IssueView({ panel, reload }: { panel: Panel; reload: () => Promise<void> }) {
  const { card, agents, people, viewerId } = panel;
  const sessions = useLiveSessions(panel.sessions, () => void reload());
  const latest = sessions.at(-1);
  // Older sessions start folded; the newest starts open. Either can be toggled.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, []);
  const lane = workLane(card);
  const laneIcon = LANE_ICONS[lane];
  const laneLabel = WORK_LANES.find(([value]) => value === lane)?.[1] ?? lane;
  const latestAgent = latest && agents[latest.run.agentId];
  const agentName = card.agentName ?? latestAgent?.name ?? null;
  const agentColor = card.agentName ? card.agentColor : latestAgent?.color;
  const risk = riskLabel(card.labels);
  const labels = card.labels.filter((name) => !parseRiskLabel(name, LABEL_PREFIX));
  const ci = ciLabel(card);
  const pr = card.pullRequestUrl && (card.pullRequestState ?? 'open') as keyof typeof PR_ICONS;
  const PrIcon = pr ? PR_ICONS[pr] ?? PR_ICONS.open : null;
  const authorName = (userId: string | null) => !userId ? 'Member' : userId === viewerId ? 'You' : people[userId] ?? 'Member';

  async function send() {
    const body = text.trim();
    if (!latest || !body || pending) return;
    setError(''); setPending(body); setText('');
    try {
      const result = await promptRunAction(latest.run.id, body);
      if ('error' in result) { setError(result.error); setText(body); }
      else await reload();
    } catch {
      setError('Could not send this prompt. Try again.'); setText(body);
    } finally { setPending(null); }
  }

  return <>
    <header className="border-b border-border px-5 pb-4 pt-4 pr-12">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <StatusIcon kind={laneIcon.kind} progress={laneIcon.progress} className={laneIcon.color} />
        <a href={card.htmlUrl} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline">{card.repo}#{card.number}</a>
      </p>
      <SheetTitle className="mt-1.5 wrap-anywhere text-lg font-semibold leading-snug">{card.title}</SheetTitle>
    </header>
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <dl aria-label="Properties" className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-[13px]">
        <Property label="Status"><StatusIcon kind={laneIcon.kind} progress={laneIcon.progress} className={laneIcon.color} />{laneLabel}</Property>
        <Property label="Assignee">{panel.requestedByUserId ? authorName(panel.requestedByUserId) : <span className="text-muted-foreground">Unassigned</span>}</Property>
        <Property label="Agent"><AgentAvatar name={agentName} color={agentColor} live={latest?.state === 'active'} />{agentName ?? <span className="text-muted-foreground">No agent yet</span>}</Property>
        <Property label="Repository"><span className="wrap-anywhere">{card.repo}</span></Property>
        {risk && <Property label="Risk">{risk}</Property>}
        {!!labels.length && <Property label="Labels">{labels.map((name) => <span key={name} className={chip} title={name}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" /><span className="truncate">{name}</span></span>)}</Property>}
        {panel.branchName && <Property label="Branch"><GitBranch aria-hidden className="size-3.5 text-muted-foreground" /><code className="wrap-anywhere font-mono text-[12px]">{panel.branchName}</code></Property>}
        {pr && PrIcon && <Property label="Pull request"><a href={card.pullRequestUrl!} target="_blank" rel="noreferrer" className={cn(chip, 'hover:bg-muted hover:text-foreground')}>
          <PrIcon aria-hidden className={cn('size-3', prColor(pr))} />PR {pr}</a></Property>}
        {ci && <Property label="CI">{ci}</Property>}
      </dl>
      <section aria-label="Agent sessions" className="mt-6">
        <h3 className="mb-2 text-[13px] font-medium">Activity</h3>
        {!sessions.length && <p className="text-[13px] text-muted-foreground">No agent has worked on this ticket yet.</p>}
        <div className="space-y-2">
          {sessions.map((session) => {
            const newest = session === latest;
            const expanded = newest !== toggled.has(session.run.id);
            return <div key={session.run.id} className={cn(session.run.parentRunId && 'relative before:absolute before:-top-2 before:left-5 before:h-2 before:w-px before:bg-border')}>
              <SessionCard session={session} agent={agents[session.run.agentId] ?? null} authorName={authorName}
                expanded={expanded} continuation={!!session.run.parentRunId}
                onToggle={() => setToggled((ids) => { const next = new Set(ids); if (next.has(session.run.id)) next.delete(session.run.id); else next.add(session.run.id); return next; })}
                onStop={async () => {
                  const result = await stopRunAction(session.run.id);
                  if ('error' in result) return result.error ?? 'Could not stop this run. Try again.';
                  await reload();
                  return null;
                }} />
            </div>;
          })}
          {pending && <PromptBubble author="You" body={pending} note="Sending…" />}
        </div>
      </section>
    </div>
    {latest && <form className="border-t border-border bg-card px-5 py-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label htmlFor="issue-composer" className="sr-only">Message the agent</label>
      <textarea id="issue-composer" rows={3} value={text} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}
        placeholder={composerPlaceholder(latest.state)}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
      {error && <p role="alert" className="mt-1.5 text-xs text-status-attention">{error}</p>}
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">Cmd or Ctrl + Enter to send</span>
        <Button type="submit" size="sm" className="h-7 rounded px-3 text-xs" disabled={!text.trim() || !!pending}>{pending ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>}
  </>;
}
