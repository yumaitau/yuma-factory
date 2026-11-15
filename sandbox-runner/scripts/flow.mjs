// Supervisor decisions that need no container. bridge.mjs supplies the effects; tests supply fakes.

// lib/run-retry.ts picks a failed run's retry policy from these phrases near the end of its log.
const CLASSIFIER_PHRASES = /GitHub did not run CI jobs|produced no file changes|Planner (?:did not|returned)/gi;
/** Text an agent, a command or a repository script wrote. It may be logged; it must never pick the retry policy. */
export const agentText = (value) => String(value ?? "").replace(CLASSIFIER_PHRASES, "[…]");

const classified = (message) => Object.assign(new Error(message), { classified: true, retryable: false });
/**
 * The supervisor's own classified failures, worded as lib/run-retry.ts matches them. Agent text inside one is
 * neutralised and bounded, and the classifying phrase comes after it, so it stays in the log's last 1,500 characters.
 */
export const failures = {
  noPlan: () => classified("Planner did not write a valid plan file."),
  githubBlocked: (block, rerun = "") => classified(`GitHub did not run CI jobs: ${block}. Fix it in GitHub settings; Factory checks the PR again on a schedule.${rerun} PR and ticket left open.`),
  cannotDo: (agentName, reason) => classified(`${agentName} reported it could not do this ticket: ${agentText(reason).slice(0, 600)} ${agentName} produced no file changes. Close the issue if the work is already done, or move it to Needs preparation to retry.`),
  notDone: (agentName, reason) => classified(`An adversarial check did not confirm the work is already done${reason ? `: ${agentText(reason).slice(0, 600)}` : "."} ${agentName} produced no file changes. Close the issue if the work is already done, or move it to Needs preparation to retry.`),
};

/** The run log: bounded, redacted, and free of classifying phrases except in a failure the supervisor classified. */
export function runLog(redact, limit = 60_000) {
  const lines = [];
  const add = (text) => {
    const safe = String(text ?? "").slice(-limit);
    if (!safe || lines.at(-1) === safe) return false;
    lines.push(safe);
    // Keep memory bounded during long command and repair sessions.
    while (lines.length > 1 && lines.join("\n").length > limit) lines.shift();
    return true;
  };
  return {
    /** Anything that may quote an agent, a command or a repository script. True when the log changed. */
    append: (text) => add(agentText(redact(text))),
    /** The error that ended the run. Only a supervisor-classified failure keeps its classifying phrase. */
    fail: (error) => add(error?.classified ? redact(error.message) : agentText(redact(error?.message ?? "Run failed."))),
    text: () => redact(lines.join("\n")).slice(-limit),
  };
}

/**
 * One author session and what it left in blocked.json. The file is cleared before the session and read as soon
 * as it ends, before any other command runs as the agent user: checks, reviewers and Git filters share that user.
 */
export async function authored({ clear, run, read }) {
  await clear();
  const result = await run();
  return { result, blocked: await read() };
}

/** The agent's live channel. It gets the agent token; the bridge's own token only when Factory issued no agent token. */
export function agentChannel(req) {
  if (typeof req?.factoryUrl !== "string" || !/^https?:\/\/[^\s"]+$/.test(req.factoryUrl)) return null;
  const token = typeof req.agentToken === "string" && req.agentToken ? req.agentToken : typeof req.runToken === "string" ? req.runToken : null;
  return token ? { url: `${req.factoryUrl.replace(/\/+$/, "")}/api/runs/mcp`, token } : null;
}

/**
 * A low-risk ticket once CI is green: ask Factory to merge, then watch the default branch.
 * A merge GitHub or Factory declines leaves the PR for review and closes the issue, as for any other ticket.
 * A merge request that fails (the head moved, it timed out, Factory was unreachable) proves nothing about the
 * ticket. GitHub is asked whether the merge landed anyway; if it did not, the PR and the issue stay open for a
 * person. Returns true when the issue was held open.
 */
export async function finishLowRisk({ merge, landed, closeIssue, watchMain, progress }) {
  let merged;
  try {
    merged = await merge();
  } catch (error) {
    // The request can land without its answer arriving. Only GitHub knows.
    const sha = await landed().catch(() => null);
    if (!sha) {
      const reason = error?.name === "TimeoutError" ? "The merge request timed out." : agentText(error?.message ?? "The merge request failed.").replace(/ Ticket left open\.$/, "");
      await progress(`Low-risk merge did not complete. ${reason} PR and issue left open for review.`);
      return true;
    }
    merged = { result: "merge", sha };
  }
  if (merged.result === "blocked" || !merged.sha) {
    await progress(merged.result === "blocked"
      ? "Low-risk merge blocked by GitHub or Factory. PR left open for review."
      : "Merge commit is unavailable. Main pipeline was not watched.");
    await closeIssue();
    await progress("CI green on the current PR head. GitHub issue closed.");
    return false;
  }
  await progress("Low risk. PR merged after green CI. Waiting for the main pipeline.");
  await watchMain(merged.sha);
  return false;
}
