import { expect, type Page } from "@playwright/test";

export const journeyCatalogue = [
  { name: "create session", engines: ["chromium", "lightpanda"] },
  { name: "reject disallowed email", engines: ["chromium", "lightpanda"] },
  {
    name: "offer Google Workspace sign-in",
    engines: ["chromium", "lightpanda"],
  },
  { name: "connect Codex subscriptions", engines: ["chromium"] },
] as const;

export async function seedSession(page: Page, email: string) {
  const response = await page.request.post("/api/auth/e2e/session", {
    data: { email, name: "Journey User" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

export async function rejectForeignEmail(page: Page) {
  await page.goto("/sign-in");
  await expect(
    page.getByRole("button", { name: "Sign in with Google Workspace" }),
  ).toBeVisible();
  await expect(page.locator("#email")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create an account" }),
  ).toHaveCount(0);
  const signup = await page.request.post("/api/auth/sign-up/email", {
    data: {
      name: "External User",
      email: `external-${Date.now()}@example.test`,
      password: "JourneyPass!2026",
    },
  });
  expect(signup.ok()).toBeFalsy();
  const seeded = await page.request.post("/api/auth/e2e/session", {
    data: {
      name: "External User",
      email: `external-${Date.now()}@example.test`,
    },
  });
  expect(seeded.ok()).toBeFalsy();
}

export async function offerGoogleWorkspace(page: Page) {
  await page.goto("/sign-in");
  await expect(
    page.getByRole("heading", { name: "Factory" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Google Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with a passkey" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
}

export async function runPortableJourneys(page: Page, email: string) {
  await seedSession(page, email);
  await page.getByRole("link", { name: "Codex subscriptions" }).click();
  await expect(
    page.getByRole("heading", { name: "Codex subscriptions", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No subscriptions connected yet.")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Allow team members to assign work" }),
  ).not.toBeChecked();
  await page
    .getByText("Already signed in to Codex on another machine?")
    .click();
  await page.getByLabel("Account name").fill("Invalid API-key login");
  await page
    .getByLabel("Codex login file (optional)")
    .setInputFiles({
      name: "auth.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          auth_mode: "apikey",
          OPENAI_API_KEY: "test-only-invalid-key",
        }),
      ),
    });
  await page
    .getByRole("button", { name: "Connect Codex", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "API keys are not supported" }),
  ).toBeVisible();
  await expect(page.getByText("No subscriptions connected yet.")).toBeVisible();
}
