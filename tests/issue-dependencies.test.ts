import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyBlockers, openBlockers } from '../lib/issue-dependencies';
import { automationCandidates } from '../lib/automation-state';
import { lifecycleDatabase } from './support/d1';

test('dependency lines name blockers; passing mentions of other issues do not', () => {
  assert.deepEqual(bodyBlockers([
    'Depends on #12',
    '- Blocked by: #3, #4 and org/other#9',
    '**Waits on** #5',
    'Parent epic: #472. Scoring maths (#474) and schema (#475).',
    'This depends on #99 mid-sentence.',
  ].join('\n')), [12, 3, 4, 5]);
  assert.deepEqual(bodyBlockers(null), []);
});

const ticket = { id: 'ticket', projectId: 'project', githubIssueNumber: 1 };

test('body and GitHub-linked blockers are recorded, and only open ones hold the ticket', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const calls: string[] = [];
    const client = { request: async (route: string) => {
      calls.push(route);
      return { data: [
        { number: 2, state: 'open', repository_url: 'https://api.github.com/repos/Org/Repo', html_url: 'https://github.com/org/repo/issues/2' },
        { number: 7, state: 'open', repository_url: 'https://api.github.com/repos/org/elsewhere', html_url: 'https://github.com/org/elsewhere/issues/7' },
      ] };
    } } as never;
    // Unblocked by GitHub's count, so no extra request; the body names a ticket that is open.
    assert.deepEqual(await openBlockers(db, client, 'org', 'repo', ticket, { body: 'Depends on #2 and #1' }), ['#2']);
    assert.equal(calls.length, 0);
    assert.ok(!(await automationCandidates(db, 'worker', 'factory:ready')).some((row) => row.ticket.id === 'ticket'));
    sqlite.exec("UPDATE tickets SET github_state='closed' WHERE id='second'");
    assert.deepEqual(await openBlockers(db, client, 'org', 'repo', ticket, { body: 'Depends on #2' }), []);
    assert.ok((await automationCandidates(db, 'worker', 'factory:ready')).some((row) => row.ticket.id === 'ticket'));
    // GitHub's own state wins over a stale row, and another repository's open issue still blocks.
    assert.deepEqual(await openBlockers(db, client, 'org', 'repo', ticket, { body: null, issue_dependencies_summary: { blocked_by: 2 } }),
      ['#2', 'https://github.com/org/elsewhere/issues/7']);
    assert.deepEqual(calls, ['GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by']);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM ticket_dependencies').get()?.n, 1);
  } finally { sqlite.close(); }
});
