/**
 * Playwright config for Claude Code E2E regression tests.
 *
 * Uses a separate port (3098) and custom global setup/teardown
 * that spawn real agent + server processes.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/claude-regression.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3098',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/global-setup.claude.ts',
  globalTeardown: './e2e/global-teardown.claude.ts',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
