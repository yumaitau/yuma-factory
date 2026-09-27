import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markGithubIssueDone, setGithubIssueRisk } from '../lib/github-completion';
type Client = Parameters<typeof markGithubIssueDone>[0];

function riskClient(issueLabels: Array<string | { name: string }>, deleted: string[], added: string[][]) {
  return { request: async (route: string, params: Record<string, unknown>) => {
    if (route.startsWith('GET') && route.includes('/labels/{name}')) throw { status: 404 };
    if (route.startsWith('POST') && route.endsWith('/labels') && !route.includes('issue_number')) return { data: {} };
    if (route.startsWith('GET') && route.includes('/issues/{issue_number}')) return { data: { labels: issueLabels } };
    if (route.startsWith('DELETE')) { deleted.push(String(params.name)); return { data: {} }; }
    if (route.startsWith('POST') && route.includes('issue_number}/labels')) {
      added.push(params.labels as string[]);
      return { data: {} };
    }
    throw new Error(`unexpected ${route}`);
  } } as unknown as Client;
}

test('completion creates missing done label, preserves unrelated labels, removes ready and closes as completed', async () => {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  const client = { request: async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params });
    if (route.includes('/labels/{name}')) throw { status: 404 };
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET'))
      return { data: { state: 'open', labels: [{ name: 'bug' }, { name: 'factory:done' }] } };
    if (route.startsWith('PATCH')) return { data: { state: 'closed', labels: [{ name: 'bug' }, { name: 'factory:done' }] } };
    return { data: [] };
  } } as unknown as Client;
  assert.deepEqual(await markGithubIssueDone(client, 'org', 'repo', 7), ['bug', 'factory:done']);
  assert.deepEqual(calls.find((call) => call.route.includes('issue_number}/labels') && call.route.startsWith('POST'))?.params.labels, ['factory:done']);
  assert.equal(calls.at(-1)?.params.state_reason, 'completed');
  assert.equal(calls.at(-1)?.params.labels, undefined);
  assert.equal(calls.some((call) => call.route.includes('/merge')), false);
});

test('retry tolerates an already-removed ready label and does not close on label failure', async () => {
  let closed = 0;
  const client = { request: async (route: string) => {
    if (route.startsWith('DELETE')) throw { status: 404 };
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET')) return { data: { labels: ['factory:done'] } };
    if (route.startsWith('PATCH')) { closed++; return { data: { state: 'closed', labels: ['factory:done'] } }; }
    return { data: [] };
  } } as unknown as Client;
  await markGithubIssueDone(client, 'org', 'repo', 7);
  await markGithubIssueDone(client, 'org', 'repo', 7);
  assert.equal(closed, 2);
  const failing = { request: async (route: string) => {
    if (route.startsWith('POST')) throw new Error('GitHub unavailable');
    if (route.startsWith('PATCH')) closed++;
    return { data: [] };
  } } as unknown as Client;
  await assert.rejects(markGithubIssueDone(failing, 'org', 'repo', 7), /unavailable/);
  assert.equal(closed, 2);
});

test('low-risk completion squash-merges the confirmed SHA then closes; unrated never merges', async () => {
  const calls: string[] = [];
  const sha = 'a'.repeat(40);
  const low = { request: async (route: string, params: Record<string, unknown>) => {
    calls.push(`${route.split(' ')[0]}:${'sha' in params ? params.merge_method ?? params.sha ?? '' : ''}`);
    if (route.includes('/labels/{name}')) return { data: {} };
    if (route.includes('/pulls/{pull_number}') && route.startsWith('GET'))
      return { data: { merged: false, state: 'open', head: { sha } } };
    if (route.includes('/merge')) return { data: { merged: true } };
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET'))
      return { data: { labels: ['factory:risk:low', 'factory:done'] } };
    if (route.startsWith('PATCH')) return { data: { state: 'closed', labels: ['factory:risk:low', 'factory:done'] } };
    return { data: [] };
  } } as unknown as Client;
  assert.deepEqual(await markGithubIssueDone(low, 'org', 'repo', 7, { pullNumber: 4, sha }), ['factory:risk:low', 'factory:done']);
  const mergeAt = calls.findIndex((call) => call.startsWith('PUT:') && call.includes('squash'));
  const closedAt = calls.findIndex((call) => call.startsWith('PATCH:'));
  assert.equal(mergeAt > closedAt && closedAt >= 0, true);
  const unratedCalls: string[] = [];
  const unrated = { request: async (route: string) => {
    unratedCalls.push(route);
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET')) return { data: { labels: ['factory:done'] } };
    if (route.startsWith('PATCH')) return { data: { state: 'closed', labels: ['factory:done'] } };
    return { data: [] };
  } } as unknown as Client;
  await markGithubIssueDone(unrated, 'org', 'repo', 7, { pullNumber: 4, sha });
  assert.equal(unratedCalls.some((route) => route.includes('/pulls/') || route.includes('/merge')), false);
});

test('low-risk merge blocked by reviews or SHA drift still closes the issue', async () => {
  const sha = 'b'.repeat(40);
  let closed = 0;
  const blocked = { request: async (route: string) => {
    if (route.includes('/pulls/{pull_number}') && route.startsWith('GET'))
      return { data: { merged: false, state: 'open', head: { sha } } };
    if (route.includes('/merge')) throw { status: 405, message: 'Pull Request is not mergeable' };
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET'))
      return { data: { labels: ['severity:low'] } };
    if (route.startsWith('PATCH')) { closed++; return { data: { state: 'closed', labels: ['severity:low', 'factory:done'] } }; }
    return { data: [] };
  } } as unknown as Client;
  await markGithubIssueDone(blocked, 'org', 'repo', 7, { pullNumber: 9, sha });
  assert.equal(closed, 1);
  const drifted = { request: async (route: string) => {
    if (route.includes('/pulls/{pull_number}')) return { data: { merged: false, state: 'open', head: { sha: 'c'.repeat(40) } } };
    if (route.includes('/issues/{issue_number}') && route.startsWith('GET')) return { data: { labels: ['risk:low'] } };
    if (route.startsWith('PATCH')) { closed++; return { data: { state: 'closed', labels: ['risk:low', 'factory:done'] } }; }
    return { data: [] };
  } } as unknown as Client;
  await markGithubIssueDone(drifted, 'org', 'repo', 7, { pullNumber: 9, sha });
  assert.equal(closed, 2);
});

test('Factory risk rating writes factory:risk and leaves human severity labels', async () => {
  const deleted: string[] = [];
  const added: string[][] = [];
  const labels = await setGithubIssueRisk(
    riskClient([{ name: 'severity:low' }, { name: 'factory:risk:high' }, { name: 'factory:ready' }], deleted, added),
    'org', 'repo', 7, 'low',
  );
  assert.deepEqual(deleted, ['factory:risk:high']);
  assert.deepEqual(added, [['factory:risk:low']]);
  assert.equal(labels.includes('severity:low'), true);
});
