/**
 * Dashboard UI E2E Tests
 *
 * 프론트엔드가 api-contract.ts 계약에 따라 데이터를 올바르게 렌더링하는지 검증.
 * DisplayStatus 규칙, 필터 동작, 네비게이션을 테스트합니다.
 */

import { test, expect, type Page } from '@playwright/test';

// =============================================================================
// Helpers
// =============================================================================

async function waitForDashboardReady(page: Page) {
  await page.waitForFunction(
    () => !document.querySelector('.loading'),
    { timeout: 15_000 },
  );
}

/** SSE 연결 상태 확인 */
async function isSSEConnected(page: Page): Promise<boolean> {
  return page.locator('.connection-status.connected').isVisible({ timeout: 5_000 });
}

// =============================================================================
// 페이지 로드 + 기본 구조
// =============================================================================

test.describe('Dashboard Smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('페이지 title이 "Session Dashboard"', async ({ page }) => {
    await expect(page).toHaveTitle('Session Dashboard');
  });

  test('SSE 연결 표시 (● Connected)', async ({ page }) => {
    await expect(page.locator('.connection-status.connected')).toBeVisible({ timeout: 10_000 });
  });

  test('Sessions 패널 존재', async ({ page }) => {
    await expect(page.locator('[data-testid="active-sessions"]')).toBeVisible();
  });

  test('Prompt History 패널 존재', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'Prompt History' })).toBeVisible();
  });

  test('TopNav 탭 모두 존재', async ({ page }) => {
    const tabs = ['Dashboard', 'Tokens', 'Impact', 'Timeline', 'Projects', 'Recovery', 'Memos'];
    for (const tab of tabs) {
      await expect(page.locator('nav button', { hasText: tab })).toBeVisible();
    }
  });

  test('커맨드 팔레트 힌트 표시', async ({ page }) => {
    await expect(page.locator('.palette-hint')).toBeVisible();
  });
});

// =============================================================================
// Source Filter (All / OpenCode / Claude)
// =============================================================================

test.describe('Source Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('기본 선택은 "All"', async ({ page }) => {
    const allBtn = page.locator('.source-filter .source-filter-btn', { hasText: 'All' });
    await expect(allBtn).toHaveClass(/active/);
  });

  test('OpenCode 필터 클릭 시 active 변경', async ({ page }) => {
    const ocBtn = page.locator('.source-filter .source-filter-btn', { hasText: 'OpenCode' });
    await ocBtn.click();
    await expect(ocBtn).toHaveClass(/active/);
  });

  test('Claude 필터 클릭 시 active 변경', async ({ page }) => {
    const claudeBtn = page.locator('.source-filter .source-filter-btn', { hasText: 'Claude' });
    await claudeBtn.click();
    await expect(claudeBtn).toHaveClass(/active/);
  });

  test('Source 필터 전환 시 세션 목록이 필터링됨', async ({ page }) => {
    // Claude 필터
    await page.locator('.source-filter .source-filter-btn', { hasText: 'Claude' }).click();
    const sessions = page.locator('[data-testid="active-sessions"] .session-item');
    const count = await sessions.count();

    if (count > 0) {
      // 모든 표시된 세션에 "Claude" 소스 텍스트가 있어야 함
      for (let i = 0; i < count; i++) {
        await expect(sessions.nth(i).locator('.source-text.claude')).toBeVisible();
      }
    }
  });
});

// =============================================================================
// Time Range Filter
// =============================================================================

test.describe('Time Range Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('시간 필터 버튼 그룹 존재', async ({ page }) => {
    const timeFilter = page.locator('.time-filter');
    await expect(timeFilter).toBeVisible();
  });

  test('기본 선택은 "1d"', async ({ page }) => {
    const btn1d = page.locator('.time-filter .source-filter-btn', { hasText: '1d' });
    await expect(btn1d).toHaveClass(/active/);
  });

  test('시간 필터 옵션: 1h, 6h, 1d, 7d, All', async ({ page }) => {
    const options = ['1h', '6h', '1d', '7d', 'All'];
    for (const opt of options) {
      await expect(page.locator('.time-filter .source-filter-btn', { hasText: opt })).toBeVisible();
    }
  });

  test('7d 클릭 시 더 많은 세션 표시 (또는 동일)', async ({ page }) => {
    // 1d 기본 상태에서 세션 수 기록
    const sessions1d = await page.locator('[data-testid="active-sessions"] .session-item').count();

    // 7d로 변경
    await page.locator('.time-filter .source-filter-btn', { hasText: '7d' }).click();
    await page.waitForTimeout(500);
    const sessions7d = await page.locator('[data-testid="active-sessions"] .session-item').count();

    expect(sessions7d).toBeGreaterThanOrEqual(sessions1d);
  });

  test('1h 클릭 시 더 적은 세션 표시 (또는 동일)', async ({ page }) => {
    const sessions1d = await page.locator('[data-testid="active-sessions"] .session-item').count();

    await page.locator('.time-filter .source-filter-btn', { hasText: '1h' }).click();
    await page.waitForTimeout(500);
    const sessions1h = await page.locator('[data-testid="active-sessions"] .session-item').count();

    expect(sessions1h).toBeLessThanOrEqual(sessions1d);
  });
});

// =============================================================================
// Machine Filter
// =============================================================================

test.describe('Machine Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('머신 필터 표시 여부는 머신 수에 따름', async ({ page }) => {
    const machines = await page.evaluate(async () => {
      const res = await fetch('/api/machines');
      const body = await res.json();
      return body.machines;
    });

    const selector = page.locator('[data-testid="machine-selector"]');
    if (machines.length > 1) {
      await expect(selector).toBeVisible();
    } else {
      await expect(selector).not.toBeVisible();
    }
  });
});

// =============================================================================
// Session Status Display (DisplayStatus 계약)
// =============================================================================

test.describe('Session Status Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('상태 뱃지는 Working/Waiting/Idle/Retry만 허용', async ({ page }) => {
    const badges = page.locator('.status-badge');
    const count = await badges.count();

    for (let i = 0; i < count; i++) {
      const text = await badges.nth(i).textContent();
      expect(['Working', 'Waiting', 'Idle', 'Retry']).toContain(text?.trim());
    }
  });

  test('Idle 세션에는 상대 시간 표시 (Working에는 로더)', async ({ page }) => {
    const idleSessions = page.locator('.session-item:has(.status-idle)');
    const count = await idleSessions.count();

    if (count > 0) {
      // Idle 세션에는 activity time 텍스트가 있어야 함
      await expect(idleSessions.first().locator('.session-activity-time')).toBeVisible();
    }
  });
});

// =============================================================================
// Tab Navigation
// =============================================================================

test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  const tabs = [
    { name: 'Tokens', selector: 'token-cost' },
    { name: 'Impact', selector: 'code-impact' },
    { name: 'Timeline', selector: 'timeline' },
    { name: 'Projects', selector: 'projects' },
    { name: 'Recovery', selector: 'context-recovery' },
    { name: 'Memos', selector: 'memos' },
  ];

  for (const tab of tabs) {
    test(`${tab.name} 탭 클릭 시 페이지 전환`, async ({ page }) => {
      await page.locator('nav button', { hasText: tab.name }).click();
      // Dashboard 뷰가 사라지고 다른 뷰가 표시
      await expect(page.locator('[data-testid="active-sessions"]')).not.toBeVisible();
    });
  }

  test('Dashboard 탭으로 복귀', async ({ page }) => {
    // Tokens 탭으로 이동
    await page.locator('nav button', { hasText: 'Tokens' }).click();
    await expect(page.locator('[data-testid="active-sessions"]')).not.toBeVisible();

    // Dashboard 탭으로 복귀
    await page.locator('nav button', { hasText: 'Dashboard' }).click();
    await expect(page.locator('[data-testid="active-sessions"]')).toBeVisible();
  });
});

// =============================================================================
// Session Detail View
// =============================================================================

test.describe('Session Detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('세션 클릭 시 detail view 진입', async ({ page }) => {
    const firstSession = page.locator('[data-testid="active-sessions"] .session-item').first();
    if (await firstSession.isVisible()) {
      await firstSession.click();
      // detail view에는 "돌아가기" 버튼이 표시됨
      await expect(page.locator('.back-btn', { hasText: '돌아가기' })).toBeVisible({ timeout: 3_000 });
    }
  });

  test('detail view에서 Escape로 복귀', async ({ page }) => {
    const firstSession = page.locator('[data-testid="active-sessions"] .session-item').first();
    if (await firstSession.isVisible()) {
      await firstSession.click();
      await expect(page.locator('.back-btn')).toBeVisible({ timeout: 3_000 });

      await page.keyboard.press('Escape');
      await expect(page.locator('.back-btn')).not.toBeVisible();
    }
  });
});

// =============================================================================
// Command Palette
// =============================================================================

test.describe('Command Palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboardReady(page);
  });

  test('⌘K로 열기/닫기', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await expect(page.locator('.command-palette')).toBeVisible({ timeout: 2_000 });

    await page.keyboard.press('Meta+k');
    await expect(page.locator('.command-palette')).not.toBeVisible();
  });
});

// =============================================================================
// Session Pin / Favorite
// =============================================================================

test.describe('Session Pin', () => {
  test.beforeEach(async ({ page }) => {
    // 테스트 간 pin 상태 격리 — localStorage 초기화
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('session-dashboard:pinned'));
    await page.reload();
    await waitForDashboardReady(page);
  });

  test('pin 버튼 클릭 시 .pinned 클래스 부여 + localStorage 기록', async ({ page }) => {
    const items = page.locator('[data-testid="active-sessions"] .session-item');
    const count = await items.count();
    test.skip(count === 0, '세션 없음');

    const first = items.first();
    await first.locator('.pin-btn').click();

    // .pinned 클래스 적용 확인 (first 위치의 항목이 재정렬되어 바뀌었을 수 있으므로
    // 재정렬 후에는 pinned 클래스를 가진 세션이 최소 1개 존재해야 함)
    const pinnedItems = page.locator('[data-testid="active-sessions"] .session-item.pinned');
    await expect(pinnedItems).toHaveCount(1);

    const stored = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });

  test('pinned 상태가 페이지 리로드 후에도 유지', async ({ page }) => {
    const items = page.locator('[data-testid="active-sessions"] .session-item');
    test.skip((await items.count()) === 0, '세션 없음');

    await items.first().locator('.pin-btn').click();

    const storedBefore = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    expect(storedBefore).not.toBeNull();

    await page.reload();
    await waitForDashboardReady(page);

    const pinnedItems = page.locator('[data-testid="active-sessions"] .session-item.pinned');
    await expect(pinnedItems).toHaveCount(1);

    const storedAfter = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    expect(storedAfter).toBe(storedBefore);
  });

  test('pin 버튼 클릭이 세션 상세 네비게이션을 트리거하지 않음', async ({ page }) => {
    const items = page.locator('[data-testid="active-sessions"] .session-item');
    test.skip((await items.count()) === 0, '세션 없음');

    const urlBefore = page.url();
    await items.first().locator('.pin-btn').click();

    // URL 변화 없음 — 세션 상세 진입 시 URL query가 바뀜
    expect(page.url()).toBe(urlBefore);
  });

  test('unpin 클릭 시 하이라이트 제거 및 localStorage 비움', async ({ page }) => {
    const items = page.locator('[data-testid="active-sessions"] .session-item');
    test.skip((await items.count()) === 0, '세션 없음');

    // 1차 클릭: pin
    await items.first().locator('.pin-btn').click();
    await expect(page.locator('[data-testid="active-sessions"] .session-item.pinned')).toHaveCount(1);

    // 재정렬된 최상단(= 방금 pin된 세션)을 다시 클릭: unpin
    await page.locator('[data-testid="active-sessions"] .session-item.pinned').first()
      .locator('.pin-btn').click();

    await expect(page.locator('[data-testid="active-sessions"] .session-item.pinned')).toHaveCount(0);

    const stored = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    const parsed = stored ? JSON.parse(stored) : [];
    expect(parsed.length).toBe(0);
  });

  test('ShortcutCheatsheet에 p 키 항목 표시', async ({ page }) => {
    await page.keyboard.press('?');
    const modal = page.locator('.shortcut-cheatsheet, [class*="cheatsheet"]').first();
    await expect(modal).toBeVisible({ timeout: 2_000 });
    await expect(modal).toContainText('pin');
  });
});
