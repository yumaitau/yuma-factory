import 'server-only';

import { eq } from 'drizzle-orm';

import { digestSends } from '@/db/schema';
import { claimDigestSend } from '@/lib/digest-claim';
import { digestMail } from '@/lib/digest-mail';
import { getDb } from '@/lib/db';
import { isSydneyMorningWindow, sydneyCalendarDate } from '@/lib/datetime';
import { isAllowedEmail, paperboyConfig } from '@/lib/env';
import { outstandingSnapshot } from '@/lib/outstanding-query';
import { sendPaperboyEmail } from '@/lib/paperboy';
import { listUsers } from '@/lib/queries';

export { claimDigestSend } from '@/lib/digest-claim';

export async function digestRecipients(): Promise<string[]> {
  const configured = paperboyConfig()?.digestTo ?? [];
  if (configured.length) return configured;
  const users = await listUsers();
  return [...new Set(users.map((user) => user.email).filter((email) => isAllowedEmail(email)))];
}

export async function previewDigest(now = new Date()) {
  const snapshot = await outstandingSnapshot(now);
  return { snapshot, mail: digestMail(snapshot) };
}

export async function sendOutstandingDigest(options: { force?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const paperboy = paperboyConfig();
  if (!paperboy) return { skipped: true as const, reason: 'not-configured' as const };
  const recipients = await digestRecipients();
  if (!recipients.length) return { skipped: true as const, reason: 'no-recipients' as const };
  const snapshot = await outstandingSnapshot(now);
  const mail = digestMail(snapshot);
  const result = await sendPaperboyEmail({
    apiUrl: paperboy.apiUrl,
    apiKey: paperboy.apiKey,
    from: paperboy.from,
    to: recipients,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    idempotencyKey: options.force
      ? `factory-digest-manual-${now.toISOString()}`
      : `factory-digest-${snapshot.sydneyDate}`,
    tags: [
      { name: 'product', value: 'factory' },
      { name: 'kind', value: options.force ? 'manual' : 'morning' },
    ],
  });
  return { skipped: false as const, messageId: result.id, recipients: recipients.length, snapshot };
}

export async function maybeSendMorningDigest(now = new Date()) {
  try {
    if (!isSydneyMorningWindow(now)) return { skipped: true as const, reason: 'before-hour' as const };
    if (!paperboyConfig()) return { skipped: true as const, reason: 'not-configured' as const };
    const sydneyDate = sydneyCalendarDate(now);
    const db = await getDb();
    const claim = await claimDigestSend(db, sydneyDate, now);
    if (!claim.claimed) return { skipped: true as const, reason: 'already-sent' as const, messageId: claim.row?.messageId ?? null };
    const result = await sendOutstandingDigest({ now });
    if (result.skipped) {
      if (claim.row) {
        await db.update(digestSends).set({ error: result.reason }).where(eq(digestSends.id, claim.row.id));
      }
      return result;
    }
    if (claim.row) {
      await db.update(digestSends).set({
        messageId: result.messageId,
        recipientCount: result.recipients,
        error: null,
        sentAt: now,
      }).where(eq(digestSends.id, claim.row.id));
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Digest send failed.';
    try {
      const db = await getDb();
      const sydneyDate = sydneyCalendarDate(now);
      await db.update(digestSends).set({ error: message }).where(eq(digestSends.sydneyDate, sydneyDate));
    } catch { /* keep the original send error */ }
    return { skipped: true as const, reason: 'error' as const, error: message };
  }
}

export async function latestDigestSend() {
  const db = await getDb();
  const rows = await db.select().from(digestSends).orderBy(digestSends.sydneyDate).all();
  return rows.at(-1) ?? null;
}