/**
 * Playwright config for OpenCode E2E regression tests.
 *
 * Uses a separate port (3099) and custom global setup/teardown
 * that spawn real agent + server processes.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/opencode-regression.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3099',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/global-setup.opencode.ts',
  globalTeardown: './e2e/global-teardown.opencode.ts',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
