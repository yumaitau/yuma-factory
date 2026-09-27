"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { applyPlan, postThreadMessage, rejectPlan } from "@/lib/collab-store";
import { createMemory, revertMemoryEvent, setProjectMemorySettings, updateMemory } from "@/lib/memory-store";
import { requireSession } from "@/lib/session";

const scope = z.string().trim().max(64).transform((value) => (value && value !== "global" ? value : null));

export async function createMemoryAction(formData: FormData) {
  const session = await requireSession();
  const input = z.object({
    projectId: scope,
    kind: z.string().max(20),
    content: z.string().trim().min(3).max(2000),
    weight: z.coerce.number().min(0).max(100),
    pinned: z.string().optional(),
  }).parse(Object.fromEntries(formData));
  await createMemory(await getDb(), { ...input, pinned: input.pinned === "on" }, `user:${session.user.id}`, session.user.id);
  revalidatePath("/memory");
}

export async function updateMemoryAction(formData: FormData) {
  const session = await requireSession();
  const input = z.object({
    memoryId: z.string().min(1).max(64),
    content: z.string().max(2000).optional(),
    kind: z.string().max(20).optional(),
    weight: z.coerce.number().min(0).max(100).optional(),
    pinned: z.enum(["true", "false"]).optional(),
    status: z.enum(["active", "suggested", "archived"]).optional(),
  }).parse(Object.fromEntries(formData));
  await updateMemory(await getDb(), input.memoryId, {
    content: input.content, kind: input.kind, weight: input.weight, status: input.status,
    pinned: input.pinned === undefined ? undefined : input.pinned === "true",
  }, `user:${session.user.id}`);
  revalidatePath("/memory");
}

export async function revertMemoryAction(formData: FormData) {
  const session = await requireSession();
  const eventId = z.string().min(1).max(64).parse(formData.get("eventId"));
  await revertMemoryEvent(await getDb(), eventId, `user:${session.user.id}`);
  revalidatePath("/memory");
}

export async function memorySettingsAction(formData: FormData) {
  await requireSession();
  const input = z.object({
    projectId: z.string().min(1).max(64),
    memoryBudget: z.coerce.number().min(0).max(20000),
  }).parse(Object.fromEntries(formData));
  await setProjectMemorySettings(await getDb(), input.projectId, {
    memoryBudget: input.memoryBudget,
    autoLearn: formData.get("autoLearn") === "on",
    autoApprovePlans: formData.get("autoApprovePlans") === "on",
  });
  revalidatePath("/memory");
}

export async function decidePlanAction(formData: FormData) {
  const session = await requireSession();
  const planId = z.string().min(1).max(64).parse(formData.get("planId"));
  const db = await getDb();
  if (formData.get("decision") === "approve") await applyPlan(db, planId, session.user.id);
  else await rejectPlan(db, planId, session.user.id);
  revalidatePath("/plans");
  revalidatePath("/work");
}

export async function postTeamMessageAction(formData: FormData) {
  const session = await requireSession();
  const input = z.object({ ticketId: z.string().min(1).max(64), body: z.string().trim().min(1).max(8000) })
    .parse(Object.fromEntries(formData));
  await postThreadMessage(await getDb(), {
    threadTicketId: input.ticketId, kind: "human", body: input.body, userId: session.user.id, author: session.user.name || "team",
  });
  revalidatePath("/plans");
}
