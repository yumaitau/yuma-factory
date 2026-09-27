import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { eq } from 'drizzle-orm';
import { automation } from '@/db/schema';
import { getDb } from '@/lib/db';

export async function enqueuePickup(source: string) {
  const db = await getDb();
  const row = await db.select().from(automation).where(eq(automation.id, 'github')).get();
  if (!row?.enabled) return;
  const { env } = await getCloudflareContext({ async: true });
  await env.FACTORY_EVENTS.send({ mode: 'pickup', source });
  await db.update(automation).set({ lastEventAt: new Date(), lastEvent: source }).where(eq(automation.id, 'github'));
}
