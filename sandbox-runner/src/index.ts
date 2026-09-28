import { getSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import {
  validateAuthFile,
  validId,
  validModel,
  type AccountStatus,
  type RunResult,
} from "../../shared/codex";
import { beforeStop, recoverJob, type DurableJob, type RunRequest } from "./recovery";
import { installScripts } from "./scripts";
export { Sandbox } from "@cloudflare/sandbox";
type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  RUNNER_SHARED_SECRET: string;
  CODEX_AUTH_KEY: string;
  CODEX_VAULT: R2Bucket;
  FACTORY_URL: string;
  // Optional. Must match the main app's NEXT_PUBLIC_LABEL_PREFIX.
  LABEL_PREFIX?: string;
  COMMIT_AUTHOR_NAME?: string;
  COMMIT_AUTHOR_EMAIL?: string;
};
// Deployment settings the bridge needs, delivered alongside each request.
function runnerSettings(env: Env) {
  return {
    labelPrefix: env.LABEL_PREFIX?.trim().toLowerCase() || "factory",
    factoryUrl: env.FACTORY_URL,
    commitAuthor: {
      name: env.COMMIT_AUTHOR_NAME?.trim() || "Factory",
      email: env.COMMIT_AUTHOR_EMAIL?.trim() || "factory@users.noreply.github.com",
    },
  };
}
const home = "/home/factory/.codex";
function sandbox(env: Env, id: string) {
  return getSandbox(env.Sandbox, id, { sleepAfter: "60m" });
}
async function key(env: Env) {
  const bytes = Uint8Array.from(atob(env.CODEX_AUTH_KEY), (c) =>
    c.charCodeAt(0),
  );
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
async function storeAuth(env: Env, id: string, auth: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(validateAuthFile(auth));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    await key(env),
    data,
  );
  await env.CODEX_VAULT.put(
    `accounts/${id}`,
    JSON.stringify({
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(encrypted)),
    }),
  );
}
/** Constant-time comparison of digests, so timing reveals nothing about the secret. */
async function secretMatches(supplied: string | null, expected: string | undefined) {
  if (!supplied || !expected) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function load(env: Env, id: string) {
  const obj = await env.CODEX_VAULT.get(`accounts/${id}`);
  if (!obj) return null;
  const v = await obj.json<{ iv: number[]; data: number[] }>();
  const decoded = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(v.iv),
      additionalData: new TextEncoder().encode(id),
    },
    await key(env),
    new Uint8Array(v.data),
  );
  return new TextDecoder().decode(decoded);
}
async function restore(env: Env, id: string, sb: ReturnType<typeof sandbox>) {
  const auth = await load(env, id);
  if (!auth) throw new Error("Subscription is not connected.");
  await sb.mkdir(home, { recursive: true });
  await sb.writeFile(`${home}/auth.json`, auth);
}
async function read<T>(
  sb: ReturnType<typeof sandbox>,
  file: string,
): Promise<T | null> {
  try {
    return JSON.parse(
      (await sb.readFile(`/factory/${file}.json`)).content,
    ) as T;
  } catch (error) {
    console.log(
      "Codex status file unavailable",
      file,
      error instanceof Error ? error.name : "Error",
    );
    return null;
  }
}
/**
 * After a run, auth.json is agent-writable. Only refreshed tokens for the same
 * ChatGPT account may replace the vault copy; a swapped-in login is discarded.
 * Parallel runs share one login, so an older copy never overwrites a newer refresh.
 */
async function persist(env: Env, id: string, sb: ReturnType<typeof sandbox>, sameAccount = false) {
  const file = await sb.readFile(`${home}/auth.json`);
  if (sameAccount) {
    const stored = await load(env, id);
    const parse = (raw: string | null) => {
      try { return raw ? JSON.parse(raw) as { tokens?: { account_id?: unknown }; last_refresh?: unknown } : undefined; } catch { return undefined; }
    };
    const previous = parse(stored);
    const current = parse(file.content);
    if (typeof previous?.tokens?.account_id !== "string" || current?.tokens?.account_id !== previous.tokens.account_id)
      throw new Error("Codex login changed account during the run. Vault copy kept.");
    if (file.content === stored) return;
    const refreshed = (value: unknown) => typeof value === "string" ? Date.parse(value) || 0 : 0;
    const vaultRefresh = refreshed(previous.last_refresh);
    if (vaultRefresh && refreshed(current.last_refresh) <= vaultRefresh) return;
  }
  await storeAuth(env, id, file.content);
}
async function metadata(sb: ReturnType<typeof sandbox>) {
  await sb.exec("node /opt/factory/bridge.mjs status", { timeout: 100000 });
  return (
    (await read<AccountStatus>(sb, "account")) ?? {
      status: "error" as const,
      error: "Could not read Codex account status.",
    }
  );
}
async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 100000)
    throw new Error("Request is too large.");
  const raw = await request.text();
  if (raw.length > 100000) throw new Error("Request is too large.");
  return JSON.parse(raw);
}
async function renewGithub(env: Env, id: string, accountId: string, resume = false) {
  const response = await fetch(`${env.FACTORY_URL}/api/codex/github-token`, {
    method: "POST",
    headers: { "x-runner-secret": env.RUNNER_SHARED_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ id, accountId, action: resume ? "resume" : "renew" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("GitHub credential renewal unavailable.");
  return response.json<{ token: string; issuedAt: number; runToken?: string }>();
}
async function recover(env: Env, id: string, accountId: string, cancel = false) {
  const sb = sandbox(env, `run-${id}`);
  const result = await recoverJob(env.CODEX_VAULT, id, accountId, {
    inspect: async (stopping) => {
      const result = await read<RunResult>(sb, "result");
      const process = await sb.getProcess("codex-run");
      const running = !!process && ["running", "starting"].includes(process.status);
      if (running && !result && !stopping) {
        const credential = await read<{ issuedAt: number }>(sb, "github-token");
        if (!credential || Date.now() - credential.issuedAt > 30 * 60_000) {
          const value = await renewGithub(env, id, accountId);
          await sb.writeFile("/factory/github-token.tmp", JSON.stringify(value));
          await sb.exec("chmod 600 /factory/github-token.tmp && mv /factory/github-token.tmp /factory/github-token.json");
        }
        // Keep refreshed subscription credentials durable during long CI waits.
        await persist(env, accountId, sb, true).catch(() => {});
      }
      return { result, running, progress: await read<RunResult>(sb, "progress") };
    },
    pause: async (result) => {
      await beforeStop(() => persist(env, accountId, sb, true));
      // Destroy first: the subscription must not be released while code can run.
      await sb.destroy();
      const response = await fetch(`${env.FACTORY_URL}/api/codex/github-token`, {
        method: "POST",
        headers: { "x-runner-secret": env.RUNNER_SHARED_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ id, accountId, action: "pause", accountStatus: result?.accountStatus }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Could not release the stopped run's subscription.");
    },
    start: async (request, recovering) => {
      // Mint credentials before destroying anything. Missing grants/auth keep the
      // durable job pending until access is restored; no manual ticket restart.
      const credential = await renewGithub(env, id, accountId, true);
      if (recovering) await sb.destroy();
      await restore(env, accountId, sb);
      await sb.mkdir("/factory", { recursive: true });
      // Credentials stay out of the durable R2 job; only the root-only request file holds them.
      await sb.writeFile("/factory/request.json", JSON.stringify({ ...request, ...runnerSettings(env), githubToken: credential.token, runToken: credential.runToken }));
      await sb.writeFile("/factory/github-token.json", JSON.stringify({ token: credential.token, issuedAt: credential.issuedAt }));
      await installScripts(sb);
      await sb.startProcess("node /opt/factory/bridge.mjs run", { processId: "codex-run", autoCleanup: false });
    },
  }, Date.now(), cancel);
  if (result.status !== 'running') {
    if (result.status === 'succeeded') {
      await persist(env, accountId, sb, true).catch(() => {});
    }
    await env.CODEX_VAULT.put(`results/${id}`, JSON.stringify({ accountId, result }));
    if (result.status === 'succeeded') await sb.destroy();
  }
  return Response.json(result);
}
const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({ ok: true, provider: "codex" });
    if (!(await secretMatches(request.headers.get("x-runner-secret"), env.RUNNER_SHARED_SECRET)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const parts = url.pathname.split("/").filter(Boolean);
    const [resource, id, action] = parts;
    if (!id || !validId(id))
      return Response.json({ error: "Invalid id" }, { status: 400 });
    try {
      if (resource === "accounts") {
        const sb = sandbox(env, `account-${id}`);
        if (request.method === "DELETE") {
          await env.CODEX_VAULT.delete(`accounts/${id}`);
          await sb.destroy();
          return Response.json({ status: "disconnected" });
        }
        if (request.method === "POST" && action === "connect") {
          const data = await body(request);
          await sb.mkdir("/factory", { recursive: true });
          if (data.auth) {
            await storeAuth(env, id, validateAuthFile(data.auth));
            await restore(env, id, sb);
            const state = await metadata(sb);
            if (state.status === "ready" || state.status === "limited")
              await persist(env, id, sb);
            await sb.destroy();
            return Response.json(state);
          }
          const proc = await sb.getProcess("login");
          console.log(
            "Codex login process",
            request.method,
            proc?.id,
            proc?.status,
          );
          if (
            !proc ||
            ["completed", "failed", "killed", "error"].includes(proc.status)
          )
            await sb.startProcess("node /opt/factory/bridge.mjs login", {
              processId: "login",
              autoCleanup: false,
            });
          // Device URL may not be ready on the first request; the UI polls this account.
          return Response.json(
            (await read<AccountStatus>(sb, "account")) ?? {
              status: "connecting",
            },
          );
        }
        if (request.method === "GET") {
          const proc = await sb.getProcess("login");
          console.log(
            "Codex login process",
            request.method,
            proc?.id,
            proc?.status,
          );
          const connected = await read<AccountStatus>(sb, "account");
          if (
            proc &&
            ["running", "starting"].includes(proc.status) &&
            (!connected || connected.status === "connecting")
          )
            return Response.json(connected ?? { status: "connecting" });
          if (connected?.status === "ready" || connected?.status === "limited")
            await persist(env, id, sb);
          const stored = await env.CODEX_VAULT.head(`accounts/${id}`);
          if (!stored) {
            await sb.destroy();
            return Response.json(connected ?? { status: "disconnected" });
          }
          await restore(env, id, sb);
          const state = await metadata(sb);
          if (state.status === "ready" || state.status === "limited")
            await persist(env, id, sb);
          await sb.destroy();
          return Response.json(state);
        }
      }
      if (resource === "runs") {
        const stored = await env.CODEX_VAULT.get(`results/${id}`);
        if (stored) {
          const cached = await stored.json<{
            accountId: string;
            result: RunResult;
          }>();
          if (
            (request.method === "GET" || action === "cancel") &&
            url.searchParams.get("accountId") !== cached.accountId
          )
            return Response.json(
              { error: "Account does not own this run." },
              { status: 403 },
            );
          return Response.json(cached.result);
        }
        const sb = sandbox(env, `run-${id}`);
        if (request.method === "POST" && action === "cancel") {
          const accountId = url.searchParams.get("accountId") ?? "";
          if (!validId(accountId)) throw new Error("Invalid account id.");
          return recover(env, id, accountId, true);
        }
        if (request.method === "GET" && action === "output") {
          // Observation must never restart, stop, or claim a job/subscription.
          const accountId = url.searchParams.get("accountId");
          const saved = await env.CODEX_VAULT.get(`jobs/${id}`);
          if (!saved) return Response.json({ error: "Run unavailable" }, { status: 404 });
          const job = await saved.json<Partial<DurableJob>>();
          if (!accountId || job.accountId !== accountId)
            return Response.json({ error: "Account does not own this run." }, { status: 403 });
          if (job.retryAt && job.retryAt > Date.now())
            return Response.json(job.progress ?? { status: "running", log: "Waiting for automatic recovery." });
          const result = await read<RunResult>(sb, "result");
          if (result) return Response.json(job.request && result.status === "failed"
            ? { ...result, status: "running", log: `${result.log}\nWaiting for automatic recovery.` }
            : result);
          return Response.json(await read<RunResult>(sb, "progress") ?? job.progress ?? {
            status: "running", log: "Waiting for Codex output.",
          });
        }
        if (request.method === "POST") {
          const data = await body(request);
          if (
            !validId(data.accountId) ||
            typeof data.prompt !== "string" ||
            data.prompt.length > 40000 ||
            (data.model && !validModel(data.model)) ||
            (data.mode !== undefined && !["implement", "plan"].includes(data.mode))
          )
            throw new Error("Invalid run request.");
          if (
            !data.probe &&
            (!/^[\w.-]+\/[\w.-]+$/.test(data.repoFullName) ||
              typeof data.defaultBranch !== "string" ||
              data.defaultBranch.startsWith("-") ||
              !/^(?:[\w-]+-)?factory\/[\w-]+$/.test(data.branchName) ||
              typeof data.githubToken !== "string")
          )
            throw new Error("Invalid repository request.");
          if (!data.probe) {
            // Persist only the reproducible request, never a GitHub credential.
            const request: RunRequest = {
              accountId: data.accountId, repoFullName: data.repoFullName,
              defaultBranch: data.defaultBranch, branchName: data.branchName,
              prompt: data.prompt, prTitle: data.prTitle, issueNumber: data.issueNumber,
              model: data.model, mode: data.mode,
            };
            const job: DurableJob = { accountId: data.accountId, request, attempt: 0 };
            await env.CODEX_VAULT.put(`jobs/${id}`, JSON.stringify(job), { onlyIf: { etagDoesNotMatch: "*" } });
            return recover(env, id, data.accountId);
          }
          if (await sb.getProcess("codex-run"))
            return Response.json({ status: "running" });
          await restore(env, data.accountId, sb);
          await sb.mkdir("/factory", { recursive: true });
          await sb.writeFile("/factory/request.json", JSON.stringify({ ...data, ...runnerSettings(env) }));
          await sb.startProcess("node /opt/factory/bridge.mjs run", {
            processId: "codex-run",
            autoCleanup: false,
          });
          await env.CODEX_VAULT.put(
            `jobs/${id}`,
            JSON.stringify({ accountId: data.accountId }),
          );
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (request.method === "GET") {
          const accountId = url.searchParams.get("accountId") ?? "";
          if (!validId(accountId)) throw new Error("Invalid account id.");
          const durable = await env.CODEX_VAULT.get(`jobs/${id}`);
          if (durable) {
            const job = await durable.json<Partial<DurableJob>>();
            if (job.accountId !== accountId) throw new Error("Account does not own this run.");
            if (job.request) return recover(env, id, accountId);
          }
          const req = await read<RunRequest & { probe?: boolean }>(sb, "request");
          if (req && req.accountId !== accountId)
            throw new Error("Account does not own this run.");
          if (req && !req.probe && req.repoFullName) {
            // Adopt pre-upgrade jobs while their request is still available.
            const { accountId: owner, repoFullName, defaultBranch, branchName, prompt, prTitle, issueNumber, model } = req;
            const job: DurableJob = { accountId: owner, attempt: 1,
              request: { accountId: owner, repoFullName, defaultBranch, branchName, prompt, prTitle, issueNumber, model } };
            const adopted = await env.CODEX_VAULT.put(`jobs/${id}`, JSON.stringify(job), {
              onlyIf: durable ? { etagMatches: durable.etag } : { etagDoesNotMatch: "*" },
            });
            if (adopted) return recover(env, id, accountId);
          }
          let result = await read<RunResult>(sb, "result");
          if (!result) {
            const proc = await sb.getProcess("codex-run");
            if (proc && ["running", "starting"].includes(proc.status)) {
              if (req && !req.probe) {
                const credential = await read<{ issuedAt: number }>(sb, "github-token");
                if (!credential || Date.now() - credential.issuedAt > 30 * 60 * 1000) {
                  const renewed = await fetch(`${env.FACTORY_URL}/api/codex/github-token`, {
                    method: "POST",
                    headers: { "x-runner-secret": env.RUNNER_SHARED_SECRET, "Content-Type": "application/json" },
                    body: JSON.stringify({ id, accountId }),
                  });
                  if (renewed.ok) {
                    const value = await renewed.json<{ token: string; issuedAt: number }>();
                    // /factory is root-only; never expose this credential to Codex.
                    await sb.writeFile("/factory/github-token.tmp", JSON.stringify(value));
                    await sb.exec("chmod 600 /factory/github-token.tmp && mv /factory/github-token.tmp /factory/github-token.json");
                  }
                }
              }
              return Response.json((await read<RunResult>(sb, "progress")) ?? { status: "running", log: "Codex is working in the repository…" });
            }
            result = {
              status: "failed",
              log: "Codex sandbox stopped before completing the run. Retry the ticket.",
            };
          }
          if (req) {
            try {
              await persist(env, accountId, sb, true);
            } catch {
              result.accountStatus = {
                status: "error",
                error: "Reconnect this subscription before its next run.",
              };
            }
          }
          await env.CODEX_VAULT.put(
            `results/${id}`,
            JSON.stringify({ accountId, result }),
          );
          await sb.destroy();
          return Response.json(result);
        }
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      console.error(
        "Codex runner operation failed",
        error instanceof Error ? error.name : "Error",
      );
      return Response.json(
        {
          error:
            "Codex runner could not complete this request. Check account connection and runner logs.",
        },
        { status: 500 },
      );
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        let cursor: string | undefined;
        do {
          const jobs = await env.CODEX_VAULT.list({ prefix: "jobs/", limit: 50, cursor });
          cursor = jobs.truncated ? jobs.cursor : undefined;
          for (const job of jobs.objects) {
            try {
              const item = await env.CODEX_VAULT.get(job.key);
              if (!item) continue;
              const { accountId } = await item.json<{ accountId: string }>();
              const id = job.key.slice(5);
              const response = await worker.fetch(
                new Request(`https://runner/runs/${id}?accountId=${accountId}`, {
                  headers: { "x-runner-secret": env.RUNNER_SHARED_SECRET },
                }),
                env,
              );
              if (!response.ok) continue;
              const result = (await response.json()) as RunResult;
              if (result.status === "running") continue;
              const callback = await fetch(
                `${env.FACTORY_URL}/api/codex/complete`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-runner-secret": env.RUNNER_SHARED_SECRET,
                  },
                  body: JSON.stringify({ id, result }),
                },
              );
              if (callback.ok) await env.CODEX_VAULT.delete(job.key);
            } catch {
              console.error(
                "Codex job completion will retry on the next scheduled check.",
              );
            }
          }
        } while (cursor);
      })(),
    );
  },
};
export default worker;
