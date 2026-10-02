import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCI, finishCommitCI, isAccountBlockedCI, isCiConfigPath, MAX_IDLE_REPAIRS, isReviewBot, finishWithGreenCI, isLowRisk, latestWorkflows, loadRequiredChecks, mergeGreenPullRequest, requiredChecks } from "../sandbox-runner/scripts/ci.mjs";

test("CI requires reported checks and waits for pending work", () => {
  assert.equal(evaluateCI([], [], []).state, "pending");
  assert.equal(evaluateCI([{ name: "test", status: "in_progress" }], [], []).state, "pending");
  assert.equal(evaluateCI([], [{ context: "deploy", state: "pending" }], []).state, "pending");
  assert.equal(evaluateCI([], [], [{ name: "CI", status: "queued" }]).state, "pending");
});

test("failed, cancelled and timed-out checks never pass", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
    assert.equal(evaluateCI([{ name: "test", status: "completed", conclusion }], [], []).state, "failed");
  }
  assert.equal(evaluateCI([], [{ context: "build", state: "error" }], []).state, "failed");
  assert.equal(evaluateCI([], [], [{ name: "CI", status: "completed", conclusion: "failure" }]).state, "failed");
  assert.equal(evaluateCI([{ name: "test", status: "completed", conclusion: "success" }], [{ context: "deploy", state: "success" }], [], [{ context: "test" }, { context: "deploy" }]).state, "green");
});

test("multiple failures repair same PR; closure waits for fresh green observations", async () => {
  const states = [
    { state: "pending", sha: "a" },
    { state: "failed", sha: "a" },
    { state: "failed", sha: "b" },
    { state: "green", sha: "c" },
    { state: "pending", sha: "c" },
    { state: "green", sha: "c" },
    { state: "green", sha: "d" },
    { state: "green", sha: "d" },
  ];
  const repaired = [], closed = [];
  await finishWithGreenCI({
    snapshot: async () => {
      assert.equal(closed.length, 0);
      assert.ok(states.length);
      return states.shift();
    },
    repair: async (current) => repaired.push(current.sha),
    closeIssue: async (sha) => closed.push(sha),
    progress: async () => {}, wait: async () => {},
  });
  assert.deepEqual(repaired, ["a", "b"]);
  assert.deepEqual(closed, ["d"]);
  assert.equal(states.length, 0);
});

test("blocked or closed PR and repair exceptions cannot close a ticket", async () => {
  let closed = false;
  let polls = 0;
  const options = {
    snapshot: async () => (++polls === 1
      ? { state: "green", sha: "a", blocked: true }
      : { closed: true }),
    closeIssue: async () => { closed = true; },
    repair: async () => { throw new Error("subscription exhausted"); },
    progress: async () => {}, wait: async () => {},
  };
  await assert.rejects(finishWithGreenCI(options), /Pull request closed/);
  await assert.rejects(finishWithGreenCI({ ...options, snapshot: async () => ({ state: "failed" }) }), /subscription exhausted/);
  assert.equal(closed, false);
});

test("required check registration and exact app identity gate green", () => {
  const success = { name: "test", app: { id: 1 }, status: "completed", conclusion: "success" };
  assert.equal(evaluateCI([success], [], []).state, "green");
  assert.deepEqual(evaluateCI([success], [], [], [{ context: "test" }, { context: "lint" }]).missing, ["lint"]);
  assert.equal(evaluateCI([success], [], [], [{ context: "test", app_id: 2 }]).state, "pending");
  assert.equal(evaluateCI([success], [], [], [{ context: "test", app_id: 1 }]).state, "green");
  assert.equal(evaluateCI([success], [], [], [{ context: "test", app_id: -1 }]).state, "green");
  assert.equal(evaluateCI([], [{ context: "test", state: "success" }], [], [{ context: "test", app_id: 1 }]).state, "pending");
});

test("classic checks and organisation rules combine without losing app pins", () => {
  const rules = requiredChecks({ contexts: ["test", "legacy"], checks: [{ context: "test", app_id: 1 }] }, [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "security", integration_id: 2 }] } },
    { type: "pull_request" },
  ]);
  assert.deepEqual(rules, [{ context: "test", app_id: 1 }, { context: "legacy" }, { context: "security", app_id: 2 }]);
  assert.throws(() => requiredChecks(null, [{ type: "required_status_checks" }]), /Invalid/);
  assert.throws(() => requiredChecks(null, [{ type: "workflows" }]), /Required workflow rules/);
});

test("missing checks prevent closure until they actually succeed", async () => {
  const required = [{ context: "test" }, { context: "lint" }];
  const check = (name) => ({ name, status: "completed", conclusion: "success" });
  const snapshots = [[check("test")], [check("test"), check("lint")], [check("test"), check("lint")]];
  let closed = 0;
  await finishWithGreenCI({
    snapshot: async () => ({ ...evaluateCI(snapshots.shift(), [], [], required), sha: "same" }),
    repair: async () => assert.fail("No failing check"),
    closeIssue: async () => { assert.equal(snapshots.length, 0); closed++; },
    progress: async () => {}, wait: async () => {},
  });
  assert.equal(closed, 1);
});


test("policy lookup errors fail closed; only confirmed unprotected branches allow rules-only policy", async () => {
  const rules = async () => [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "lint" }] } }];
  const api = (error) => async (path) => {
    if (path.endsWith("/protection")) throw error;
    return { name: "main" };
  };
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(loadRequiredChecks(api(Object.assign(new Error("Policy unavailable"), { status })), rules, "main"), /Policy unavailable/);
  }
  const unprotected = Object.assign(new Error("Branch not protected"), { status: 404, apiMessage: "Branch not protected" });
  assert.deepEqual(await loadRequiredChecks(api(unprotected), rules, "main"), [{ context: "lint", app_id: undefined }]);
  await assert.rejects(loadRequiredChecks(api(unprotected), async () => { throw new Error("Rules unavailable"); }, "main"), /Rules unavailable/);
});


test("low-risk merge is SHA-pinned, uses a merge commit, and treats already-merged as success", async () => {
  const calls = [];
  const github = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path === "/pulls/4" && method === "GET") return { merged: false, state: "open", head: { sha: "abc" } };
    if (method === "PUT") return { merged: true, sha: "merged" };
    throw new Error(`unexpected ${method} ${path}`);
  };
  assert.deepEqual(await mergeGreenPullRequest({ github, pullNumber: 4, sha: "abc" }), { result: "merge", sha: "merged" });
  assert.equal(calls.at(-1)?.body.merge_method, "merge");
  assert.deepEqual(await mergeGreenPullRequest({
    github: async (path) => path === "/pulls/4" ? { merged: true, state: "closed", head: { sha: "abc" }, merge_commit_sha: "landed" } : assert.fail("merged PRs must not PUT"),
    pullNumber: 4, sha: "abc",
  }), { result: "already-merged", sha: "landed" });
});

test("never squashes: disallowed merge commits and review blocks leave the PR; SHA drift throws", async () => {
  const methods = [];
  const noMergeCommits = async (_path, verb = "GET", body) => {
    if (verb === "GET") return { merged: false, state: "open", head: { sha: "abc" } };
    methods.push(body.merge_method);
    throw Object.assign(new Error("failed"), { status: 405, apiMessage: "Merge commits are not allowed on this repository." });
  };
  assert.deepEqual(await mergeGreenPullRequest({ github: noMergeCommits, pullNumber: 4, sha: "abc" }), { result: "blocked", sha: null });
  assert.deepEqual(methods, ["merge"]);
  assert.deepEqual(await mergeGreenPullRequest({
    github: async (_path, verb = "GET") => {
      if (verb === "GET") return { merged: false, state: "open", head: { sha: "abc" } };
      throw Object.assign(new Error("failed"), { status: 405, apiMessage: "Pull Request is not mergeable" });
    },
    pullNumber: 4, sha: "abc",
  }), { result: "blocked", sha: null });
  await assert.rejects(mergeGreenPullRequest({
    github: async () => ({ merged: false, state: "open", head: { sha: "other" } }),
    pullNumber: 4, sha: "abc",
  }), /PR head changed/);
  await assert.rejects(mergeGreenPullRequest({
    github: async () => ({ merged: false, state: "open", head: {} }),
    pullNumber: 4, sha: "abc",
  }), /PR head changed/);
  assert.equal(isLowRisk(["severity:low"]), true);
  assert.equal(isLowRisk(["factory:risk:low", "severity:high"]), false);
  assert.equal(isLowRisk(["Risk / Low"]), true);
  assert.equal(isLowRisk(["not-factory:risk:low"]), false);
});

test("main pipeline repairs until two green observations, and a follow-up ends the watch", async () => {
  const states = [
    { state: "failed", sha: "m" },
    { state: "green", sha: "m" },
    { state: "pending", sha: "m", missing: ["deploy"] },
    { state: "green", sha: "m" },
    { state: "green", sha: "m" },
  ];
  const done = [];
  let repairs = 0;
  await finishCommitCI({
    snapshot: async () => {
      assert.equal(done.length, 0);
      return states.shift();
    },
    repair: async () => {
      repairs++;
      return false;
    },
    done: async (sha) => done.push(sha),
    progress: async () => {}, wait: async () => {},
  });
  assert.equal(repairs, 1);
  assert.deepEqual(done, ["m"]);
  assert.equal(states.length, 0);
  let closed = false;
  await finishCommitCI({
    snapshot: async () => ({ state: "failed", sha: "m" }),
    repair: async () => true,
    done: async () => { closed = true; },
    progress: async () => {}, wait: async () => {},
  });
  assert.equal(closed, false);
});

test("push and pull request runs of the same workflow stay distinct", () => {
  const runs = [
    { id: 1, workflow_id: 9, event: "pull_request" },
    { id: 3, workflow_id: 9, event: "push" },
    { id: 2, workflow_id: 9, event: "pull_request" },
  ];
  assert.deepEqual(latestWorkflows(runs).map((run) => [run.event, run.id]), [["push", 3], ["pull_request", 2]]);
});

test("stalled main pipeline terminates without closing the issue or restarting coding", async () => {
  let time = 0;
  await assert.rejects(finishCommitCI({
    snapshot: async () => ({ ...evaluateCI([], [], [{ name: "Deploy", status: "queued" }]), sha: "merge" }),
    repair: async () => assert.fail("Missing CI is not a code failure"),
    done: async () => assert.fail("Absent CI must not close the issue"),
    progress: async () => {},
    wait: async () => { time += 15 * 60_000; },
    now: () => time,
  }), (error) => error.retryable === false && /Main pipeline did not complete/.test(error.message));
});

test("main pipeline can register late and finish green before the wait expires", async () => {
  let time = 0;
  let closed = 0;
  const states = ["pending", "pending", "green", "green"];
  await finishCommitCI({
    snapshot: async () => ({ state: states.shift(), sha: "merge" }),
    repair: async () => assert.fail("No failure"),
    done: async () => { closed++; },
    progress: async () => {},
    wait: async () => { time += 10 * 60_000; },
    now: () => time,
  });
  assert.equal(closed, 1);
});

test('conditional jobs do not trigger repairs when the PR CI passed', () => {
  const check = (name, conclusion) => ({ name, status: 'completed', conclusion });
  const checks = [check('api-docs', 'success'), check('validate', 'success'), check('api-docs-main', 'skipped')];
  const workflows = [{ name: 'API Docs', status: 'completed', conclusion: 'success' }];
  assert.equal(evaluateCI(checks, [], workflows).state, 'green');
  for (const conclusion of ['skipped', 'neutral']) {
    assert.equal(evaluateCI([check('required', conclusion)], [], [], [{ context: 'required' }]).state, 'green');
  }
  assert.equal(evaluateCI([check('conditional', 'skipped')], [], []).state, 'pending');
  assert.equal(evaluateCI(checks, [], [{ name: 'CI', status: 'queued' }]).state, 'pending');
  assert.equal(evaluateCI(checks, [], workflows, [{ context: 'missing' }]).state, 'pending');
  assert.equal(evaluateCI([...checks, check('security', 'failure')], [], workflows).state, 'failed');
});

test("runner honours a custom label prefix", () => {
  assert.equal(isLowRisk(["acme:risk:low"], "acme"), true);
  assert.equal(isLowRisk(["factory:risk:low"], "acme"), false);
});

test("review bots are not CI unless a branch rule requires them", () => {
  const rabbit = { context: "CodeRabbit", state: "success" };
  assert.equal(isReviewBot("CodeRabbit"), true);
  assert.equal(isReviewBot("build", "coderabbitai"), true);
  assert.equal(isReviewBot("test"), false);
  assert.deepEqual(evaluateCI([], [rabbit], []), { state: "pending", failures: [], missing: [], empty: true });
  assert.equal(evaluateCI([{ name: "test", status: "completed", conclusion: "success" }], [rabbit], []).state, "green");
  assert.equal(evaluateCI([], [rabbit], [], [{ context: "CodeRabbit" }]).state, "green");
  assert.equal(evaluateCI([], [{ context: "CodeRabbit", state: "failure" }], []).state, "pending");
});

test("a PR with no CI is left for review after 30 minutes and never closes the issue", async () => {
  let time = 0;
  const messages = [];
  const result = await finishWithGreenCI({
    snapshot: async () => ({ ...evaluateCI([], [{ context: "CodeRabbit", state: "success" }], []), sha: "head" }),
    repair: async () => assert.fail("No CI is not a code failure"),
    closeIssue: async () => assert.fail("Unverified work must not close the issue"),
    progress: async (message) => { messages.push(message); },
    wait: async () => { time += 10 * 60_000; },
    now: () => time,
  });
  assert.equal(result, null);
  assert.match(messages.at(-1), /No CI registered on the PR/);
});

test("a repository without any CI finishes a low-risk PR after the grace period", async () => {
  let time = 0;
  const calls = [];
  const result = await finishWithGreenCI({
    snapshot: async () => ({ ...evaluateCI([], [], []), noCI: true, sha: "head" }),
    repair: async () => assert.fail("No CI is not a code failure"),
    closeIssue: async () => assert.fail("Only green CI uses closeIssue"),
    closeWithoutCI: async (sha) => { calls.push([sha, time]); return true; },
    progress: async () => {},
    wait: async () => { time += 60_000; },
    now: () => time,
  });
  assert.equal(result, "head");
  assert.deepEqual(calls, [["head", 5 * 60_000]]);
});

test("a repository without any CI keeps a declined PR for review", async () => {
  let time = 0;
  let calls = 0;
  const result = await finishWithGreenCI({
    snapshot: async () => ({ ...evaluateCI([], [], []), noCI: true, sha: "head" }),
    repair: async () => assert.fail("No CI is not a code failure"),
    closeIssue: async () => assert.fail("Unverified work must not close the issue"),
    closeWithoutCI: async () => { calls++; return false; },
    progress: async () => {},
    wait: async () => { time += 5 * 60_000; },
    now: () => time,
  });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("CI that registers late on the PR resets the no-CI clock", async () => {
  let time = 0;
  let closed = 0;
  const snapshots = [evaluateCI([], [], []), evaluateCI([], [], []), evaluateCI([{ name: "test", status: "in_progress" }], [], []),
    ...Array(4).fill(evaluateCI([{ name: "test", status: "completed", conclusion: "success" }], [], []))];
  await finishWithGreenCI({
    snapshot: async () => ({ ...snapshots.shift(), sha: "head" }),
    repair: async () => assert.fail("No failure"),
    closeIssue: async () => { closed++; },
    progress: async () => {},
    wait: async () => { time += 20 * 60_000; },
    now: () => time,
  });
  assert.equal(closed, 1);
});

test("a default branch without any pipeline completes after 10 minutes", async () => {
  let time = 0;
  let closed = 0;
  const sha = await finishCommitCI({
    snapshot: async () => ({ ...evaluateCI([], [{ context: "CodeRabbit", state: "success" }], []), sha: "merge" }),
    repair: async () => assert.fail("Missing CI is not a code failure"),
    done: async () => { closed++; },
    progress: async () => {},
    wait: async () => { time += 5 * 60_000; },
    now: () => time,
  });
  assert.equal(sha, "merge");
  assert.equal(closed, 1);
});

test("CI workflow and action files are never published by the agent", () => {
  for (const path of [".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".GitHub/Workflows/x.yml"]) assert.equal(isCiConfigPath(path), true, path);
  for (const path of [".github/CODEOWNERS", "src/.github/workflows/x.yml", "workflows/ci.yml", ""]) assert.equal(isCiConfigPath(path), false, path);
});

test("repairs that change nothing stop the run; a pushed repair resets the count", async () => {
  let repairs = 0;
  const results = [false, false, true, ...Array(MAX_IDLE_REPAIRS).fill(false)];
  const error = await finishWithGreenCI({
    snapshot: async () => ({ state: "failed", sha: "a" }),
    repair: async () => { repairs++; return results.shift(); },
    closeIssue: async () => assert.fail("closed"),
    progress: async () => {}, wait: async () => {},
  }).catch((e) => e);
  assert.match(error.message, /repairs that changed nothing/);
  assert.equal(error.retryable, false);
  assert.equal(repairs, 3 + MAX_IDLE_REPAIRS);
});

test("GitHub billing blocks are recognised as unfixable CI failures", () => {
  assert.ok(isAccountBlockedCI(JSON.stringify([{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings" }])));
  assert.equal(isAccountBlockedCI("test: failure\nexpected 1 to equal 2"), false);
  assert.equal(isAccountBlockedCI(undefined), false);
});
