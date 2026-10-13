// Review evidence names the check, the time, the commit and the result. A run log is a transcript, not evidence.
export const EVIDENCE_KINDS = ['check', 'command', 'preview', 'note'] as const;
export const EVIDENCE_RESULTS = ['passed', 'failed', 'skipped', 'unknown'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];
export type Evidence = {
  kind: EvidenceKind; name: string; sourceSha: string; environment: string | null;
  startedAt: string | null; finishedAt: string | null; result: EvidenceResult; url: string | null; logKey: string | null;
};
/** ready: checks passed on the current head. Every other state keeps the task out of Ready for review. */
export type EvidenceState = 'ready' | 'pending' | 'failed' | 'missing' | 'unchecked';
export type EvidenceGate = { state: EvidenceState; headSha: string | null; reason: string; current: Evidence[]; stale: Evidence[] };

export const shortSha = (sha: string) => sha.slice(0, 7);

type CheckRun = { name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null;
  html_url?: string | null; details_url?: string | null; app?: { slug?: string | null } | null };
type CommitStatus = { context: string; state: string; created_at?: string | null; updated_at?: string | null; target_url?: string | null };

// AI review bots post statuses but test nothing; a model's summary is not evidence. Mirrors sandbox-runner/scripts/ci.mjs.
const REVIEW_BOTS = /coderabbit|sourcery|greptile|ellipsis|codeant|qodo/i;
const RANK: Record<EvidenceResult, number> = { failed: 3, unknown: 2, passed: 1, skipped: 0 };

function checkResult(status: string, conclusion: string | null): EvidenceResult {
  if (status !== 'completed') return 'unknown';
  if (conclusion === 'success' || conclusion === 'neutral') return 'passed';
  if (conclusion === 'skipped') return 'skipped';
  return conclusion && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(conclusion) ? 'failed' : 'unknown';
}
// Stored timestamps are whole seconds; normalise so an unchanged check is recognised as unchanged.
const at = (value: string | null | undefined) => value && !Number.isNaN(Date.parse(value)) ? new Date(Math.floor(Date.parse(value) / 1000) * 1000).toISOString() : null;
const statusResult = (state: string): EvidenceResult => state === 'success' ? 'passed' : state === 'failure' || state === 'error' ? 'failed' : 'unknown';

/** GitHub check runs and commit statuses on one commit, as evidence. One record per name; the worst result wins. */
export function checkEvidence(sha: string, checkRuns: CheckRun[], statuses: CommitStatus[]): Evidence[] {
  const records: Evidence[] = [
    ...checkRuns.filter((check) => !REVIEW_BOTS.test(check.name) && !REVIEW_BOTS.test(check.app?.slug ?? '')).map((check) => ({
      kind: 'check' as const, name: check.name, sourceSha: sha, environment: check.app?.slug ?? null,
      startedAt: at(check.started_at), finishedAt: check.status === 'completed' ? at(check.completed_at) : null,
      result: checkResult(check.status, check.conclusion), url: check.html_url ?? check.details_url ?? null, logKey: null })),
    ...statuses.filter((status) => !REVIEW_BOTS.test(status.context)).map((status) => ({
      kind: 'check' as const, name: status.context, sourceSha: sha, environment: null,
      startedAt: at(status.created_at), finishedAt: status.state === 'pending' ? null : at(status.updated_at),
      result: statusResult(status.state), url: status.target_url ?? null, logKey: null })),
  ];
  const byName = new Map<string, Evidence>();
  for (const record of records) {
    const known = byName.get(record.name);
    if (!known || RANK[record.result] > RANK[known.result]) byName.set(record.name, record);
  }
  return [...byName.values()];
}

const names = (records: Evidence[]) => records.map((record) => record.name).join(', ');

/** Only checks on the current head count. Records on any other commit stay visible as stale. */
export function evidenceGate(records: Evidence[], headSha: string | null): EvidenceGate {
  const newest = (a: Evidence, b: Evidence) => Date.parse(b.finishedAt ?? b.startedAt ?? '') - Date.parse(a.finishedAt ?? a.startedAt ?? '') || 0;
  const current = records.filter((record) => record.sourceSha === headSha).sort(newest);
  const stale = records.filter((record) => record.sourceSha !== headSha).sort(newest);
  const gate = (state: EvidenceState, reason: string) => ({ state, headSha, reason, current, stale });
  if (!headSha) return gate('unchecked', 'Factory has not read the pull request head yet, so there is no evidence to show.');
  const head = shortSha(headSha);
  const checks = current.filter((record) => record.kind === 'check');
  if (!checks.length) return gate('missing', stale.length
    ? `Checks were recorded on ${shortSha(stale[0].sourceSha)}, which is stale. The head is now ${head} and has no checks yet.`
    : `No checks reported on ${head}. Not ready for review without evidence for this commit.`);
  const failed = checks.filter((record) => record.result === 'failed');
  if (failed.length) return gate('failed', `${names(failed)} failed on ${head}.`);
  const pending = checks.filter((record) => record.result === 'unknown');
  if (pending.length) return gate('pending', `Waiting for ${names(pending)} on ${head}.`);
  const passed = checks.filter((record) => record.result === 'passed');
  if (!passed.length) return gate('missing', `Every check on ${head} was skipped. Not ready for review without a passing check.`);
  return gate('ready', `${passed.length} ${passed.length === 1 ? 'check' : 'checks'} passed on ${head}.`);
}
