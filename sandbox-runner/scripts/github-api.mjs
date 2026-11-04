// The supervisor's GitHub REST client. Every run on an installation shares one rate limit, so a burst of
// runs can exhaust it; a limited request waits for GitHub's reset instead of failing the run.

// GitHub resets the primary limit within the hour.
export const MAX_RATE_WAIT_MS = 65 * 60_000;
// Waits are announced in steps so the run keeps reporting progress while it waits.
export const WAIT_STEP_MS = 5 * 60_000;
// GitHub's advice when a secondary limit names no reset time.
const SECONDARY_WAIT_MS = 60_000;
const MAX_TRANSIENT_ATTEMPTS = 4;
const CACHE_ENTRIES = 200;

/** How long GitHub asks a limited request to wait, or null when the response is not a rate limit. */
export function rateLimitWait(status, headers, message, now = Date.now()) {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return Math.max(Number(retryAfter), 1) * 1000;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    return reset > 0 ? Math.max(reset * 1000 - now, 0) + 1000 : SECONDARY_WAIT_MS;
  }
  if (/rate limit|abuse detection/i.test(message ?? "")) return SECONDARY_WAIT_MS;
  return status === 429 ? SECONDARY_WAIT_MS : null;
}

/** Full jitter, so runs that failed together do not retry together. */
export const transientDelay = (attempt, random = Math.random) => Math.round(random() * Math.min(30_000, 1000 * 2 ** attempt));

/**
 * `github(path, method, body)` for one repository. GETs are conditional: an unchanged poll answers
 * 304, which GitHub does not count against the rate limit. Server errors and lost connections are
 * retried only for requests that are safe to repeat; a POST may already have created its comment or PR.
 */
export function createGithub({ repoFullName, token, onWait = async () => {}, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, random = Math.random }) {
  const cache = new Map();
  return async function github(path, method = "GET", body) {
    const label = `GitHub ${method} ${path.split("?")[0]}`;
    const repeatable = method !== "POST";
    let rateWaited = 0;
    for (let attempt = 1; ; attempt++) {
      const cached = method === "GET" ? cache.get(path) : undefined;
      let response;
      try {
        response = await fetch(`https://api.github.com/repos/${repoFullName}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await token()}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Factory",
            "Content-Type": "application/json",
            ...(cached ? { "If-None-Match": cached.etag } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (!repeatable || attempt >= MAX_TRANSIENT_ATTEMPTS)
          throw Object.assign(new Error(`${label} failed (${error?.name === "TimeoutError" ? "timed out" : "connection lost"}). Ticket left open.`), { status: 0 });
        await sleep(transientDelay(attempt, random));
        continue;
      }
      if (response.status === 304 && cached) return JSON.parse(cached.text);
      if (response.ok) {
        // Some writes, such as job re-runs, answer with an empty body.
        const text = await response.text();
        const etag = response.headers.get("etag");
        if (method === "GET" && etag && text) {
          cache.delete(path);
          cache.set(path, { etag, text });
          if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        }
        return text ? JSON.parse(text) : {};
      }
      const apiMessage = (await response.json().catch(() => ({}))).message;
      const fail = (detail = "") => {
        const error = new Error(`${label} failed (${response.status}).${detail} Ticket left open.`);
        error.status = response.status;
        error.apiMessage = apiMessage;
        return error;
      };
      const limited = rateLimitWait(response.status, response.headers, apiMessage, now());
      if (limited !== null) {
        // A small spread keeps every waiting run from calling GitHub in the same second after the reset.
        const wait = limited + Math.round(random() * 15_000);
        if (rateWaited + wait > MAX_RATE_WAIT_MS)
          throw fail(` GitHub's rate limit for this installation was still exhausted after ${Math.round(rateWaited / 60_000)} minutes of waiting.`);
        rateWaited += wait;
        for (let left = wait; left > 0; left -= WAIT_STEP_MS) {
          // Each message differs, so the run's log, and its liveness, advance during the wait.
          await onWait(`GitHub rate limit reached for this installation. Retrying in ${Math.ceil(left / 60_000)} min, at ${new Date(now() + left).toISOString()}.`);
          await sleep(Math.min(left, WAIT_STEP_MS));
        }
        continue;
      }
      if (repeatable && response.status >= 500 && attempt < MAX_TRANSIENT_ATTEMPTS) {
        await sleep(transientDelay(attempt, random));
        continue;
      }
      throw fail();
    }
  };
}
