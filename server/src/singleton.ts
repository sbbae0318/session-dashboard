/**
 * Singleton Lock Management
 *
 * Ensures only one session-dashboard daemon runs at a time.
 * Uses file-based locking with process existence checking.
 */

import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LOCK_FILE = join(homedir(), '.opencode', 'session-dashboard.lock');

/**
 * Check if a process with the given PID exists
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 just checks existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the singleton lock
 *
 * @returns true if lock acquired, false if another instance is running
 */
export async function acquireLock(): Promise<boolean> {
  try {
    // Ensure parent directory exists
    await mkdir(dirname(LOCK_FILE), { recursive: true });
    // Try to create lock file exclusively
    const fd = await open(LOCK_FILE, 'wx');
    await fd.write(String(process.pid));
    await fd.close();
    console.log('[Singleton] Lock acquired');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lock file exists, check if the process is still alive
      try {
        const content = await readFile(LOCK_FILE, 'utf8');
        const pid = parseInt(content.trim(), 10);

        if (isNaN(pid)) {
          // Invalid PID, take over
          console.log('[Singleton] Invalid lock file, taking over');
          await unlink(LOCK_FILE);
          return acquireLock();
        }

        if (isProcessAlive(pid)) {
          console.log(`[Singleton] Another instance (PID ${pid}) is running`);
          return false;
        }

        // Process is dead, take over
        console.log(`[Singleton] Stale lock (PID ${pid} dead), taking over`);
        await unlink(LOCK_FILE);
        return acquireLock();
      } catch (readErr) {
        // Can't read lock file, try to take over
        console.log('[Singleton] Cannot read lock file, attempting takeover');
        try {
          await unlink(LOCK_FILE);
        } catch {
          // Ignore
        }
        return acquireLock();
      }
    }

    // Other error (e.g., ENOENT for parent directory)
    throw err;
  }
}

/**
 * Release the singleton lock
 */
export async function releaseLock(): Promise<void> {
  try {
    // Only delete if we own the lock
    if (existsSync(LOCK_FILE)) {
      const content = await readFile(LOCK_FILE, 'utf8');
      const pid = parseInt(content.trim(), 10);

      if (pid === process.pid) {
        await unlink(LOCK_FILE);
        console.log('[Singleton] Lock released');
      }
    }
  } catch (err) {
    console.error('[Singleton] Failed to release lock:', err);
  }
}

/**
 * Get the PID of the running daemon (if any)
 */
export async function getRunningDaemonPid(): Promise<number | null> {
  if (!existsSync(LOCK_FILE)) {
    return null;
  }

  try {
    const content = await readFile(LOCK_FILE, 'utf8');
    const pid = parseInt(content.trim(), 10);

    if (isNaN(pid)) {
      return null;
    }

    if (isProcessAlive(pid)) {
      return pid;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  const pid = await getRunningDaemonPid();
  return pid !== null;
}

/**
 * Get the lock file path (for debugging)
 */
export function getLockFilePath(): string {
  return LOCK_FILE;
}

/**
 * Setup cleanup handlers for graceful shutdown
 */
export function setupCleanupHandlers(cleanup: () => Promise<void>): void {
  const handleExit = async (signal: string) => {
    console.log(`\n[Singleton] Received ${signal}, shutting down...`);
    await cleanup();
    await releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', () => handleExit('SIGINT'));
  process.on('SIGTERM', () => handleExit('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    console.error('[Singleton] Uncaught exception:', err);
    await cleanup();
    await releaseLock();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('[Singleton] Unhandled rejection:', reason);
    await cleanup();
    await releaseLock();
    process.exit(1);
  });
}
