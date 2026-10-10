import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WORK_LANES } from '@/lib/work-board';

export type StatusKind = 'backlog' | 'todo' | 'started' | 'done' | 'cancelled' | 'attention';

const PIE = 2 * Math.PI * 2.5;

/** Linear-style progress ring. Colour comes from `currentColor`; marks inside filled shapes use the card colour. */
export function StatusIcon({ kind, progress = 0.5, className }: { kind: StatusKind; progress?: number; className?: string }) {
  return <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden className={cn('shrink-0', className)}>
    {kind === 'backlog' && <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.6 1.55" />}
    {kind === 'todo' && <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    {kind === 'started' && <>
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray={`${progress * PIE} ${PIE}`} transform="rotate(-90 7 7)" />
    </>}
    {kind === 'done' && <>
      <circle cx="7" cy="7" r="7" fill="currentColor" />
      <path d="M4.2 7.2 6.1 9 9.8 5.2" fill="none" stroke="var(--card)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>}
    {kind === 'cancelled' && <>
      <circle cx="7" cy="7" r="7" fill="currentColor" />
      <path d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2" stroke="var(--card)" strokeWidth="1.5" strokeLinecap="round" />
    </>}
    {kind === 'attention' && <>
      <path d="M7 1.6 12.7 11.8H1.3Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 5.3v3" stroke="var(--card)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10.1" r="0.8" fill="var(--card)" />
    </>}
  </svg>;
}

type Lane = (typeof WORK_LANES)[number][0];

export const LANE_ICONS: Record<Lane, { kind: StatusKind; progress?: number; color: string }> = {
  attention: { kind: 'attention', color: 'text-status-attention' },
  review: { kind: 'started', progress: 0.75, color: 'text-status-review' },
  running: { kind: 'started', progress: 0.33, color: 'text-status-running' },
  waiting: { kind: 'started', progress: 0.5, color: 'text-status-waiting' },
  queued: { kind: 'todo', color: 'text-muted-foreground' },
  intake: { kind: 'backlog', color: 'text-muted-foreground' },
  done: { kind: 'done', color: 'text-status-done' },
};

export const PR_ICONS = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;
export const prColor = (state: string) => state === 'merged' ? 'text-status-done' : state === 'closed' ? 'text-status-attention' : 'text-status-review';
