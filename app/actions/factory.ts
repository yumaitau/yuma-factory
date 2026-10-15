"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  importRepos, moveWorkCard, refreshRepos, retryAttention, setTicketRisk, syncTickets,
} from "@/lib/factory-control";
import {
  assignTicket,
  createAgent,
  listProjects,
  setTicketStage,
  TICKET_STAGES,
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
  const result = await importRepos(installationGithubId);
  revalidatePath("/");
  return result;
}

/** Re-read every connected installation, e.g. after granting the App access to more repositories. */
export async function refreshReposAction() {
  await requireSession();
  await refreshRepos();
  revalidatePath("/");
}

/** Pull open issues for a project into tickets. */
export async function syncTicketsAction(projectId: string) {
  await requireSession();
  const result = await syncTickets(projectId);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
  return result;
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

/** A Work board drop. The lane is re-derived here, so the client's view never decides the move. */
export async function moveWorkCardAction(ticketId: string, lane: string) {
  await requireSession();
  try {
    await moveWorkCard(ticketId, lane);
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
    const { retried, failed } = await retryAttention([...ids]);
    if (failed) return { retried, error: `${failed} of ${retried + failed} tasks could not be retried. Try again.` };
    return { retried };
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
  const { projectId } = await setTicketRisk(ticketId, parsed);
  revalidatePath("/");
  revalidatePath("/work");
  revalidatePath(`/projects/${projectId}`);
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
