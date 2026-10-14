import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REVIEW_FIXES, isDependencyBump, parseFindings, reviewPrompt, reviewUntilClean } from "../sandbox-runner/scripts/review.mjs";

const diff = (path, ...lines) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n ${"context"}\n${lines.join("\n")}\n`;

test("dependency version bumps skip review; anything else is reviewed", () => {
  const bump = diff("package.json", '-    "next": "16.3.8",', '+    "next": "16.4.1",', '-    "@types/node": "^22.1.0"', '+    "@types/node": "^22.2.0"')
    + diff("pnpm-lock.yaml", "-  next@16.3.8:", "+  next@16.4.1:", "-    resolution: {integrity: sha512-old}", "+    resolution: {integrity: sha512-abc}",
      "-  '@next/env@16.3.8':", "+  '@next/env@16.4.1':", "-  sharp@0.35.4:", "+  sharp@0.35.5:", "+  next@16.4.1(react@19.2.5):")
    + diff("package-lock.json", '-    "node_modules/next": {', '+    "node_modules/next": {', '+      "resolved": "https://registry.npmjs.org/next/-/next-16.4.1.tgz",')
    + diff("go.sum", "-golang.org/x/net v0.59.0 h1:a=", "+golang.org/x/net v0.60.0 h1:b=")
    + diff("pnpm-workspace.yaml", "-  sharp: 0.35.4", "+  sharp: 0.35.5")
    + diff("go.mod", "-require golang.org/x/net v0.59.0", "+require golang.org/x/net v0.60.0", "-\tgolang.org/x/text v0.1.0 // indirect", "+\tgolang.org/x/text v0.2.0 // indirect")
    + diff("requirements.txt", "-pyjwt==2.13.0", "+pyjwt==2.14.0");
  assert.equal(isDependencyBump(bump), true);
  // A script, a code file, or a new manifest field is a real change.
  assert.equal(isDependencyBump(diff("package.json", '-    "build": "next build"', '+    "build": "next build && rm -rf /"')), false);
  assert.equal(isDependencyBump(bump + diff("src/app.ts", "-a()", "+b()")), false);
  assert.equal(isDependencyBump(diff("package.json", '+  "postinstall": "curl x | sh",')), false);
  assert.equal(isDependencyBump("diff --git a/package.json b/evil.json\n"), false);
  assert.equal(isDependencyBump(""), false);
  // Bypasses: aliases, paths that start with a digit, new keys, hidden or binary content, lockfile-only edits.
  for (const [name, patch] of Object.entries({
    alias: diff("package.json", '-    "lodash": "4.17.21",', '+    "lodash": "npm:evil-lodash@1.0.0",'),
    main: diff("package.json", '-  "main": "0.js",', '+  "main": "1.js",'),
    bin: diff("package.json", '+  "bin": "0evil.sh",'),
    renamedKey: diff("package.json", '-    "next": "16.3.8",', '+    "nextt": "16.4.1",'),
    binary: "diff --git a/package.json b/package.json\nindex 1..2 100644\nBinary files a/package.json and b/package.json differ\n",
    symlink: "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\nindex 1..2 120000\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-a\n+/etc/passwd\n",
    newFile: "diff --git a/package.json b/package.json\nnew file mode 100644\n--- /dev/null\n+++ b/package.json\n@@ -0,0 +1 @@\n+{}\n",
    lockfileOnly: diff("pnpm-lock.yaml", "-    resolution: {integrity: sha512-a}", "+    resolution: {integrity: sha512-b}"),
    tarball: diff("package.json", '-    "next": "16.3.8",', '+    "next": "16.4.1",')
      + diff("pnpm-lock.yaml", "-    resolution: {integrity: sha512-a}", "+    resolution: {tarball: https://evil.example/x.tgz}"),
    newPackage: diff("package.json", '-    "next": "16.3.8",', '+    "next": "16.4.1",')
      + diff("pnpm-lock.yaml", "-  next@16.3.8:", "+  next@16.4.1:", "+  evil@1.0.0:", "+    requiresBuild: true"),
    newGoModule: diff("go.mod", "-require golang.org/x/net v0.59.0", "+require golang.org/x/net v0.60.0")
      + diff("go.sum", "+evil.example/x v1.0.0 h1:c="),
    otherRegistry: diff("package.json", '-    "next": "16.3.8",', '+    "next": "16.4.1",')
      + diff("package-lock.json", '+      "resolved": "https://evil.example/next-16.4.1.tgz",'),
    nextEnv: diff("next-env.d.ts", '-import "./.next/dev/types/routes.d.ts";', '+import "./evil";'),
    unreadLockfile: diff("Cargo.toml", '-serde = "1.0.1"', '+serde = "1.0.2"') + diff("Cargo.lock", '-version = "1.0.1"', '+version = "1.0.2"'),
  })) assert.equal(isDependencyBump(patch), false, name);
});

test("reviewer output is validated and bounded", () => {
  assert.equal(parseFindings(null), null);
  assert.equal(parseFindings({ findings: "none" }), null);
  assert.deepEqual(parseFindings({ findings: [] }), []);
  assert.deepEqual(parseFindings({ findings: [
    { severity: "HIGH", file: "a.ts", line: 3, problem: " Null crash ", fix: "check" },
    { severity: "critical", problem: "critical counts as high" },
    { severity: "low", problem: "" },
    { severity: "medium", line: -1, problem: "x" },
    { severity: "urgent", problem: "unknown counts as medium" },
  ] }), [
    { severity: "high", file: "a.ts", line: 3, problem: "Null crash", fix: "check" },
    { severity: "high", file: "", line: null, problem: "critical counts as high", fix: "" },
    { severity: "medium", file: "", line: null, problem: "x", fix: "" },
    { severity: "medium", file: "", line: null, problem: "unknown counts as medium", fix: "" },
  ]);
  assert.equal(parseFindings({ findings: Array(50).fill({ severity: "low", problem: "p" }) }).length, 20);
});

test("blocking findings are fixed and re-reviewed until clean or the fix budget runs out", async () => {
  const high = { severity: "high", file: "a.ts", line: 1, problem: "bug", fix: "" };
  const low = { severity: "low", file: "", line: null, problem: "nit", fix: "" };
  const progress = async () => {};

  const verdicts = [[high], [low]];
  const fixes = [];
  const reviews = [];
  const clean = await reviewUntilClean({
    progress,
    review: async (previous, response) => { reviews.push({ previous, response }); return verdicts.shift(); },
    fix: async (findings) => { fixes.push(findings); return "fixed it"; },
  });
  assert.deepEqual(clean, { verdict: "clean", findings: [low] });
  assert.deepEqual(fixes, [[high]]);
  assert.deepEqual(reviews[1], { previous: [high], response: "fixed it" });

  let fixCount = 0;
  const stuck = await reviewUntilClean({ progress, review: async () => [high], fix: async () => { fixCount++; return ""; } });
  assert.equal(stuck.verdict, "unresolved");
  assert.equal(fixCount, MAX_REVIEW_FIXES);

  assert.deepEqual(await reviewUntilClean({ progress, review: async () => null, fix: async () => assert.fail() }), { verdict: "missing", findings: [] });
});

test("the review prompt carries the earlier findings and forbids edits", () => {
  const prompt = reviewPrompt({ task: "Fix #1", diffFile: "/workspace/factory-review/changes.diff", previous: [{ severity: "high", file: "a.ts", line: 2, problem: "bug", fix: "" }], response: "done" });
  assert.match(prompt, /changes\.diff/);
  assert.match(prompt, /Do NOT edit/);
  assert.match(prompt, /\[high\] a\.ts:2: bug/);
  assert.match(prompt, /Author's reply:\ndone/);
});
