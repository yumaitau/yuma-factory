export type RateWindow = {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins?: number;
};
export type AccountStatus = {
  status: "connecting" | "ready" | "limited" | "disconnected" | "error";
  email?: string;
  plan?: string;
  accountKey?: string;
  limits?: {
    primary?: RateWindow | null;
    secondary?: RateWindow | null;
  } | null;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
};
export type RunResult = {
  status: "running" | "succeeded" | "failed" | "cancelled";
  retryable?: boolean;
  log: string;
  pullRequestUrl?: string;
  ciHeadSha?: string;
  issueClosed?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  accountStatus?: AccountStatus;
  outputUpdatedAt?: string;
  // Untrusted agent output; lib/memory.ts and lib/plan.ts validate before use.
  notes?: { learnings?: unknown; handoff?: unknown };
  plan?: unknown;
};
/** Legacy implementation-only results must not close issues or mark tickets done. */
export function hasGreenCICompletion(result: RunResult): boolean {
  return result.status === "succeeded" && result.issueClosed === true &&
    typeof result.ciHeadSha === "string" && /^[a-f0-9]{40}$/.test(result.ciHeadSha) &&
    typeof result.pullRequestUrl === "string" && result.pullRequestUrl.startsWith("https://github.com/");
}

/** Only a succeeded run whose GitHub issue was verifiably closed may reach done. */
/** Upper bound on tickets one subscription works at the same time. */
export const MAX_PARALLEL_RUNS = 10;

export function completionStage(status: RunResult["status"], issueClosed: boolean): "done" | "review" | "assigned" | "intake" {
  if (status === "cancelled") return "intake";
  return status === "succeeded" ? (issueClosed ? "done" : "review") : "assigned";
}

export function hasCapacity(
  limits: AccountStatus["limits"],
  now = Date.now() / 1000,
) {
  return ![limits?.primary, limits?.secondary].some(
    (w) => w && w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt > now),
  );
}
export function validateAuthFile(raw: string): string {
  if (raw.length > 32_000) throw new Error("Login file is too large.");
  const value = JSON.parse(raw);
  if (
    value.auth_mode !== "chatgpt" ||
    value.OPENAI_API_KEY ||
    !value.tokens ||
    !["access_token", "refresh_token", "id_token", "account_id"].every(
      (k) => typeof value.tokens[k] === "string" && value.tokens[k].length > 0,
    )
  ) {
    throw new Error(
      "Use a Codex login file from a ChatGPT subscription. API keys are not supported.",
    );
  }
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: value.tokens,
    last_refresh: value.last_refresh,
  });
}
/** Agent CLIs a subscription can drive. Workers AI runs Codex against Cloudflare-hosted models. */
export const PROVIDERS = ["codex", "claude", "workersai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_NAMES: Record<Provider, string> = { codex: "Codex", claude: "Claude", workersai: "Workers AI" };
/** Affordable Workers AI model that still handles agentic coding and tool calls well. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.3-flash";
export function validWorkersAiModel(model: string) {
  return /^@cf\/[a-z0-9._-]{1,60}\/[a-z0-9._-]{1,80}$/.test(model);
}
/** Workers AI needs no per-account secret; the runner holds one scoped Cloudflare token. */
export const WORKERS_AI_LOGIN = JSON.stringify({ auth_mode: "workers_ai" });
export function isWorkersAiLogin(raw: string) {
  try {
    return JSON.parse(raw).auth_mode === "workers_ai";
  } catch {
    return false;
  }
}
export function isProvider(value: unknown): value is Provider {
  return PROVIDERS.includes(value as Provider);
}
/** A long-lived Claude subscription token from `claude setup-token`; API keys are refused. */
export function validateClaudeToken(raw: string): string {
  const token = raw.trim();
  if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/.test(token))
    throw new Error(
      "Paste a token from `claude setup-token` on a Claude subscription. API keys are not supported.",
    );
  return JSON.stringify({ auth_mode: "claude_oauth", token });
}
export function isClaudeLogin(raw: string) {
  try {
    return JSON.parse(raw).auth_mode === "claude_oauth";
  } catch {
    return false;
  }
}
/** Validate either stored login kind before it enters the vault. */
export function validateStoredLogin(raw: string): string {
  if (isWorkersAiLogin(raw)) return WORKERS_AI_LOGIN;
  return isClaudeLogin(raw)
    ? validateClaudeToken(String(JSON.parse(raw).token ?? ""))
    : validateAuthFile(raw);
}
export function validId(id: string) {
  return /^[a-z]+_[a-f0-9]{32}$/.test(id);
}
export function validModel(model: string) {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model) && !model.startsWith("au.")
  );
}
