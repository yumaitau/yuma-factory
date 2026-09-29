import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  agents,
  codexAccounts,
  githubInstallations,
  projects,
  runs,
  tickets,
  users,
} from "@/db/schema";
import { getDb } from "@/lib/db";
import { newId } from "@/lib/ids";
import { runWaitReason } from "@/lib/run-wait";
import { runLeased } from "@/lib/codex/accounts";

export type Db = Awaited<ReturnType<typeof getDb>>;

/* --------------------------------- Users --------------------------------- */

export async function listUsers() {
  const db = await getDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users);
}

/* ---------------------------- Installations ------------------------------ */

export async function upsertInstallation(input: {
  installationId: number;
  accountLogin: string;
  accountType: string;
  connectedByUserId: string;
}) {
  const db = await getDb();
  const now = new Date();
  const id = newId("inst");
  // Atomic upsert: concurrent webhook deliveries must not race select->insert.
  await db.insert(githubInstallations).values({
    id,
    installationId: input.installationId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    connectedByUserId: input.connectedByUserId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [githubInstallations.installationId], set: {
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    updatedAt: now,
  } });
  const row = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, input.installationId))
    .get();
  return row!.id;
}

export async function getInstallationByGithubId(installationId: number) {
  const db = await getDb();
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .get();
}

/* -------------------------------- Projects ------------------------------- */

/**
 * Retire projects whose repository GitHub reports as archived. A repository missing
 * from the installation's listing is left alone: narrowing App access is not intent to archive.
 */
export async function archiveProjects(installationRowId: string, archivedRepoIds: number[]) {
  if (!archivedRepoIds.length) return [];
  const db = await getDb();
  const archived = await db.update(projects).set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(projects.installationId, installationRowId), eq(projects.status, "active"), inArray(projects.repoId, archivedRepoIds)))
    .returning({ repo: projects.repoFullName });
  return archived.map((row) => row.repo);
}

export async function listInstallations() {
  const db = await getDb();
  return db.select().from(githubInstallations).all();
}

export async function upsertProject(input: {
  installationRowId: string;
  repoId: number;
  repoFullName: string;
  defaultBranch: string;
  description: string | null;
  private: boolean;
}) {
  const db = await getDb();
  const now = new Date();
  const id = newId("proj");
  // Atomic upsert: concurrent syncs must not race select->insert.
  await db.insert(projects).values({
    id,
    installationId: input.installationRowId,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    description: input.description,
    private: input.private,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [projects.repoId], set: {
    status: "active",
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    description: input.description,
    private: input.private,
    updatedAt: now,
  } });
  const row = await db
    .select()
    .from(projects)
    .where(eq(projects.repoId, input.repoId))
    .get();
  return row!.id;
}

export async function listProjects() {
  const db = await getDb();
  return db.select().from(projects).where(eq(projects.status, "active")).all();
}

export async function getProject(projectId: string) {
  const db = await getDb();
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

/** Open-ticket counts grouped by stage, for the project cards. */
export async function ticketCountsByProject() {
  const db = await getDb();
  const rows = await db
    .select({
      projectId: tickets.projectId,
      stage: tickets.stage,
      count: sql<number>`count(*)`,
    })
    .from(tickets)
    .where(eq(tickets.githubState, "open"))
    .groupBy(tickets.projectId, tickets.stage)
    .all();
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const byStage = map.get(row.projectId) ?? {};
    byStage[row.stage] = row.count;
    map.set(row.projectId, byStage);
  }
  return map;
}

/* -------------------------------- Tickets -------------------------------- */

export async function upsertTicket(input: {
  projectId: string;
  githubIssueNumber: number;
  githubIssueId: number;
  title: string;
  body: string | null;
  labels: string[];
  githubState: string;
  htmlUrl: string;
}) {
  const db = await getDb();
  const now = new Date();
  const labelsJson = JSON.stringify(input.labels);
  const id = newId("tkt");
  // Atomic upsert: concurrent webhook deliveries must not race select->insert.
  // Preserve factory stage + assignment; only refresh GitHub-owned fields.
  await db.insert(tickets).values({
    id,
    projectId: input.projectId,
    githubIssueNumber: input.githubIssueNumber,
    githubIssueId: input.githubIssueId,
    title: input.title,
    body: input.body,
    labels: labelsJson,
    githubState: input.githubState,
    stage: "intake",
    htmlUrl: input.htmlUrl,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [tickets.projectId, tickets.githubIssueNumber], set: {
    title: input.title,
    body: input.body,
    labels: labelsJson,
    githubState: input.githubState,
    htmlUrl: input.htmlUrl,
    updatedAt: now,
  } });
  const row = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, input.projectId),
        eq(tickets.githubIssueNumber, input.githubIssueNumber),
      ),
    )
    .get();
  return row!.id;
}

export async function listTicketsForProject(projectId: string) {
  const db = await getDb();
  return db
    .select()
    .from(tickets)
    .where(eq(tickets.projectId, projectId))
    .orderBy(desc(tickets.updatedAt))
    .all();
}

/** Load a ticket joined with its project + assigned agent, for a run. */
export async function getTicketWithContext(ticketId: string) {
  const db = await getDb();
  const ticket = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .get();
  if (!ticket) return null;
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .get();
  if (!project) return null;
  const installation = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, project.installationId))
    .get();
  const agent = ticket.assignedAgentId
    ? await db
        .select()
        .from(agents)
        .where(eq(agents.id, ticket.assignedAgentId))
        .get()
    : null;
  return { ticket, project, installation, agent };
}

export const TICKET_STAGES = [
  "intake",
  "assigned",
  "in_progress",
  "review",
  "done",
] as const;
export type TicketStage = (typeof TICKET_STAGES)[number];

export async function setTicketLabels(ticketId: string, labels: string[]) {
  const db = await getDb();
  await db.update(tickets).set({ labels: JSON.stringify(labels), updatedAt: new Date() }).where(eq(tickets.id, ticketId));
}

/**
 * `requeue` marks a human decision to retry: earlier runs stop blocking automatic pickup.
 * Only a failed or stopped latest attempt is cleared; a succeeded one must not make a second PR.
 */
export async function setTicketStage(ticketId: string, stage: TicketStage, requeue = false) {
  const db = await getDb();
  const now = new Date();
  const requeuedAt = sql`case when (select status from runs where ticket_id = ${ticketId} order by created_at desc, id desc limit 1)
    in ('failed', 'cancelled') then ${Math.floor(now.getTime() / 1000)} else ${tickets.requeuedAt} end`;
  const changed = await db
    .update(tickets)
    .set({ stage, updatedAt: now, ...(requeue ? { requeuedAt } : {}) })
    .where(and(eq(tickets.id, ticketId), sql`not exists (select 1 from runs where ticket_id = ${ticketId} and status = 'running')`))
    .returning({ id: tickets.id });
  if (!changed.length) throw new Error('Stop the active run on the Work board before moving this ticket.');
}

export async function assignTicket(ticketId: string, agentId: string | null) {
  const db = await getDb();
  const changed = await db
    .update(tickets)
    .set({
      assignedAgentId: agentId,
      stage: agentId ? "assigned" : "intake",
      updatedAt: new Date(),
    })
    .where(and(eq(tickets.id, ticketId), sql`not exists (select 1 from runs where ticket_id = ${ticketId} and status = 'running')`))
    .returning({ id: tickets.id });
  if (!changed.length) throw new Error('Stop the active run on the Work board before reassigning this ticket.');
}

/* --------------------------------- Agents -------------------------------- */

export async function createAgent(input: {
  ownerUserId: string;
  name: string;
  color?: string;
  modelId?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
}) {
  const db = await getDb();
  const now = new Date();
  const id = newId("agent");
  await db.insert(agents).values({
    id,
    ownerUserId: input.ownerUserId,
    name: input.name,
    color: input.color ?? "#6366f1",
    modelId: input.modelId ?? null,
    provider: input.provider ?? null,
    systemPrompt: input.systemPrompt ?? null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** All agents with their owner, for the "my agents vs co-founder's" board. */
export async function listAgentsWithOwners() {
  const db = await getDb();
  return db
    .select({
      id: agents.id,
      name: agents.name,
      color: agents.color,
      status: agents.status,
      modelId: agents.modelId,
      provider: agents.provider,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(agents)
    .innerJoin(users, eq(agents.ownerUserId, users.id))
    .all();
}

export async function setAgentStatus(agentId: string, status: string) {
  const db = await getDb();
  await db
    .update(agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(agents.id, agentId));
}

/* ---------------------------------- Runs --------------------------------- */

export async function createRun(input: {
  ticketId: string;
  agentId: string;
  modelId: string;
  requestedByUserId: string;
}) {
  const db = await getDb();
  const id = newId("run");
  await db.insert(runs).values({
    id,
    ticketId: input.ticketId,
    agentId: input.agentId,
    status: "queued",
    requestedByUserId: input.requestedByUserId,
    modelId: input.modelId,
    log: "",
    inputTokens: 0,
    outputTokens: 0,
    createdAt: new Date(),
  });
  return id;
}

export async function listRunsForTicket(ticketId: string) {
  const db = await getDb();
  return db
    .select()
    .from(runs)
    .where(eq(runs.ticketId, ticketId))
    .orderBy(desc(runs.createdAt))
    .all();
}

export async function getRun(runId: string) {
  const db = await getDb();
  const row = await db.select({ run: runs, account: codexAccounts, leased: runLeased(sql`${runs.id}`) }).from(runs)
    .leftJoin(codexAccounts, eq(runs.codexAccountId, codexAccounts.id)).where(eq(runs.id, runId)).get();
  if (!row) return undefined;
  // runWaitReason handles a missing account (deleted/unassigned subscription),
  // so always call it for running runs instead of hiding the actionable reason.
  return { ...row.run, waitingReason: row.run.status === 'running'
    ? runWaitReason(row.run.id, row.account && { ...row.account, leased: !!row.leased }) : null };
}

export async function markRunRunning(runId: string, sandboxId: string) {
  const db = await getDb();
  await db
    .update(runs)
    .set({ status: "running", sandboxId, startedAt: new Date() })
    .where(eq(runs.id, runId));
}

export async function finishRun(input: {
  runId: string;
  status: "succeeded" | "failed";
  log: string;
  pullRequestUrl?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const db = await getDb();
  await db
    .update(runs)
    .set({
      status: input.status,
      log: input.log.slice(0, 100_000), // cap inline log; large logs -> R2 later
      pullRequestUrl: input.pullRequestUrl ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, input.runId));
}
