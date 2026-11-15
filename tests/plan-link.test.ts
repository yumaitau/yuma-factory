import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { planLinkForBody, savePlanProposal } from '../lib/collab-store';
import { subtaskIssueBody } from '../lib/plan';
import * as schema from '../db/schema';
import { lifecycleDatabase } from './support/d1';

const bot = { type: 'Bot' };

test('only an issue the Factory App created joins a plan, and a marker already in use is not linked again', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, 'ticket')).get())!;
    const plan = await savePlanProposal(db, { ticket, runId: 'plan-run', raw: { summary: 'One task', tasks: [{ key: 'ui', title: 'Build UI' }] } });
    const body = subtaskIssueBody({ key: 'ui', title: 'Build UI', body: 'x', dependsOn: [], files: [] }, 1, new Map(), plan.id);
    const link = { planTask: `${plan.id}:ui`, parentTicketId: 'ticket' };

    assert.deepEqual(await planLinkForBody(db, { number: 2, body, user: bot }, 'project'), link);
    // A person who copies the marker does not become a subtask.
    assert.equal(await planLinkForBody(db, { number: 2, body, user: { type: 'User' } }, 'project'), null);
    assert.equal(await planLinkForBody(db, { number: 2, body, user: null }, 'project'), null);
    assert.equal(await planLinkForBody(db, { number: 2, body }, 'project'), null);
    assert.equal(await planLinkForBody(db, { number: 2, body: 'no marker', user: bot }, 'project'), null);
    assert.equal(await planLinkForBody(db, { number: 2, body, user: bot }, 'another-project'), null);

    // Once issue 2 holds the task, issue 2 still resolves (edits are idempotent); any other issue does not.
    await db.update(schema.tickets).set(link).where(eq(schema.tickets.id, 'second'));
    assert.deepEqual(await planLinkForBody(db, { number: 2, body, user: bot }, 'project'), link);
    assert.equal(await planLinkForBody(db, { number: 3, body, user: bot }, 'project'), null);
  } finally { sqlite.close(); }
});
