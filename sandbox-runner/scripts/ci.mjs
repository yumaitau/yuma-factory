/** A hidden/inaccessible policy must never be mistaken for an unprotected branch. */
export async function loadRequiredChecks(github, pages, baseBranch) {
  const branch = encodeURIComponent(baseBranch);
  await github(`/branches/${branch}`);
  const protection = await github(`/branches/${branch}/protection`).catch((error) => {
    if (error.status === 404 && error.apiMessage === "Branch not protected") return null;
    throw error;
  });
  return requiredChecks(protection?.required_status_checks, await pages(`/rules/branches/${branch}`));
}

/** Merge classic branch protection and all active repository/organisation rules. */
export function requiredChecks(protection, rules) {
  const checks = [...(protection?.checks ?? [])];
  for (const context of protection?.contexts ?? []) {
    if (!checks.some((check) => check.context === context)) checks.push({ context });
  }
  for (const rule of rules) {
    if (rule.type === "workflows")
      throw new Error("Required workflow rules need named required status checks before Factory can verify completion.");
    if (rule.type === "required_status_checks") {
      if (!Array.isArray(rule.parameters?.required_status_checks))
        throw new Error("Invalid required status checks policy. Ticket left open.");
      checks.push(...rule.parameters.required_status_checks.map((check) => ({
        context: check.context, app_id: check.integration_id,
      })));
    }
  }
  if (checks.some((check) => typeof check.context !== "string" || !check.context))
    throw new Error("Invalid required check name. Ticket left open.");
  return checks;
}

// GitHub accepts successful, neutral and conditionally skipped check runs.
export function isPassingConclusion(conclusion) {
  return ["success", "neutral", "skipped"].includes(conclusion);
}

/** A push and a pull request can run the same workflow. Keep the newest of each. */
export function latestWorkflows(runs) {
  const latest = new Map();
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    const key = `${run.workflow_id}:${run.event}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  return [...latest.values()];
}

/** Workflow and composite-action files run with repository secrets on push. */
export function isCiConfigPath(path) {
  return /^\.github\/(workflows|actions)\//i.test(path);
}

// AI review bots post commit statuses but test nothing. They count only when a branch rule requires them.
const REVIEW_BOTS = /coderabbit|sourcery|greptile|ellipsis|codeant|qodo/i;
export function isReviewBot(name, slug) {
  return REVIEW_BOTS.test(name ?? "") || REVIEW_BOTS.test(slug ?? "");
}

export function evaluateCI(checks, statuses, workflows, required = []) {
  const rows = [
    ...checks.map((c) => ({ name: c.name, slug: c.app?.slug, appId: c.app?.id, state: c.status === "completed" ? c.conclusion : "pending" })),
    ...statuses.map((s) => ({ name: s.context, appId: s.app?.id, state: s.state })),
  ].filter((row) => !isReviewBot(row.name, row.slug) || required.some((r) => r.context === row.name));
  const missing = required.filter((r) => !rows.some((row) => row.name === r.context &&
    (r.app_id == null || r.app_id === -1 || row.appId === r.app_id))).map((r) => r.context);
  const all = [...rows, ...workflows.map((w) => ({ name: w.name, state: w.status === "completed" ? w.conclusion : "pending" }))];
  const failures = all.filter((r) => r.state && r.state !== "pending" && !isPassingConclusion(r.state));
  if (failures.length) return { state: "failed", failures, missing };
  // `empty`: nothing that tests code has registered at all, as opposed to CI still running.
  if (!all.length && !required.length) return { state: "pending", failures: [], missing, empty: true };
  if (missing.length || !all.length || all.some((r) => !r.state || r.state === "pending"))
    return { state: "pending", failures: [], missing };
  // Repositories without required-check rules still need successful CI evidence.
  // The supervisor confirms the same green head twice before completing a ticket.
  if (!required.length && !all.some((r) => r.state === "success"))
    return { state: "pending", failures: [], missing: [] };
  return { state: "green", failures: [], missing: [] };
}

export function labelNames(labels) {
  return (labels ?? []).map((label) => typeof label === "string" ? label : label?.name).filter((name) => typeof name === "string");
}

/** Highest matching GitHub risk/severity label. Unrated issues are not low risk. */
export function ticketRisk(labels, prefix = "factory") {
  let found = null;
  const rank = { low: 1, medium: 2, high: 3 };
  for (const raw of labels ?? []) {
    if (typeof raw !== "string") continue;
    let value = raw.toLowerCase().trim().replace(/\s+/g, "");
    if (value.startsWith(`${prefix}:`)) value = value.slice(prefix.length + 1);
    const match = /^(?:risk|severity)[:/=-](low|medium|high|critical)$/.exec(value);
    if (!match) continue;
    const risk = match[1] === "critical" ? "high" : match[1];
    if (!found || rank[risk] > rank[found]) found = risk;
  }
  return found;
}

export function isLowRisk(labels, prefix) {
  return ticketRisk(labels, prefix) === "low";
}

/**
 * SHA-pinned merge commit for a confirmed-green PR, so every PR commit lands on the
 * base branch unchanged. Never squashes or rebases: a repository that disallows merge
 * commits leaves the PR for a human. Already merged is success.
 * Branch-protection / review blocks return "blocked" so the ticket can still close.
 */
export async function mergeGreenPullRequest({ github, pullNumber, sha }) {
  const pr = await github(`/pulls/${pullNumber}`);
  if (pr.merged) return { result: "already-merged", sha: pr.merge_commit_sha || null };
  if (pr.state !== "open") throw new Error("Pull request closed before merge. Ticket left open.");
  if (!pr.head?.sha || pr.head.sha !== sha) throw new Error("PR head changed before merge. Ticket left open.");
  try {
    const result = await github(`/pulls/${pullNumber}/merge`, "PUT", { sha, merge_method: "merge" });
    return result.merged ? { result: "merge", sha: result.sha || null } : { result: "blocked", sha: null };
  } catch (error) {
    if (error.status === 409) throw new Error("PR head changed before merge. Ticket left open.");
    // 405 includes "merge commits not allowed": leave the PR for review rather than squash.
    if (error.status === 405 || error.status === 422) return { result: "blocked", sha: null };
    throw error;
  }
}

export const NO_PR_CI_MS = 30 * 60_000;
// A repository with no workflows and no required checks can only get CI from an external app.
export const NO_CI_REPO_MS = 5 * 60_000;
export const NO_MAIN_CI_MS = 10 * 60_000;
// CI that stays pending this long is usually queued for an offline self-hosted runner.
export const PENDING_CI_MS = 2 * 60 * 60_000;
// Repairs in a row that change nothing before the PR is left for a human.
export const MAX_IDLE_REPAIRS = 3;

// GitHub refuses to start jobs when the account's Actions billing is blocked.
// No code change can fix that, so repairing only burns the subscription.
const ACCOUNT_BLOCKED_CI = /job was not started because recent account payments have failed|spending limit needs to be increased/i;
export function isAccountBlockedCI(diagnostics) {
  return ACCOUNT_BLOCKED_CI.test(diagnostics ?? "");
}

/**
 * Repairs that push changes are unlimited; every repair must pass CI on its new head
 * before closure. MAX_IDLE_REPAIRS in a row that change nothing stop the run.
 * Returns null when no CI ever registers on the PR: it is left for human review.
 * In a repository without any CI (`noCI`), closeWithoutCI() may finish the ticket instead;
 * it returns false to keep the PR for review.
 */
export async function finishWithGreenCI({ snapshot, repair, closeIssue, closeWithoutCI, progress, wait, now = Date.now }) {
  let greenHead = null;
  let emptySince = null;
  let idleRepairs = 0;
  let keepForReview = false;
  let pendingSince = null;
  for (;;) {
    const current = await snapshot();
    if (current.state === "pending" && !current.empty && !current.closed) {
      pendingSince ??= now();
      if (now() - pendingSince >= PENDING_CI_MS) {
        await progress("CI has not finished within 2 hours; its jobs may be queued for an offline runner. PR left open for review; subscription released.");
        return null;
      }
    } else pendingSince = null;
    if (current.empty) {
      emptySince ??= now();
      if (current.noCI && closeWithoutCI && !keepForReview && !current.blocked && !current.closed &&
        now() - emptySince >= NO_CI_REPO_MS) {
        if (await closeWithoutCI(current.sha)) return current.sha;
        keepForReview = true;
      }
      if (now() - emptySince >= NO_PR_CI_MS) {
        await progress("No CI registered on the PR within 30 minutes. Only review bots, if any, reported. PR left open for review; subscription released.");
        return null;
      }
    } else emptySince = null;
    if (current.closed) throw new Error("Pull request closed before CI completion. Ticket left open.");
    if (current.state === "failed") {
      greenHead = null;
      await progress("CI failed. Fixing failures on the existing PR.");
      // repair() returns false when Codex changed nothing; anything else counts as progress.
      if (await repair(current) === false) {
        if (++idleRepairs >= MAX_IDLE_REPAIRS)
          throw Object.assign(new Error(`CI still failing after ${MAX_IDLE_REPAIRS} repairs that changed nothing. PR left open for review; ticket left open.`), { retryable: false });
      } else idleRepairs = 0;
    } else if (current.state === "green" && !current.blocked) {
      // Two independent observations avoid closing during check registration/reruns.
      if (greenHead === current.sha) {
        await closeIssue(current.sha);
        return current.sha;
      }
      greenHead = current.sha;
      await progress("CI green. Confirming the current PR head before closing the ticket.");
    } else {
      greenHead = null;
      await progress(current.missing?.length
        ? `Waiting for required checks: ${current.missing.join(", ")}. Ticket stays open.`
        : "Waiting for CI on the current PR head. Ticket stays open.");
    }
    await wait();
  }
}

/**
 * Poll the merge commit on the default branch. repair() returns true when a
 * follow-up pull request has taken over the ticket.
 */
export async function finishCommitCI({ snapshot, repair, done, progress, wait, now = Date.now }) {
  let greenHead = null;
  let pendingSince = null;
  let pendingHead = null;
  let emptySince = null;
  for (;;) {
    const current = await snapshot();
    // The PR already passed CI and merged. A default branch with no pipeline has nothing left to verify.
    if (current.empty) {
      emptySince ??= now();
      if (now() - emptySince >= NO_MAIN_CI_MS) {
        await progress("No default-branch pipeline registered on the merge commit within 10 minutes. Completion rests on the PR's CI.");
        await done(current.sha);
        return current.sha;
      }
    } else emptySince = null;
    if (current.state !== "pending" || pendingHead !== current.sha) pendingSince = null;
    pendingHead = current.sha;
    if (current.state === "failed") {
      greenHead = null;
      await progress("Main pipeline failed. Fixing it from the merge commit.");
      if (await repair(current)) return current.sha;
    } else if (current.state === "green") {
      if (greenHead === current.sha) {
        await done(current.sha);
        return current.sha;
      }
      greenHead = current.sha;
      await progress("Main pipeline green. Confirming the merge commit before finishing.");
    } else {
      greenHead = null;
      pendingSince ??= now();
      // Missing/blocked pipelines need operator attention, not an occupied
      // subscription forever. Never turn absent CI into successful completion.
      if (now() - pendingSince >= 30 * 60_000) {
        throw Object.assign(new Error("Main pipeline did not complete within 30 minutes. Check workflow triggers and pending checks before retrying. Ticket left open; subscription released."), { retryable: false });
      }
      await progress(current.missing?.length
        ? `Waiting for the main pipeline: ${current.missing.join(", ")}. Ticket stays open.`
        : "Waiting for the main pipeline. Ticket stays open.");
    }
    await wait();
  }
}
