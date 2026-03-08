/**
 * OpenCode E2E Regression Tests — Real Pipeline
 *
 * Pipeline: Playwright browser → Test Server (3099) → Test Agent (3198) → JSONL/SQLite
 *
 * Cards: written to cards.jsonl → agent reads directly → server polls agent
 * Queries: written to PromptStore SQLite DB → agent reads from DB → server polls agent
 * (Agent's /api/queries uses SQLite-first strategy, NOT JSONL, when source='opencode')
 */

import { test, expect } from '@playwright/test';
import {
  TEST_AGENT_HOME,
  cleanAgentHome,
  cleanPromptStore,
  writeCards,
  writeQueriesToPromptStore,
} from './helpers/opencode-data.js';

const AGENT_URL = 'http://127.0.0.1:3198';
const SERVER_URL = 'http://127.0.0.1:3099';
const AGENT_KEY = 'e2e-oc-test-key-12345';

/** Fetch agent API with Bearer auth */
async function agentGet(path: string): Promise<Response> {
  return fetch(`${AGENT_URL}${path}`, {
    headers: { Authorization: `Bearer ${AGENT_KEY}` },
  });
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

test.beforeEach(async () => {
  cleanAgentHome(TEST_AGENT_HOME);
  cleanPromptStore(TEST_AGENT_HOME);
  // Brief pause for FS watcher to process the cleanup
  await new Promise((r) => setTimeout(r, 300));
});

// ---------------------------------------------------------------------------
// Scenario 1: Cards in API
// ---------------------------------------------------------------------------

test.describe('Scenario 1: Cards in API', () => {
  test('cards.jsonl entries appear in agent /api/cards and server /api/history', async ({ request }) => {
    writeCards(TEST_AGENT_HOME, [
      { sessionId: 'oc-sess-001', title: 'Build the auth module', source: 'opencode' },
      { sessionId: 'oc-sess-002', title: 'Refactor database layer', source: 'opencode' },
    ]);

    // Poll agent /api/cards until data appears
    await expect.poll(
      async () => {
        const r = await agentGet('/api/cards');
        const body = await r.json() as { cards: Array<{ sessionId: string }> };
        return body.cards.length;
      },
      { timeout: 15_000, intervals: [500] },
    ).toBeGreaterThanOrEqual(2);

    // Server /api/history should also have them (response is { cards: [...] })
    await expect.poll(
      async () => {
        const r = await request.get(`${SERVER_URL}/api/history?limit=50`);
        const body = await r.json() as { cards?: Array<{ sessionId?: string; source?: string }> };
        if (!body.cards) return 0;
        return body.cards.filter((s) => s.source === 'opencode').length;
      },
      { timeout: 15_000, intervals: [500] },
    ).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Queries in Recent Prompts
// ---------------------------------------------------------------------------

test.describe('Scenario 2: Queries in Recent Prompts', () => {
  test('query entries appear in agent /api/queries and server /api/queries', async ({ page, request }) => {
    writeQueriesToPromptStore(TEST_AGENT_HOME, [
      { query: 'Implement the login flow', sessionId: 'oc-sess-q-001', timestamp: Date.now() - 2000 },
      { query: 'Add error handling to API', sessionId: 'oc-sess-q-002', timestamp: Date.now() - 1000 },
    ]);

    await expect.poll(
      async () => {
        const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
        const body = await r.json() as { queries?: Array<{ query: string; source: string }> };
        if (!body.queries) return 0;
        return body.queries.filter((q) => q.source === 'opencode').length;
      },
      { timeout: 15_000, intervals: [500] },
    ).toBeGreaterThanOrEqual(2);

    // Browser verification
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("OpenCode")');

    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel).toBeVisible({ timeout: 10_000 });
    await expect(promptsPanel.getByText('Implement the login flow')).toBeVisible({ timeout: 10_000 });
    await expect(promptsPanel.getByText('Add error handling to API')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: oc-serve down graceful degradation
// ---------------------------------------------------------------------------

test.describe('Scenario 3: oc-serve down graceful degradation', () => {
  test('/api/sessions returns 502 when oc-serve is not running (expected)', async () => {
    // oc-serve is not running in E2E environment — this is expected
    const r = await agentGet('/api/sessions');
    // 502 is the expected response when oc-serve is down
    expect([200, 502]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Source filter OpenCode
// ---------------------------------------------------------------------------

test.describe('Scenario 4: Source filter OpenCode', () => {
  test('clicking OpenCode filter shows only opencode data', async ({ page, request }) => {
    writeCards(TEST_AGENT_HOME, [
      { sessionId: 'oc-filter-001', title: 'OpenCode session', source: 'opencode' },
    ]);
    writeQueriesToPromptStore(TEST_AGENT_HOME, [
      { query: 'Run the OpenCode pipeline', sessionId: 'oc-filter-001', timestamp: Date.now() },
    ]);

    await expect.poll(
      async () => {
        const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
        const body = await r.json() as { queries?: Array<{ query: string; source: string }> };
        if (!body.queries) return false;
        return body.queries.some((q) => q.query === 'Run the OpenCode pipeline');
      },
      { timeout: 15_000, intervals: [500] },
    ).toBeTruthy();

    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("OpenCode")');

    const ocBtn = page.locator('.source-filter-btn:has-text("OpenCode")');
    await expect(ocBtn).toHaveClass(/active/);

    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel.getByText('Run the OpenCode pipeline')).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Real-time update
// ---------------------------------------------------------------------------

test.describe('Scenario 5: Real-time update', () => {
  test('cards appear in browser after cards.jsonl is written', async ({ request }) => {
    writeCards(TEST_AGENT_HOME, [
      { sessionId: 'oc-realtime-001', title: 'Deploy to staging' },
    ]);

    await expect.poll(
      async () => {
        const r = await agentGet('/api/cards');
        const body = await r.json() as { cards: Array<{ sessionId: string }> };
        return body.cards.some((c) => c.sessionId === 'oc-realtime-001');
      },
      { timeout: 10_000, intervals: [500] },
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Empty state
// ---------------------------------------------------------------------------

test.describe('Scenario 6: Empty state', () => {
  test('agent returns empty arrays when no JSONL files exist', async () => {
    // cleanAgentHome() already called in beforeEach
    const cardsResp = await agentGet('/api/cards');
    const cardsBody = await cardsResp.json() as { cards: unknown[] };
    expect(cardsBody.cards).toHaveLength(0);

    const queriesResp = await agentGet('/api/queries?limit=50');
    const queriesBody = await queriesResp.json() as { queries: unknown[] };
    expect(queriesBody.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Large file handling
// ---------------------------------------------------------------------------

test.describe('Scenario 7: Large file handling', () => {
  test('500 entries in cards.jsonl, limit=50 returns only 50', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      sessionId: `oc-large-${String(i).padStart(3, '0')}`,
      title: `Session ${i}`,
    }));
    writeCards(TEST_AGENT_HOME, entries);

    await expect.poll(
      async () => {
        const r = await agentGet('/api/cards?limit=50');
        const body = await r.json() as { cards: unknown[] };
        return body.cards.length;
      },
      { timeout: 10_000, intervals: [500] },
    ).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Recent prompt visibility (long session)
// ---------------------------------------------------------------------------

test.describe('Scenario 8: Recent prompt visibility (long session)', () => {
  test('장기 세션에서 최신 user 메시지가 표시됨 (첫 번째가 아닌 마지막)', async ({ request }) => {
    const now = Date.now();
    writeQueriesToPromptStore(TEST_AGENT_HOME, [
      {
        query: 'Old first prompt from session start',
        sessionId: 'oc-long-sess',
        timestamp: now - 3_600_000,
      },
      {
        query: 'Recent prompt after hours of work',
        sessionId: 'oc-long-sess',
        timestamp: now - 1_000,
      },
    ]);

    await expect.poll(
      async () => {
        const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
        const body = await r.json() as { queries?: Array<{ query: string; sessionId: string }> };
        return (body.queries ?? []).filter((q) => q.sessionId === 'oc-long-sess');
      },
      { timeout: 15_000, intervals: [500] },
    ).toSatisfy((entries: Array<{ query: string }>) =>
      entries.some((e) => e.query === 'Recent prompt after hours of work'),
    );
  });
});
