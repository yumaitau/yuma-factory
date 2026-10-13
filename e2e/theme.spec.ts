import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./journeys";
import { cleanupUser, uniqueEmail } from "./support";

const colorScheme = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);

test("light, dark and system each survive a reload", async ({ page, request }) => {
  const email = uniqueEmail("theme");
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await seedSession(page, email);
    const html = page.locator("html");
    const theme = page.getByRole("group", { name: "Theme" });

    // System is the default, and follows the operating system.
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    await expect(html).not.toHaveAttribute("data-theme");
    expect(await colorScheme(page)).toBe("dark");

    for (const [choice, scheme] of [["Light", "light"], ["Dark", "dark"]] as const) {
      await theme.getByRole("radio", { name: choice }).check();
      await expect(html).toHaveAttribute("data-theme", scheme);
      await page.reload();
      await expect(html).toHaveAttribute("data-theme", scheme);
      await expect(theme.getByRole("radio", { name: choice })).toBeChecked();
      expect(await colorScheme(page)).toBe(scheme);
    }

    await theme.getByRole("radio", { name: "System" }).check();
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(html).not.toHaveAttribute("data-theme");
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    expect(await colorScheme(page)).toBe("light");
  } finally {
    await cleanupUser(email, request);
  }
});

test("sign-in follows the stored theme", async ({ page }) => {
  await page.goto("/sign-in");
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("img", { name: "Factory" })).toHaveAttribute("src", /logo-dark/);
});
