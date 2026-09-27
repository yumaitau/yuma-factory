// Pure planner rules: validate an agent's breakdown and render what people and agents see.

import { PLAN_PATH } from '@/lib/memory';

export const MAX_PLAN_TASKS = 12;

export type PlanTask = { key: string; title: string; body: string; dependsOn: string[]; files: string[] };
export type Plan = { summary: string; tasks: PlanTask[] };

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Throws a readable error for invalid, oversized or cyclic plans. Returns tasks in dependency order. */
export function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { tasks?: unknown }).tasks))
    throw new Error('Plan must be an object with a tasks array.');
  const input = raw as { summary?: unknown; tasks: unknown[] };
  if (!input.tasks.length) throw new Error('Plan has no tasks.');
  if (input.tasks.length > MAX_PLAN_TASKS) throw new Error(`Plan has more than ${MAX_PLAN_TASKS} tasks.`);
  const tasks: PlanTask[] = input.tasks.map((item, index) => {
    const task = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const key = text(task.key, 40).toLowerCase();
    const title = text(task.title, 200);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`Task ${index + 1} needs a key of lowercase letters, digits or hyphens.`);
    if (!title) throw new Error(`Task ${key} needs a title.`);
    const list = (value: unknown, max: number) => Array.isArray(value)
      ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))].slice(0, max)
      : [];
    return { key, title, body: text(task.body, 6000), dependsOn: list(task.dependsOn, MAX_PLAN_TASKS).map((dep) => dep.toLowerCase()), files: list(task.files, 30) };
  });
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) throw new Error(`Duplicate task key ${task.key}.`);
    keys.add(task.key);
  }
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!keys.has(dep)) throw new Error(`Task ${task.key} depends on unknown task ${dep}.`);
    if (dep === task.key) throw new Error(`Task ${task.key} depends on itself.`);
  }
  return { summary: text(input.summary, 4000) || 'Planner breakdown.', tasks: dependencyOrder(tasks) };
}

function dependencyOrder(tasks: PlanTask[]) {
  const ordered: PlanTask[] = [];
  const done = new Set<string>();
  const remaining = [...tasks];
  while (remaining.length) {
    const index = remaining.findIndex((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (index < 0) throw new Error('Plan dependencies form a cycle.');
    const [task] = remaining.splice(index, 1);
    ordered.push(task);
    done.add(task.key);
  }
  return ordered;
}

/** Tasks sharing files cannot run in parallel safely; flag them so reviewers can add a dependency. */
export function fileConflicts(tasks: PlanTask[]) {
  const reachable = (from: string, to: string): boolean => {
    const task = tasks.find((item) => item.key === from);
    return !!task && task.dependsOn.some((dep) => dep === to || reachable(dep, to));
  };
  const conflicts: { a: string; b: string; files: string[] }[] = [];
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const [a, b] = [tasks[i], tasks[j]];
    const shared = a.files.filter((file) => b.files.includes(file));
    if (shared.length && !reachable(a.key, b.key) && !reachable(b.key, a.key)) conflicts.push({ a: a.key, b: b.key, files: shared });
  }
  return conflicts;
}

/** Hidden marker tying a GitHub issue to its plan task, so a crashed apply can find what it created. */
export function planTaskId(planId: string, key: string) {
  return `${planId}:${key}`;
}

export function planTaskFromBody(body: string | null | undefined) {
  return /<!-- factory-plan-task:([a-z]+_[a-f0-9]{32}:[a-z0-9][a-z0-9-]*) -->/.exec(body ?? '')?.[1] ?? null;
}

export function subtaskIssueBody(task: PlanTask, epicNumber: number, issueByKey: Map<string, number>, planId: string) {
  const deps = task.dependsOn.map((dep) => issueByKey.get(dep)).filter((value): value is number => !!value);
  return [
    `Part of #${epicNumber}.`,
    deps.length ? `Blocked by ${deps.map((number) => `#${number}`).join(', ')}.` : '',
    '',
    task.body,
    task.files.length ? `\nLikely files:\n${task.files.map((file) => `- \`${file}\``).join('\n')}` : '',
    `\n<!-- factory-plan-task:${planTaskId(planId, task.key)} -->`,
  ].filter((line, index) => line || index === 2).join('\n');
}

export function planComment(plan: Plan, status: 'proposed' | 'applied') {
  return [
    status === 'proposed' ? '**Factory plan proposed.** Approve it on the Factory Plans page to create subtasks.' : '**Factory plan applied.** Subtasks created below.',
    '',
    plan.summary,
    '',
    ...plan.tasks.map((task, index) => `${index + 1}. **${task.title}** (\`${task.key}\`)${task.dependsOn.length ? ` after ${task.dependsOn.map((dep) => `\`${dep}\``).join(', ')}` : ''}`),
  ].join('\n');
}

export function planInstructions() {
  return `You are the planner. Do not change repository files. Inspect the codebase and split this epic into independently shippable subtasks that separate agents can implement in parallel, each as its own pull request. Minimise overlap: tasks touching the same files must depend on each other. Put shared interfaces first so later tasks build on them. Write ${PLAN_PATH} as JSON: {"summary":"approach and key decisions","tasks":[{"key":"short-kebab-id","title":"...","body":"what to build, acceptance criteria, relevant code locations","dependsOn":["other-key"],"files":["paths/likely/touched"]}]}. At most ${MAX_PLAN_TASKS} tasks. Finish with a short summary of the plan.`;
}
