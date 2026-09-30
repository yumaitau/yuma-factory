import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { claimRun, moveTicket, reconcileAbandonedClaims } from '../lib/run-lifecycle';
import { automationCandidates } from '../lib/automation-state';
import { savePlanProposal } from '../lib/collab-store';
import * as schema from '../db/schema';
import { lifecycleDatabase } from './support/d1';

const input = { id: 'run', ticketId: 'ticket', agentId: 'worker', userId: 'user', accountId: 'account', modelId: 'codex-default', mode: 'implement' as const };
const options = { automationLabel: 'factory:ready', automationLeaseId: 'lease' };
async function reserve(db: ReturnType<typeof lifecycleDatabase>['db'], id = 'run') {
  await db.insert(schema.accountLeases).values({ holderId: id, accountId: 'account', createdAt: new Date() });
}

test('run claim atomically reserves the ticket and agent, excluding competing claims', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await reserve(db); await reserve(db, 'competitor');
    assert.equal(await claimRun(db, input), true);
    assert.equal(await claimRun(db, { ...input, id: 'competitor', agentId: 'other' }), false);
    assert.equal(await claimRun(db, { ...input, id: 'competitor', ticketId: 'second' }), false);
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='worker'").get()?.status, 'working');
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='other'").get()?.status, 'idle');
    assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='ticket'").get()?.stage, 'in_progress');
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  } finally { sqlite.close(); }
});

test('interrupted claim rolls back the run, ticket and agent together', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await reserve(db);
    sqlite.exec("CREATE TRIGGER fail_ticket BEFORE UPDATE ON tickets BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    await assert.rejects(claimRun(db, input), /simulated failure/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM runs').get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='worker'").get()?.status, 'idle');
    assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='ticket'").get()?.stage, 'intake');
    sqlite.exec('DROP TRIGGER fail_ticket');
    assert.equal(await claimRun(db, input), true);
  } finally { sqlite.close(); }
});

test('claim rejects closed, archived, blocked, orphaned and busy work without claiming an agent', async () => {
  for (const mutation of [
    "UPDATE tickets SET github_state='closed' WHERE id='ticket'",
    "UPDATE projects SET status='archived'",
    "INSERT INTO ticket_dependencies VALUES ('ticket', 'second')",
    "UPDATE agents SET status='working' WHERE id='worker'",
    "DELETE FROM account_leases",
    "UPDATE tickets SET plan_task='missing:task' WHERE id='ticket'",
  ]) {
    const { db, sqlite } = lifecycleDatabase();
    try {
      await reserve(db); sqlite.exec(mutation);
      assert.equal(await claimRun(db, input), false, mutation);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM runs').get()?.n, 0);
      assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='ticket'").get()?.stage, 'intake');
    } finally { sqlite.close(); }
  }
});

test('same-second requeue clears a failed attempt and the replacement run remains visible', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db.insert(schema.runs).values({ id: 'old', ticketId: 'ticket', agentId: 'worker', modelId: 'codex-default', status: 'failed', createdAt: now });
    await moveTicket(db, 'ticket', 'intake', true, now);
    const ticket = await db.select().from(schema.tickets).where(eq(schema.tickets.id, 'ticket')).get();
    assert.equal(ticket?.requeuedAt?.getTime(), now.getTime() + 1000);
    assert.ok((await automationCandidates(db, 'worker', 'factory:ready')).some(row => row.ticket.id === 'ticket'));
    await reserve(db);
    await db.insert(schema.automation).values({ id: 'github', enabled: true, userId: 'user', agentId: 'worker', leaseId: 'lease', leaseUntil: new Date(Date.now() + 60_000), updatedAt: now });
    sqlite.exec("UPDATE agents SET automation_slot=1 WHERE id='worker'");
    assert.equal(await claimRun(db, input, options), true);
    const run = await db.select().from(schema.runs).where(eq(schema.runs.id, 'run')).get();
    assert.ok(run!.createdAt >= ticket!.requeuedAt!);
    assert.ok(!(await automationCandidates(db, 'worker', 'factory:ready')).some(row => row.ticket.id === 'ticket'));
  } finally { sqlite.close(); }
});

test('manual stage moves cannot invent running work or move a live run', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await assert.rejects(moveTicket(db, 'ticket', 'in_progress'), /Start a run/);
    await reserve(db); await claimRun(db, input);
    await assert.rejects(moveTicket(db, 'ticket', 'intake', true), /Stop the active run/);
  } finally { sqlite.close(); }
});

test('plan proposals survive callback retries and subtasks wait until dependencies are installed', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, 'ticket')).get())!;
    const raw = { summary: 'Two tasks', tasks: [{ key: 'api', title: 'Build API' }, { key: 'ui', title: 'Build UI', dependsOn: ['api'] }] };
    const proposal = await savePlanProposal(db, { ticket, runId: 'plan-run', raw });
    assert.equal((await savePlanProposal(db, { ticket, runId: 'plan-run', raw })).id, proposal.id);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM plans').get()?.n, 1);
    await db.update(schema.tickets).set({ planTask: `${proposal.id}:ui`, parentTicketId: 'ticket' }).where(eq(schema.tickets.id, 'second'));
    await reserve(db);
    for (const status of ['proposed', 'applying', 'failed']) {
      await db.update(schema.plans).set({ status }).where(eq(schema.plans.id, proposal.id));
      assert.equal(await claimRun(db, { ...input, ticketId: 'second' }), false);
      assert.ok(!(await automationCandidates(db, 'worker', 'factory:ready')).some(row => row.ticket.id === 'second'));
    }
    await db.insert(schema.ticketDependencies).values({ ticketId: 'second', dependsOnTicketId: 'ticket' });
    await db.update(schema.plans).set({ status: 'applied' }).where(eq(schema.plans.id, proposal.id));
    assert.equal(await claimRun(db, { ...input, ticketId: 'second' }), false);
    await db.update(schema.tickets).set({ githubState: 'closed' }).where(eq(schema.tickets.id, 'ticket'));
    assert.equal(await claimRun(db, { ...input, ticketId: 'second' }), true);
  } finally { sqlite.close(); }
});

test('expired scheduler ownership cannot dispatch a new run', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await reserve(db);
    await db.insert(schema.automation).values({ id: 'github', enabled: true, userId: 'user', agentId: 'worker', leaseId: 'lease', leaseUntil: new Date(0), updatedAt: new Date() });
    sqlite.exec("UPDATE agents SET automation_slot=1 WHERE id='worker'");
    assert.equal(await claimRun(db, input, options), false);
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='worker'").get()?.status, 'idle');
  } finally { sqlite.close(); }
});


test('abandoned claims recover while fresh claims, live runs and disabled agents remain untouched', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const now = new Date();
    sqlite.exec("UPDATE agents SET status='working'; UPDATE tickets SET stage='in_progress', assigned_agent_id='worker';");
    await reconcileAbandonedClaims(db, now);
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='worker'").get()?.status, 'idle');
    assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='ticket'").get()?.stage, 'assigned');
    await reserve(db); assert.equal(await claimRun(db, input), true);
    sqlite.exec("UPDATE agents SET status='disabled' WHERE id='other'; UPDATE tickets SET stage='in_progress', updated_at=unixepoch() WHERE id='second';");
    await reconcileAbandonedClaims(db, now);
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='worker'").get()?.status, 'working');
    assert.equal(sqlite.prepare("SELECT status FROM agents WHERE id='other'").get()?.status, 'disabled');
    assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='ticket'").get()?.stage, 'in_progress');
    assert.equal(sqlite.prepare("SELECT stage FROM tickets WHERE id='second'").get()?.stage, 'in_progress');
  } finally { sqlite.close(); }
});


test('bounded candidate scans rotate rejected tickets independently of repository sync timestamps', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    await db.update(schema.tickets).set({ createdAt: new Date(0) });
    const first = (await automationCandidates(db, 'worker', 'factory:ready', 1))[0].ticket.id;
    await db.update(schema.tickets).set({ dispatchCheckedAt: new Date() }).where(eq(schema.tickets.id, first));
    // Full GitHub sync touches updatedAt but must not reset dispatch fairness.
    await db.update(schema.tickets).set({ updatedAt: new Date() });
    const next = (await automationCandidates(db, 'worker', 'factory:ready', 1))[0].ticket.id;
    assert.notEqual(next, first);
  } finally { sqlite.close(); }
});
