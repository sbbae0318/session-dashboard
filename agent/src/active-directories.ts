/**
 * Detect active OpenCode project directories from running processes.
 *
 * Scans `ps` output for `opencode attach --dir <path>` processes
 * and returns the unique directory list. Results are cached to avoid
 * running `ps` on every poll cycle (default 30 s TTL).
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  directories: string[];
  updatedAt: number;
}

let cache: CacheEntry = { directories: [], updatedAt: 0 };

/**
 * Parse `opencode attach ... --dir <path>` from a single ps line.
 * Returns the directory path or null if not an attach process.
 */
export function parseAttachDir(line: string): string | null {
  // Match: opencode attach <url> --dir <path>
  const match = /opencode\s+attach\s+\S+\s+--dir\s+(\S+)/.exec(line);
  return match?.[1] ?? null;
}

/**
 * Run `ps` and collect unique directories from opencode attach processes.
 */
export async function detectActiveDirectories(): Promise<string[]> {
  const now = Date.now();
  if (now - cache.updatedAt < CACHE_TTL_MS) {
    return cache.directories;
  }

  const dirs = await detectActiveDirectoriesUncached();
  cache = { directories: dirs, updatedAt: now };
  return dirs;
}

/**
 * Uncached detection — always runs ps.
 * Exported for testing.
 */
export function detectActiveDirectoriesUncached(): Promise<string[]> {
  return new Promise((resolve) => {
    const isLinux = platform() === 'linux';
    const args = isLinux ? ['-eo', 'args'] : ['aux'];

    execFile('ps', args, { timeout: 5_000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }

      const seen = new Set<string>();
      for (const line of stdout.split('\n')) {
        const dir = parseAttachDir(line);
        if (dir && dir !== '/') {
          seen.add(dir);
        }
      }

      resolve([...seen].sort());
    });
  });
}

/**
 * Reset cache (for testing).
 */
export function resetCache(): void {
  cache = { directories: [], updatedAt: 0 };
}
