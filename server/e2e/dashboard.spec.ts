import { test, expect } from "@playwright/test";

/**
 * Wait for the initial data loading to complete.
 * The Svelte app shows "Loading..." until API fetches finish,
 * then renders the 3 panels (session-cards, active-sessions, recent-prompts).
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

  test("renders all 3 panels", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const sessionCards = page.locator('[data-testid="session-cards"]');
    const activeSessions = page.locator('[data-testid="active-sessions"]');
    const recentPrompts = page.locator('[data-testid="recent-prompts"]');

    await expect(sessionCards).toBeVisible({ timeout: 10_000 });
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

    // Wait for panels to be in the DOM
    await page.locator('[data-testid="session-cards"]').waitFor({ state: "visible", timeout: 10_000 });

    await page.screenshot({
      path: "test-results/dashboard-screenshot.png",
      fullPage: true,
    });
  });
});
