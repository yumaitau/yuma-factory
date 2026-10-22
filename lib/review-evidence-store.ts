import 'server-only';
import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { reviewAcceptances, runEvidence, runs } from '@/db/schema';
import { loadRequiredChecks } from '@/sandbox-runner/scripts/ci.mjs';
import { newId } from '@/lib/ids';
import { checkEvidence, evidenceGate, NO_CI_NOTE, type Evidence, type EvidenceGate } from '@/lib/review-evidence';
import type { Db } from '@/lib/queries';
import type { getGithubApp } from '@/lib/github';

type Client = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;
type Row = typeof runEvidence.$inferSelect;
const iso = (value: Date | null) => value?.toISOString() ?? null;

export function evidenceFromRow(row: Row): Evidence {
  return { kind: row.kind as Evidence['kind'], name: row.name, sourceSha: row.sourceSha, environment: row.environment,
    startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt), result: row.result as Evidence['result'], url: row.url, logKey: row.logKey };
}

/** Read GitHub's check runs and commit statuses for one commit. Factory reads CI; it does not run a second one. */
export async function readCheckEvidence(client: Client, owner: string, repo: string, sha: string) {
  const params = { owner, repo, ref: sha, per_page: 100, request: { signal: AbortSignal.timeout(15_000) } };
  const [{ data: checks }, { data: status }] = await Promise.all([
    client.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...params, filter: 'latest' }),
    client.request('GET /repos/{owner}/{repo}/commits/{ref}/status', params),
  ]);
  return checkEvidence(sha, checks.check_runs ?? [], status.statuses ?? []);
}

/** Upsert records for a run; unchanged rows are not rewritten. */
export async function recordEvidence(db: Db, run: { id: string; ticketId: string }, records: Evidence[]) {
  if (!records.length) return;
  const existing = await db.select().from(runEvidence).where(eq(runEvidence.runId, run.id)).all();
  const key = (record: { sourceSha: string; kind: string; name: string }) => `${record.sourceSha}\n${record.kind}\n${record.name}`;
  const known = new Map(existing.map((row) => [key(row), evidenceFromRow(row)]));
  const changed = records.filter((record) => JSON.stringify(known.get(key(record))) !== JSON.stringify(record));
  if (!changed.length) return;
  const date = (value: string | null) => value ? new Date(value) : null;
  const [first, ...rest] = changed.map((record) => {
    const values = { kind: record.kind, name: record.name, sourceSha: record.sourceSha, environment: record.environment,
      startedAt: date(record.startedAt), finishedAt: date(record.finishedAt), result: record.result, url: record.url, logKey: record.logKey, recordedAt: new Date() };
    return db.insert(runEvidence).values({ id: newId('evd'), runId: run.id, ticketId: run.ticketId, ...values })
      .onConflictDoUpdate({ target: [runEvidence.runId, runEvidence.sourceSha, runEvidence.kind, runEvidence.name], set: values });
  });
  await db.batch([first, ...rest]);
}

/** A new head clears the current acceptance. The superseded row stays in history. */
function supersede(db: Db, pullRequestUrl: SQL | string, sha: string) {
  return db.update(reviewAcceptances).set({ status: 'superseded', supersededAt: new Date() }).where(and(
    eq(reviewAcceptances.pullRequestUrl, pullRequestUrl), eq(reviewAcceptances.status, 'active'), ne(reviewAcceptances.headSha, sha)));
}

/** Remember the PR head Factory last saw. Evidence and acceptances on any other commit are stale from now on. */
export async function observeHead(db: Db, runId: string, sha: string) {
  await db.batch([
    db.update(runs).set({ pullRequestHeadSha: sha }).where(and(eq(runs.id, runId), sql`${runs.pullRequestHeadSha} is not ${sha}`)),
    supersede(db, sql`(select pull_request_url from runs where id = ${runId})`, sha),
  ]);
}

/** A push reported by GitHub: every run on that pull request now has a new head. */
export async function observePullHead(db: Db, pullRequestUrl: string, sha: string) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pullRequestUrl) || !/^[a-f0-9]{40}$/.test(sha)) return;
  await db.batch([db.update(runs).set({ pullRequestHeadSha: sha }).where(eq(runs.pullRequestUrl, pullRequestUrl)), supersede(db, pullRequestUrl, sha)]);
}

/** Observe the head, record its checks, and return the gate over everything the run has recorded. */
export async function syncHeadEvidence(db: Db, client: Client, input: { runId: string; ticketId: string; owner: string; repo: string; headSha: string; baseBranch?: string; updatedAt?: string }) {
  await observeHead(db, input.runId, input.headSha);
  // An unreadable check list keeps the stored records; the gate still judges them against the new head.
  // Changed or unreadable checks/policy invalidate an earlier no-CI observation.
  await db.delete(runEvidence).where(and(eq(runEvidence.runId, input.runId), eq(runEvidence.sourceSha, input.headSha),
    eq(runEvidence.kind, 'note'), eq(runEvidence.name, NO_CI_NOTE)));
  await readCheckEvidence(client, input.owner, input.repo, input.headSha).then(async (records) => {
    await recordEvidence(db, { id: input.runId, ticketId: input.ticketId }, records);
    if (records.length || !input.baseBranch) return;
    const params = { owner: input.owner, repo: input.repo, request: { signal: AbortSignal.timeout(15_000) } };
    const { data: workflows } = await client.request('GET /repos/{owner}/{repo}/actions/workflows', { ...params, per_page: 1 });
    if (workflows.total_count !== 0) {
      // Release-only and default-branch workflows may never run on a PR. Allow the same
      // registration grace period as the supervisor, and confirm no workflow is queued.
      if (!input.updatedAt || Date.now() - Date.parse(input.updatedAt) < 30 * 60_000 || !Number.isFinite(Date.parse(input.updatedAt))) return;
      const { data: active } = await client.request('GET /repos/{owner}/{repo}/actions/runs', { ...params, head_sha: input.headSha, per_page: 1 });
      if (active.total_count !== 0) return;
    }
    const github = async (path: string) => {
      try { return (await client.request(`GET /repos/{owner}/{repo}${path}`, params)).data; }
      catch (error) {
        if (error && typeof error === 'object' && 'response' in error)
          Object.assign(error, { apiMessage: (error.response as { data?: { message?: string } })?.data?.message });
        throw error;
      }
    };
    const required = await loadRequiredChecks(github,
      async (path: string) => {
        const rules: unknown[] = [];
        for (let page = 1; ; page++) {
          const { data } = await client.request(`GET /repos/{owner}/{repo}${path}`, { ...params, per_page: 100, page });
          if (!Array.isArray(data)) throw new Error('Invalid branch rules response');
          rules.push(...data);
          if (data.length < 100) return rules;
        }
      }, input.baseBranch);
    if (required.length) return;
    await recordEvidence(db, { id: input.runId, ticketId: input.ticketId }, [{ kind: 'note', name: NO_CI_NOTE,
      sourceSha: input.headSha, environment: 'github', startedAt: null, finishedAt: new Date().toISOString(),
      result: 'skipped', url: null, logKey: null }]);
  }).catch(() => {});
  return runEvidenceGate(db, input.runId, input.headSha);
}

export async function runEvidenceGate(db: Db, runId: string, headSha: string | null): Promise<EvidenceGate> {
  const rows = await db.select().from(runEvidence).where(eq(runEvidence.runId, runId)).orderBy(desc(runEvidence.recordedAt)).limit(200).all();
  return evidenceGate(rows.map(evidenceFromRow), headSha);
}

/** Evidence of each ticket's latest run, for the board. One query, no bound-parameter fan-out. */
export async function latestRunEvidence(db: Db, ticketId?: string) {
  const rows = await db.select().from(runEvidence).where(and(
    ticketId ? eq(runEvidence.ticketId, ticketId) : undefined,
    sql`${runEvidence.runId} = (select latest.id from runs latest where latest.ticket_id = ${runEvidence.ticketId} order by latest.created_at desc, latest.id desc limit 1)`,
  )).all();
  return Map.groupBy(rows, (row) => row.runId);
}
