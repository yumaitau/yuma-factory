import "server-only";

import { z } from "zod";

const envSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  // Comma-separated sign-in domains. Empty rejects every account.
  ALLOWED_EMAIL_DOMAINS: z.string().default(""),
  // Extra comma-separated origins trusted by Better Auth, e.g. a workers.dev URL.
  TRUSTED_ORIGINS: z.string().optional(),
  E2E_DISABLE_AUTH_RATE_LIMIT: z.string().optional(),
  // Session-minting endpoint for Playwright/Lightpanda. Separate from the
  // rate-limit flag so disabling rate limiting in prod can never enable it.
  E2E_AUTH_ENABLED: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // GitHub App (ticket intake + PR creation). All-or-nothing: the integration
  // is only enabled when the full group is present (see githubAppCredentials).
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  // Sandbox runner Worker (separate deployment that owns the container + DO).
  SANDBOX_RUNNER_URL: z.string().url().optional(),
  SANDBOX_RUNNER_SECRET: z.string().optional(),
  PAPERBOY_API_URL: z.string().url().optional(),
  PAPERBOY_API_KEY: z.string().optional(),
  PAPERBOY_FROM: z.string().optional(),
  PAPERBOY_DIGEST_TO: z.string().optional(),
  FACTORY_API_KEY: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(): AppEnv {
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";
  const parsed = envSchema.safeParse({
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ??
      (isBuild ? "build-only-placeholder-not-for-runtime-32" : undefined),
    BETTER_AUTH_URL:
      process.env.BETTER_AUTH_URL ??
      (isBuild ? "http://localhost:3000" : undefined),
    ALLOWED_EMAIL_DOMAINS: process.env.ALLOWED_EMAIL_DOMAINS,
    TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS,
    E2E_DISABLE_AUTH_RATE_LIMIT: process.env.E2E_DISABLE_AUTH_RATE_LIMIT,
    E2E_AUTH_ENABLED: process.env.E2E_AUTH_ENABLED,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
    SANDBOX_RUNNER_URL: process.env.SANDBOX_RUNNER_URL,
    SANDBOX_RUNNER_SECRET: process.env.SANDBOX_RUNNER_SECRET,
    PAPERBOY_API_URL: process.env.PAPERBOY_API_URL,
    PAPERBOY_API_KEY: process.env.PAPERBOY_API_KEY,
    PAPERBOY_FROM: process.env.PAPERBOY_FROM,
    PAPERBOY_DIGEST_TO: process.env.PAPERBOY_DIGEST_TO,
    FACTORY_API_KEY: process.env.FACTORY_API_KEY,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

export function allowedEmailDomains(env: AppEnv = getEnv()): string[] {
  return env.ALLOWED_EMAIL_DOMAINS.split(",")
    .map((domain) => domain.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string, env: AppEnv = getEnv()): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return allowedEmailDomains(env).includes(domain);
}

export function googleCredentials(env: AppEnv = getEnv()) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return {
      clientId: "build-google-client-id.apps.googleusercontent.com",
      clientSecret: "build-only-google-client-secret",
    };
  }
  return null;
}

/**
 * GitHub App credentials for ticket intake and PR creation. All-or-nothing:
 * returns null unless the full group is present, so a partial configuration
 * leaves the integration cleanly disabled (the status route reports it).
 */
export function githubAppCredentials(env: AppEnv = getEnv()) {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (appId && privateKey && clientId && clientSecret && slug) {
    return {
      appId,
      // Support both real newlines and \n-escaped PEMs from env/secrets.
      privateKey: privateKey.replace(/\\n/g, "\n"),
      clientId,
      clientSecret,
      slug,
      webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET?.trim() || undefined,
    };
  }
  return null;
}

export function githubConfigured(env: AppEnv = getEnv()): boolean {
  return githubAppCredentials(env) !== null;
}

export function parseEmailList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function paperboyConfig(env: AppEnv = getEnv()) {
  const apiKey = env.PAPERBOY_API_KEY?.trim();
  const apiUrl = env.PAPERBOY_API_URL?.trim();
  const from = env.PAPERBOY_FROM?.trim();
  if (!apiKey || !apiUrl || !from) return null;
  return {
    apiUrl,
    apiKey,
    from,
    digestTo: parseEmailList(env.PAPERBOY_DIGEST_TO),
  };
}

export function appUrl(env: AppEnv = getEnv()): string {
  return env.BETTER_AUTH_URL.replace(/\/$/, '');
}

export function factoryApiKey(env: AppEnv = getEnv()): string | undefined {
  return env.FACTORY_API_KEY?.trim() || undefined;
}
