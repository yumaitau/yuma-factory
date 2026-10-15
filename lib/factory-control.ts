import 'server-only';
// What a signed-in person can do to Factory, shared by server actions and the API/MCP.
// Each function acts as `userId` and checks the same ownership rules the app does. No cache revalidation here.
import { and, eq } from 'drizzle-orm';
import { agents, automation, codexAccounts, githubInstallations, tickets, users } from '@/db/schema';
import { getDb } from '@/lib/db';
import { newId } from '@/lib/ids';
import { AUTOMATION_ID, ensureAutomationAgents } from '@/lib/automation-state';
import { enqueuePickup } from '@/lib/automation-queue';
import { APP_NAME, LABEL_PREFIX, LABELS } from '@/lib/brand';
import { getGithubApp, listInstallationRepos, listRepoIssues } from '@/lib/github';
import { ensureRepoLabel, riskLabelMeta, setGithubIssueReady, setGithubIssueRisk } from '@/lib/github-completion';
import { stripMarkers } from '@/lib/plan';
import { ownedAccount } from '@/lib/codex/accounts';
import { workMove } from '@/lib/board-moves';
import { workBoardCards } from '@/lib/work-board-query';
import { workLane, type WorkCard } from '@/lib/work-board';
import { acceptReview, mergeReview, reviewContext } from '@/lib/review-merge';
import {
  archiveProjects, getInstallationByGithubId, getProject, getTicketWithContext, listInstallations,
  setTicketLabels, setTicketStage, upsertProject, upsertTicket,
} from '@/lib/queries';
import { riskLabel, type TicketRisk } from '@/shared/ticket-risk';
import { validId } from '@/shared/codex';

export async function importRepos(installationGithubId: number) {
  const installation = await getInstallationByGithubId(installationGithubId);
  if (!installation) throw new Error('Installation not found. Connect GitHub first.');
  const listed = await listInstallationRepos(installationGithubId);
  const repos = listed.filter((repo) => !repo.archived);
  for (const repo of repos) {
    await upsertProject({
      installationRowId: installation.id, repoId: repo.repoId, repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch, description: repo.description, private: repo.private,
    });
  }
  const archived = await archiveProjects(installation.id, listed.filter((repo) => repo.archived).map((repo) => repo.repoId));
  return { imported: repos.length, archived };
}

/** Re-read every connected installation, e.g. after granting the App access to more repositories. */
export async function refreshRepos() {
  let imported = 0;
  for (const installation of await listInstallations()) imported += (await importRepos(installation.installationId)).imported;
  return { imported };
}

/**
 * The issue a new ticket opens: its body with any plan markers removed (they would let it pose as a planner
 * subtask) and a footer naming the person, never their email, plus the labels to create it with.
 */
export function newTicketIssue(input: Pick<NewTicket, 'body' | 'risk' | 'start'>, personName: string | null) {
  const labels: { name: string; color: string; description: string }[] = [];
  if (input.risk) labels.push({ name: riskLabel(input.risk, LABEL_PREFIX), ...riskLabelMeta(input.risk) });
  if (input.start === 'queue') labels.push({ name: LABELS.ready, color: '1F6FEB', description: `${APP_NAME} picks this ticket up automatically.` });
  if (input.start === 'plan') labels.push({ name: LABELS.plan, color: '8250DF', description: `${APP_NAME} plans this epic into subtasks.` });
  return { body: `${stripMarkers(input.body).trim()}\n\n---\nCreated in ${APP_NAME} by ${personName?.trim() || 'a team member'}.`, labels };
}

export type NewTicket = { projectId: string; title: string; body: string; risk: TicketRisk | null; start: 'queue' | 'plan' | 'none' };

/**
 * Opens a GitHub issue for a project and records it as a ticket. `queue` labels it for pickup, `plan` asks the
 * planner to break it into subtasks, `none` leaves it on Needs preparation. Labels are set in the same request
 * that creates the issue, so a failure never leaves a half-labelled issue, and the body never changes after.
 * The issue names the person who created it, because the GitHub App files it.
 */
export async function createTicket(userId: string, input: NewTicket) {
  const project = await getProject(input.projectId);
  if (!project || project.status !== 'active') throw new NotFoundError('Project not found.');
  const db = await getDb();
  const installation = await db.select().from(githubInstallations).where(eq(githubInstallations.id, project.installationId)).get();
  if (!installation) throw new Error('Installation row missing for project.');
  const person = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  const [owner, repo] = project.repoFullName.split('/');
  const client = await getGithubApp().getInstallationOctokit(installation.installationId);
  const params = { owner, repo, request: { signal: AbortSignal.timeout(20_000) } };
  const { body, labels } = newTicketIssue(input, person?.name ?? null);
  for (const label of labels) await ensureRepoLabel(client, params, label.name, label.color, label.description);
  const { data: issue } = await client.request('POST /repos/{owner}/{repo}/issues', { ...params, title: input.title, body, labels: labels.map((label) => label.name) });
  const created = { issueNumber: issue.number, url: issue.html_url };
  // The issue exists from here on: report it even if recording it fails, so a retry doesn't open another.
  try {
    await upsertTicket({
      projectId: project.id, githubIssueNumber: issue.number, githubIssueId: Number(issue.id), title: issue.title,
      body: issue.body ?? null, labels: issue.labels.map((label) => typeof label === 'string' ? label : label.name ?? '').filter(Boolean),
      githubState: issue.state, htmlUrl: issue.html_url,
    });
    const ticket = await db.select({ id: tickets.id }).from(tickets)
      .where(and(eq(tickets.projectId, project.id), eq(tickets.githubIssueNumber, issue.number))).get();
    if (input.start !== 'none') await enqueuePickup('Ticket created').catch(() => {});
    return { ...created, ticketId: ticket?.id ?? null, labels: labels.map((label) => label.name) };
  } catch (error) {
    return { ...created, ticketId: null, labels: labels.map((label) => label.name),
      warning: `The issue was created, but recording it failed: ${error instanceof Error ? error.message : 'unknown error'}. Sync the project's tickets; don't create it again.` };
  }
}

export class NotFoundError extends Error {}

/** Share a subscription you own with the team, or stop sharing it. */
export async function shareSubscription(userId: string, accountId: string, shared: boolean) {
  await ownedAccount(accountId, userId);
  const db = await getDb();
  // Not updatedAt: it times maintenance locks, and sharing must not extend one.
  await db.update(codexAccounts).set({ shared })
    .where(and(eq(codexAccounts.id, accountId), eq(codexAccounts.ownerUserId, userId)));
}

/** Pull open issues for a project into tickets. */
export async function syncTickets(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const db = await getDb();
  const installation = await db.select().from(githubInstallations).where(eq(githubInstallations.id, project.installationId)).get();
  if (!installation) throw new Error('Installation row missing for project.');
  const [owner, repo] = project.repoFullName.split('/');
  const issues = await listRepoIssues(installation.installationId, owner, repo);
  for (const issue of issues) {
    await upsertTicket({
      projectId, githubIssueNumber: issue.number, githubIssueId: issue.githubIssueId, title: issue.title,
      body: issue.body, labels: issue.labels, githubState: issue.state, htmlUrl: issue.htmlUrl,
    });
  }
  return { synced: issues.length };
}

export async function applyWorkMove(card: WorkCard, lane: string) {
  const move = workMove(card, lane);
  if ('error' in move) throw new Error(move.error);
  // moveTicket refuses while a run is active, so this goes before any GitHub change.
  if (move.requeue) await setTicketStage(card.id, 'intake', true);
  if (move.ready !== undefined) {
    const context = await getTicketWithContext(card.id);
    if (!context?.installation) throw new Error('Ticket or GitHub installation is unavailable.');
    const [owner, repo] = context.project.repoFullName.split('/');
    const client = await getGithubApp().getInstallationOctokit(context.installation.installationId);
    await setTicketLabels(card.id, await setGithubIssueReady(client, owner, repo, context.ticket.githubIssueNumber, move.ready));
  }
}

/** A Work board drop. The lane is re-derived here, so the caller's view never decides the move. */
export async function moveWorkCard(ticketId: string, lane: string) {
  const card = (await workBoardCards()).find((item) => item.id === ticketId);
  if (!card) throw new Error('This task is no longer on the Work board.');
  await applyWorkMove(card, lane);
}

/** Queues each listed task still failed on Needs attention, or every one there when none are listed. */
export async function retryAttention(ticketIds?: string[]) {
  const ids = ticketIds && new Set(ticketIds);
  const cards = (await workBoardCards()).filter((card) => (!ids || ids.has(card.id)) && workLane(card) === 'attention'
    && !('error' in workMove(card, 'queued')));
  let failed = 0;
  // One at a time, so a GitHub error on one task never leaves the others half moved.
  for (const card of cards) {
    try { await applyWorkMove(card, 'queued'); } catch { failed++; }
  }
  return { retried: cards.length - failed, failed };
}

export async function setTicketRisk(ticketId: string, risk: TicketRisk | null) {
  const context = await getTicketWithContext(ticketId);
  if (!context?.installation) throw new Error('Ticket or GitHub installation is unavailable.');
  const [owner, repo] = context.project.repoFullName.split('/');
  const client = await getGithubApp().getInstallationOctokit(context.installation.installationId);
  const labels = await setGithubIssueRisk(client, owner, repo, context.ticket.githubIssueNumber, risk);
  await setTicketLabels(ticketId, labels);
  return { projectId: context.project.id, labels };
}

export async function setAutomationEnabled(userId: string, enabled: boolean) {
  const db = await getDb();
  const existing = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (existing && existing.userId !== userId) throw new Error('Only the user who enabled this worker can change it.');
  if (!existing) {
    if (!enabled) return;
    if (!(await db.select({ id: githubInstallations.id }).from(githubInstallations).limit(1)).length)
      throw new Error('Connect GitHub before enabling the worker.');
    const now = new Date();
    const agentId = newId('agt');
    await db.batch([
      db.insert(agents).values({ id: agentId, ownerUserId: userId, name: 'Factory worker',
        color: '#d74c2f', status: 'idle', createdAt: now, updatedAt: now }),
      db.insert(automation).values({ id: AUTOMATION_ID, enabled: true, userId, agentId, label: LABELS.ready, updatedAt: now }),
    ]);
  } else {
    // Clearing the lease stops status reporting running:true while disabled
    // and lets the next enable claim a fresh lease immediately.
    await db.update(automation).set(enabled
      ? { enabled, updatedAt: new Date() }
      : { enabled, leaseId: null, leaseUntil: null, updatedAt: new Date() }).where(eq(automation.id, AUTOMATION_ID));
  }
  if (enabled) await enqueuePickup('Worker enabled');
}

export async function setAutomationSize(userId: string, targetAgents: number) {
  if (!Number.isInteger(targetAgents) || targetAgents < 10 || targetAgents > 20) throw new Error('Choose 10 to 20 agents.');
  const db = await getDb();
  const row = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
  if (!row || row.userId !== userId) throw new Error('Only the worker owner can resize the pool.');
  await ensureAutomationAgents(db, { ...row, targetAgents });
  await db.update(automation).set({ targetAgents }).where(eq(automation.id, AUTOMATION_ID));
  await enqueuePickup('Agent pool resized');
}

async function reviewFor(runId: string) {
  if (!validId(runId)) throw new Error('Invalid run.');
  const db = await getDb();
  const review = await reviewContext(db, runId);
  if (!review) throw new Error('This run has no pull request.');
  return { db, review, client: await getGithubApp().getInstallationOctokit(review.installationId) };
}

/** Accept review: records the person, the head SHA they reviewed, and the time. It does not merge. */
export async function acceptRunReview(userId: string, runId: string, headSha: string) {
  if (!/^[a-f0-9]{40}$/.test(String(headSha))) throw new Error('Invalid commit.');
  const { db, review, client } = await reviewFor(runId);
  return acceptReview(db, client, review, userId, headSha);
}

/** One GitHub merge of the accepted current head. A concurrent merge returns that same result. */
export async function mergeRunReview(userId: string, runId: string) {
  const { db, review, client } = await reviewFor(runId);
  return mergeReview(db, client, review, userId);
}
