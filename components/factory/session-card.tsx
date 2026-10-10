'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronRight, Loader2, Square } from 'lucide-react';
import type { PublicActivity, RunSession } from '@/lib/run-activities';
import type { PlanStep } from '@/lib/run-session';
import {
  SESSION_BADGES, collapsedSteps, formatWorkedFor, isLiveSession, isLongText, isStep, liveActivity, mergeSession,
} from '@/lib/session-view';
import { AgentAvatar } from '@/components/factory/agent-avatar';
import { PR_ICONS, StatusIcon, prColor, type StatusKind } from '@/components/factory/status-icon';
import { cn } from '@/lib/utils';

export type SessionAgent = { name: string; color: string };

/**
 * Sessions that may still change are polled every 3 seconds with `?after=lastSeq`, while the tab is visible.
 * Polling stops once every session is finished or the view unmounts. `onSettled` fires when one finishes.
 */
export function useLiveSessions(initial: RunSession[], onSettled?: () => void) {
  const [base, setBase] = useState(initial);
  const [sessions, setSessions] = useState(initial);
  // A fresh server load replaces whatever polling had merged.
  if (base !== initial) { setBase(initial); setSessions(initial); }
  const current = useRef(sessions);
  const settled = useRef(onSettled);
  useEffect(() => { current.current = sessions; settled.current = onSettled; });
  const live = sessions.filter((session) => isLiveSession(session.state)).map((session) => session.run.id).join(' ');
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (id: string) => {
      const after = current.current.find((session) => session.run.id === id)?.lastSeq ?? 0;
      const response = await fetch(`/api/runs/${id}/activities?after=${after}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return;
      const next = await response.json() as RunSession;
      if (controller.signal.aborted) return;
      setSessions((list) => list.map((session) => session.run.id === id ? mergeSession(session, next) : session));
      if (!isLiveSession(next.state)) settled.current?.();
    };
    const tick = async () => {
      if (document.visibilityState === 'visible') await Promise.allSettled(live.split(' ').map(poll));
      if (!controller.signal.aborted) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [live]);
  return sessions;
}

const markdown = 'min-w-0 wrap-anywhere text-[13px] leading-relaxed [&>*+*]:mt-2 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3';

function Markdown({ children, className }: { children: string; className?: string }) {
  return <div className={cn(markdown, className)}>
    <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{children}</ReactMarkdown>
  </div>;
}

const badgeTone = {
  muted: 'border-border text-muted-foreground',
  running: 'border-status-running/40 text-status-running',
  review: 'border-status-review/40 text-status-review',
  attention: 'border-status-attention/40 text-status-attention',
  done: 'border-status-done/40 text-status-done',
};

const planIcon: Record<PlanStep['status'], { kind: StatusKind; progress?: number; color: string; label: string }> = {
  pending: { kind: 'todo', color: 'text-muted-foreground', label: 'To do' },
  inProgress: { kind: 'started', progress: 0.5, color: 'text-status-running', label: 'In progress' },
  completed: { kind: 'done', color: 'text-status-done', label: 'Done' },
  canceled: { kind: 'cancelled', color: 'text-muted-foreground', label: 'Cancelled' },
};

function Plan({ steps }: { steps: PlanStep[] }) {
  return <ol aria-label="Plan" className="space-y-1 rounded-md border border-border bg-background px-3 py-2 text-[13px]">
    {steps.map((step, index) => <li key={index} className="flex items-start gap-2">
      <StatusIcon kind={planIcon[step.status].kind} progress={planIcon[step.status].progress} className={cn('mt-[3px]', planIcon[step.status].color)} />
      <span className="sr-only">{planIcon[step.status].label}: </span>
      <span className={cn('min-w-0 wrap-anywhere', step.status === 'completed' && 'text-muted-foreground', step.status === 'canceled' && 'text-muted-foreground line-through')}>{step.content}</span>
    </li>)}
  </ol>;
}

function Thought({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const long = isLongText(body);
  return <div>
    <Markdown className={cn('text-muted-foreground', long && !open && 'max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]')}>{body}</Markdown>
    {long && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground">{open ? 'Show less' : 'Show more'}</button>}
  </div>;
}

const actionText = (activity: PublicActivity) => `${activity.action}${activity.parameter ? ` · ${activity.parameter}` : ''}`;

function ActionRow({ activity }: { activity: PublicActivity }) {
  const label = <span className="min-w-0 truncate"><span className="font-medium text-foreground">{activity.action}</span>
    {activity.parameter && <> · <code className="font-mono text-[12px]">{activity.parameter}</code></>}</span>;
  if (!activity.result) return <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><span aria-hidden className="w-3.5 shrink-0" />{label}</p>;
  return <details className="group text-[13px]">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90" />{label}
    </summary>
    <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-5">{activity.result}</pre>
  </details>;
}

/** A person's message. Prompts are plain text; only the agent writes markdown. */
export function PromptBubble({ author, body, signal, note }: { author: string; body: string; signal?: string | null; note?: string }) {
  return <div className="ml-8 rounded-lg bg-muted px-3 py-2 text-[13px]">
    <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">{author}{note && ` · ${note}`}</p>
    {signal === 'stop' ? <p className="italic text-muted-foreground">Stop requested</p> : <p className="whitespace-pre-wrap wrap-anywhere">{body}</p>}
  </div>;
}

function Activity({ activity, live, authorName }: { activity: PublicActivity; live: boolean; authorName: (userId: string | null) => string }) {
  switch (activity.type) {
    case 'thought': return <Thought body={activity.body} />;
    case 'action': return <ActionRow activity={activity} />;
    case 'prompt': return <PromptBubble author={authorName(activity.authorUserId)} body={activity.body} signal={activity.signal}
      note={live && !activity.deliveredAt && !activity.signal ? 'Queued' : undefined} />;
    case 'response': return <div className="rounded-md border border-status-done/30 bg-status-done/5 px-3 py-2.5"><Markdown>{activity.body}</Markdown></div>;
    case 'error': return <div className="rounded-md border border-status-attention/30 bg-status-attention/5 px-3 py-2.5 text-status-attention"><Markdown>{activity.body}</Markdown></div>;
    case 'elicitation': return <div className="rounded-md border border-status-review/40 bg-status-review/5 px-3 py-2.5">
      <p className="mb-1 text-[11px] font-medium text-status-review">Agent needs your input</p><Markdown>{activity.body}</Markdown>
    </div>;
    default: return null;
  }
}

/** One run as a Linear-style agent session: who worked, for how long, its plan, and its activity stream. */
export function SessionCard({ session, agent, authorName, expanded = true, onToggle, onStop, continuation, rawLog = true }: {
  session: RunSession; agent: SessionAgent | null; authorName: (userId: string | null) => string;
  expanded?: boolean; onToggle?: () => void; continuation?: boolean; rawLog?: boolean;
  // Resolves to an error message, or null once the stop was recorded.
  onStop?: () => Promise<string | null>;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const { run, state, activities } = session;
  const badge = SESSION_BADGES[state];
  const live = liveActivity(activities, state);
  const steps = collapsedSteps(activities, state);
  const fold = steps > 0 && !showSteps;
  const firstStep = steps ? activities.findIndex(isStep) : -1;
  const running = run.status === 'running' || run.status === 'queued';
  const pr = run.pullRequestUrl && (run.pullRequestState ?? 'open') as keyof typeof PR_ICONS;
  const PrIcon = pr ? PR_ICONS[pr] ?? PR_ICONS.open : null;
  const name = agent?.name ?? 'Agent';
  async function stop() {
    if (!onStop) return;
    setStopping(true); setStopError('');
    const error = await onStop().catch(() => 'Could not stop this run. Try again.');
    if (error) setStopError(error);
    setStopping(false);
  }
  const who = <><AgentAvatar name={agent?.name ?? null} color={agent?.color} live={state === 'active'} />
    <span className="truncate font-medium">{name}</span>
    {continuation && <span className="text-xs font-normal text-muted-foreground">Follow-up</span>}</>;
  return <section aria-label={`${name} session`} className="rounded-lg border border-border bg-card shadow-[0_1px_2px_rgb(28_25_23/0.04)]">
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-[13px]">
      {onToggle ? <button type="button" aria-expanded={expanded} onClick={onToggle}
        className="-m-1 flex min-w-0 items-center gap-2 rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', expanded && 'rotate-90')} />{who}
      </button> : <span className="flex min-w-0 items-center gap-2">{who}</span>}
      <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium', badgeTone[badge.tone])}>
        {state === 'active' && <span aria-hidden className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />}{badge.label}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{formatWorkedFor(session.workedForMs)}</span>
      <span className="ml-auto flex items-center gap-3 text-xs">
        {rawLog && <Link href={`/work/runs/${run.id}`} className="text-muted-foreground hover:text-foreground hover:underline">Raw log</Link>}
        {pr && PrIcon && <a href={run.pullRequestUrl!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
          <PrIcon aria-hidden className={cn('size-3', prColor(pr))} />PR {pr}</a>}
        {onStop && running && <button type="button" disabled={stopping} onClick={stop}
          aria-label="Stop execution and keep changes" title="Stops this run and keeps the branch and pull request."
          className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50">
          <Square className="size-3" aria-hidden />{stopping ? 'Stopping…' : 'Stop'}</button>}
      </span>
    </header>
    {stopError && <p role="alert" className="px-3 pb-2 text-xs text-status-attention">{stopError}</p>}
    {expanded && <div className="space-y-2.5 border-t border-border px-3 py-3">
      {!!session.plan?.length && <Plan steps={session.plan} />}
      {activities.map((activity, index) => {
        if (index === firstStep) return <div key="steps" className="space-y-2.5">
          <button type="button" aria-expanded={!fold} onClick={() => setShowSteps(!showSteps)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight aria-hidden className={cn('size-3.5 transition-transform duration-150', !fold && 'rotate-90')} />{fold ? 'Show' : 'Hide'} {steps} {steps === 1 ? 'step' : 'steps'}
          </button>
          {!fold && <Activity activity={activity} live={running} authorName={authorName} />}
        </div>;
        if (fold && isStep(activity)) return null;
        if (activity === live) return <p key={activity.seq} className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
          <span className="truncate">{activity.type === 'action' ? actionText(activity) : activity.body.split('\n')[0]}</span>
        </p>;
        return <Activity key={activity.seq} activity={activity} live={running} authorName={authorName} />;
      })}
      {!activities.length && <p className="text-[13px] text-muted-foreground">
        {state === 'pending' ? 'Waiting for the agent’s first step…' : 'No session activity was recorded for this run. Check the raw log.'}
      </p>}
    </div>}
  </section>;
}
