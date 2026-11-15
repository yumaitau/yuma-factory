import { createHmac, generateKeyPairSync } from 'node:crypto';
import { lifecycleDatabase } from './d1';

/** Test-only values. None is a real credential; the GitHub App key is generated per process and never written. */
export const RUNNER_SECRET = 'test-only-runner-secret';
export const WEBHOOK_SECRET = 'test-only-webhook-secret';
export const SHARED_API_KEY = 'test-only-shared-api-key';
export const APP_URL = 'http://factory.test';
export const RUNNER_URL = 'http://runner.test';
export const CHANNEL_PURPOSE = 'factory-run-channel:v1:';
export const MERGE_PURPOSE = 'factory-run-merge:v1:';

let appKey: string | undefined;
const testAppKey = () => appKey ??= generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
/** An id the app accepts: a prefix and 32 hex characters. */
export const hexId = (prefix: string, digit: string) => `${prefix}_${digit.repeat(32)}`;
/** A per-run bearer token, minted as lib/run-token.ts documents, with the test runner secret. */
export const runToken = (runId: string, purpose = CHANNEL_PURPOSE) =>
  `${runId}.${createHmac('sha256', RUNNER_SECRET).update(purpose + runId).digest('base64url')}`;
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${APP_URL}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
/** A GitHub webhook delivery, signed with the test webhook secret unless a signature is given. */
export function webhook(event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return post('/api/github/webhook', body, { 'x-github-event': event,
    'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}` });
}

type Respond = (request: Request, url: URL, body: unknown) => Response | undefined | Promise<Response | undefined>;

/**
 * The Factory app with nothing real behind it: an in-memory D1 with every migration applied, a queue that
 * records what was sent, and a fetch that answers only what the test declares. Any other outbound request is
 * answered 599 and listed in `unexpected`, so a test can assert that nothing else was called.
 */
export function factoryApp() {
  const { db, sqlite } = lifecycleDatabase();
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: 'test-only-auth-secret-of-32-bytes!!', BETTER_AUTH_URL: APP_URL, ALLOWED_EMAIL_DOMAINS: 'example.com',
    SANDBOX_RUNNER_URL: RUNNER_URL, SANDBOX_RUNNER_SECRET: RUNNER_SECRET, FACTORY_API_KEY: SHARED_API_KEY,
    GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: testAppKey(), GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_CLIENT_SECRET: 'test-only',
    GITHUB_APP_SLUG: 'factory-test', GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  const queued: unknown[] = [];
  // lib/db.ts and lib/automation-queue.ts read their bindings from this global, as the deployed Worker does.
  const context = Symbol.for('__cloudflare-context__');
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const previousContext = scope[context];
  scope[context] = { env: { DB: db.$client, FACTORY_EVENTS: { send: async (message: unknown) => { queued.push(message); } } }, ctx: {}, cf: {} };
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const unexpected: string[] = [];
  const handlers: Respond[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* Not JSON: keep the text. */ }
    calls.push({ method: request.method, url: `${url.origin}${url.pathname}`, headers: Object.fromEntries(request.headers), body });
    // The GitHub App exchanges its key for an installation token before any installation request.
    if (url.hostname === 'api.github.com' && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname))
      return json({ token: 'test-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), repository_selection: 'all',
        permissions: { administration: 'read', checks: 'read', actions: 'read', statuses: 'read', issues: 'write', pull_requests: 'write', contents: 'write' } }, 201);
    for (const handler of handlers) {
      const response = await handler(request, url, body);
      if (response) return response;
    }
    unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
    return json({ message: 'No test handler for this request.' }, 599);
  }) as typeof fetch;
  return {
    db, sqlite, queued, calls, unexpected,
    /** Answer outbound requests; the newest handler is asked first. Return undefined to pass. */
    on(handler: Respond) { handlers.unshift(handler); },
    /**
     * Answer one GitHub REST or GraphQL route with JSON data or a function, for example 'GET /repos/org/repo/issues/1'
     * or 'POST /graphql'. The path is matched as sent, so a label such as factory:ready appears as factory%3Aready.
     */
    github(route: string, respond: object | ((body: unknown) => Response | Promise<Response>)) {
      handlers.unshift((request, url, body) => url.hostname === 'api.github.com' && `${request.method} ${url.pathname}` === route
        ? (typeof respond === 'function' ? (respond as (body: unknown) => Response | Promise<Response>)(body) : json(respond)) : undefined);
    },
    /** Answer every request to the sandbox runner. */
    runner(respond: (request: Request, url: URL, body: unknown) => Response | Promise<Response>) {
      handlers.unshift((request, url, body) => url.origin === RUNNER_URL ? respond(request, url, body) : undefined);
    },
    /** One row of the test database, as plain values. */
    row(query: string, ...params: (string | number | null)[]) {
      const found = sqlite.prepare(query).get(...params);
      return found ? { ...found } : undefined;
    },
    /** GitHub calls made so far, as 'METHOD /path'. */
    githubCalls: () => calls.filter((call) => call.url.startsWith('https://api.github.com') && !call.url.endsWith('/access_tokens'))
      .map((call) => `${call.method} ${new URL(call.url).pathname}`),
    close() {
      globalThis.fetch = previousFetch;
      scope[context] = previousContext;
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      sqlite.close();
    },
  };
}
export type FactoryApp = ReturnType<typeof factoryApp>;
