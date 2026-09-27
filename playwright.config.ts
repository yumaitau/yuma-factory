import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: process.env.CI
          ? "pnpm d1:migrate:local && pnpm build && pnpm start --port 3010"
          : "pnpm d1:migrate:local && pnpm dev --port 3010",
        env: {
          ...process.env,
          PORT: "3010",
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET ??
            "e2e-only-secret-32-bytes-minimum!!",
          BETTER_AUTH_URL: baseURL,
          E2E_DISABLE_AUTH_RATE_LIMIT: "1",
          E2E_AUTH_ENABLED: "1",
          SANDBOX_RUNNER_URL: process.env.SANDBOX_RUNNER_URL ?? "http://127.0.0.1:3011",
          SANDBOX_RUNNER_SECRET: process.env.SANDBOX_RUNNER_SECRET ?? "e2e-only-runner-secret",
          ALLOWED_EMAIL_DOMAINS: "example.com",
          GOOGLE_CLIENT_ID:
            process.env.GOOGLE_CLIENT_ID ??
            "e2e-google-client-id.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET:
            process.env.GOOGLE_CLIENT_SECRET ?? "e2e-google-client-secret",
        },
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: process.env.CI ? 300_000 : 120_000,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
