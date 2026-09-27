import "server-only";
import { getEnv } from "@/lib/env";
export async function runnerRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<T> {
  const env = getEnv();
  if (!env.SANDBOX_RUNNER_URL || !env.SANDBOX_RUNNER_SECRET)
    throw new Error("Codex runner is not connected.");
  const response = await fetch(`${env.SANDBOX_RUNNER_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-runner-secret": env.SANDBOX_RUNNER_SECRET,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(data.error || `Codex runner returned ${response.status}.`);
  return data;
}
