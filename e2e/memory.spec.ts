import { expect, test } from "@playwright/test";
import { seedSession } from "./journeys";
import { cleanupUser, uniqueEmail } from "./support";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

function deleteMemory(content: string) {
  const root = ".wrangler/state/v3/d1";
  for (const file of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith(".sqlite"))) {
    const db = new DatabaseSync(path.join(root, String(file)));
    try { db.prepare("DELETE FROM memories WHERE content = ?").run(content); } catch { /* Other local databases are not Factory. */ }
    db.close();
  }
}

test("team memory can be taught, tuned, archived and reverted", async ({ page, request }) => {
  const email = uniqueEmail("memory");
  const content = `E2E memory ${Date.now()}: run migrations before integration tests.`;
  try {
    await seedSession(page, email);
    await page.getByRole("link", { name: "Memory" }).click();
    await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
    await page.getByLabel("Memory", { exact: true }).fill(content);
    await page.getByRole("button", { name: "Add memory" }).click();
    const card = page.getByRole("article").filter({ has: page.locator(`textarea:text-is("${content}")`) });
    await expect(card.getByLabel("Memory content")).toHaveValue(content);
    await card.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByLabel("Memory content").filter({ hasText: content })).toHaveCount(0);
    await page.getByRole("link", { name: "Archived" }).click();
    const archived = page.getByRole("article").filter({ has: page.locator(`textarea:text-is("${content}")`) });
    await archived.getByText(/^History/).click();
    await archived.getByRole("button", { name: "Revert" }).first().click();
    await page.getByRole("link", { name: "Active" }).click();
    await expect(page.locator(`textarea:text-is("${content}")`)).toHaveCount(1);
    await page.getByRole("link", { name: "Plans" }).click();
    await expect(page.getByRole("heading", { name: "Plans", exact: true })).toBeVisible();
  } finally {
    deleteMemory(content);
    await cleanupUser(email, request);
  }
});
