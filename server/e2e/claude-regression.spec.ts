/**
 * Claude Code E2E Regression Tests — Real Pipeline
 *
 * Pipeline: Playwright browser → Test Server (3098) → Test Agent (3199) → JSONL files
 *
 * These tests write JSONL files, wait for the real agent to detect them,
 * then verify data flows through the real server API and renders in the browser.
 */

import { test, expect } from '@playwright/test';
import {
  TEST_AGENT_HOME,
  cleanAgentHome,
  writeHistory,
  writeProjectSession,
  makeFileStale,
} from './helpers/claude-data.js';

const AGENT_URL = 'http://127.0.0.1:3199';
const SERVER_URL = 'http://127.0.0.1:3098';
const AGENT_KEY = 'e2e-test-key-12345';

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
  // Brief pause for FS watcher to process the cleanup
  await new Promise((r) => setTimeout(r, 300));
});

// ---------------------------------------------------------------------------
// Scenario 1: Real prompts appear in Recent Prompts
// ---------------------------------------------------------------------------

test.describe('Scenario 1: Prompts in Recent Prompts', () => {
  test('real prompts from history.jsonl appear in API and browser', async ({ page, request }) => {
    // Write 3 real queries to history.jsonl
    writeHistory(TEST_AGENT_HOME, [
      { display: 'Refactor the auth module', sessionId: 'sess-prompt-001', timestamp: Date.now() - 3000 },
      { display: 'Add unit tests for parser', sessionId: 'sess-prompt-002', timestamp: Date.now() - 2000 },
      { display: 'Fix memory leak in worker', sessionId: 'sess-prompt-003', timestamp: Date.now() - 1000 },
    ]);

    // Poll server API until queries appear (server polls agent every 5s)
    await expect
      .poll(
        async () => {
          const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
          const body = (await r.json()) as { queries: Array<{ query: string; source: string }> };
          const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');
          return claudeQueries.length;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(3);

    // Browser verification
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });

    // Click "Claude" source filter
    await page.click('.source-filter-btn:has-text("Claude")');

    // Verify prompts in Recent Prompts panel
    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel).toBeVisible({ timeout: 10_000 });

    // Check that our prompts are rendered
    await expect(promptsPanel.getByText('Refactor the auth module')).toBeVisible({ timeout: 10_000 });
    await expect(promptsPanel.getByText('Add unit tests for parser')).toBeVisible();
    await expect(promptsPanel.getByText('Fix memory leak in worker')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Slash commands are filtered
// ---------------------------------------------------------------------------

test.describe('Scenario 2: Slash command filtering', () => {
  test('slash commands and XML are excluded from queries', async ({ page, request }) => {
    writeHistory(TEST_AGENT_HOME, [
      { display: '/exit', sessionId: 'sess-slash-001', timestamp: Date.now() - 3000 },
      { display: '/help', sessionId: 'sess-slash-002', timestamp: Date.now() - 2000 },
      { display: '<system>internal message</system>', sessionId: 'sess-slash-003', timestamp: Date.now() - 1500 },
      { display: 'Explain the caching strategy', sessionId: 'sess-slash-004', timestamp: Date.now() - 1000 },
    ]);

    // Wait for the real query to appear
    await expect
      .poll(
        async () => {
          const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
          const body = (await r.json()) as { queries: Array<{ query: string; source: string }> };
          const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');
          return claudeQueries;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ query: 'Explain the caching strategy' })]),
      );

    // Verify NO slash commands in API response
    const r = await request.get(`${SERVER_URL}/api/queries?limit=50`);
    const body = (await r.json()) as { queries: Array<{ query: string; source: string }> };
    const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');

    for (const q of claudeQueries) {
      expect(q.query).not.toMatch(/^\//);
      expect(q.query).not.toMatch(/^</);
    }

    // Browser: slash commands should not be visible
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("Claude")');

    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel.getByText('Explain the caching strategy')).toBeVisible({ timeout: 10_000 });

    // These should NOT be present
    await expect(promptsPanel.getByText('/exit')).not.toBeVisible();
    await expect(promptsPanel.getByText('/help')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Busy session in Active Sessions
// ---------------------------------------------------------------------------

test.describe('Scenario 3: Busy session detection', () => {
  test('session with last entry type=user shows in Active Sessions', async ({ page, request }) => {
    // Write JSONL with last entry = user → status: "busy"
    writeProjectSession(TEST_AGENT_HOME, '/tmp/testproject', 'sess-busy-001', [
      { type: 'user', content: 'Build the feature' },
    ]);

    // Wait for agent to detect the session
    await expect
      .poll(
        async () => {
          const r = await agentGet('/api/claude/sessions');
          const body = (await r.json()) as { sessions: Array<{ sessionId: string; status: string }> };
          return body.sessions.find((s) => s.sessionId === 'sess-busy-001');
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Verify status is "busy" at agent level
    const agentResp = await agentGet('/api/claude/sessions');
    const agentBody = (await agentResp.json()) as { sessions: Array<{ sessionId: string; status: string }> };
    const busySession = agentBody.sessions.find((s) => s.sessionId === 'sess-busy-001');
    expect(busySession?.status).toBe('busy');

    // Wait for server to pick it up
    await expect
      .poll(
        async () => {
          const r = await request.get(`${SERVER_URL}/api/sessions`);
          const body = (await r.json()) as { sessions: Array<{ sessionId: string; source: string }> };
          return body.sessions.some((s) => s.sessionId === 'sess-busy-001');
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Browser: session should be visible
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("Claude")');

    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await expect(sessionsPanel).toBeVisible();
    // Claude sessions show "Untitled" for title
    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Idle session in Active Sessions
// ---------------------------------------------------------------------------

test.describe('Scenario 4: Idle session detection', () => {
  test('session with last entry type=assistant (text) shows as idle', async ({ request }) => {
    // Last entry = assistant with text-only → status: "idle"
    writeProjectSession(TEST_AGENT_HOME, '/tmp/testproject', 'sess-idle-001', [
      { type: 'user', content: 'What is the status?' },
      { type: 'assistant', content: 'Everything looks good.' },
    ]);

    // Wait for agent to detect it
    await expect
      .poll(
        async () => {
          const r = await agentGet('/api/claude/sessions');
          const body = (await r.json()) as { sessions: Array<{ sessionId: string; status: string }> };
          return body.sessions.find((s) => s.sessionId === 'sess-idle-001');
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Verify status
    const agentResp = await agentGet('/api/claude/sessions');
    const agentBody = (await agentResp.json()) as { sessions: Array<{ sessionId: string; status: string }> };
    const idleSession = agentBody.sessions.find((s) => s.sessionId === 'sess-idle-001');
    expect(idleSession?.status).toBe('idle');

    // Server also should have it
    await expect
      .poll(
        async () => {
          const r = await request.get(`${SERVER_URL}/api/sessions`);
          const body = (await r.json()) as { sessions: Array<{ sessionId: string; source: string }> };
          return body.sessions.some(
            (s) => s.sessionId === 'sess-idle-001' && s.source === 'claude-code',
          );
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Source filter "Claude" only shows claude-code data
// ---------------------------------------------------------------------------

test.describe('Scenario 5: Source filter Claude', () => {
  test('clicking Claude filter shows only claude-code sessions and prompts', async ({ page, request }) => {
    // Set up both session and queries
    writeProjectSession(TEST_AGENT_HOME, '/tmp/testproject', 'sess-filter-001', [
      { type: 'user', content: 'Run tests' },
    ]);

    writeHistory(TEST_AGENT_HOME, [
      { display: 'Run all integration tests', sessionId: 'sess-filter-001', timestamp: Date.now() },
    ]);

    // Wait for data to propagate
    await expect
      .poll(
        async () => {
          const [sessResp, queryResp] = await Promise.all([
            request.get(`${SERVER_URL}/api/sessions`),
            request.get(`${SERVER_URL}/api/queries?limit=50`),
          ]);
          const sessions = ((await sessResp.json()) as { sessions: Array<{ sessionId: string }> }).sessions;
          const queries = ((await queryResp.json()) as { queries: Array<{ query: string; source: string }> }).queries;
          const hasSession = sessions.some((s) => s.sessionId === 'sess-filter-001');
          const hasQuery = queries.some((q) => q.query === 'Run all integration tests');
          return hasSession && hasQuery;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    // Browser: click Claude filter
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("Claude")');

    // The "Claude" button should be active
    const claudeBtn = page.locator('.source-filter-btn:has-text("Claude")');
    await expect(claudeBtn).toHaveClass(/active/);

    // Session should be visible
    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible({ timeout: 10_000 });

    // Prompt should be visible
    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel.getByText('Run all integration tests')).toBeVisible({ timeout: 10_000 });

    // Source badge should say Claude
    await expect(promptsPanel.locator('.source-badge.claude').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Real-time update (session appears after file write)
// ---------------------------------------------------------------------------

test.describe('Scenario 6: Real-time update', () => {
  test('session appears in browser after JSONL file is written', async ({ page, request }) => {
    // Write a session file
    writeProjectSession(TEST_AGENT_HOME, '/tmp/testproject', 'sess-realtime-001', [
      { type: 'user', content: 'Deploy to production' },
    ]);

    // Wait for server to pick it up via API
    await expect
      .poll(
        async () => {
          const r = await request.get(`${SERVER_URL}/api/sessions`);
          const body = (await r.json()) as { sessions: Array<{ sessionId: string }> };
          return body.sessions.some((s) => s.sessionId === 'sess-realtime-001');
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Browser: navigate and verify session is visible
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 15_000 });
    await page.click('.source-filter-btn:has-text("Claude")');

    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Stale session excluded
// ---------------------------------------------------------------------------

test.describe('Scenario 7: Stale session excluded', () => {
  test('JSONL file with old mtime is excluded from active sessions', async ({ request }) => {
    // Write a session, then make it stale (mtime > 120s ago)
    const filePath = writeProjectSession(
      TEST_AGENT_HOME,
      '/tmp/testproject',
      'sess-stale-001',
      [{ type: 'user', content: 'Old work' }],
    );
    makeFileStale(filePath, 180_000); // 3 minutes ago

    // Give agent time to scan
    await new Promise((r) => setTimeout(r, 2000));

    // Check agent — should NOT have this session
    const agentResp = await agentGet('/api/claude/sessions');
    const agentBody = (await agentResp.json()) as { sessions: Array<{ sessionId: string }> };
    const staleSession = agentBody.sessions.find((s) => s.sessionId === 'sess-stale-001');
    expect(staleSession).toBeUndefined();

    // Double-check server too
    const serverResp = await request.get(`${SERVER_URL}/api/sessions`);
    const serverBody = (await serverResp.json()) as { sessions: Array<{ sessionId: string }> };
    const serverStale = serverBody.sessions.find((s) => s.sessionId === 'sess-stale-001');
    expect(serverStale).toBeUndefined();
  });
});
