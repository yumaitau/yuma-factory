import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAFE_GIT, loginTokens, readAgentFile } from "../sandbox-runner/scripts/agent-files.mjs";

test("root reads of agent files refuse links, FIFOs and oversized files without waiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-files-"));
  try {
    writeFileSync(join(dir, "real.txt"), "summary");
    assert.equal(await readAgentFile(join(dir, "real.txt")), "summary");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    await assert.rejects(readAgentFile(join(dir, "link.txt")));
    execFileSync("mkfifo", [join(dir, "pipe.txt")]);
    // A FIFO with no writer would block a plain open forever.
    await assert.rejects(readAgentFile(join(dir, "pipe.txt")), /Unexpected agent file/);
    await assert.rejects(readAgentFile(join(dir, "real.txt"), 3), /Unexpected agent file/);
    await assert.rejects(readAgentFile(join(dir, "missing.txt")));
    await assert.rejects(readAgentFile(dir), /Unexpected agent file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only token-shaped values of the known login fields are redacted", () => {
  const token = "abcDEF123._-".repeat(4);
  assert.deepEqual(loginTokens({ tokens: { access_token: token, refresh_token: token + "x", id_token: token + "y", account_id: "acct-1234567890-abcdefgh" } }),
    [token, token + "x", token + "y"]);
  // Extra keys and code-shaped values are how an agent would hide lines from the reviewer.
  assert.deepEqual(loginTokens({ tokens: { hidden: token, access_token: 'require("child_process").exec(payload)' } }), []);
  assert.deepEqual(loginTokens({ tokens: { access_token: "short" } }), []);
  for (const value of [null, undefined, "text", 1, {}, { tokens: null }, { tokens: "x" }]) assert.deepEqual(loginTokens(value), []);
});

test("agent-user git never starts a monitor or a hook", () => {
  assert.deepEqual(SAFE_GIT, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
});
