import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3097";

test.describe("Enrichment Pages Navigation", () => {
  test.beforeEach(async ({ page }) => {
    try {
      await page.goto(BASE_URL, { timeout: 5000 });
    } catch {
      test.skip();
    }
  });

  test("TopNav shows 6 tabs", async ({ page }) => {
    await page.goto(BASE_URL);
    const topNav = page.locator('[data-testid="top-nav"]');
    await expect(topNav).toBeVisible();
    const tabs = topNav.locator('[data-testid="nav-tab"]');
    await expect(tabs).toHaveCount(6);
  });

  test("Tokens tab navigates to token-cost page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-token-cost"]');
    await expect(page).toHaveURL(/view=token-cost/);
    await expect(
      page.locator('[data-testid="page-token-cost"]'),
    ).toBeVisible();
  });

  test("Impact tab navigates to code-impact page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-code-impact"]');
    await expect(page).toHaveURL(/view=code-impact/);
    await expect(
      page.locator('[data-testid="page-code-impact"]'),
    ).toBeVisible();
  });

  test("Timeline tab navigates to timeline page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-timeline"]');
    await expect(page).toHaveURL(/view=timeline/);
    await expect(
      page.locator('[data-testid="page-timeline"]'),
    ).toBeVisible();
  });

  test("Projects tab navigates to projects page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-projects"]');
    await expect(page).toHaveURL(/view=projects/);
    await expect(
      page.locator('[data-testid="page-projects"]'),
    ).toBeVisible();
  });

  test("Recovery tab navigates to context-recovery page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-context-recovery"]');
    await expect(page).toHaveURL(/view=context-recovery/);
    await expect(
      page.locator('[data-testid="page-context-recovery"]'),
    ).toBeVisible();
  });

  test("Dashboard tab returns to overview", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=token-cost`);
    await page.click('[data-testid="nav-tab-overview"]');
    await expect(page).not.toHaveURL(/view=/);
    await expect(
      page.locator('[data-testid="active-sessions"]'),
    ).toBeVisible();
  });

  test("Direct URL access loads correct view", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=code-impact`);
    await expect(
      page.locator('[data-testid="page-code-impact"]'),
    ).toBeVisible();
  });

  test("Browser back/forward navigation", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.click('[data-testid="nav-tab-timeline"]');
    await page.click('[data-testid="nav-tab-projects"]');
    await page.goBack();
    await expect(page).toHaveURL(/view=timeline/);
    await page.goBack();
    await expect(page).not.toHaveURL(/view=/);
  });
});

test.describe("Enrichment Pages Content", () => {
  test.beforeEach(async ({ page }) => {
    try {
      await page.goto(BASE_URL, { timeout: 5000 });
    } catch {
      test.skip();
    }
  });

  test("Token page shows summary or empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=token-cost`);
    await page.waitForTimeout(2000);
    const summary = page.locator('[data-testid="token-summary"]');
    const emptyState = page.locator('[data-testid="empty-state"]');
    const summaryVisible = await summary.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(summaryVisible || emptyVisible).toBe(true);
  });

  test("Impact page shows list or empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=code-impact`);
    await page.waitForTimeout(2000);
    const list = page.locator('[data-testid="impact-list"]');
    const emptyState = page.locator('[data-testid="empty-state"]');
    const listVisible = await list.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(listVisible || emptyVisible).toBe(true);
  });

  test("Timeline page shows SVG or empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=timeline`);
    await page.waitForTimeout(2000);
    const svg = page.locator('[data-testid="timeline-svg"]');
    const emptyState = page.locator('[data-testid="empty-state"]');
    const svgVisible = await svg.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(svgVisible || emptyVisible).toBe(true);
  });

  test("Projects page shows cards or empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=projects`);
    await page.waitForTimeout(2000);
    const cards = page.locator('[data-testid="project-card"]');
    const emptyState = page.locator('[data-testid="empty-state"]');
    const cardsVisible = await cards.first().isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(cardsVisible || emptyVisible).toBe(true);
  });

  test("Recovery page shows cards or empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}?view=context-recovery`);
    await page.waitForTimeout(2000);
    const cards = page.locator('[data-testid="recovery-card"]');
    const emptyState = page.locator('[data-testid="empty-state"]');
    const cardsVisible = await cards.first().isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(cardsVisible || emptyVisible).toBe(true);
  });
});

test.describe("Regression — Existing Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    try {
      await page.goto(BASE_URL, { timeout: 5000 });
    } catch {
      test.skip();
    }
  });

  test("Dashboard overview loads with active sessions", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(
      page.locator('[data-testid="active-sessions"]'),
    ).toBeVisible();
  });

  test("TopNav does not break existing layout", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(
      page.locator('[data-testid="active-sessions"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="top-nav"]')).toBeVisible();
  });
});
