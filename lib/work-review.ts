export type CompletedWork = {
  runId: string; title: string; repo: string; issueNumber: number;
  finishedAt: string; pullRequestUrl: string | null;
};
export type ReviewPullRequest = {
  url: string; number: number; title: string; repo: string; runId: string;
  draft: boolean; updatedAt: string; running: boolean;
};
export type ReviewQueue = { pulls: ReviewPullRequest[]; unavailableRepos: string[]; checkedAt: string };
export type PullCandidate = { runId: string; repo: string; pullRequestUrl: string | null; status: string };

/**
 * Single tolerant parser for GitHub PR URLs. Accepts a trailing slash,
 * query string, or fragment (e.g. /pull/12/files, /pull/12?query, /pull/12#x)
 * and normalises the repo to lowercase for comparison.
 */
export function parsePullRef(pullRequestUrl: string | null, repo: string): { repo: string; number: number } | null {
  if (!pullRequestUrl) return null;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(pullRequestUrl.trim());
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return null;
  return { repo: match[1].toLowerCase(), number: Number(match[2]) };
}

/** A later attempt must not hide an earlier open PR, or duplicate the same PR. */
export function uniquePullCandidates<T extends PullCandidate>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const ref = parsePullRef(row.pullRequestUrl, row.repo);
    if (!ref) return false;
    const key = `${ref.repo}/${ref.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchOpenPulls(candidates: PullCandidate[], pulls: {
  number: number; state: string; title: string; html_url: string; draft?: boolean; updated_at: string;
}[]): ReviewPullRequest[] {
  return pulls.filter((pr) => pr.state === 'open').flatMap((pr) => {
    // Match on repo AND number: PR numbers collide across repositories.
    const run = candidates.find((row) => {
      const ref = parsePullRef(row.pullRequestUrl, row.repo);
      return ref !== null && ref.number === pr.number;
    });
    return run ? [{ url: pr.html_url, number: pr.number, title: pr.title, repo: run.repo,
      runId: run.runId, draft: pr.draft ?? false, updatedAt: pr.updated_at, running: run.status === 'running' }] : [];
  });
}
