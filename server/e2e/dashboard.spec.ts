import { test, expect } from "@playwright/test";

/**
 * Wait for the initial data loading to complete.
 * The Svelte app shows "Loading..." until API fetches finish,
 * then renders the overview panels (active-sessions, recent-prompts).
 */
async function waitForDashboardReady(page: import("@playwright/test").Page) {
  // Wait until the loading indicator disappears (API fetches completed)
  await page.waitForFunction(
    () => !document.querySelector(".loading"),
    { timeout: 15_000 },
  );
}

test.describe("Dashboard Page", () => {
  test("loads and title contains Session Dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Session Dashboard/);
  });

  test("renders overview panels", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const activeSessions = page.locator('[data-testid="active-sessions"]');
    const recentPrompts = page.locator('[data-testid="recent-prompts"]');

    await expect(activeSessions).toBeVisible({ timeout: 10_000 });
    await expect(recentPrompts).toBeVisible({ timeout: 10_000 });
  });

  test("connection status indicator exists", async ({ page }) => {
    await page.goto("/");

    const statusIndicator = page.locator(".connection-status, [data-testid='connection-status']");
    await expect(statusIndicator).toBeVisible({ timeout: 10_000 });
  });

  test("capture dashboard screenshot", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    await page.screenshot({
      path: "test-results/dashboard-screenshot.png",
      fullPage: true,
    });
  });
});
