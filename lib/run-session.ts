// Pure agent-session rules shared by ingest, the read API and the UI. No database access.

export const ACTIVITY_TYPES = ['thought', 'action', 'elicitation', 'response', 'error', 'prompt'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type SessionState = 'pending' | 'active' | 'awaitingInput' | 'complete' | 'error' | 'stale' | 'stopped';
export const PLAN_STATUSES = ['pending', 'inProgress', 'completed', 'canceled'] as const;
export type PlanStep = { content: string; status: (typeof PLAN_STATUSES)[number] };

/** An agent activity as the runner reports it. Prompts come from people, never from the runner. */
export type IncomingActivity = {
  key: string;
  type: Exclude<ActivityType, 'prompt'>;
  body: string;
  action: string | null;
  parameter: string | null;
  result: string | null;
  ephemeral: boolean;
};

// Runner output is untrusted and can be huge; every field is bounded before it reaches D1.
export const ACTIVITY_LIMITS = { batch: 100, key: 80, body: 8_000, action: 60, parameter: 500, result: 2_000, prompt: 4_000, planSteps: 50, planStep: 500 };
// Matches the runner's SILENT_CODING_MS: past this, recovery treats a silent coding run as wedged.
export const STALE_AFTER_MS = 60 * 60_000;
// workedForMs counts a gap between activities as at most this long.
export const IDLE_CAP_MS = 5 * 60_000;

const clip = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const optional = (value: unknown, max: number) => typeof value === 'string' && value ? clip(value, max) : null;

/** Validate one runner activity; null drops it. Only thoughts and actions may be ephemeral. */
export function normalizeActivity(raw: unknown): IncomingActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const type = item.type;
  if (typeof item.key !== 'string' || !item.key || item.key.length > ACTIVITY_LIMITS.key) return null;
  if (type !== 'thought' && type !== 'action' && type !== 'elicitation' && type !== 'response' && type !== 'error') return null;
  const isAction = type === 'action';
  const action = isAction ? optional(item.action, ACTIVITY_LIMITS.action) : null;
  const body = clip(item.body, ACTIVITY_LIMITS.body);
  if (isAction ? !action : !body.trim()) return null;
  return {
    key: item.key, type, body: isAction ? '' : body, action,
    parameter: isAction ? optional(item.parameter, ACTIVITY_LIMITS.parameter) : null,
    result: isAction ? optional(item.result, ACTIVITY_LIMITS.result) : null,
    ephemeral: item.ephemeral === true && (type === 'thought' || isAction),
  };
}

/** Validate a plan replacement; null means "not a plan". */
export function parseRunPlan(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const item of raw.slice(0, ACTIVITY_LIMITS.planSteps)) {
    const content = optional(item?.content, ACTIVITY_LIMITS.planStep);
    if (!content || !PLAN_STATUSES.includes(item.status)) continue;
    steps.push({ content, status: item.status });
  }
  return steps;
}

/** An ephemeral activity is superseded by the next agent activity; people's prompts do not supersede it. */
export function visibleActivities<T extends { type: string; ephemeral: boolean }>(activities: T[]): T[] {
  const last = activities.findLastIndex((activity) => activity.type !== 'prompt');
  return activities.filter((activity, index) => !activity.ephemeral || index === last);
}

type RunLike = { status: string; startedAt?: Date | null; finishedAt?: Date | null };
type Stamp = { type: string; createdAt: Date };

/**
 * Run status decides finished sessions. A live run is judged by its latest agent activity:
 * none yet is pending, a question is awaitingInput, an hour of silence is stale.
 */
export function sessionState(run: RunLike, last: Stamp | null, now = Date.now()): SessionState {
  if (run.status === 'cancelled') return 'stopped';
  if (run.status === 'failed') return 'error';
  if (run.status === 'succeeded') return 'complete';
  if (!last) return 'pending';
  if (last.type === 'elicitation') return 'awaitingInput';
  if (last.type === 'error') return 'error';
  if (last.type === 'response') return 'complete';
  return now - last.createdAt.getTime() >= STALE_AFTER_MS ? 'stale' : 'active';
}

/** Latest agent activity, ignoring people's prompts, for sessionState. */
export function lastAgentActivity<T extends Stamp>(activities: T[]): T | null {
  return activities.findLast((activity) => activity.type !== 'prompt') ?? null;
}

/**
 * Approximate active time: from run start through each activity to the finish (or now while running),
 * counting every gap as at most IDLE_CAP_MS so CI waits and paused subscriptions do not inflate it.
 */
export function workedForMs(run: RunLike, activities: { createdAt: Date }[], now = Date.now()) {
  const end = run.finishedAt?.getTime() ?? (run.status === 'running' || run.status === 'queued' ? now : null);
  const points = [run.startedAt?.getTime(), ...activities.map((activity) => activity.createdAt.getTime()), end]
    .filter((value): value is number => typeof value === 'number');
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.min(Math.max(points[i] - points[i - 1], 0), IDLE_CAP_MS);
  return total;
}
