// Pure presentation rules for the memory page. No database access.
import { memoryCost, memoryScore, type RankableMemory } from '@/lib/memory';

export const ALL_PROJECTS = 'All projects';

export type Inclusion = { label: string; detail: string; tone: 'primary' | 'done' | 'muted' | 'attention' };

/**
 * How a memory reaches a run's prompt. `typical` holds what a ticket with nothing relevant in it receives
 * (memoriesForTicket with no text). It is absent in the All projects view, where each project has its own budget.
 */
export function memoryInclusion(memory: { id: string; pinned: boolean; status: string }, typical?: ReadonlySet<string>): Inclusion {
  if (memory.status === 'suggested') return { label: 'Not used until accepted', tone: 'muted', detail: 'An agent proposed this. Runs ignore it until someone accepts it.' };
  if (memory.status !== 'active') return { label: 'Not used', tone: 'muted', detail: 'Archived memories never reach a run.' };
  if (!typical) return memory.pinned
    ? { label: 'Always included', tone: 'primary', detail: 'Pinned: goes into every run before anything ranked, within each project\'s budget.' }
    : { label: 'Included when relevant', tone: 'muted', detail: 'Ranked against each ticket by priority, track record and relevance, until the project\'s budget is full.' };
  if (memory.pinned) return typical.has(memory.id)
    ? { label: 'Always included', tone: 'primary', detail: 'Pinned: goes into every run before anything ranked.' }
    : { label: 'Pinned, over budget', tone: 'attention', detail: 'Pinned memories alone exceed this project\'s budget, so this one is left out. Raise the budget or unpin something.' };
  return typical.has(memory.id)
    ? { label: 'Included by default', tone: 'done', detail: 'Fits this project\'s budget for a typical ticket. Memories more relevant to a ticket can take its place.' }
    : { label: 'Only when relevant', tone: 'muted', detail: 'Left out of a typical ticket by its score or the budget. A ticket that shares its words can bring it in.' };
}

/** Plain-language outcomes, e.g. "Used in 7 runs · 5 green · 1 failed". Zero counts are left out. */
export function trackRecord(memory: { uses: number; successes: number; failures: number }) {
  if (!memory.uses) return 'Not used in a run yet';
  return [
    `Used in ${memory.uses} ${memory.uses === 1 ? 'run' : 'runs'}`,
    memory.successes ? `${memory.successes} green` : '',
    memory.failures ? `${memory.failures} failed` : '',
  ].filter(Boolean).join(' · ');
}

export function scoreExplanation(memory: Pick<RankableMemory, 'weight' | 'successes' | 'failures'>) {
  return `Ranking score ${memoryScore(memory)}: priority ${memory.weight}, raised by green runs and lowered more by failed ones.`;
}

export function sourceLabel(source: string) {
  return source === 'human' ? 'Added by the team' : source === 'agent' ? 'Learned by an agent' : source === 'planner' ? 'From the planner' : source;
}

export type MemoryCount = { projectId: string | null; status: string; count: number };
export type StatusCounts = { active: number; suggested: number; archived: number };

export function statusCounts(counts: MemoryCount[], projectId: string | null): StatusCounts {
  const totals: StatusCounts = { active: 0, suggested: 0, archived: 0 };
  for (const row of counts) if (row.projectId === projectId && row.status in totals) totals[row.status as keyof StatusCounts] += row.count;
  return totals;
}

export type ScopeOption = { id: string; name: string; active: number; review: number };

/** Projects with memories come first, those needing review before the rest; the others follow alphabetically. */
export function scopeOptions(projects: { id: string; repoFullName: string }[], counts: MemoryCount[]): ScopeOption[] {
  return projects.map((project) => {
    const totals = statusCounts(counts, project.id);
    return { id: project.id, name: project.repoFullName, active: totals.active, review: totals.suggested };
  }).sort((a, b) => Number(b.active + b.review > 0) - Number(a.active + a.review > 0)
    || b.review - a.review || b.active - a.active || a.name.localeCompare(b.name));
}

export function filterMemories<T extends { kind: string; content: string }>(rows: T[], filter: { kind?: string; text?: string }) {
  const text = filter.text?.trim().toLowerCase();
  return rows.filter((row) => (!filter.kind || row.kind === filter.kind) && (!text || row.content.toLowerCase().includes(text)));
}

/** Characters a selection takes from the budget, counted the way rankMemories counts them. */
export function selectionSize(memories: Pick<RankableMemory, 'kind' | 'content'>[]) {
  return memories.reduce((total, memory) => total + memoryCost(memory), 0);
}

/** Who made a history entry; agent runs link to their output. */
export function eventActor(actor: string): { label: string; runId?: string } {
  if (actor.startsWith('run:')) return { label: 'an agent run', runId: actor.slice(4) };
  if (actor.startsWith('user:')) return { label: 'a team member' };
  return { label: actor === 'system' ? 'Factory' : actor };
}

const FIELD_NAMES: Record<string, string> = { weight: 'priority', pinned: 'always included' };

/** One line for an audited change, e.g. "status: archived, priority: 75". */
export function eventSummary(json: string | null) {
  if (!json) return '';
  try {
    const values = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(values).map(([key, value]) => {
      const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
      return `${FIELD_NAMES[key] ?? key}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
    }).join(', ');
  } catch {
    return json;
  }
}
