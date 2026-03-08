/**
 * Global teardown for OpenCode E2E regression tests.
 *
 * 1. Reads PIDs persisted by global-setup
 * 2. Kills agent & server processes (SIGTERM then SIGKILL)
 * 3. Cleans up temporary directories
 */

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_AGENT_HOME, TEST_SERVER_HOME } from './helpers/opencode-data.js';

const PID_FILE = join(TEST_SERVER_HOME, '.e2e-oc-pids.json');

function killProcess(pid: number, label: string): void {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[E2E Teardown] Sent SIGTERM to ${label} (PID: ${pid})`);

    // Give 3s for graceful shutdown, then SIGKILL
    setTimeout(() => {
      try {
        process.kill(pid, 0); // check if still alive
        process.kill(pid, 'SIGKILL');
        console.log(`[E2E Teardown] Sent SIGKILL to ${label} (PID: ${pid})`);
      } catch {
        // Already dead — good
      }
    }, 3000);
  } catch {
    console.log(`[E2E Teardown] ${label} (PID: ${pid}) already stopped`);
  }
}

export default async function globalTeardown(): Promise<void> {
  console.log('[E2E Teardown] Cleaning up...');

  // 1. Kill processes
  if (existsSync(PID_FILE)) {
    try {
      const pids = JSON.parse(readFileSync(PID_FILE, 'utf-8')) as {
        agentPid?: number;
        serverPid?: number;
      };

      if (pids.serverPid) killProcess(pids.serverPid, 'server');
      if (pids.agentPid) killProcess(pids.agentPid, 'agent');
    } catch (err) {
      console.error('[E2E Teardown] Failed to read PID file:', err);
    }
  }

  // 2. Wait a bit for processes to die before cleanup
  await new Promise((r) => setTimeout(r, 1000));

  // 3. Clean up temp directories
  for (const dir of [TEST_AGENT_HOME, TEST_SERVER_HOME]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`[E2E Teardown] Removed ${dir}`);
    }
  }

  console.log('[E2E Teardown] Done.');
}
