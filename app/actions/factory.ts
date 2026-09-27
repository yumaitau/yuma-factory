"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getGithubApp, listInstallationRepos, listRepoIssues } from "@/lib/github";
import { setGithubIssueRisk } from "@/lib/github-completion";
import {
  assignTicket,
  createAgent,
  getInstallationByGithubId,
  getProject,
  archiveProjectsExcept,
  listInstallations,
  getTicketWithContext,
  listProjects,
  setTicketLabels,
  setTicketStage,
  TICKET_STAGES,
  upsertProject,
  upsertTicket,
  type TicketStage,
} from "@/lib/queries";
import { TICKET_RISKS } from "@/shared/ticket-risk";
import { requireSession } from "@/lib/session";

/**
 * Import repos from a connected installation into projects. Called after the
 * GitHub App is installed (the callback records the installation row).
 */
export async function importReposAction(installationGithubId: number) {
  await requireSession();
  const installation = await getInstallationByGithubId(installationGithubId);
  if (!installation)
    throw new Error("Installation not found. Connect GitHub first.");

  const repos = (await listInstallationRepos(installationGithubId)).filter((repo) => !repo.archived);
  for (const repo of repos) {
    await upsertProject({
      installationRowId: installation.id,
      repoId: repo.repoId,
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      description: repo.description,
      private: repo.private,
    });
  }
  const archived = await archiveProjectsExcept(installation.id, repos.map((repo) => repo.repoId));
  revalidatePath("/");
  return { imported: repos.length, archived };
}

/** Re-read every connected installation, e.g. after granting the App access to more repositories. */
export async function refreshReposAction() {
  await requireSession();
  for (const installation of await listInstallations()) await importReposAction(installation.installationId);
}

/** Pull open issues for a project into tickets. */
export async function syncTicketsAction(projectId: string) {
  await requireSession();
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found.");

  const installation = await getInstallationByGithubIdForProject(
    project.installationId,
  );
  const [owner, repo] = project.repoFullName.split("/");
  const issues = await listRepoIssues(installation.installationId, owner, repo);
  for (const issue of issues) {
    await upsertTicket({
      projectId,
      githubIssueNumber: issue.number,
      githubIssueId: issue.githubIssueId,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      githubState: issue.state,
      htmlUrl: issue.htmlUrl,
    });
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
  return { synced: issues.length };
}

// Small helper: resolve the installation row for a project's installation id.
async function getInstallationByGithubIdForProject(installationRowId: string) {
  // projects.installationId is the row id; we need the github installation id.
  const { getDb } = await import("@/lib/db");
  const { githubInstallations } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  const row = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationRowId))
    .get();
  if (!row) throw new Error("Installation row missing for project.");
  return row;
}

const stageSchema = z.enum(TICKET_STAGES);

export async function cancelRunAction(runId: string) {
  const session = await requireSession();
  try {
    const { cancelCodexRun } = await import('@/lib/agent/run');
    await cancelCodexRun(runId, session.user.id);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not stop this run.' };
  }
}

export async function moveTicketAction(ticketId: string, stage: string) {
  await requireSession();
  try {
    const parsed = stageSchema.parse(stage) as TicketStage;
    if (parsed === "done")
      throw new Error("Tickets are completed automatically after the PR's CI is green.");
    await setTicketStage(ticketId, parsed);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not move ticket.' };
  }
}

export async function assignTicketAction(
  ticketId: string,
  agentId: string | null,
) {
  await requireSession();
  try {
    await assignTicket(ticketId, agentId);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not reassign ticket.' };
  }
}

const riskSchema = z.enum(TICKET_RISKS);

export async function setTicketRiskAction(ticketId: string, risk: string | null) {
  await requireSession();
  const parsed = risk === null || risk === "" ? null : riskSchema.parse(risk);
  const context = await getTicketWithContext(ticketId);
  if (!context?.installation) throw new Error("Ticket or GitHub installation is unavailable.");
  const [owner, repo] = context.project.repoFullName.split("/");
  const client = await getGithubApp().getInstallationOctokit(context.installation.installationId);
  const labels = await setGithubIssueRisk(client, owner, repo, context.ticket.githubIssueNumber, parsed);
  await setTicketLabels(ticketId, labels);
  revalidatePath("/");
  revalidatePath("/work");
  revalidatePath(`/projects/${context.project.id}`);
}

const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  modelId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
    .optional(),
  systemPrompt: z.string().max(4000).optional(),
});

export async function createAgentAction(formData: FormData) {
  const session = await requireSession();
  const input = createAgentSchema.parse({
    name: formData.get("name"),
    color: formData.get("color") || undefined,
    modelId: formData.get("modelId") || undefined,
    systemPrompt: formData.get("systemPrompt") || undefined,
  });
  await createAgent({
    ownerUserId: session.user.id,
    name: input.name,
    color: input.color,
    modelId: input.modelId ?? null,
    systemPrompt: input.systemPrompt ?? null,
  });
  revalidatePath("/agents");
}

/** Assign a subscription and start a real Codex development run. */
export async function startRunAction(
  ticketId: string,
  agentId: string,
  modelId: string,
) {
  const session = await requireSession();
  const { startCodexRun } = await import("@/lib/agent/run");
  try {
    const runId = await startCodexRun(
      ticketId,
      agentId,
      modelId,
      session.user.id,
    );
    revalidatePath("/");
    return { runId };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not start this run.",
    };
  }
}

export async function listProjectsAction() {
  await requireSession();
  return listProjects();
}
