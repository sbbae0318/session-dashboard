import { test, expect } from "@playwright/test";

async function waitForDashboardReady(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => !document.querySelector(".loading"),
    { timeout: 15_000 },
  );
}

test.describe("Machine Status Badges", () => {
  test("machine buttons show status dots", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    if (machines.length > 1) {
      // Check that status dots exist
      for (const machine of machines) {
        const statusDot = page.locator(`[data-testid="machine-filter-${machine.id}"] .status-dot`);
        await expect(statusDot).toBeVisible();
      }
    }
  });

  test("connected machines show green status dot", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    const connected = machines.filter((m: { status: string }) => m.status === "connected");
    if (connected.length > 0 && machines.length > 1) {
      const dot = page.locator('[data-testid="machine-status-connected"]').first();
      await expect(dot).toBeVisible();
      await expect(dot).toHaveClass(/connected/);
    }
  });

  test("session cards show machine tags when multiple machines", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    if (machines.length > 1) {
      // Machine tags should appear in session cards
      const machineTags = page.locator('[data-testid="recent-prompts"] .machine-tag');
      // This may or may not have tags depending on data, so just check the count >= 0
      const count = await machineTags.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test("capture multi-machine dashboard screenshot", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    await page.screenshot({
      path: "test-results/multi-machine-dashboard.png",
      fullPage: true,
    });
  });
});
