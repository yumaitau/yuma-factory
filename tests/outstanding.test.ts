import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupOutstanding } from '../lib/outstanding';
import { digestHtml, digestMail, digestSubject } from '../lib/digest-mail';
import { paperboyEmailsUrl } from '../lib/paperboy';
import { secretMatches } from '../lib/factory-auth';
import { FACTORY_OPERATIONS, factoryCapabilities } from '../lib/factory-catalog';
import type { WorkCard } from '../lib/work-board';

const card: WorkCard = {
  id: 'ticket', title: 'Fix <script>', number: 1, repo: 'org/repo', projectId: 'project',
  htmlUrl: 'https://github.com/org/repo/issues/1', stage: 'intake', githubState: 'open',
  labels: ['factory:ready'], assignedAgentId: null, agentName: null, automationSlot: null,
  runStatus: null, runId: null, startedAt: null, finishedAt: null, pullRequestUrl: null,
};

test('outstanding snapshot drops done work and keeps failed, queued, and review items', () => {
  const snapshot = groupOutstanding([
    card,
    { ...card, id: 'failed', runStatus: 'failed', runId: 'run', title: 'Broken' },
    { ...card, id: 'done', githubState: 'closed', title: 'Shipped' },
  ], { pulls: [{ url: 'https://github.com/org/repo/pull/9', number: 9, title: 'PR', repo: 'org/repo', runId: 'run', draft: false, updatedAt: '2026-09-21T00:00:00Z', running: false }], unavailableRepos: [] }, new Date('2026-09-17T21:00:00Z'));
  assert.equal(snapshot.sydneyDate, '2026-09-18');
  assert.equal(snapshot.counts.queued, 1);
  assert.equal(snapshot.counts.attention, 1);
  assert.equal(snapshot.counts.intake, 0);
  assert.equal(snapshot.lanes.attention[0].title, 'Broken');
  assert.equal(snapshot.pulls.length, 1);
  assert.equal(snapshot.total, 3);
});

test('digest mail names the Sydney day, escapes HTML, and builds the PaperBoy endpoint', () => {
  const snapshot = groupOutstanding(
    [{ ...card, runStatus: 'failed', runId: 'run' }],
    { pulls: [], unavailableRepos: [] },
    new Date('2026-09-17T21:00:00Z'),
  );
  const mail = digestMail(snapshot);
  assert.equal(digestSubject(snapshot), 'Factory outstanding · 2026-09-18 · 1 need attention');
  assert.match(mail.text, /org\/repo#1/);
  assert.match(digestHtml(snapshot), /Fix &lt;script&gt;/);
  assert.doesNotMatch(digestHtml(snapshot), /<script>/);
  assert.equal(paperboyEmailsUrl('https://paperboy.example.com/'), 'https://paperboy.example.com/api/v1/emails');
});

test('factory catalog exposes HTTP and MCP peers and API keys compare in constant time', () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: 'https://factory.example.com/',
    PAPERBOY_API_URL: 'https://paperboy.example.com',
    PAPERBOY_API_KEY: 'pb_test',
    PAPERBOY_FROM: 'Factory <factory@example.com>',
  });
  let capabilities;
  try { capabilities = factoryCapabilities(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  assert.equal(capabilities.baseUrl, 'https://factory.example.com');
  assert.equal(capabilities.from, 'Factory <factory@example.com>');
  assert.equal(capabilities.transports.mcp, '/api/mcp');
  assert.ok(FACTORY_OPERATIONS.some((operation) => operation.mcp === 'factory_list_outstanding'));
  assert.ok(FACTORY_OPERATIONS.some((operation) => operation.id === 'sendDigest' && operation.method === 'POST'));
  const names = FACTORY_OPERATIONS.map((operation) => operation.mcp).filter(Boolean);
  assert.equal(names.length, new Set(names).size);
  assert.equal(secretMatches('secret', 'secret'), true);
  assert.equal(secretMatches('nope', 'secret'), false);
  assert.equal(secretMatches(null, 'secret'), false);
});