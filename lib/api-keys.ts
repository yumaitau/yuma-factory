import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { apiKeys, users } from '@/db/schema';
import { isAllowedEmail } from '@/lib/env';
import type { Db } from '@/lib/queries';
import { newId } from '@/lib/ids';

const KEY_PREFIX = 'fk_';
/** Keys per person, so a leaked session cannot mint keys without bound. */
export const MAX_API_KEYS = 20;
/** A key stops working after this long; people make a new one. */
export const API_KEY_DAYS = 90;

const digest = (key: string) => createHash('sha256').update(key).digest('hex');

/** Creates a key for this person. The plain key is returned once and never stored. */
export async function createApiKey(db: Db, userId: string, name: string) {
  const label = name.trim().slice(0, 80);
  if (!label) throw new Error('Name the key after the agent or tool that will use it.');
  const active = await db.select({ id: apiKeys.id }).from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, new Date()))).all();
  if (active.length >= MAX_API_KEYS) throw new Error(`You already have ${MAX_API_KEYS} keys. Revoke one first.`);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `${KEY_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
  const now = new Date();
  const row = { id: newId('key'), userId, name: label, prefix: key.slice(0, 10), hash: digest(key), createdAt: now,
    expiresAt: new Date(now.getTime() + API_KEY_DAYS * 86_400_000) };
  await db.insert(apiKeys).values(row);
  return { key, id: row.id, name: row.name, prefix: row.prefix, expiresAt: row.expiresAt };
}

export async function listApiKeys(db: Db, userId: string) {
  return db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt)).all();
}

export async function revokeApiKey(db: Db, userId: string, id: string) {
  const [revoked] = await db.update(apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
  if (!revoked) throw new Error('Key not found or already revoked.');
}

export const isPersonalKey = (key: string | null) => !!key?.startsWith(KEY_PREFIX);

/**
 * The owner of an active, unexpired key, or null. Lookup is by digest, so timing reveals nothing about the key.
 * The owner must still be allowed to sign in: someone who leaves the Workspace loses their keys with it.
 */
export async function apiKeyOwner(db: Db, key: string | null, allowed: (email: string) => boolean = isAllowedEmail): Promise<string | null> {
  if (!isPersonalKey(key)) return null;
  const row = await db.select({ id: apiKeys.id, userId: apiKeys.userId, lastUsedAt: apiKeys.lastUsedAt, email: users.email })
    .from(apiKeys).innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.hash, digest(key!)), isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, new Date()))).get();
  if (!row || !allowed(row.email)) return null;
  // At most one write a minute per key.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
  return row.userId;
}
