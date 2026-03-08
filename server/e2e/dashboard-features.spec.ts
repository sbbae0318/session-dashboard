import { test, expect } from "@playwright/test";

async function waitForDashboardReady(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => !document.querySelector(".loading"),
    { timeout: 15_000 },
  );
}

test.describe("Feature: Prompt Click Filtering", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);
    const count = await page.locator(".prompt-item").count();
    if (count === 0) test.skip();
  });

  test("clicking a prompt filters by session", async ({ page }) => {
    const beforeCount = await page.locator(".prompt-item").count();
    await page.locator(".prompt-item").first().click();
    await page.waitForTimeout(500);
    const afterCount = await page.locator(".prompt-item").count();
    expect(afterCount).toBeLessThan(beforeCount);
  });

  test("clicking same prompt again clears the filter", async ({ page }) => {
    const beforeCount = await page.locator(".prompt-item").count();
    await page.locator(".prompt-item").first().click();
    await page.waitForTimeout(400);
    await page.locator(".prompt-item").first().click();
    await page.waitForTimeout(400);
    const afterClearCount = await page.locator(".prompt-item").count();
    expect(afterClearCount).toBe(beforeCount);
  });

  test("filtered prompts all belong to the same session", async ({ page }) => {
    await page.locator(".prompt-item").first().click();
    await page.waitForTimeout(500);

    const filteredCount = await page.locator(".prompt-item").count();
    expect(filteredCount).toBeGreaterThanOrEqual(1);

    const sessionTitles = await page.locator(".prompt-item .prompt-session").allTextContents();
    if (sessionTitles.length > 1) {
      const firstTitle = sessionTitles[0];
      for (const title of sessionTitles) {
        expect(title).toBe(firstTitle);
      }
    }
  });
});

test.describe("Feature: Prompt Detail Modal (전문 버튼)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);
    const count = await page.locator(".prompt-detail-btn").count();
    if (count === 0) test.skip();
  });

  test("전문 button opens the detail modal", async ({ page }) => {
    await expect(page.locator(".modal-backdrop")).not.toBeVisible();
    await page.locator(".prompt-detail-btn").first().click();
    await expect(page.locator(".modal-backdrop")).toBeVisible({ timeout: 3000 });
  });

  test("전문 button does not trigger session filtering", async ({ page }) => {
    const beforeCount = await page.locator(".prompt-item").count();
    await page.locator(".prompt-detail-btn").first().click();
    await page.waitForTimeout(400);
    const afterCount = await page.locator(".prompt-item").count();
    expect(afterCount).toBe(beforeCount);
    await page.keyboard.press("Escape");
  });

  test("ESC key closes the modal", async ({ page }) => {
    await page.locator(".prompt-detail-btn").first().click();
    await expect(page.locator(".modal-backdrop")).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-backdrop")).not.toBeVisible({ timeout: 3000 });
  });

  test("clicking backdrop closes the modal", async ({ page }) => {
    await page.locator(".prompt-detail-btn").first().click();
    await expect(page.locator(".modal-backdrop")).toBeVisible({ timeout: 3000 });
    await page.locator(".modal-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".modal-backdrop")).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("Feature: Background Prompt Toggle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);
  });

  test("bg toggle button is visible and shows count", async ({ page }) => {
    const bgBtn = page.locator("button", { hasText: /bg 포함 \(\d+\)/ });
    const isVisible = await bgBtn.isVisible();
    if (!isVisible) {
      test.skip();
      return;
    }
    await expect(bgBtn).toBeVisible({ timeout: 5000 });
  });

  test("toggling shows background prompts", async ({ page }) => {
    const bgBtn = page.locator("button", { hasText: /bg 포함 \(\d+\)/ });
    const isVisible = await bgBtn.isVisible();
    if (!isVisible) {
      test.skip();
      return;
    }
    const bgCountText = await bgBtn.textContent();
    const bgCount = parseInt(bgCountText?.match(/\d+/)?.[0] ?? "0");
    if (bgCount === 0) {
      test.skip();
      return;
    }
    const beforeCount = await page.locator(".prompt-item").count();
    await bgBtn.click();
    await page.waitForTimeout(400);
    const afterCount = await page.locator(".prompt-item").count();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test("toggling back hides background prompts", async ({ page }) => {
    const bgBtn = page.locator("button", { hasText: /bg 포함 \(\d+\)/ });
    const isVisible = await bgBtn.isVisible();
    if (!isVisible) {
      test.skip();
      return;
    }
    const bgCountText = await bgBtn.textContent();
    const bgCount = parseInt(bgCountText?.match(/\d+/)?.[0] ?? "0");
    if (bgCount === 0) {
      test.skip();
      return;
    }
    const beforeCount = await page.locator(".prompt-item").count();
    await bgBtn.click();
    await page.waitForTimeout(300);
    await page.locator("button", { hasText: /bg 숨김/ }).click();
    await page.waitForTimeout(400);
    const afterCount = await page.locator(".prompt-item").count();
    expect(afterCount).toBe(beforeCount);
  });
});

test.describe("Feature: Session Command Copy", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForDashboardReady(page);
    const count = await page.locator(".session-item").count();
    if (count === 0) test.skip();
  });

  test("clicking a session card copies command to clipboard and shows toast", async ({ page }) => {
    await page.locator(".session-item").first().click();
    await page.waitForTimeout(500);
    const toast = page.locator(".copy-toast");
    await expect(toast).toBeVisible({ timeout: 3000 });
  });

  test("toast disappears after a short time", async ({ page }) => {
    await page.locator(".session-item").first().click();
    const toast = page.locator(".copy-toast");
    await expect(toast).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(2200);
    await expect(toast).not.toBeVisible();
  });
});
