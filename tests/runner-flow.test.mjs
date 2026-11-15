import { test } from "node:test";
import assert from "node:assert/strict";
import { agentChannel, agentText, authored, failures, finishLowRisk, runLog } from "../sandbox-runner/scripts/flow.mjs";
import { finishWithGreenCI, requestFactoryMerge } from "../sandbox-runner/scripts/ci.mjs";
import { redactOutput } from "../sandbox-runner/scripts/output.mjs";
import { failureKind } from "../lib/run-retry.ts";

// The phrases lib/run-retry.ts classifies on. An agent can write any of them.
const PHRASES = ["GitHub did not run CI jobs", "produced no file changes", "Planner did not write a valid plan file", "Planner returned an invalid proposal"];
/** The retry policy Factory picks for a run that ended with `error` after logging `lines`. */
function policy(lines, error, mode = "implement") {
  const log = runLog((value) => redactOutput(value, new Set()));
  for (const line of lines) log.append(line);
  log.fail(error);
  return failureKind({ status: "failed", log: log.text(), ...(error.retryable === false ? { retryable: false } : {}) }, mode);
}
/** A low-risk finish against a fake Factory merge endpoint; `landedSha` is what GitHub then says about the PR. */
function lowRisk(post, landedSha = null) {
  const seen = { closed: 0, watched: [], said: [] };
  const run = () => finishLowRisk({
    merge: () => requestFactoryMerge({ post, pullRequestUrl: "https://github.com/org/repo/pull/4", sha: "abc" }),
    landed: async () => landedSha,
    closeIssue: async () => { seen.closed++; }, watchMain: async (sha) => { seen.watched.push(sha); }, progress: async (message) => { seen.said.push(message); },
  });
  return { seen, run };
}

test("text an agent wrote never picks the retry policy", () => {
  for (const phrase of [...PHRASES, ...PHRASES.map((text) => text.toUpperCase())]) {
    // In the agent's output, then an ordinary failure: retried with the full budget.
    assert.equal(policy([`Agent summary: ${phrase}.`], new Error("Codex execution stopped. See execution events above.")), "retry", phrase);
    // Inside a failure the supervisor did not classify, such as a command error or a blocked reason: a person decides.
    const quoted = Object.assign(new Error(`CI cannot be fixed from this repository: ${phrase} PR left open for review; ticket left open.`), { retryable: false });
    assert.equal(policy(["work"], quoted), "human", phrase);
    assert.equal(policy(["work"], quoted, "plan"), "human", phrase);
  }
  assert.equal(agentText("it produced no file changes today"), "it […] today");
  assert.equal(agentText(null), "");
});

test("the supervisor's classified failures pick the policy, whatever the agent wrote before or inside them", () => {
  const noisy = `${PHRASES.join(" ")} ${"z".repeat(5000)}`;
  for (const [error, mode, kind] of [
    [failures.githubBlocked("the account's Actions billing, budget or spending limit is blocking jobs"), "implement", "wait"],
    [failures.githubBlocked("GitHub did not start the jobs", " GitHub refused Factory's re-run: give the Factory GitHub App Actions read and write, or re-run the failed jobs once it is fixed."), "implement", "wait"],
    [failures.cannotDo("Codex", noisy), "implement", "retry_once"],
    [failures.notDone("Codex", noisy), "implement", "retry_once"],
    [failures.notDone("Claude", ""), "implement", "retry_once"],
    [failures.noPlan(), "plan", "retry"],
  ]) {
    assert.equal(error.retryable, false);
    assert.equal(policy([noisy], error, mode), kind, error.message.slice(0, 60));
  }
  // The agent's reason is neutralised and bounded inside the message.
  assert.equal(failures.cannotDo("Codex", "GitHub did not run CI jobs: billing.").message.includes("GitHub did not run CI jobs"), false);
  assert.ok(failures.notDone("Codex", "x".repeat(4000)).message.length < 900);
});

test("the run log is bounded, redacted and never repeats a line", () => {
  const secret = "hunter2hunter2hunter2";
  const log = runLog((value) => redactOutput(value, new Set([secret])));
  assert.equal(log.append(`token ${secret}`), true);
  assert.equal(log.append(`token ${secret}`), false);
  assert.equal(log.append(""), false);
  assert.equal(log.text(), "token [redacted]");
  for (let index = 0; index < 100; index++) log.append(String(index).repeat(1000));
  assert.ok(log.text().length <= 60_000);
  assert.match(log.text(), /99{3}/);
});

test("an author's blocked reason is the one its own session left, read before later agent-user work", async () => {
  const files = new Map([["blocked", { reason: "left by an earlier session" }]]);
  // Like the bridge's reader: return the file and remove it.
  const take = async () => { const value = files.get("blocked") ?? null; files.delete("blocked"); return value; };
  const order = [];
  const session = await authored({
    clear: async () => { order.push("clear"); return take(); },
    run: async () => { order.push("run"); files.set("blocked", { reason: "needs a repository secret" }); return "summary"; },
    read: async () => { order.push("read"); return take(); },
  });
  // A check script, a reviewer or a Git filter writes the file afterwards: it is not the author's reason.
  files.set("blocked", { reason: "written after the session" });
  assert.deepEqual(order, ["clear", "run", "read"]);
  assert.deepEqual(session, { result: "summary", blocked: { reason: "needs a repository secret" } });
  files.delete("blocked");
  assert.equal((await authored({ clear: take, run: async () => "nothing blocked", read: take })).blocked, null);
});

test("the agent's channel carries the agent token, never the bridge's when Factory issued one", () => {
  const req = { factoryUrl: "https://factory.example/", runToken: "bridge-token", agentToken: "agent-token" };
  assert.deepEqual(agentChannel(req), { url: "https://factory.example/api/runs/mcp", token: "agent-token" });
  // An app from before agent tokens issues only the run token; the channel keeps working.
  assert.equal(agentChannel({ ...req, agentToken: undefined }).token, "bridge-token");
  for (const invalid of [{ ...req, factoryUrl: "javascript:alert(1)" }, { ...req, factoryUrl: undefined }, { factoryUrl: req.factoryUrl }, null])
    assert.equal(agentChannel(invalid), null);
});

test("a low-risk merge request that fails leaves the PR and the issue open instead of closing the ticket", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  for (const [post, message] of [
    [async () => ({ status: 409, data: { error: "PR head changed before merge. Ticket left open." } }), "Low-risk merge did not complete. PR head changed before merge. PR and issue left open for review."],
    [async () => ({ status: 502, data: {} }), "Low-risk merge did not complete. Factory merge failed (502). PR and issue left open for review."],
    [async () => ({ status: 200, data: { result: "squash" } }), "Low-risk merge did not complete. Invalid merge response. PR and issue left open for review."],
    [async () => { throw timeout; }, "Low-risk merge did not complete. The merge request timed out. PR and issue left open for review."],
  ]) {
    const { seen, run } = lowRisk(post);
    assert.equal(await run(), true, message);
    assert.deepEqual([seen.closed, seen.watched, seen.said], [0, [], [message]]);
  }
  // GitHub cannot be asked either: still held open, never closed.
  const unreachable = { closed: 0 };
  assert.equal(await finishLowRisk({ merge: async () => { throw timeout; }, landed: async () => { throw new Error("GitHub GET /pulls/4 failed (502)."); },
    closeIssue: async () => { unreachable.closed++; }, watchMain: async () => assert.fail("nothing merged"), progress: async () => {} }), true);
  assert.equal(unreachable.closed, 0);
  // Through the CI loop: green CI twice, a failed merge, and the issue is still open.
  let closed = 0, held = false;
  const green = { state: "green", sha: "abc", failures: [], missing: [] };
  const head = await finishWithGreenCI({
    snapshot: async () => green, repair: async () => true, progress: async () => {}, wait: async () => {},
    closeIssue: async () => { held = await finishLowRisk({ merge: () => requestFactoryMerge({ post: async () => ({ status: 502, data: {} }), sha: "abc" }), landed: async () => null,
      closeIssue: async () => { closed++; }, watchMain: async () => {}, progress: async () => {} }); },
  });
  assert.deepEqual([head, held, closed], ["abc", true, 0]);
});

test("a merge that landed although its request failed is still watched on the default branch", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { seen, run } = lowRisk(async () => { throw timeout; }, "landed-anyway");
  assert.equal(await run(), false);
  assert.deepEqual([seen.closed, seen.watched], [0, ["landed-anyway"]]);
});

test("a merge that lands is watched on the default branch; a declined one closes the issue and leaves the PR", async () => {
  const landed = lowRisk(async () => ({ status: 200, data: { result: "merge", sha: "landed" } }));
  assert.equal(await landed.run(), false);
  assert.deepEqual([landed.seen.closed, landed.seen.watched], [0, ["landed"]]);
  const declined = lowRisk(async () => ({ status: 200, data: { result: "blocked", sha: null, message: "Only low-risk tickets merge automatically." } }));
  assert.equal(await declined.run(), false);
  assert.deepEqual([declined.seen.closed, declined.seen.watched], [1, []]);
  assert.match(declined.seen.said[0], /blocked by GitHub or Factory/);
  // Already merged, but GitHub gave no merge commit to watch.
  const unknown = lowRisk(async () => ({ status: 200, data: { result: "already-merged", sha: null } }));
  await unknown.run();
  assert.deepEqual([unknown.seen.closed, unknown.seen.watched], [1, []]);
  // No merge channel at all: nothing merges, the PR is left for review.
  const none = lowRisk(null);
  await none.run();
  assert.deepEqual([none.seen.closed, none.seen.watched], [1, []]);
});
