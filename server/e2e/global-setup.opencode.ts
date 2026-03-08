/**
 * Global setup for OpenCode E2E regression tests.
 *
 * 1. Creates isolated HOME directories for agent & server
 * 2. Cleans stale singleton lock files
 * 3. Spawns test agent (port 3198) and test server (port 3099)
 * 4. Waits for both to be healthy before handing off to Playwright
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_AGENT_HOME, TEST_SERVER_HOME } from './helpers/opencode-data.js';

const AGENT_PORT = 3198;
const SERVER_PORT = 3099;
const AGENT_KEY = 'e2e-oc-test-key-12345';

// File to persist PIDs across setup/teardown (globalThis doesn't survive separate processes)
const PID_FILE = join(TEST_SERVER_HOME, '.e2e-oc-pids.json');

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${url} (${timeoutMs}ms)`);
}

/**
 * Wait for server to be reachable.
 * /api/sessions returns 502 when oc-serve is not running — that's expected
 * and means the server itself is alive and proxying correctly.
 */
async function waitForServerReady(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 502) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for server at ${url} (${timeoutMs}ms)`);
}

export default async function globalSetup(): Promise<void> {
  console.log('[E2E Setup] Starting OpenCode regression test environment...');

  // 1. Create directories
  mkdirSync(join(TEST_AGENT_HOME, '.opencode', 'history'), { recursive: true });
  mkdirSync(join(TEST_SERVER_HOME, '.opencode'), { recursive: true });

  // 2. Remove stale singleton lock (from previous test runs)
  const lockFile = join(TEST_SERVER_HOME, '.opencode', 'session-dashboard.lock');
  if (existsSync(lockFile)) {
    rmSync(lockFile, { force: true });
    console.log('[E2E Setup] Removed stale lock file');
  }

  // 3. Start test agent
  const agentProc: ChildProcess = spawn(
    'node',
    [join(process.cwd(), '..', 'agent', 'dist', 'index.js')],
    {
      env: {
        ...process.env,
        HOME: TEST_AGENT_HOME,
        PORT: String(AGENT_PORT),
        API_KEY: AGENT_KEY,
        SOURCE: 'opencode',
        HISTORY_DIR: join(TEST_AGENT_HOME, '.opencode', 'history'),
      },
      stdio: 'pipe',
      detached: false,
    },
  );

  agentProc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[agent] ${d}`));
  agentProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[agent:err] ${d}`));

  // 4. Start test server
  const machinesConfig = join(process.cwd(), 'e2e', 'fixtures', 'machines.opencode-test.yml');
  const serverProc: ChildProcess = spawn(
    'node',
    [join(process.cwd(), 'dist', 'cli.js'), 'start', String(SERVER_PORT)],
    {
      env: {
        ...process.env,
        HOME: TEST_SERVER_HOME,
        MACHINES_CONFIG: machinesConfig,
      },
      stdio: 'pipe',
      detached: false,
    },
  );

  serverProc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server:err] ${d}`));

  // 5. Persist PIDs for teardown
  const pids = {
    agentPid: agentProc.pid,
    serverPid: serverProc.pid,
  };
  writeFileSync(PID_FILE, JSON.stringify(pids), 'utf-8');

  // 6. Wait for both to be healthy
  try {
    await waitForHealth(`http://127.0.0.1:${AGENT_PORT}/health`);
    console.log(`[E2E Setup] Test agent ready on port ${AGENT_PORT} (PID: ${agentProc.pid})`);
  } catch (err) {
    console.error('[E2E Setup] Agent failed to start');
    throw err;
  }

  try {
    // Server: /api/sessions returns 502 without oc-serve — that's OK
    await waitForServerReady(`http://127.0.0.1:${SERVER_PORT}/api/sessions`);
    console.log(`[E2E Setup] Test server ready on port ${SERVER_PORT} (PID: ${serverProc.pid})`);
  } catch (err) {
    console.error('[E2E Setup] Server failed to start');
    throw err;
  }

  console.log('[E2E Setup] Environment ready.');
}
