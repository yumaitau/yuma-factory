import 'server-only';

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { agentMessages, githubInstallations, plans, projects, ticketDependencies, tickets } from '@/db/schema';
import { LABEL_PREFIX, LABELS } from '@/lib/brand';
import { getGithubApp } from '@/lib/github';
import { ensureRepoLabel } from '@/lib/github-completion';
import { newId } from '@/lib/ids';
import { parsePlan, planComment, planTaskFromBody, planTaskId, subtaskIssueBody, type Plan } from '@/lib/plan';
import type { Db } from '@/lib/queries';
import { riskLabel, ticketRisk } from '@/shared/ticket-risk';

type Ticket = typeof tickets.$inferSelect;

function labelsOf(ticket: Pick<Ticket, 'labels'>): string[] {
  try {
    const parsed: unknown = JSON.parse(ticket.labels ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

export function isPlanTicket(ticket: Pick<Ticket, 'labels'>) {
  return labelsOf(ticket).some((label) => label.toLowerCase() === LABELS.plan);
}

async function repoClient(db: Db, projectId: string) {
  const row = await db.select({ project: projects, installation: githubInstallations }).from(projects)
    .innerJoin(githubInstallations, eq(projects.installationId, githubInstallations.id))
    .where(eq(projects.id, projectId)).get();
  if (!row) throw new Error('Project installation unavailable.');
  const [owner, repo] = row.project.repoFullName.split('/');
  const client = await getGithubApp().getInstallationOctokit(row.installation.installationId);
  return { client, owner, repo, project: row.project };
}

/** Store a thread message and mirror it to the GitHub epic, so the conversation stays auditable. */
export async function postThreadMessage(db: Db, input: {
  threadTicketId: string; kind: 'plan' | 'handoff' | 'agent' | 'human'; body: string;
  fromTicketId?: string | null; runId?: string | null; agentId?: string | null; userId?: string | null; author: string;
}) {
  const thread = await db.select().from(tickets).where(eq(tickets.id, input.threadTicketId)).get();
  if (!thread) throw new Error('Thread ticket not found.');
  const body = input.body.trim().slice(0, 8000);
  if (!body) throw new Error('Message is empty.');
  const id = newId('msg');
  await db.insert(agentMessages).values({
    id, threadTicketId: thread.id, fromTicketId: input.fromTicketId ?? null, runId: input.runId ?? null,
    agentId: input.agentId ?? null, userId: input.userId ?? null, kind: input.kind, body, createdAt: new Date(),
  });
  try {
    const { client, owner, repo } = await repoClient(db, thread.projectId);
    const { data } = await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner, repo, issue_number: thread.githubIssueNumber,
      body: `**${{ human: 'Team note', plan: 'Planner', handoff: 'Agent handoff', agent: 'Agent update' }[input.kind]}** from ${input.author}\n\n${body}`,
      request: { signal: AbortSignal.timeout(20_000) },
    });
    await db.update(agentMessages).set({ githubCommentId: Number(data.id) }).where(eq(agentMessages.id, id));
  } catch {
    // The D1 thread is authoritative; a GitHub outage must not lose the message.
  }
  return id;
}

export async function threadMessages(db: Db, threadTicketId: string, limit = 50) {
  const rows = await db.select().from(agentMessages).where(eq(agentMessages.threadTicketId, threadTicketId))
    .orderBy(desc(agentMessages.createdAt)).limit(limit).all();
  return rows.reverse();
}

/** Goal ancestry for a subtask: epic, approach, siblings and the recent thread. */
export async function epicContext(db: Db, ticket: Ticket) {
  if (!ticket.parentTicketId) return null;
  const epic = await db.select().from(tickets).where(eq(tickets.id, ticket.parentTicketId)).get();
  if (!epic) return null;
  const plan = await db.select({ summary: plans.summary }).from(plans)
    .where(and(eq(plans.ticketId, epic.id), eq(plans.status, 'applied'))).orderBy(desc(plans.createdAt)).get();
  const siblings = await db.select().from(tickets).where(eq(tickets.parentTicketId, epic.id)).orderBy(asc(tickets.githubIssueNumber)).all();
  const blockers = new Set((await db.select().from(ticketDependencies).where(eq(ticketDependencies.ticketId, ticket.id)).all())
    .map((row) => row.dependsOnTicketId));
  const thread = await threadMessages(db, epic.id, 12);
  return {
    epic: { number: epic.githubIssueNumber, title: epic.title, body: epic.body, planSummary: plan?.summary ?? null },
    siblings: siblings.filter((item) => item.id !== ticket.id).map((item) => ({
      number: item.githubIssueNumber, title: item.title, state: item.githubState, stage: item.stage, blocksThis: blockers.has(item.id),
    })),
    thread: thread.map((message) => ({ kind: message.kind, from: message.fromTicketId ? `ticket ${siblings.find((item) => item.id === message.fromTicketId)?.githubIssueNumber ?? ''}`.trim() : message.kind === 'human' ? 'team' : 'planner', body: message.body.slice(0, 2000) })),
  };
}

/** Planner output lands as a proposal; projects that trust their planner apply it immediately. */
export async function storePlan(db: Db, input: { ticket: Ticket; runId: string; raw: unknown }) {
  const plan = parsePlan(input.raw);
  const id = newId('pln');
  const inserted = await db.insert(plans).values({
    id, ticketId: input.ticket.id, runId: input.runId, status: 'proposed', summary: plan.summary,
    tasksJson: JSON.stringify(plan.tasks), createdAt: new Date(),
  }).onConflictDoNothing().returning({ id: plans.id });
  if (!inserted.length) return null;
  const project = await db.select({ autoApprovePlans: projects.autoApprovePlans }).from(projects).where(eq(projects.id, input.ticket.projectId)).get();
  if (project?.autoApprovePlans) {
    await applyPlan(db, id, null);
  } else {
    await postThreadMessage(db, { threadTicketId: input.ticket.id, kind: 'plan', body: planComment(plan, 'proposed'), runId: input.runId, author: 'Factory planner' });
  }
  return id;
}

// An apply interrupted mid-way (Worker eviction, timeout) can be claimed again after this long.
const STALE_APPLY_MS = 10 * 60_000;

/** Create one GitHub sub-issue per task, in dependency order, with blockers recorded for pickup. */
export async function applyPlan(db: Db, planId: string, userId: string | null) {
  const claimed = await db.update(plans).set({ status: 'applying', decidedByUserId: userId, decidedAt: new Date(), error: null })
    .where(and(eq(plans.id, planId), or(
      inArray(plans.status, ['proposed', 'failed']),
      and(eq(plans.status, 'applying'), lt(plans.decidedAt, new Date(Date.now() - STALE_APPLY_MS))),
    ))).returning();
  if (!claimed.length) throw new Error('Plan is not waiting for approval.');
  const row = claimed[0];
  const epic = await db.select().from(tickets).where(eq(tickets.id, row.ticketId)).get();
  if (!epic) throw new Error('Epic ticket not found.');
  const plan: Plan = { summary: row.summary, tasks: parsePlan({ summary: row.summary, tasks: JSON.parse(row.tasksJson) }).tasks };
  try {
    const { client, owner, repo } = await repoClient(db, epic.projectId);
    const params = { owner, repo, request: { signal: AbortSignal.timeout(20_000) } };
    await ensureRepoLabel(client, params, LABELS.ready, '1F6FEB', 'Factory picks this ticket up automatically.');
    // Subtasks inherit the epic's Factory risk so low-risk epics still auto-merge.
    const risk = ticketRisk(labelsOf(epic), LABEL_PREFIX);
    const labels = [LABELS.ready, ...(risk ? [riskLabel(risk, LABEL_PREFIX)] : [])];
    if (risk) await ensureRepoLabel(client, params, riskLabel(risk, LABEL_PREFIX), risk === 'low' ? '2DA44E' : risk === 'medium' ? 'D4A72C' : 'CF222E', `Inherited from epic #${epic.githubIssueNumber}.`);
    const issueByKey = new Map<string, number>();
    const ticketByKey = new Map<string, string>();
    const saveSubtask = async (task: Plan['tasks'][number], issue: GithubIssue) => {
      const now = new Date();
      const planTask = planTaskId(planId, task.key);
      const [ticket] = await db.insert(tickets).values({
        id: newId('tkt'), projectId: epic.projectId, githubIssueNumber: issue.number, githubIssueId: Number(issue.id),
        title: issue.title, body: issue.body ?? null, labels: JSON.stringify(labelNames(issue.labels)), githubState: issue.state,
        htmlUrl: issue.html_url, stage: 'intake', parentTicketId: epic.id, planTask, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        // The issues webhook can import the new issue first; keep its row and add the parent.
        target: [tickets.projectId, tickets.githubIssueNumber], set: { parentTicketId: epic.id, planTask, updatedAt: now },
      }).returning({ id: tickets.id });
      issueByKey.set(task.key, issue.number);
      ticketByKey.set(task.key, ticket.id);
    };
    // Retrying reuses subtasks already recorded in D1.
    const known = await db.select().from(tickets).where(eq(tickets.parentTicketId, epic.id)).all();
    for (const ticket of known) {
      const key = ticket.planTask?.startsWith(`${planId}:`) ? ticket.planTask.slice(planId.length + 1) : null;
      if (key) { issueByKey.set(key, ticket.githubIssueNumber); ticketByKey.set(key, ticket.id); }
    }
    // A crash between creating an issue and recording it leaves it only on GitHub; find it by its marker.
    if (plan.tasks.some((task) => !ticketByKey.has(task.key))) {
      for (const issue of await issuesSince(client, params, row.createdAt)) {
        // Only issues the Factory App created can be adopted as its subtasks.
        const marker = issue.user?.type === 'Bot' ? planTaskFromBody(issue.body) : null;
        const task = plan.tasks.find((item) => marker === planTaskId(planId, item.key));
        if (task && !ticketByKey.has(task.key)) await saveSubtask(task, issue);
      }
    }
    for (const task of plan.tasks) {
      if (ticketByKey.has(task.key)) continue;
      const body = subtaskIssueBody(task, epic.githubIssueNumber, issueByKey, planId);
      const { data: issue } = await client.request('POST /repos/{owner}/{repo}/issues', { ...params, title: task.title, body, labels });
      await saveSubtask(task, issue);
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        ...params, issue_number: epic.githubIssueNumber, sub_issue_id: Number(issue.id),
      }).catch(() => {}); // Sub-issue links are a GitHub convenience; D1 holds the parent.
    }
    const deps = plan.tasks.flatMap((task) => task.dependsOn.map((dep) => ({ ticketId: ticketByKey.get(task.key)!, dependsOnTicketId: ticketByKey.get(dep)! })));
    for (let offset = 0; offset < deps.length; offset += 40)
      await db.insert(ticketDependencies).values(deps.slice(offset, offset + 40)).onConflictDoNothing();
    await db.update(plans).set({ status: 'applied' }).where(eq(plans.id, planId));
    await postThreadMessage(db, {
      threadTicketId: epic.id, kind: 'plan', runId: row.runId, author: 'Factory planner',
      body: `${planComment(plan, 'applied')}\n\n${plan.tasks.map((task) => `- #${issueByKey.get(task.key)} ${task.title}`).join('\n')}`,
    });
  } catch (error) {
    await db.update(plans).set({ status: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Could not apply plan.' }).where(eq(plans.id, planId));
    throw error;
  }
}

type GithubIssue = { id: number | bigint; number: number; title: string; body?: string | null; state: string; html_url: string; labels: unknown[]; pull_request?: unknown; user?: { type?: string } | null };

function labelNames(labels: unknown[]) {
  return labels.map((label) => typeof label === 'string' ? label : (label as { name?: string } | null)?.name).filter((name): name is string => !!name);
}

/** Issues touched since the plan was proposed; bounded so a busy repository cannot stall an apply. */
async function issuesSince(client: Awaited<ReturnType<typeof repoClient>>['client'], params: { owner: string; repo: string; request: { signal: AbortSignal } }, since: Date) {
  const found: GithubIssue[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await client.request('GET /repos/{owner}/{repo}/issues', {
      ...params, state: 'all', since: since.toISOString(), sort: 'created', direction: 'desc', per_page: 100, page,
    });
    found.push(...data.filter((issue) => !issue.pull_request));
    if (data.length < 100) break;
  }
  return found;
}

/** Plans whose apply was interrupted resume on the next automation pass. */
export async function resumeStalePlans(db: Db) {
  const stale = await db.select({ id: plans.id }).from(plans)
    .where(and(eq(plans.status, 'applying'), lt(plans.decidedAt, new Date(Date.now() - STALE_APPLY_MS)))).limit(5).all();
  for (const plan of stale) await applyPlan(db, plan.id, null).catch(() => {});
}

/** Link an issue imported by sync or webhook back to its plan, only within the plan's own project. */
export async function planLinkForBody(db: Db, body: string | null | undefined, projectId: string) {
  const planTask = planTaskFromBody(body);
  if (!planTask) return null;
  const plan = await db.select({ ticketId: plans.ticketId }).from(plans)
    .innerJoin(tickets, eq(plans.ticketId, tickets.id))
    .where(and(eq(plans.id, planTask.split(':')[0]), eq(tickets.projectId, projectId))).get();
  return plan ? { planTask, parentTicketId: plan.ticketId } : null;
}

export async function rejectPlan(db: Db, planId: string, userId: string | null) {
  const changed = await db.update(plans).set({ status: 'rejected', decidedByUserId: userId, decidedAt: new Date() })
    .where(and(eq(plans.id, planId), inArray(plans.status, ['proposed', 'failed']))).returning({ id: plans.id });
  if (!changed.length) throw new Error('Plan is not waiting for approval.');
}

export async function listPlans(db: Db, limit = 50) {
  const rows = await db.select({ plan: plans, epic: tickets, repo: projects.repoFullName }).from(plans)
    .innerJoin(tickets, eq(plans.ticketId, tickets.id)).innerJoin(projects, eq(tickets.projectId, projects.id))
    .orderBy(desc(plans.createdAt)).limit(limit).all();
  const epicIds = [...new Set(rows.map((row) => row.epic.id))];
  const children = epicIds.length ? await db.select().from(tickets).where(inArray(tickets.parentTicketId, epicIds)).all() : [];
  return rows.map(({ plan, epic, repo }) => ({
    ...plan,
    // Proposed plans await a decision; failed or interrupted applies can be retried.
    actionable: ['proposed', 'failed'].includes(plan.status)
      || (plan.status === 'applying' && !!plan.decidedAt && plan.decidedAt.getTime() < Date.now() - STALE_APPLY_MS),
    tasks: JSON.parse(plan.tasksJson) as Plan['tasks'],
    epic: { id: epic.id, number: epic.githubIssueNumber, title: epic.title, htmlUrl: epic.htmlUrl, state: epic.githubState, repo },
    subtasks: children.filter((child) => child.parentTicketId === epic.id)
      .map((child) => ({ id: child.id, planTask: child.planTask, number: child.githubIssueNumber, title: child.title, state: child.githubState, htmlUrl: child.htmlUrl, stage: child.stage })),
  }));
}

/** Close an epic once every subtask it spawned is closed. */
export async function reconcileEpics(db: Db) {
  const epics = await db.select().from(tickets).where(and(eq(tickets.githubState, 'open'),
    sql`exists (select 1 from plans p where p.ticket_id = ${tickets.id} and p.status = 'applied')`,
    sql`not exists (select 1 from tickets child where child.parent_ticket_id = ${tickets.id} and child.github_state = 'open')`,
  )).limit(20).all();
  for (const epic of epics) {
    try {
      const { client, owner, repo } = await repoClient(db, epic.projectId);
      await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner, repo, issue_number: epic.githubIssueNumber, state: 'closed', state_reason: 'completed',
        request: { signal: AbortSignal.timeout(20_000) },
      });
      await db.update(tickets).set({ githubState: 'closed', stage: 'done', updatedAt: new Date() }).where(eq(tickets.id, epic.id));
    } catch {
      // Retried on the next automation pass.
    }
  }
}
