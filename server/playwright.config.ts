import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Isolated HOME for E2E tests — avoids real JSONL data with duplicate keys
// that trigger Svelte each_key_duplicate errors during rendering
const TEST_HOME = join(process.cwd(), ".playwright-home");
mkdirSync(join(TEST_HOME, ".opencode", "history"), { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3097",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node dist/cli.js start",
    port: 3097,
    reuseExistingServer: true,
    timeout: 15_000,
    env: {
      HOME: TEST_HOME,
    },
  },
});
