"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, revokeApiKey } from "@/lib/api-keys";
import { getDb } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { validId } from "@/shared/codex";

/** Returns the plain key once. Only its digest is stored. */
export async function createApiKeyAction(name: string) {
  const session = await requireSession();
  try {
    const created = await createApiKey(await getDb(), session.user.id, String(name ?? ""));
    revalidatePath("/api-keys");
    return { key: created.key, name: created.name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create a key." };
  }
}

export async function revokeApiKeyAction(id: string) {
  const session = await requireSession();
  try {
    if (!validId(id)) throw new Error("Invalid key.");
    await revokeApiKey(await getDb(), session.user.id, id);
    revalidatePath("/api-keys");
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not revoke this key." };
  }
}
