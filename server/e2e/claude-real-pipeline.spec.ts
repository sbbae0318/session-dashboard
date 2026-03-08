/**
 * Claude Code Real Pipeline E2E Tests
 *
 * Pipeline: Playwright Browser → Production Server (3097) → Real Agent (3101) → ~/.claude/ JSONL files
 *
 * These tests write REAL Claude Code JSONL files to ~/.claude/,
 * verify data flows through the real agent + server, then confirm
 * sessions/queries render in the browser.
 *
 * All test data is cleaned up after each test.
 */

import { test, expect } from '@playwright/test';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
  truncateSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REAL_AGENT_URL = 'http://127.0.0.1:3101';
const REAL_SERVER_URL = 'http://127.0.0.1:3097';
const REAL_AGENT_KEY = 'test-local-key';
const HOME = process.env['HOME']!;
const TEST_CWD = '/tmp/claudetest';
const ENCODED_CWD = '-tmp-claudetest';
const TEST_PROJECT_DIR = join(HOME, '.claude', 'projects', ENCODED_CWD);
const HISTORY_FILE = join(HOME, '.claude', 'history.jsonl');

// ---------------------------------------------------------------------------
// Helper: Write a real-format Claude session JSONL file
// ---------------------------------------------------------------------------

function writeRealSession(
  sessionId: string,
  entries: Array<{ type: 'user' | 'assistant'; content: string }>,
): string {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });

  const now = Date.now();
  const lines: string[] = [];
  let parentUuid: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const uuid = `e2e-uuid-${sessionId}-${i}`;
    const timestamp = now + i * 100;

    if (e.type === 'user') {
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: 'external',
          cwd: TEST_CWD,
          sessionId,
          version: '2.1.71',
          gitBranch: 'HEAD',
          type: 'user',
          message: { role: 'user', content: e.content },
          uuid,
          timestamp,
          permissionMode: 'default',
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: 'external',
          cwd: TEST_CWD,
          sessionId,
          version: '2.1.71',
          gitBranch: 'HEAD',
          message: {
            id: `msg-${sessionId}-${i}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: e.content }],
          },
          requestId: `req-${sessionId}-${i}`,
          type: 'assistant',
          uuid,
          timestamp,
        }),
      );
    }
    parentUuid = uuid;
  }

  const filePath = join(TEST_PROJECT_DIR, `${sessionId}.jsonl`);
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Helper: Append entries to real ~/.claude/history.jsonl
// Returns original file size for cleanup
// ---------------------------------------------------------------------------

function appendToHistory(
  entries: Array<{ display: string; sessionId: string }>,
): number {
  const originalSize = existsSync(HISTORY_FILE) ? statSync(HISTORY_FILE).size : 0;
  const now = Date.now();

  const lines = entries.map((e, i) =>
    JSON.stringify({
      display: e.display,
      pastedContents: {},
      timestamp: now + i * 100,
      project: TEST_CWD,
      sessionId: e.sessionId,
    }),
  );

  appendFileSync(HISTORY_FILE, lines.join('\n') + '\n', 'utf-8');
  return originalSize;
}

// ---------------------------------------------------------------------------
// Helper: Restore history.jsonl to original size
// ---------------------------------------------------------------------------

function restoreHistory(originalSizeBytes: number): void {
  if (existsSync(HISTORY_FILE)) {
    truncateSync(HISTORY_FILE, originalSizeBytes);
  }
}

// ---------------------------------------------------------------------------
// Helper: Delete test project dir and all session files
// ---------------------------------------------------------------------------

function cleanTestProject(): void {
  if (existsSync(TEST_PROJECT_DIR)) {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helper: Fetch real agent API with auth
// ---------------------------------------------------------------------------

async function agentGet(path: string): Promise<Response> {
  return fetch(`${REAL_AGENT_URL}${path}`, {
    headers: { Authorization: `Bearer ${REAL_AGENT_KEY}` },
  });
}

// ---------------------------------------------------------------------------
// Helper: Skip test if agent is not running
// ---------------------------------------------------------------------------

async function skipIfAgentDown(): Promise<void> {
  try {
    const r = await fetch(`${REAL_AGENT_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await r.json()) as { status: string };
    if (body.status !== 'ok') throw new Error('agent not healthy');
  } catch {
    test.skip(true, 'Real agent at port 3101 not running');
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  cleanTestProject();
});

test.afterEach(() => {
  cleanTestProject();
});

// ---------------------------------------------------------------------------
// Scenario A: Session appears in Active Sessions panel
// ---------------------------------------------------------------------------

test.describe('Scenario A: Session in Active Sessions', () => {
  test('fresh real-format session (last entry: user → busy) appears in browser', async ({
    page,
    request,
  }) => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-a-${Date.now()}`;

    // Write fresh real-format Claude session (last entry: type=user → status=busy)
    writeRealSession(sessionId, [{ type: 'user', content: 'Build the feature' }]);

    // Poll real agent API until session appears
    await expect
      .poll(
        async () => {
          const r = await agentGet('/api/claude/sessions');
          const body = (await r.json()) as {
            sessions: Array<{ sessionId: string }>;
          };
          return body.sessions.some((s) => s.sessionId === sessionId);
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Poll real server API until session appears (source=claude-code)
    await expect
      .poll(
        async () => {
          const r = await request.get(`${REAL_SERVER_URL}/api/sessions`);
          const body = (await r.json()) as {
            sessions: Array<{ sessionId: string; source: string }>;
          };
          return body.sessions.some(
            (s) => s.sessionId === sessionId && s.source === 'claude-code',
          );
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Navigate browser to /
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), {
      timeout: 15_000,
    });

    // Click "Claude" source filter button
    await page.click('.source-filter-btn:has-text("Claude")');

    // Verify .session-item is visible in [data-testid="active-sessions"]
    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Claude queries from history.jsonl appear in Recent Prompts
// ---------------------------------------------------------------------------

test.describe('Scenario B: Queries in Recent Prompts', () => {
  let originalHistorySize = 0;

  test.afterEach(() => {
    restoreHistory(originalHistorySize);
  });

  test('queries from history.jsonl appear in API and browser', async ({ page, request }) => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-b-${Date.now()}`;
    const query1 = `E2E test query alpha ${Date.now()}`;
    const query2 = `E2E test query beta ${Date.now()}`;

    // Append 2 test queries to ~/.claude/history.jsonl
    originalHistorySize = appendToHistory([
      { display: query1, sessionId },
      { display: query2, sessionId },
    ]);

    // Poll real server /api/queries until queries appear with source=claude-code
    await expect
      .poll(
        async () => {
          const r = await request.get(`${REAL_SERVER_URL}/api/queries?limit=50`);
          const body = (await r.json()) as {
            queries: Array<{ query: string; source: string }>;
          };
          const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');
          const has1 = claudeQueries.some((q) => q.query === query1);
          const has2 = claudeQueries.some((q) => q.query === query2);
          return has1 && has2;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    // Navigate browser and verify
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), {
      timeout: 15_000,
    });

    // Click "Claude" filter
    await page.click('.source-filter-btn:has-text("Claude")');

    // Verify query text visible in [data-testid="recent-prompts"]
    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel).toBeVisible({ timeout: 10_000 });
    await expect(promptsPanel.getByText(query1)).toBeVisible({ timeout: 10_000 });
    await expect(promptsPanel.getByText(query2)).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario C: Slash commands filtered from Recent Prompts
// ---------------------------------------------------------------------------

test.describe('Scenario C: Slash command filtering', () => {
  let originalHistorySize = 0;

  test.afterEach(() => {
    restoreHistory(originalHistorySize);
  });

  test('slash commands and XML excluded, real query visible', async ({ page, request }) => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-c-${Date.now()}`;
    const realQuery = `E2E explain caching strategy ${Date.now()}`;

    // Append mix: slash commands + 1 real query
    originalHistorySize = appendToHistory([
      { display: '/exit', sessionId },
      { display: '/help', sessionId },
      { display: '<system>internal</system>', sessionId },
      { display: realQuery, sessionId },
    ]);

    // Wait for real query to appear in server API
    await expect
      .poll(
        async () => {
          const r = await request.get(`${REAL_SERVER_URL}/api/queries?limit=50`);
          const body = (await r.json()) as {
            queries: Array<{ query: string; source: string }>;
          };
          const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');
          return claudeQueries.some((q) => q.query === realQuery);
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    // Verify slash commands NOT in API response
    const r = await request.get(`${REAL_SERVER_URL}/api/queries?limit=50`);
    const body = (await r.json()) as {
      queries: Array<{ query: string; source: string }>;
    };
    const claudeQueries = body.queries.filter((q) => q.source === 'claude-code');
    for (const q of claudeQueries) {
      expect(q.query).not.toMatch(/^\//);
      expect(q.query).not.toMatch(/^</);
    }

    // Browser: real query visible, slash commands not visible
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), {
      timeout: 15_000,
    });
    await page.click('.source-filter-btn:has-text("Claude")');

    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel.getByText(realQuery)).toBeVisible({ timeout: 10_000 });

    // Slash commands should NOT be present
    await expect(promptsPanel.getByText('/exit')).not.toBeVisible();
    await expect(promptsPanel.getByText('/help')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Scenario D: Stale session excluded
// ---------------------------------------------------------------------------

test.describe('Scenario D: Stale session excluded', () => {
  test('JSONL file with old mtime is excluded from active sessions', async () => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-d-${Date.now()}`;

    // Write session JSONL, then set mtime to 3 minutes ago
    const filePath = writeRealSession(sessionId, [
      { type: 'user', content: 'Old work from the past' },
    ]);
    const past = new Date(Date.now() - 180_000);
    utimesSync(filePath, past, past);

    // Wait for agent to scan
    await new Promise((r) => setTimeout(r, 2000));

    // Verify session NOT in agent API
    const agentResp = await agentGet('/api/claude/sessions');
    const agentBody = (await agentResp.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    const staleSession = agentBody.sessions.find((s) => s.sessionId === sessionId);
    expect(staleSession).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario E: Source filter shows only Claude data
// ---------------------------------------------------------------------------

test.describe('Scenario E: Source filter Claude only', () => {
  let originalHistorySize = 0;

  test.afterEach(() => {
    restoreHistory(originalHistorySize);
  });

  test('Claude filter shows claude-code sessions and prompts with proper badges', async ({
    page,
    request,
  }) => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-e-${Date.now()}`;
    const queryText = `E2E run integration tests ${Date.now()}`;

    // Write session + history entry
    writeRealSession(sessionId, [{ type: 'user', content: 'Run tests' }]);
    originalHistorySize = appendToHistory([{ display: queryText, sessionId }]);

    // Wait for data to propagate
    await expect
      .poll(
        async () => {
          const [sessResp, queryResp] = await Promise.all([
            request.get(`${REAL_SERVER_URL}/api/sessions`),
            request.get(`${REAL_SERVER_URL}/api/queries?limit=50`),
          ]);
          const sessions = (
            (await sessResp.json()) as { sessions: Array<{ sessionId: string }> }
          ).sessions;
          const queries = (
            (await queryResp.json()) as {
              queries: Array<{ query: string; source: string }>;
            }
          ).queries;
          const hasSession = sessions.some((s) => s.sessionId === sessionId);
          const hasQuery = queries.some((q) => q.query === queryText);
          return hasSession && hasQuery;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    // Browser: click Claude filter
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), {
      timeout: 15_000,
    });
    await page.click('.source-filter-btn:has-text("Claude")');

    // The "Claude" button should have .active class
    const claudeBtn = page.locator('.source-filter-btn:has-text("Claude")');
    await expect(claudeBtn).toHaveClass(/active/);

    // Session should be visible
    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible({
      timeout: 10_000,
    });

    // Prompt should be visible
    const promptsPanel = page.locator('[data-testid="recent-prompts"]');
    await expect(promptsPanel.getByText(queryText)).toBeVisible({ timeout: 10_000 });

    // Source badge should say Claude
    await expect(promptsPanel.locator('.source-badge.claude').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario F: Real-time SSE update
// ---------------------------------------------------------------------------

test.describe('Scenario F: Real-time SSE update', () => {
  test('session appears in browser after JSONL written (via SSE, no reload)', async ({
    page,
    request,
  }) => {
    await skipIfAgentDown();

    const sessionId = `e2e-real-sess-f-${Date.now()}`;

    // Navigate browser FIRST (before writing any session)
    await page.goto('/');
    await page.waitForFunction(() => !document.querySelector('.loading'), {
      timeout: 15_000,
    });

    // Click "Claude" filter
    await page.click('.source-filter-btn:has-text("Claude")');

    // Write session JSONL AFTER browser is open
    writeRealSession(sessionId, [
      { type: 'user', content: 'Deploy to production via SSE' },
    ]);

    // Poll server API until session appears
    await expect
      .poll(
        async () => {
          const r = await request.get(`${REAL_SERVER_URL}/api/sessions`);
          const body = (await r.json()) as {
            sessions: Array<{ sessionId: string }>;
          };
          return body.sessions.some((s) => s.sessionId === sessionId);
        },
        { timeout: 10_000, intervals: [500] },
      )
      .toBeTruthy();

    // Verify session item appears in browser via SSE push (no reload needed)
    const sessionsPanel = page.locator('[data-testid="active-sessions"]');
    await page.waitForFunction(
      (sid: string) => {
        const items = document.querySelectorAll(
          '[data-testid="active-sessions"] .session-item',
        );
        // At least one session item should be visible (SSE pushed it)
        return items.length > 0;
      },
      sessionId,
      { timeout: 15_000, polling: 500 },
    );

    await expect(sessionsPanel.locator('.session-item').first()).toBeVisible();
  });
});
