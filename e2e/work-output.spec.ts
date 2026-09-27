import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { seedSession } from './journeys';
import { uniqueEmail } from './support';

let runner: Server;
let polls = 0;
let complete = false;
let offline = false;
let cancellations = 0;
test.beforeAll(async () => {
  runner = createServer((request, response) => {
    if (offline) { response.writeHead(503).end(); return; }
    if (request.method === 'POST' && request.url?.includes('/cancel?accountId=')) {
      cancellations++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'cancelled', log: 'Stopped by user. Existing branch and PR preserved.', pullRequestUrl: 'https://github.com/fixture/waiting/pull/1' }));
      return;
    }
    if (!request.url?.includes('/output?accountId=')) { response.writeHead(404).end(); return; }
    polls++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: complete ? 'succeeded' : 'running',
      log: `$ pnpm test\nOutput event ${polls}${complete ? '\nAll tests passed.' : ''}`,
      outputUpdatedAt: new Date().toISOString(), accountStatus: { email: 'must-not-reach-browser@example.test' } }));
  });
  await new Promise<void>((resolve) => runner.listen(3011, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>((resolve) => runner.close(() => resolve())); });

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

test('waiting tickets can stop safely and then move on their project board', async ({ page, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local fixtures only');
  test.setTimeout(90_000);
  offline = false;
  cancellations = 0;
  const email = uniqueEmail('waiting');
  await seedSession(page, email);
  const { db, userId } = localDatabase(email);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const inst = `inst_${suffix}`, proj = `proj_${suffix}`, agent = `agt_${suffix}`;
  const run = `run_${suffix}`, ticket = `tkt_${suffix}`, account = `codex_${suffix}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inst, now + 100, 'fixture', 'Organization', userId, now, now);
    db.prepare('INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(proj, inst, 'fixture/waiting', now + 100, now, now);
    db.prepare('INSERT INTO agents (id, owner_user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(agent, userId, 'Waiting worker', 'working', now, now);
    db.prepare('INSERT INTO codex_accounts (id, owner_user_id, label, status, enabled, active_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(account, userId, 'Busy subscription', 'ready', 1, 'another-operation', now, now);
    db.prepare('INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, stage, assigned_agent_id, labels, html_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket, proj, 1, now + 100, 'Recover this waiting ticket', 'in_progress', agent, '["factory:ready"]', 'https://github.com/fixture/waiting/issues/1', now, now);
    db.prepare('INSERT INTO runs (id, ticket_id, agent_id, requested_by_user_id, codex_account_id, model_id, status, log, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run, ticket, agent, userId, account, 'codex-default', 'running', 'Waiting for subscription', now, now);
    await page.route('**/api/work/review', (route) => route.fulfill({ json: { pulls: [], unavailableRepos: [], checkedAt: new Date().toISOString() } }));
    await page.goto('/work');
    const waiting = page.getByRole('region', { name: 'Waiting tickets', exact: true });
    await expect(waiting.getByText('Recover this waiting ticket')).toBeVisible();
    await expect(waiting.getByRole('link', { name: 'Manage subscriptions' })).toBeVisible();
    await waiting.getByRole('link', { name: 'Project board' }).click();
    await page.getByLabel('Move stage').selectOption('review');
    await expect(page.getByRole('alert').filter({ hasText: 'Stop the active run' })).toBeVisible();
    expect(db.prepare('SELECT stage FROM tickets WHERE id = ?').get(ticket)?.stage).toBe('in_progress');
    await page.goto('/work');
    const stop = waiting.getByRole('button', { name: 'Stop and return to intake' });

    // A board is shared, but stopping another user's run must fail before runner dispatch.
    db.prepare('UPDATE runs SET requested_by_user_id = NULL WHERE id = ?').run(run);
    await stop.click();
    await expect(page.getByRole('region', { name: 'Factory work board' }).getByRole('alert')).toContainText('belongs to another user');
    expect(cancellations).toBe(0);
    db.prepare('UPDATE runs SET requested_by_user_id = ? WHERE id = ?').run(userId, run);
    offline = true;
    await stop.click();
    await expect(page.getByRole('region', { name: 'Factory work board' }).getByRole('alert')).not.toContainText('belongs to another user');
    await expect(stop).toBeEnabled();
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(run)?.status).toBe('running');
    expect(db.prepare('SELECT stage FROM tickets WHERE id = ?').get(ticket)?.stage).toBe('in_progress');
    offline = false;
    await stop.click();
    const intake = page.getByRole('region', { name: 'Needs preparation tickets', exact: true });
    await expect(intake.getByText('Recover this waiting ticket')).toBeVisible();
    await expect(intake.getByText(/Run stopped/)).toBeVisible();
    expect(cancellations).toBe(1);
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(run)?.status).toBe('cancelled');
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(agent)?.status).toBe('idle');
    expect(db.prepare('SELECT active_run_id FROM codex_accounts WHERE id = ?').get(account)?.active_run_id).toBe('another-operation');
    const callback = {
      headers: { 'x-runner-secret': process.env.SANDBOX_RUNNER_SECRET ?? 'e2e-only-runner-secret' },
      data: { id: run, accountId: account, action: 'pause' },
    };
    expect((await page.request.post('/api/codex/github-token', callback)).status()).toBe(200);
    expect((await page.request.post('/api/codex/github-token', { ...callback, data: { ...callback.data, action: 'resume' } })).status()).toBe(409);
    expect(db.prepare('SELECT active_run_id FROM codex_accounts WHERE id = ?').get(account)?.active_run_id).toBe('another-operation');
    await page.reload();
    await expect(intake.getByText('Recover this waiting ticket')).toBeVisible();
    await intake.getByRole('link', { name: 'Project board' }).click();
    await page.getByLabel('Move stage').selectOption('review');
    await expect.poll(() => db.prepare('SELECT stage FROM tickets WHERE id = ?').get(ticket)?.stage).toBe('review');
    await expect(page.getByLabel('Move stage')).toHaveValue('review');
  } finally {
    offline = false;
    await page.goto('about:blank');
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj);
    db.prepare('DELETE FROM codex_accounts WHERE id = ?').run(account);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();
  }
});

test('completed work, open PR review and authenticated live output', async ({ page, request, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local fixtures only');
  test.setTimeout(90_000);
  expect((await request.get('/api/runs/missing/output')).status()).toBe(401);
  expect((await request.get('/api/work/review')).status()).toBe(401);
  const email = uniqueEmail('work-output');
  await seedSession(page, email);
  const { db, userId } = localDatabase(email);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const inst = `inst_${suffix}`, proj = `proj_${suffix}`, agent = `agent_${suffix}`;
  const runId = `run_${suffix}`, doneId = `done_${suffix}`;
  const accountId = `codex_${suffix}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inst, now, 'fixture', 'Organization', userId, now, now);
    db.prepare('INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(proj, inst, 'fixture/work-output', now, now, now);
    db.prepare('INSERT INTO agents (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(agent, userId, 'Fixture agent', now, now);
    db.prepare('INSERT INTO codex_accounts (id, owner_user_id, label, status, active_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(accountId, userId, 'Running subscription', 'ready', runId, now, now);
    for (const [id, number, title, stage, status, log, finished] of [
      [runId, 1, 'Watch this running task', 'in_progress', 'running', 'Preparing repository', null],
      [doneId, 2, 'Recently completed fixture', 'done', 'succeeded', 'Completed fixture output', now - 30],
    ] as const) {
      db.prepare('INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, stage, labels, html_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`tkt_${id}`, proj, number, now + number, title, stage, number === 1 ? '["factory:ready","factory:risk:low"]' : '["factory:ready"]', `https://github.com/fixture/work-output/issues/${number}`, now, now);
      db.prepare('INSERT INTO runs (id, ticket_id, agent_id, requested_by_user_id, codex_account_id, model_id, status, log, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, `tkt_${id}`, agent, userId, accountId, 'codex-default', status, log, now, finished, now);
    }
    let reviewOpen = true;
    await page.route('**/api/work/review', (route) => route.fulfill({ json: {
      pulls: reviewOpen ? [{ url: 'https://github.com/fixture/work-output/pull/5', number: 5, title: 'Review this completed change', repo: 'fixture/work-output', runId: doneId, draft: false, updatedAt: new Date().toISOString(), running: false }] : [],
      unavailableRepos: [], checkedAt: new Date().toISOString(),
    } }));
    await page.goto('/work');
    const recent = page.getByRole('region', { name: 'Recently completed' });
    await expect(recent.getByText('Recently completed fixture')).toBeVisible();
    await expect(page.getByText('Low-risk tickets merge automatically after green CI')).toBeVisible();
    await expect(page.getByText('Low risk · auto-merge')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review this completed change' })).toBeVisible();
    reviewOpen = false;
    await page.getByRole('button', { name: 'Refresh PRs' }).click();
    await expect(page.getByText('No open Factory PRs waiting for review.')).toBeVisible();
    await page.getByRole('link', { name: 'Watch this running task' }).click();
    const output = page.getByLabel('Execution log');
    await expect(output).toContainText('Output event', { timeout: 20_000 });
    const first = polls;
    await expect.poll(() => polls, { timeout: 10_000 }).toBeGreaterThan(first);
    await expect(page.getByRole('status')).toHaveText('Connected');
    expect(await page.content()).not.toContain('must-not-reach-browser');
    await page.getByLabel('Follow output').uncheck();
    await expect(page.getByLabel('Follow output')).not.toBeChecked();
    offline = true;
    await expect(page.getByRole('status')).toContainText('Reconnecting', { timeout: 10_000 });
    await expect(output).toContainText('Output event');
    offline = false;
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Connected', { timeout: 15_000 });
    complete = true;
    await expect(output).toContainText('All tests passed.', { timeout: 10_000 });
    await expect(page.getByRole('status')).toHaveText('Run finished');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Execution log')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/run-output-mobile.png', fullPage: true });
    await page.goto(`/work/runs/${doneId}`);
    await expect(page.getByLabel('Execution log')).toContainText('Completed fixture output');
    await page.setViewportSize({ width: 1440, height: 1000 });
    reviewOpen = true;
    await page.goto('/work');
    await expect(page.getByRole('link', { name: 'Review this completed change' })).toBeVisible();
    await expect(recent.getByText('Recently completed fixture')).toBeVisible();
    await page.screenshot({ path: 'test-results/work-review-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/work-review-mobile.png', fullPage: true });
  } finally {
    await page.goto('about:blank');
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj);
    db.prepare('DELETE FROM codex_accounts WHERE id = ?').run(accountId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();
  }
});
