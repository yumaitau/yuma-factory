import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { seedSession } from './journeys';
import { uniqueEmail } from './support';

// Mirrors lib/run-token.ts with the Playwright server's runner secret.
const token = (runId: string) => `${runId}.${createHmac('sha256', process.env.SANDBOX_RUNNER_SECRET ?? 'e2e-only-runner-secret')
  .update(`factory-run-channel:v1:${runId}`).digest('base64url')}`;

function localDatabase(email: string) {
  const root = '.wrangler/state/v3/d1';
  for (const file of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith('.sqlite'))) {
    const db = new DatabaseSync(path.join(root, String(file)));
    try {
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (user) { db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'); return { db, userId: String(user.id) }; }
    } catch { /* Other local databases are not Factory. */ }
    db.close();
  }
  throw new Error('Local Factory fixture database not found');
}

test('running agents share memory and an epic thread over their scoped live channel', async ({ page, request, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local fixtures only');
  const email = uniqueEmail('channel');
  await seedSession(page, email);
  const { db, userId } = localDatabase(email);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const inst = `inst_${suffix}`, proj = `proj_${suffix}`, agent = `agt_${suffix}`;
  const epic = `tkt_e${suffix.slice(1)}`, child = `tkt_c${suffix.slice(1)}`, sibling = `tkt_s${suffix.slice(1)}`, run = `run_${suffix}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inst, now + 200, 'fixture', 'Organization', userId, now, now);
    db.prepare('INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(proj, inst, 'fixture/channel', now + 200, now, now);
    db.prepare('INSERT INTO agents (id, owner_user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(agent, userId, 'Channel worker', 'working', now, now);
    const ticket = db.prepare('INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, stage, labels, html_url, parent_ticket_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ticket.run(epic, proj, 1, now + 1, 'Checkout epic', 'review', '["factory:plan"]', 'https://github.com/fixture/channel/issues/1', null, now, now);
    ticket.run(child, proj, 2, now + 2, 'Checkout API', 'in_progress', '["factory:ready"]', 'https://github.com/fixture/channel/issues/2', epic, now, now);
    ticket.run(sibling, proj, 3, now + 3, 'Checkout UI', 'intake', '["factory:ready"]', 'https://github.com/fixture/channel/issues/3', epic, now, now);
    db.prepare('INSERT INTO runs (id, ticket_id, agent_id, requested_by_user_id, model_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run, child, agent, userId, 'codex-default', 'running', now, now);

    const rpc = (method: string, params?: unknown, bearer = token(run)) => request.post('/api/runs/mcp', {
      headers: { Authorization: `Bearer ${bearer}` }, data: { jsonrpc: '2.0', id: 1, method, params },
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => (await (await rpc('tools/call', { name, arguments: args })).json()) as {
      result?: { structuredContent: Record<string, unknown> }; error?: { message: string };
    };

    expect((await request.get('/api/runs/mcp')).status()).toBe(405);
    expect((await rpc('tools/list', undefined, `${run}.forged`)).status()).toBe(401);
    expect((await (await rpc('initialize')).json()).result.serverInfo.name).toBe('factory-run');
    const tools = (await (await rpc('tools/list')).json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(['factory_memory_search', 'factory_memory_propose', 'factory_thread_read', 'factory_thread_post', 'factory_team_status']);

    expect((await call('factory_memory_propose', { kind: 'gotcha', content: `Checkout totals are cached in KV per cart ${suffix}.` })).result?.structuredContent.ok).toBe(true);
    const found = await call('factory_memory_search', { query: 'checkout totals cart cache' });
    expect(JSON.stringify(found.result?.structuredContent)).toContain(suffix);
    expect(db.prepare('SELECT status, weight, source FROM memories WHERE project_id = ?').get(proj)).toEqual({ status: 'active', weight: 20, source: 'agent' });

    expect((await call('factory_thread_post', { body: 'API contract: POST /checkout returns { orderId }.' })).result?.structuredContent.ok).toBe(true);
    const thread = await call('factory_thread_read');
    expect(JSON.stringify(thread.result?.structuredContent)).toContain('POST /checkout returns');
    expect(db.prepare('SELECT thread_ticket_id, kind FROM agent_messages WHERE run_id = ?').get(run)).toEqual({ thread_ticket_id: epic, kind: 'agent' });

    const status = await call('factory_team_status');
    expect(status.result?.structuredContent).toMatchObject({ epic: { number: 1, title: 'Checkout epic' }, siblings: [{ number: 3, stage: 'intake' }] });

    for (let posted = 1; posted < 8; posted++) await call('factory_thread_post', { body: `Update ${posted}` });
    expect((await call('factory_thread_post', { body: 'One too many' })).error?.message).toMatch(/limit reached/);

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('succeeded', run);
    expect((await rpc('tools/list')).status()).toBe(401);
  } finally {
    await page.goto('about:blank');
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();
  }
});
