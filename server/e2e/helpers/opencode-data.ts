/**
 * JSONL fixture helpers for OpenCode E2E regression tests.
 *
 * Writes JSONL files into TEST_AGENT_HOME/.opencode/history/ so that
 * the real agent process (OpenCodeHeartbeat + OpenCodeSource) picks them up.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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

/**
 * Path to the agent's PromptStore SQLite DB.
 * When agent runs with cwd=TEST_AGENT_HOME, the DB is at ./data/session-cache.db.
 */
function getPromptStoreDbPath(agentHome: string): string {
  return join(agentHome, 'data', 'session-cache.db');
}

/**
 * Write query entries directly to the agent's PromptStore SQLite DB.
 *
 * The agent's /api/queries endpoint reads from SQLite (PromptStore) first,
 * NOT from queries.jsonl when source='opencode'. So we must inject test data
 * directly into the DB for queries to appear in the pipeline.
 */
export function writeQueriesToPromptStore(
  agentHome: string,
  entries: Array<{
    query: string;
    sessionId: string;
    timestamp: number;
    [key: string]: unknown;
  }>,
): void {
  const dbPath = getPromptStoreDbPath(agentHome);
  mkdirSync(join(agentHome, 'data'), { recursive: true });

  // Create table (idempotent — agent also creates it on startup)
  const createSql = [
    'CREATE TABLE IF NOT EXISTS prompt_history (',
    '  id TEXT PRIMARY KEY,',
    '  session_id TEXT NOT NULL,',
    '  session_title TEXT,',
    '  timestamp INTEGER NOT NULL,',
    '  query TEXT NOT NULL,',
    '  is_background INTEGER DEFAULT 0,',
    '  source TEXT DEFAULT \'opencode\',',
    '  collected_at INTEGER NOT NULL',
    ')'
  ].join(' ');
  execSync(`sqlite3 "${dbPath}" "${createSql}"`);

  // Insert entries
  const now = Date.now();
  for (const entry of entries) {
    const id = `${entry.sessionId}-${entry.timestamp}`;
    const escapedQuery = entry.query.replace(/'/g, "''");
    const sql = `INSERT OR REPLACE INTO prompt_history (id, session_id, session_title, timestamp, query, is_background, source, collected_at) VALUES ('${id}', '${entry.sessionId}', NULL, ${entry.timestamp}, '${escapedQuery}', 0, 'opencode', ${now})`;
    execSync(`sqlite3 "${dbPath}" "${sql}"`);
  }
}

/**
 * Clean the PromptStore DB between tests.
 * Deletes all rows from prompt_history table.
 */
export function cleanPromptStore(agentHome: string): void {
  const dbPath = getPromptStoreDbPath(agentHome);
  if (existsSync(dbPath)) {
    try {
      execSync(`sqlite3 "${dbPath}" "DELETE FROM prompt_history"`);
    } catch {
      // DB might not exist yet or table might not exist — ignore
    }
  }
}
