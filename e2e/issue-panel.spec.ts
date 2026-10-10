import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { seedSession } from './journeys';
import { uniqueEmail } from './support';

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

test('issue panel shows agent sessions, takes a follow-up and follows live activity', async ({ page, request, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local fixtures only');
  test.setTimeout(90_000);
  expect((await request.get('/api/tickets/tkt_00000000000000000000000000000000')).status()).toBe(401);
  const email = uniqueEmail('issue-panel');
  await seedSession(page, email);
  const { db, userId } = localDatabase(email);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const inst = `inst_${suffix}`, proj = `proj_${suffix}`, agent = `agt_${suffix}`, ticket = `tkt_${suffix}`;
  const first = `run_${suffix}`, next = `next_${suffix}`;
  const now = Math.floor(Date.now() / 1000);
  const activity = db.prepare('INSERT INTO run_activities (id, run_id, ticket_id, seq, type, body, action, parameter, result, ephemeral, author_user_id, delivered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const add = (run: string, seq: number, type: string, body: string, extra: { action?: string; parameter?: string; result?: string; ephemeral?: boolean; author?: string } = {}) =>
    activity.run(`act_${seq}${run}`, run, ticket, seq, type, body, extra.action ?? null, extra.parameter ?? null, extra.result ?? null,
      extra.ephemeral ? 1 : 0, extra.author ?? null, extra.author ? Date.now() : null, Date.now() - 60_000 + seq * 1000);
  try {
    db.prepare('INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inst, now + 300, 'fixture', 'Organization', userId, now, now);
    db.prepare('INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(proj, inst, 'fixture/session', now + 300, now, now);
    db.prepare('INSERT INTO agents (id, owner_user_id, name, color, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, userId, 'Session worker', '#2d7a8c', 'working', now, now);
    db.prepare('INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, stage, assigned_agent_id, labels, html_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket, proj, 1, now + 300, 'Fix checkout totals', 'in_progress', agent, '["factory:ready","factory:risk:low"]', 'https://github.com/fixture/session/issues/1', now, now);
    const run = db.prepare('INSERT INTO runs (id, ticket_id, agent_id, requested_by_user_id, model_id, status, log, pull_request_url, pull_request_state, branch_name, parent_run_id, plan, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    run.run(first, ticket, agent, userId, 'codex-default', 'succeeded', 'First attempt log', 'https://github.com/fixture/session/pull/7', 'open', 'factory/ticket-1-session', null, null, now - 600, now - 300, now - 600);
    run.run(next, ticket, agent, userId, 'codex-default', 'running', 'Follow-up log', 'https://github.com/fixture/session/pull/7', 'open', 'factory/ticket-1-session', first,
      JSON.stringify([{ content: 'Read the refunds module', status: 'completed' }, { content: 'Cover refunds', status: 'inProgress' }]), now - 60, null, now - 60);
    add(first, 1, 'thought', 'Reading the **checkout** module first.');
    add(first, 2, 'action', '', { action: 'Ran', parameter: 'pnpm test', result: 'All 12 tests passed' });
    add(first, 3, 'response', 'Opened a pull request that fixes the totals.');
    add(next, 1, 'prompt', 'Also cover refunds', { author: userId });
    add(next, 2, 'thought', 'Looking at refunds next.');
    add(next, 3, 'action', '', { action: 'Editing', parameter: 'lib/refunds.ts', ephemeral: true });

    await page.route('**/api/work/review', (route) => route.fulfill({ json: { pulls: [], unavailableRepos: [], checkedAt: new Date().toISOString() } }));
    await page.goto('/work');
    await page.getByRole('region', { name: 'Factory work board' }).getByRole('link', { name: 'Fix checkout totals' }).click();
    const panel = page.getByRole('dialog', { name: 'Fix checkout totals' });
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?issue=${ticket}$`));
    await expect(panel.getByRole('link', { name: 'fixture/session#1' })).toHaveAttribute('href', 'https://github.com/fixture/session/issues/1');
    const properties = panel.getByRole('definition');
    await expect(properties.filter({ hasText: 'Session worker' })).toBeVisible();
    await expect(properties.filter({ hasText: 'Low risk · auto-merge' })).toBeVisible();
    await expect(properties.filter({ hasText: 'factory/ticket-1-session' })).toBeVisible();
    await expect(properties.getByRole('link', { name: 'PR open' })).toBeVisible();

    // The finished first session is folded; the newest is open and working.
    const [older, newer] = [panel.getByRole('region', { name: 'Session worker session' }).first(), panel.getByRole('region', { name: 'Session worker session' }).last()];
    await expect(older.getByText('Done', { exact: true })).toBeVisible();
    await expect(older.getByText('Opened a pull request')).toBeHidden();
    await older.getByRole('button', { expanded: false }).first().click();
    await expect(older.getByText('Opened a pull request that fixes the totals.')).toBeVisible();
    await expect(older.getByText('Reading the')).toBeHidden();
    await older.getByRole('button', { name: 'Show 2 steps' }).click();
    await expect(older.getByText('Reading the checkout module first.')).toBeVisible();
    await older.getByText('pnpm test').click();
    await expect(older.getByText('All 12 tests passed')).toBeVisible();
    await expect(newer.getByText('Follow-up')).toBeVisible();
    await expect(newer.getByText('Working', { exact: true })).toBeVisible();
    await expect(newer.getByRole('list', { name: 'Plan' })).toContainText('Cover refunds');
    await expect(newer.getByText('Also cover refunds')).toBeVisible();
    await expect(newer.getByText('Editing · lib/refunds.ts')).toBeVisible();
    await page.screenshot({ path: 'test-results/issue-panel.png' });

    // A follow-up to a live run is queued for the agent.
    const composer = panel.getByLabel('Message the agent');
    await expect(composer).toHaveAttribute('placeholder', 'Agent will pick this up after its current step');
    await composer.fill('Please add a regression test');
    await composer.press('ControlOrMeta+Enter');
    await expect(newer.getByText('Please add a regression test')).toBeVisible();
    await expect(composer).toHaveValue('');
    expect(db.prepare("SELECT author_user_id FROM run_activities WHERE run_id = ? AND type = 'prompt' AND body = ?").get(next, 'Please add a regression test')?.author_user_id).toBe(userId);

    // The runner reports a final answer; polling picks it up and the session folds its steps.
    add(next, 10, 'response', 'Added the regression test for refunds.');
    await expect(newer.getByText('Added the regression test for refunds.')).toBeVisible({ timeout: 10_000 });
    await expect(newer.getByText('Done', { exact: true })).toBeVisible();
    // The superseded live action is gone, so one step remains.
    await expect(newer.getByRole('button', { name: 'Show 1 step' })).toBeVisible();
    await expect(newer.getByText('Editing · lib/refunds.ts')).toBeHidden();

    // Esc closes the panel and returns focus to the card; Enter on the card opens it again.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/\/work$/);
    const card = page.locator(`[data-card="${ticket}"]`);
    await expect(card).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Deep links open the panel, and the run page leads with the session.
    await page.goto(`/work?issue=${ticket}`);
    await expect(panel).toBeVisible();
    await page.goto(`/projects/${proj}`);
    await page.getByRole('link', { name: 'Fix checkout totals' }).click();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${proj}\\?issue=${ticket}$`));
    await page.goto(`/work/runs/${first}`);
    await expect(page.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Opened a pull request that fixes the totals.')).toBeVisible();
    await page.screenshot({ path: 'test-results/run-session.png' });
    await page.getByRole('tab', { name: 'Raw log' }).click();
    await expect(page.getByLabel('Execution log')).toContainText('First attempt log');
  } finally {
    await page.goto('about:blank');
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();
  }
});
