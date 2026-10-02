import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncPullRequests } from '../lib/pull-request-sync';
import { lifecycleDatabase } from './support/d1';

test('a merged PR finishes its ticket and a closed PR is recorded for the board to hide', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    sqlite.exec(`
      INSERT INTO runs (id, ticket_id, agent_id, status, model_id, pull_request_url, created_at)
        VALUES ('merged', 'ticket', 'worker', 'succeeded', 'm', 'https://github.com/org/repo/pull/10', 1),
        ('closed', 'second', 'other', 'succeeded', 'm', 'https://github.com/org/repo/pull/20', 1);
      UPDATE tickets SET stage = 'review';
    `);
    const calls: string[] = [];
    const client = { request: async (route: string, params: { pull_number?: number }) => {
      calls.push(route);
      if (route.includes('/pulls/')) return { data: params.pull_number === 10 ? { merged: true, state: 'closed' } : { merged: false, state: 'closed' } };
      if (route.startsWith('PATCH')) return { data: { state: 'closed', labels: [{ name: 'factory:done' }] } };
      return { data: { labels: [] } };
    } };
    await syncPullRequests(db, async () => client as never, Date.now() + 60_000);
    assert.deepEqual(sqlite.prepare("SELECT id, pull_request_state AS state FROM runs ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: 'closed', state: 'closed' }, { id: 'merged', state: 'merged' }]);
    assert.deepEqual({ ...sqlite.prepare("SELECT stage, github_state FROM tickets WHERE id='ticket'").get() }, { stage: 'done', github_state: 'closed' });
    assert.deepEqual({ ...sqlite.prepare("SELECT stage, github_state FROM tickets WHERE id='second'").get() }, { stage: 'review', github_state: 'open' });
    // Only one issue closed: the closed-unmerged PR leaves its issue alone.
    assert.equal(calls.filter((route) => route.startsWith('PATCH')).length, 1);
  } finally { sqlite.close(); }
});
