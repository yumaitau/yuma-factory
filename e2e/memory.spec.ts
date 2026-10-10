import { expect, test } from "@playwright/test";
import { seedSession } from "./journeys";
import { cleanupUser, uniqueEmail } from "./support";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

function localDatabase(email: string) {
  const root = ".wrangler/state/v3/d1";
  for (const file of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith(".sqlite"))) {
    const db = new DatabaseSync(path.join(root, String(file)));
    try {
      const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (user) { db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"); return { db, userId: String(user.id) }; }
    } catch { /* Other local databases are not Factory. */ }
    db.close();
  }
  throw new Error("Local Factory fixture database not found");
}

test("team memory can be taught, edited, pinned, archived, restored and reverted, and projects review and test it", async ({ page, request, baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Local fixtures only");
  test.setTimeout(90_000);
  const email = uniqueEmail("memory");
  const stamp = `${Date.now()}`;
  const content = `E2E memory ${stamp}: run migrations before integration tests.`;
  const edited = `E2E memory ${stamp}: run pnpm d1:migrate:local before integration tests.`;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const inst = `inst_${suffix}`, proj = `proj_${suffix}`, repo = `fixture/memory-${suffix.slice(0, 8)}`;
  let fixture: ReturnType<typeof localDatabase> | undefined;
  try {
    await seedSession(page, email);
    await page.getByRole("link", { name: "Memory" }).click();
    await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();

    // A new memory says where it applies before it is saved.
    await page.getByRole("button", { name: "Add memory" }).click();
    const form = page.getByRole("form", { name: "Add memory" });
    await expect(form.getByText("Applies to: All projects")).toBeVisible();
    await form.getByLabel("Memory", { exact: true }).fill(content);
    await form.getByRole("button", { name: "Save memory" }).click();
    await expect(form).toHaveCount(0);
    const row = page.getByRole("article").filter({ hasText: `E2E memory ${stamp}` });
    await expect(row.getByText(content, { exact: true })).toBeVisible();
    await expect(row.getByText("All projects", { exact: true })).toBeVisible();
    await expect(row.getByText("Included when relevant", { exact: true })).toBeVisible();
    await expect(row.getByText("Not used in a run yet", { exact: true })).toBeVisible();
    await expect(row.getByLabel("Memory content")).toHaveCount(0);

    // Editing is on demand.
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await row.getByLabel("Memory content").fill(edited);
    await row.getByLabel("Priority (0–100)").fill("75");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.getByText(edited, { exact: true })).toBeVisible();
    await expect(row.getByText("Priority 75/100", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Pin", exact: true }).click();
    await expect(row.getByText("Always included", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole("link", { name: /^Archived/ }).click();
    await expect(row.getByText("Not used", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole("link", { name: /^Active/ }).click();

    // Reverting the content edit puts the original text back.
    await row.getByText(/^History/).click();
    await row.getByRole("listitem").filter({ hasText: "content:" }).getByRole("button", { name: "Revert" }).click();
    await expect(row.getByText(content, { exact: true })).toBeVisible();

    // A project shows its own memories, the shared ones it inherits, and a review queue.
    fixture = localDatabase(email);
    const { db, userId } = fixture;
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(inst, now + 500, "fixture", "Organization", userId, now, now);
    db.prepare("INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(proj, inst, repo, now + 500, now, now);
    const suggest = db.prepare("INSERT INTO memories (id, project_id, scope_key, content_key, kind, content, status, source, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'suggested', 'agent', 20, ?, ?)");
    suggest.run(`mem_a${suffix}`, proj, proj, `accept ${suffix}`, "gotcha", `Learning to accept ${suffix}: checkout totals live in lib/pricing.ts.`, now, now);
    suggest.run(`mem_d${suffix}`, proj, proj, `dismiss ${suffix}`, "note", `Learning to dismiss ${suffix}: this one is wrong.`, now, now);

    await page.reload();
    await page.getByRole("button", { name: /^Scope/ }).click();
    await page.getByLabel("Find a project").fill(repo);
    await page.getByRole("dialog", { name: "Choose scope" }).getByRole("link", { name: new RegExp(repo) }).click();
    await expect(page).toHaveURL(new RegExp(`project=${proj}`));
    const shared = page.getByRole("region", { name: /^From all projects/ });
    await expect(shared.getByRole("article").filter({ hasText: content }).getByRole("link", { name: "Edit in All projects" })).toBeVisible();

    const review = page.getByRole("link", { name: /^Needs review/ });
    await expect(review).toContainText("2");
    await review.click();
    const queue = page.getByRole("region", { name: /^Waiting for your review/ });
    await queue.getByRole("article").filter({ hasText: `Learning to accept ${suffix}` }).getByRole("button", { name: "Accept" }).click();
    await queue.getByRole("article").filter({ hasText: `Learning to dismiss ${suffix}` }).getByRole("button", { name: "Dismiss" }).click();
    await expect(queue.getByRole("article")).toHaveCount(0);
    await page.getByRole("link", { name: /^Active/ }).click();
    const own = page.getByRole("region", { name: /^This project/ });
    await expect(own.getByRole("article").filter({ hasText: `Learning to accept ${suffix}` }).getByText("Included by default", { exact: true })).toBeVisible();

    await page.getByText("Test a ticket", { exact: true }).click();
    await page.getByLabel("Ticket title or description").fill("Fix checkout totals in pricing");
    await page.getByRole("button", { name: "Test ticket" }).click();
    await expect(page.getByRole("list", { name: "Memories for this ticket" })).toContainText(`Learning to accept ${suffix}`);
    await expect(page.getByRole("list", { name: "Memories for this ticket" })).not.toContainText(`Learning to dismiss ${suffix}`);

    await page.getByText("Project settings", { exact: true }).click();
    await page.getByLabel("Memory budget per run (characters)").fill("4500");
    await page.getByLabel(/Use agent learnings right away/).uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect.poll(() => ({ ...db.prepare("SELECT memory_budget, auto_learn FROM projects WHERE id = ?").get(proj) }))
      .toEqual({ memory_budget: 4500, auto_learn: 0 });
    await page.reload();
    await expect(page.getByText(/of 4,500 characters/)).toBeVisible();
  } finally {
    try { fixture ??= localDatabase(email); } catch { /* The session never reached the database. */ }
    if (fixture) {
      fixture.db.prepare("DELETE FROM memories WHERE content LIKE ?").run(`E2E memory ${stamp}%`);
      fixture.db.prepare("DELETE FROM projects WHERE id = ?").run(proj);
      fixture.db.prepare("DELETE FROM github_installations WHERE id = ?").run(inst);
      fixture.db.close();
    }
    await cleanupUser(email, request);
  }
});
