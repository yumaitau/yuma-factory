import { expect, test } from "@playwright/test";
import { seedSession } from "./journeys";
import { cleanupUser, uniqueEmail } from "./support";
test("Factory navigation and protected subscription API", async ({
  page,
  request,
}) => {
  const unauthenticated = await request.get("/api/codex/status");
  expect(unauthenticated.status()).toBe(401);
  const email = uniqueEmail("navigation");
  try {
    await seedSession(page, email);
    await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Connect a subscription" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Account name")).toBeVisible();
  } finally {
    await cleanupUser(email, request);
  }
});
