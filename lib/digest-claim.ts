import { eq } from 'drizzle-orm';

import { digestSends } from '@/db/schema';
import { newId } from '@/lib/ids';
import type { Db } from '@/lib/queries';

export async function claimDigestSend(db: Db, sydneyDate: string, now = new Date()) {
  const inserted = await db.insert(digestSends).values({
    id: newId('digest'),
    sydneyDate,
    sentAt: now,
  }).onConflictDoNothing({ target: digestSends.sydneyDate }).returning();
  if (inserted[0]) return { claimed: true as const, row: inserted[0] };
  const existing = await db.select().from(digestSends).where(eq(digestSends.sydneyDate, sydneyDate)).get();
  if (!existing) return { claimed: false as const, row: null };
  if (existing.messageId) return { claimed: false as const, row: existing };
  return { claimed: true as const, row: existing };
}