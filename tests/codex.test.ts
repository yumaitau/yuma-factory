import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionStage,
  hasCapacity,
  hasGreenCICompletion,
  validId,
  validModel,
  validateAuthFile,
} from "../shared/codex";
test("both subscription windows constrain availability until their reset", () => {
  assert.equal(
    hasCapacity(
      {
        primary: { usedPercent: 2, resetsAt: 200 },
        secondary: { usedPercent: 100, resetsAt: 200 },
      },
      100,
    ),
    false,
  );
  assert.equal(
    hasCapacity({ primary: { usedPercent: 100, resetsAt: 200 } }, 100),
    false,
  );
  assert.equal(
    hasCapacity({ primary: { usedPercent: 100, resetsAt: 100 } }, 100),
    true,
  );
  assert.equal(
    hasCapacity({ primary: { usedPercent: 100, resetsAt: null } }, 100),
    false,
  );
  assert.equal(
    hasCapacity({ primary: { usedPercent: 99, resetsAt: 200 } }, 100),
    true,
  );
});
test("subscription auth requires complete tokens and rejects API-key fallback", () => {
  const auth = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "test-access",
      refresh_token: "test-refresh",
      id_token: "test-id",
      account_id: "test-account",
    },
  };
  assert.equal(
    JSON.parse(validateAuthFile(JSON.stringify(auth))).auth_mode,
    "chatgpt",
  );
  assert.throws(() =>
    validateAuthFile(
      JSON.stringify({ ...auth, OPENAI_API_KEY: "test-api-key" }),
    ),
  );
  assert.throws(() =>
    validateAuthFile(JSON.stringify({ ...auth, auth_mode: "apikey" })),
  );
  assert.throws(() =>
    validateAuthFile(
      JSON.stringify({ ...auth, tokens: { account_id: "test-account" } }),
    ),
  );
  assert.throws(() => validateAuthFile("a".repeat(32001)));
});
test("run identifiers and models reject paths, flags and legacy profiles", () => {
  assert.equal(validId("run_" + "a".repeat(32)), true);
  for (const id of ["../auth", "run_abc", "run_" + "a".repeat(32) + "/other"])
    assert.equal(validId(id), false);
  assert.equal(validModel("codex-default"), true);
  for (const model of [
    "--config=bad",
    "au.anthropic.claude",
    "../model",
    "x;id",
  ])
    assert.equal(validModel(model), false);
});

 test("legacy successes, failed runs and missing CI evidence leave tickets open", () => {
  const verified = { status: "succeeded" as const, log: "CI green", issueClosed: true,
    ciHeadSha: "a".repeat(40), pullRequestUrl: "https://github.com/org/repo/pull/1" };
  assert.equal(hasGreenCICompletion(verified), true);
  assert.equal(hasGreenCICompletion({ status: "succeeded", log: "Implementation complete" }), false);
  assert.equal(hasGreenCICompletion({ ...verified, status: "failed" }), false);
  assert.equal(hasGreenCICompletion({ ...verified, issueClosed: false }), false);
  assert.equal(hasGreenCICompletion({ ...verified, ciHeadSha: undefined }), false);
  assert.equal(hasGreenCICompletion({ ...verified, ciHeadSha: "pending" }), false);
  assert.equal(hasGreenCICompletion({ ...verified, pullRequestUrl: undefined }), false);
});

test("ticket only reaches done when the GitHub issue was verifiably closed", () => {
  assert.equal(completionStage("succeeded", true), "done");
  assert.equal(completionStage("succeeded", false), "review");
  assert.equal(completionStage("failed", false), "assigned");
  assert.equal(completionStage("failed", true), "assigned");
  assert.equal(completionStage("cancelled", false), "intake");
  assert.equal(completionStage("cancelled", true), "intake");
});
