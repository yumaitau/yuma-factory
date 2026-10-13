// Accepting a review, merging and deploying are separate authorities. Each has its own check.
import { shortSha } from '@/lib/review-evidence';
import type { TicketRisk } from '@/shared/ticket-risk';

export type Decision = { allowed: boolean; reason: string };
export type PullState = { open: boolean; merged: boolean; draft: boolean; headSha: string; mergeableState?: string | null };
export type Acceptance = { id: string; headSha: string; userId: string };

const allow = (reason: string): Decision => ({ allowed: true, reason });
const refuse = (reason: string): Decision => ({ allowed: false, reason });

/** Accepting records who reviewed which head. It never merges. */
export function acceptDecision(pull: PullState, reviewedSha: string, active: Acceptance | null, userId: string): Decision {
  if (pull.merged) return refuse('This pull request is already merged.');
  if (!pull.open) return refuse('This pull request is closed.');
  if (pull.draft) return refuse('Draft pull requests are not ready to accept.');
  if (reviewedSha !== pull.headSha)
    return refuse(`The head is now ${shortSha(pull.headSha)}; you reviewed ${shortSha(reviewedSha)}. Review the new commit before accepting.`);
  if (active?.headSha === pull.headSha && active.userId === userId) return refuse(`You already accepted ${shortSha(pull.headSha)}.`);
  return allow(`Accept ${shortSha(pull.headSha)}. Accepting does not merge.`);
}

// GitHub's view of branch protection and rulesets for this PR. `unknown` is still being computed;
// the SHA-pinned merge call is the final word either way.
const RULES: Record<string, string> = {
  blocked: 'Repository rules block this merge: required reviews or checks are missing.',
  dirty: 'The pull request has merge conflicts.',
  behind: 'The branch is behind its base. Update it, then review the new head.',
  draft: 'Draft pull requests cannot merge.',
};

/**
 * Risk policy for a person merging. High risk needs a second person: whoever merges must not be
 * the person who accepted. Low, medium and unrated changes may be merged by any team member.
 */
export function riskDecision(risk: TicketRisk | null, acceptance: Acceptance, userId: string): Decision {
  if (risk === 'high' && acceptance.userId === userId) return refuse('High risk: a second person must merge after you accepted the review.');
  return allow(risk === 'high' ? 'High risk: merged by a second person.' : 'Risk policy allows any team member to merge an accepted head.');
}

/** Merge needs an acceptance of the current head, repository rules that allow it, and a risk policy that allows this user. */
export function mergeDecision(pull: PullState, acceptance: Acceptance | null, risk: TicketRisk | null, userId: string): Decision {
  if (pull.merged) return refuse('This pull request is already merged.');
  if (!pull.open) return refuse('This pull request is closed.');
  if (!acceptance) return refuse(`Accept the review of ${shortSha(pull.headSha)} before merging.`);
  if (acceptance.headSha !== pull.headSha)
    return refuse(`The acceptance was for ${shortSha(acceptance.headSha)}. The head is now ${shortSha(pull.headSha)}; accept it again before merging.`);
  const rule = pull.draft ? RULES.draft : RULES[pull.mergeableState ?? ''];
  if (rule) return refuse(rule);
  const policy = riskDecision(risk, acceptance, userId);
  if (!policy.allowed) return policy;
  return allow(`Merge ${shortSha(pull.headSha)}. Merging does not deploy.`);
}

/** Deploy is hidden until the project has a deployment target, and offered only once the change is merged. */
export function deployControl(target: string | null | undefined, merged: boolean) {
  return target && merged && /^https:\/\//.test(target) ? { target } : null;
}

export type AcceptanceRecord = { headSha: string; userId: string; status: string; createdAt: string };
export type MergeRecord = { headSha: string; actor: string; userId: string | null; status: string; mergeSha: string | null; message: string | null; createdAt: string };
export type HistoryEntry = { at: string; text: string; tone: 'done' | 'attention' | 'muted' | 'review' };

/** Task history: who accepted which head, and who merged which SHA. Factory's merges never read as a person's acceptance. */
export function historyEntries(acceptances: AcceptanceRecord[], merges: MergeRecord[], name: (userId: string | null) => string): HistoryEntry[] {
  const accepted = acceptances.map((row): HistoryEntry => ({ at: row.createdAt, tone: row.status === 'active' ? 'review' : 'muted',
    text: `${name(row.userId)} accepted the review of ${shortSha(row.headSha)}${row.status === 'superseded' ? '. Superseded: the head changed' : ''}.` }));
  const merged = merges.filter((row) => row.status !== 'abandoned').map((row): HistoryEntry => {
    const who = row.actor === 'factory' ? 'Factory' : name(row.userId);
    const policy = row.actor === 'factory' ? ' under the low-risk policy' : '';
    const sha = shortSha(row.headSha);
    switch (row.status) {
      case 'merged': return { at: row.createdAt, tone: 'done', text: `${who} merged ${sha}${policy}${row.mergeSha ? ` as ${shortSha(row.mergeSha)}` : ''}. Merging did not deploy.` };
      case 'pending': return { at: row.createdAt, tone: 'review', text: `${who} is merging ${sha}${policy}.` };
      case 'already-merged': return { at: row.createdAt, tone: 'muted', text: `${who} found ${sha} already merged on GitHub.` };
      default: return { at: row.createdAt, tone: 'attention', text: `${who} did not merge ${sha}${policy}: ${row.message ?? row.status}` };
    }
  });
  return [...accepted, ...merged].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
