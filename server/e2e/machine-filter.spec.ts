import { test, expect } from "@playwright/test";

async function waitForDashboardReady(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => !document.querySelector(".loading"),
    { timeout: 15_000 },
  );
}

test.describe("Machine Filter UI", () => {
  test("machine selector is hidden with single machine", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    // When only one machine is configured, the filter should be hidden
    const selector = page.locator('[data-testid="machine-selector"]');
    // If the machine list has only 1 entry (or 0), selector should not be visible
    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    if (machines.length <= 1) {
      await expect(selector).not.toBeVisible();
    } else {
      await expect(selector).toBeVisible();
    }
  });

  test("machine selector shows all buttons when multiple machines", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    if (machines.length > 1) {
      const selector = page.locator('[data-testid="machine-selector"]');
      await expect(selector).toBeVisible({ timeout: 5000 });

      // "전체" button should exist
      const allBtn = selector.locator("button", { hasText: "전체" });
      await expect(allBtn).toBeVisible();

      // Each machine should have a filter button
      for (const machine of machines) {
        const btn = page.locator(`[data-testid="machine-filter-${machine.id}"]`);
        await expect(btn).toBeVisible();
      }
    }
  });

  test("clicking machine filter button sets active state", async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);

    const machines = await page.evaluate(async () => {
      const res = await fetch("/api/machines");
      const body = await res.json();
      return body.machines;
    });

    if (machines.length > 1) {
      const firstMachineBtn = page.locator(`[data-testid="machine-filter-${machines[0].id}"]`);
      await firstMachineBtn.click();
      await expect(firstMachineBtn).toHaveClass(/active/);
    }
  });
});
