import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFixPrompt, checkPlan, failureOutput, newFailures } from "../sandbox-runner/scripts/checks.mjs";

const pkg = (scripts) => JSON.stringify({ name: "app", scripts });

test("each check runs the first usable script in its group, through the lockfile's package manager", () => {
  const plan = checkPlan(pkg({ lint: "eslint .", "type-check": "tsc --noEmit", "test:unit": "vitest run", test: "vitest run && playwright test", build: "next build", dev: "next dev" }),
    new Set(["package.json", "pnpm-lock.yaml"]));
  assert.deepEqual(plan, { bin: "pnpm", install: ["install", "--frozen-lockfile"], checks: [
    { name: "lint", script: "lint" }, { name: "typecheck", script: "type-check" }, { name: "test", script: "test:unit" }, { name: "build", script: "build" },
  ] });
  assert.deepEqual(checkPlan(pkg({ build: "next build" }), new Set(["package-lock.json"])),
    { bin: "npm", install: ["ci", "--no-audit", "--no-fund"], checks: [{ name: "build", script: "build" }] });
});

test("no plan without a lockfile Factory can install, or without usable scripts", () => {
  const scripts = pkg({ lint: "eslint ." });
  assert.equal(checkPlan(scripts, new Set(["yarn.lock"])), null);
  assert.equal(checkPlan(scripts, new Set(["bun.lockb"])), null);
  assert.equal(checkPlan(scripts, new Set([])), null);
  assert.equal(checkPlan("{not json", new Set(["pnpm-lock.yaml"])), null);
  assert.equal(checkPlan(null, new Set(["pnpm-lock.yaml"])), null);
  // npm init's placeholder and watchers are skipped, not run.
  assert.equal(checkPlan(pkg({ test: 'echo "Error: no test specified" && exit 1', typecheck: "tsc --watch", lint: "watch" }), new Set(["pnpm-lock.yaml"])), null);
  assert.deepEqual(checkPlan(pkg({ test: "jest --watch", "test:unit": "jest" }), new Set(["pnpm-lock.yaml"])).checks, [{ name: "test", script: "test:unit" }]);
  // One-shot forms run; watchers that only look one-shot don't.
  const tests = (test) => checkPlan(pkg({ test }), new Set(["pnpm-lock.yaml"]))?.checks ?? [];
  assert.equal(tests("vitest --watch=false").length, 1);
  assert.equal(tests("ng test --watch=false").length, 1);
  assert.equal(tests("jest --watchAll").length, 0);
  assert.equal(tests("vitest dev").length, 0);
  assert.equal(tests("vitest run").length, 1);
});

test("only failures the change introduced are fixed before the push", () => {
  const after = [{ name: "lint", ok: false }, { name: "typecheck", ok: false }, { name: "test", ok: true }, { name: "build", ok: false }];
  // lint already failed on the base branch; typecheck passed there; build is new on this branch.
  const base = [{ name: "lint", ok: false }, { name: "typecheck", ok: true }, { name: "test", ok: true }];
  assert.deepEqual(newFailures(after, base).map((result) => result.name), ["typecheck", "build"]);
  // A base that can't install can't be compared: CI decides.
  assert.deepEqual(newFailures(after, [{ name: "install", ok: false }]), []);
  // A base with no checks Factory can run didn't have them: every failure is new.
  assert.deepEqual(newFailures(after, []).map((result) => result.name), ["lint", "typecheck", "build"]);
  // A change that breaks the install itself is the change's to fix.
  assert.deepEqual(newFailures([{ name: "install", ok: false }], base).map((result) => result.name), ["install"]);
});

test("failure output keeps the tail, and the fix prompt forbids weakening the checks", () => {
  // A summary on stdout survives noisy stderr.
  const output = failureOutput({ stdout: `${"x".repeat(9000)}Tests 3 failed`, stderr: "warning: act()\n".repeat(2000) });
  assert.match(output, /Tests 3 failed/);
  assert.ok(output.length <= 8001);
  // A timeout names itself and keeps what the command printed before it hung.
  assert.match(failureOutput({ stdout: "RUN src/slow.test.ts", stderr: "", message: "pnpm exceeded its time limit." }), /time limit\.\nRUN src\/slow\.test\.ts/);
  assert.match(failureOutput({ message: "pnpm exceeded its time limit." }), /time limit/);
  const prompt = checkFixPrompt("Fix the login page.", [{ name: "typecheck", output: "src/a.ts(1,1): error TS2322" }]);
  assert.match(prompt, /^Fix the login page\./);
  assert.match(prompt, /## typecheck failed\nsrc\/a\.ts/);
  assert.match(prompt, /Do not weaken or skip tests/);
  assert.match(prompt, /Do not commit, push/);
});
