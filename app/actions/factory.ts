"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getGithubApp, listInstallationRepos, listRepoIssues } from "@/lib/github";
import { setGithubIssueReady, setGithubIssueRisk } from "@/lib/github-completion";
import { workMove } from "@/lib/board-moves";
import { workBoardCards } from "@/lib/work-board-query";
import { workLane, type WorkCard } from "@/lib/work-board";
import {
  assignTicket,
  createAgent,
  getInstallationByGithubId,
  getProject,
  archiveProjects,
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
import { PROVIDERS } from "@/shared/codex";
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

  const listed = await listInstallationRepos(installationGithubId);
  const repos = listed.filter((repo) => !repo.archived);
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
  const archived = await archiveProjects(installation.id, listed.filter((repo) => repo.archived).map((repo) => repo.repoId));
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
    await setTicketStage(ticketId, parsed, parsed === "intake" || parsed === "assigned");
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not move ticket.' };
  }
}

async function applyWorkMove(card: WorkCard, lane: string) {
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

/** A Work board drop. The lane is re-derived here, so the client's view never decides the move. */
export async function moveWorkCardAction(ticketId: string, lane: string) {
  await requireSession();
  try {
    const card = (await workBoardCards()).find((item) => item.id === ticketId);
    if (!card) throw new Error('This task is no longer on the Work board.');
    await applyWorkMove(card, lane);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not move this task.' };
  } finally {
    // A requeue can succeed before the label change fails; show whatever was saved.
    revalidatePath('/', 'layout');
  }
}

/** Retry all on Needs attention: queues each listed task that is still failed there, like its own Retry button. */
export async function retryAttentionAction(ticketIds: string[]) {
  await requireSession();
  const ids = new Set(z.array(z.string()).max(500).parse(ticketIds));
  try {
    const cards = (await workBoardCards()).filter((card) => ids.has(card.id) && workLane(card) === 'attention' && !('error' in workMove(card, 'queued')));
    let failed = 0;
    // One at a time, so a GitHub error on one task never leaves the others half moved.
    for (const card of cards) {
      try { await applyWorkMove(card, 'queued'); } catch { failed++; }
    }
    if (failed) return { retried: cards.length - failed, error: `${failed} of ${cards.length} tasks could not be retried. Try again.` };
    return { retried: cards.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not retry these tasks.' };
  } finally {
    revalidatePath('/', 'layout');
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
  provider: z.enum(PROVIDERS).optional(),
  systemPrompt: z.string().max(4000).optional(),
}).refine((input) => !input.modelId || input.provider, {
  message: "Choose Codex or Claude for a custom model.",
});

export async function createAgentAction(formData: FormData) {
  const session = await requireSession();
  const input = createAgentSchema.parse({
    name: formData.get("name"),
    color: formData.get("color") || undefined,
    modelId: formData.get("modelId") || undefined,
    provider: formData.get("provider") || undefined,
    systemPrompt: formData.get("systemPrompt") || undefined,
  });
  await createAgent({
    ownerUserId: session.user.id,
    name: input.name,
    color: input.color,
    modelId: input.modelId ?? null,
    provider: input.provider ?? null,
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
