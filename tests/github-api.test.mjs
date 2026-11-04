import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RATE_WAIT_MS, createGithub, rateLimitWait } from "../sandbox-runner/scripts/github-api.mjs";

const headers = (values = {}) => new Headers(values);
const reply = (status, body, values = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: values });

function client(responses, extra = {}) {
  const calls = [], slept = [], waits = [];
  let clock = 1_000_000;
  const github = createGithub({
    repoFullName: "acme/app",
    token: async () => "t",
    onWait: async (message) => { waits.push(message); },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    now: () => clock,
    random: () => 0,
    ...extra,
  });
  return { github, calls, slept, waits };
}

test("a 403 is a rate limit only when GitHub's headers or message say so", () => {
  const now = 1_000_000;
  assert.equal(rateLimitWait(403, headers({ "retry-after": "30" }), "", now), 30_000);
  assert.equal(rateLimitWait(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 120) }), "", now), 121_000);
  assert.equal(rateLimitWait(403, headers(), "You have exceeded a secondary rate limit.", now), 60_000);
  assert.equal(rateLimitWait(429, headers(), "", now), 60_000);
  // A missing permission must fail fast; waiting cannot grant it.
  assert.equal(rateLimitWait(403, headers({ "x-ratelimit-remaining": "4000" }), "Resource not accessible by integration", now), null);
  assert.equal(rateLimitWait(404, headers({ "x-ratelimit-remaining": "0" }), "", now), null);
});

test("a rate-limited request waits for the reset, reports progress, then succeeds", async () => {
  const { github, slept, waits } = client([
    reply(403, { message: "API rate limit exceeded for installation" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_000_000 / 1000 + 600) }),
    reply(200, { number: 7 }),
  ]);
  assert.deepEqual(await github("/pulls/7"), { number: 7 });
  // Ten minutes and a second, reported in five-minute steps.
  assert.deepEqual(slept, [300_000, 300_000, 1000]);
  assert.equal(waits.length, 3);
  assert.match(waits[0], /rate limit reached/);
  // Distinct messages: the log dedupes repeats, and a silent run is treated as wedged.
  assert.equal(new Set(waits).size, waits.length);
});

test("a rate limit that outlasts the wait budget fails with the reason", async () => {
  const limited = () => reply(403, { message: "secondary rate limit" }, { "retry-after": String(MAX_RATE_WAIT_MS / 1000) });
  const { github } = client([limited(), limited()]);
  await assert.rejects(github("/pulls"), (error) => error.status === 403 && /still exhausted/.test(error.message));
});

test("permission errors fail at once with GitHub's message kept for callers", async () => {
  const { github, calls } = client([reply(404, { message: "Branch not protected" })]);
  await assert.rejects(github("/branches/main/protection"), (error) =>
    error.status === 404 && error.apiMessage === "Branch not protected" && /GitHub GET \/branches\/main\/protection failed \(404\)/.test(error.message));
  assert.equal(calls.length, 1);
});

test("server errors and lost connections retry safe requests, never a create", async () => {
  const retried = client([reply(502, {}), new TypeError("fetch failed"), reply(200, { ok: true })]);
  assert.deepEqual(await retried.github("/pulls/1"), { ok: true });
  assert.equal(retried.calls.length, 3);
  // PATCH is idempotent: closing an issue twice leaves it closed.
  const patched = client([reply(503, {}), reply(200, { state: "closed" })]);
  assert.deepEqual(await patched.github("/issues/1", "PATCH", { state: "closed" }), { state: "closed" });
  // A POST that timed out may already have opened its PR.
  const created = client([reply(502, {})]);
  await assert.rejects(created.github("/pulls", "POST", { title: "x" }), /failed \(502\)/);
  assert.equal(created.calls.length, 1);
  const lost = client([new TypeError("fetch failed")]);
  await assert.rejects(lost.github("/issues/1/comments", "POST", { body: "x" }), /connection lost/);
  assert.equal(lost.calls.length, 1);
});

test("repeat GETs are conditional and an unchanged answer is served from the cache", async () => {
  const { github, calls } = client([
    reply(200, { head: { sha: "a" } }, { etag: '"v1"' }),
    new Response(null, { status: 304 }),
  ]);
  assert.deepEqual(await github("/pulls/3"), { head: { sha: "a" } });
  assert.deepEqual(await github("/pulls/3"), { head: { sha: "a" } });
  assert.equal(calls[0].init.headers["If-None-Match"], undefined);
  assert.equal(calls[1].init.headers["If-None-Match"], '"v1"');
});

test("an empty success body still parses", async () => {
  const { github } = client([new Response("", { status: 201 })]);
  assert.deepEqual(await github("/actions/runs/1/rerun-failed-jobs", "POST"), {});
});
