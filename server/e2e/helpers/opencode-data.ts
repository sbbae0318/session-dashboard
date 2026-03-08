/**
 * JSONL fixture helpers for OpenCode E2E regression tests.
 *
 * Writes JSONL files into TEST_AGENT_HOME/.opencode/history/ so that
 * the real agent process (OpenCodeHeartbeat + OpenCodeSource) picks them up.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_AGENT_HOME = '/tmp/sd-e2e-oc-agent-home';
export const TEST_SERVER_HOME = '/tmp/sd-e2e-oc-server-home';

/**
 * Write cards.jsonl for OpenCodeSource.
 *
 * Path: TEST_AGENT_HOME/.opencode/history/cards.jsonl
 */
export function writeCards(
  agentHome: string,
  entries: Array<{
    sessionId: string;
    title: string;
    duration?: string;
    model?: string;
    [key: string]: unknown;
  }>,
): void {
  const dir = join(agentHome, '.opencode', 'history');
  mkdirSync(dir, { recursive: true });

  const lines = entries.map((e) =>
    JSON.stringify({
      sessionId: e.sessionId,
      title: e.title,
      duration: e.duration ?? '',
      model: e.model ?? '',
      ...Object.fromEntries(
        Object.entries(e).filter(
          ([k]) => !['sessionId', 'title', 'duration', 'model'].includes(k),
        ),
      ),
    }),
  );

  writeFileSync(join(dir, 'cards.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

/**
 * Write queries.jsonl (prompt history) for OpenCodeSource.
 *
 * Path: TEST_AGENT_HOME/.opencode/history/queries.jsonl
 */
export function writeQueries(
  agentHome: string,
  entries: Array<{
    query: string;
    sessionId: string;
    timestamp: number;
    [key: string]: unknown;
  }>,
): void {
  const dir = join(agentHome, '.opencode', 'history');
  mkdirSync(dir, { recursive: true });

  const lines = entries.map((e) =>
    JSON.stringify({
      query: e.query,
      sessionId: e.sessionId,
      timestamp: e.timestamp,
      ...Object.fromEntries(
        Object.entries(e).filter(
          ([k]) => !['query', 'sessionId', 'timestamp'].includes(k),
        ),
      ),
    }),
  );

  writeFileSync(join(dir, 'queries.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

/**
 * Clean agent home between tests.
 * IMPORTANT: Only delete CONTENTS of .opencode/history/ directory.
 * Do NOT delete .opencode/ or .opencode/history/ directories themselves,
 * because the agent's OpenCodeHeartbeat has an active fs.watch() on them.
 */
export function cleanAgentHome(agentHome: string): void {
  const historyDir = join(agentHome, '.opencode', 'history');
  // Remove files inside history dir but keep the directory itself (FS watcher safe)
  if (existsSync(historyDir)) {
    for (const entry of readdirSync(historyDir)) {
      rmSync(join(historyDir, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(historyDir, { recursive: true });
  }
}
