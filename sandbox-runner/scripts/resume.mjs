/** Remote branch/PR state survives the disposable container. Never replace a PR. */
export async function findExistingRun(req, github, pages) {
  const owner = req.repoFullName.split("/")[0];
  const prs = await pages(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${req.branchName}`)}`);
  const pr = prs.find((item) => item.head.ref === req.branchName && item.head.repo?.full_name === req.repoFullName);
  if (pr?.merged) {
    const issue = await github(`/issues/${req.issueNumber}`);
    if (issue.state !== "open")
      throw Object.assign(new Error("Existing PR is closed. Recovery will not create another PR or reopen the ticket."), { retryable: false, pullRequestUrl: pr.html_url });
    const open = await pages("/pulls?state=open");
    const follow = open.find((item) => item.head?.ref?.startsWith(`${req.branchName}-main-`) && item.head?.repo?.full_name === req.repoFullName);
    if (follow) return { pr: follow, branch: { object: { sha: follow.head.sha } }, cloneBranch: follow.head.ref, publishBranch: follow.head.ref, resumeMain: false };
    if (!pr.merge_commit_sha)
      throw Object.assign(new Error("Merged PR has no merge commit. Ticket left open."), { retryable: false, pullRequestUrl: pr.html_url });
    return { pr, branch: null, cloneBranch: req.defaultBranch, publishBranch: req.branchName, resumeMain: true };
  }
  if (pr && pr.state !== "open")
    throw Object.assign(new Error("Existing PR is closed. Recovery will not create another PR or reopen the ticket."), { retryable: false, pullRequestUrl: pr.html_url });
  const branch = await github(`/git/ref/heads/${req.branchName}`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  if (pr && !branch) throw Object.assign(new Error("Existing PR branch is unavailable. Ticket left open."), { retryable: false, pullRequestUrl: pr.html_url });
  return { pr, branch, cloneBranch: branch ? req.branchName : req.defaultBranch, publishBranch: req.branchName, resumeMain: false };
}
