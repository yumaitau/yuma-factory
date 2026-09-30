import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateGithubIssueStatus, type IssueRunStatus } from '../lib/github-status';

type Comment = { id: number; body: string; user: { type: string } };
function fixture(pages: Comment[][] = [[]]) {
  const writes: { kind: string; body: string; comment_id?: number }[] = [];
  const client = {
    async request(route: string, params: { page?: number; body: string; comment_id: number }): Promise<unknown> {
      if (route.startsWith('GET')) return { data: pages[(params.page ?? 1) - 1] ?? [] };
      if (route.startsWith('POST')) return client.rest.issues.createComment(params);
      if (route.startsWith('PATCH')) return client.rest.issues.updateComment(params);
      throw new Error(`Unexpected route: ${route}`);
    },
    rest: { issues: {
      listComments() {},
      async createComment(params: { body: string }) {
        writes.push({ kind: 'create', ...params });
        pages[0].push({ id: 42, body: params.body, user: { type: 'Bot' } });
      },
      async updateComment(params: { body: string; comment_id: number }) {
        writes.push({ kind: 'update', ...params });
        pages.flat().find((comment) => comment.id === params.comment_id)!.body = params.body;
      },
    } },
  };
  return {
    writes, pages, client,
    update: (run: IssueRunStatus) => updateGithubIssueStatus(
      client as unknown as Parameters<typeof updateGithubIssueStatus>[0], 'owner', 'repo', 8, run,
    ),
  };
}

test('running comment becomes completed with a PR link; repeated status makes no write', async () => {
  const f = fixture();
  const run = { runId: 'run_123', status: 'running' as const };
  await f.update(run);
  assert.match(f.writes[0].body, /In progress/);
  await f.update(run);
  assert.equal(f.writes.length, 1);
  await f.update({ ...run, status: 'succeeded', issueClosed: true, pullRequestUrl: 'https://github.com/owner/repo/pull/12?test' });
  assert.equal(f.writes[1].kind, 'update');
  assert.equal(f.writes[1].comment_id, 42);
  assert.match(f.writes[1].body, /Completed/);
  assert.match(f.writes[1].body, /\[Pull request #12\]\(https:\/\/github.com\/owner\/repo\/pull\/12\)/);
  assert.equal(f.pages.flat().length, 1);
});

test('each attempt has its own comment; human comments and other bot comments stay untouched', async () => {
  const human = { id: 1, body: '<!-- factory-run-status:run_123 -->\nhuman', user: { type: 'User' } };
  const other = { id: 2, body: 'A review', user: { type: 'Bot' } };
  const f = fixture([[human, other]]);
  await f.update({ runId: 'run_123', status: 'running' });
  await f.update({ runId: 'run_456', status: 'running' });
  assert.deepEqual(f.writes.map((write) => write.kind), ['create', 'create']);
  assert.equal(human.body, '<!-- factory-run-status:run_123 -->\nhuman');
  assert.equal(other.body, 'A review');
});

test('finds status on later pages and reports review, failure and cancellation accurately', async () => {
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id: id + 100, body: 'Unrelated', user: { type: 'User' } }));
  const f = fixture([firstPage, [{ id: 10, body: '<!-- factory-run-status:run_123 -->\nold', user: { type: 'Bot' } }]]);
  for (const [status, expected] of [['succeeded', 'Awaiting review'], ['failed', 'Failed'], ['cancelled', 'Cancelled']] as const) {
    await f.update({ runId: 'run_123', status, pullRequestUrl: 'https://github.com/unrelated/repo/pull/1' });
    assert.equal(f.writes.at(-1)?.comment_id, 10);
    assert.match(f.writes.at(-1)!.body, new RegExp(expected));
    assert.doesNotMatch(f.writes.at(-1)!.body, /Pull request|unrelated/);
  }
});

test('a failed lookup does not create a duplicate status comment', async () => {
  const f = fixture();
  f.client.request = async () => { throw new Error('GitHub unavailable'); };
  await assert.rejects(f.update({ runId: 'run_123', status: 'running' }), /GitHub unavailable/);
  assert.equal(f.writes.length, 0);
});

test('raw execution output is never published in the issue comment', async () => {
  const f = fixture();
  const result = { runId: 'run_123', status: 'failed' as const, log: 'private execution output' };
  await f.update(result);
  assert.match(f.writes[0].body, /Failed/);
  assert.doesNotMatch(f.writes[0].body, /private execution output/);
});

test('an update failure does not fall back to creating another comment', async () => {
  const f = fixture();
  await f.update({ runId: 'run_123', status: 'running' });
  f.client.rest.issues.updateComment = async () => { throw new Error('GitHub unavailable'); };
  await assert.rejects(f.update({ runId: 'run_123', status: 'failed' }), /GitHub unavailable/);
  assert.equal(f.writes.length, 1);
});
