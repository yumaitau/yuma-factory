// Pure presentation rules for agent sessions in the issue panel and on the run page. No database access.
import { visibleActivities, type SessionState } from '@/lib/run-session';
import type { PublicActivity, RunSession } from '@/lib/run-activities';

export const SESSION_BADGES: Record<SessionState, { label: string; tone: 'muted' | 'running' | 'attention' | 'done' | 'review' }> = {
  pending: { label: 'Starting', tone: 'muted' },
  active: { label: 'Working', tone: 'running' },
  awaitingInput: { label: 'Needs input', tone: 'review' },
  complete: { label: 'Done', tone: 'done' },
  error: { label: 'Error', tone: 'attention' },
  stale: { label: 'No activity', tone: 'muted' },
  stopped: { label: 'Stopped', tone: 'muted' },
};

/** The run may still produce activity, so the client keeps polling. */
export const isLiveSession = (state: SessionState) => state === 'pending' || state === 'active' || state === 'awaitingInput' || state === 'stale';

/** Only these states earn a badge on a board card; the others are already told by its lane. */
export const cardSessionBadge = (state: SessionState | null | undefined) =>
  state === 'awaitingInput' || state === 'error' || state === 'stale' ? SESSION_BADGES[state] : null;

/** Apply a poll taken with `?after=lastSeq`: newer activities may supersede an ephemeral one already shown. */
export function mergeSession(current: RunSession, polled: RunSession): RunSession {
  const bySeq = new Map(current.activities.map((activity) => [activity.seq, activity]));
  for (const activity of polled.activities) bySeq.set(activity.seq, activity);
  return { ...polled, activities: visibleActivities([...bySeq.values()].sort((a, b) => a.seq - b.seq)) };
}

export const isStep = (activity: PublicActivity) => activity.type === 'thought' || activity.type === 'action';

/** A complete session folds its thoughts and actions away, the way Linear does, leaving prompts and the answer. */
export function collapsedSteps(activities: PublicActivity[], state: SessionState) {
  return state === 'complete' ? activities.filter(isStep).length : 0;
}

/** The latest ephemeral activity is the agent's live line while it works. */
export function liveActivity(activities: PublicActivity[], state: SessionState) {
  const last = activities.findLast((activity) => activity.type !== 'prompt');
  return state === 'active' && last?.ephemeral ? last : null;
}

export function formatWorkedFor(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Worked for <1m';
  return minutes < 60 ? `Worked for ${minutes}m` : `Worked for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const composerPlaceholder = (state: SessionState) =>
  isLiveSession(state) ? 'Agent will pick this up after its current step' : 'Continue this work…';

// Long thoughts are clamped behind an expand toggle.
export const isLongText = (text: string) => text.length > 600 || text.split('\n').length > 8;
