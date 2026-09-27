import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { claimDigestSend } from '../lib/digest-claim';
import * as schema from '../db/schema';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  const binding = {
    prepare(query: string) {
      return { bind(...params: unknown[]) {
        const statement = sqlite.prepare(query);
        return {
          async raw() { statement.setReturnArrays(true); return statement.all(...params as never[]); },
          async all() { return { results: statement.all(...params as never[]) }; },
          async run() { statement.run(...params as never[]); return { success: true }; },
        };
      } };
    },
  };
  return { db: drizzle(binding as unknown as D1Database, { schema }), sqlite };
}

test('digest claim is once per Sydney date until a message id is stored', async () => {
  const { db, sqlite } = database();
  try {
    const now = new Date('2026-09-17T21:00:00Z');
    const first = await claimDigestSend(db, '2026-09-18', now);
    const second = await claimDigestSend(db, '2026-09-18', now);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, true);
    assert.equal(second.row?.id, first.row?.id);
    await db.update(schema.digestSends).set({ messageId: 'pb_msg' }).where(eq(schema.digestSends.id, first.row!.id));
    const third = await claimDigestSend(db, '2026-09-18', now);
    assert.equal(third.claimed, false);
    assert.equal(third.row?.messageId, 'pb_msg');
    const nextDay = await claimDigestSend(db, '2026-09-19', now);
    assert.equal(nextDay.claimed, true);
  } finally { sqlite.close(); }
});