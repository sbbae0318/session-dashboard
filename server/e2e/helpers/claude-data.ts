/**
 * JSONL fixture helpers for Claude Code E2E regression tests.
 *
 * Writes JSONL files into TEST_AGENT_HOME/.claude/ so that
 * the real agent process (ClaudeHeartbeat + ClaudeSource) picks them up.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_AGENT_HOME = '/tmp/sd-e2e-agent-home';
export const TEST_SERVER_HOME = '/tmp/sd-e2e-server-home';

/**
 * Encode an absolute path the same way ClaudeHeartbeat does:
 *   /tmp/testproject → -tmp-testproject
 */
export function encodePath(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
}

/**
 * Write a session JSONL file into the agent's projects directory.
 *
 * The agent's ClaudeHeartbeat watches:
 *   TEST_AGENT_HOME/.claude/projects/{encoded-cwd}/{sessionId}.jsonl
 */
export function writeProjectSession(
  agentHome: string,
  cwd: string,
  sessionId: string,
  entries: Array<{
    type: 'user' | 'assistant';
    content: string | Array<{ type: string; [k: string]: unknown }>;
    timestamp?: string;
  }>,
): string {
  const encoded = encodePath(cwd);
  const dir = join(agentHome, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });

  const lines = entries.map((e) => {
    const base: Record<string, unknown> = { type: e.type, message: { content: e.content } };
    if (e.timestamp) base.timestamp = e.timestamp;
    return JSON.stringify(base);
  });

  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

/**
 * Write history.jsonl (prompt history) for ClaudeSource.
 *
 * Path: TEST_AGENT_HOME/.claude/history.jsonl
 */
export function writeHistory(
  agentHome: string,
  entries: Array<{
    display: string;
    sessionId: string;
    timestamp?: number;
    project?: string;
  }>,
): void {
  const dir = join(agentHome, '.claude');
  mkdirSync(dir, { recursive: true });

  const lines = entries.map((e) =>
    JSON.stringify({
      display: e.display,
      sessionId: e.sessionId,
      timestamp: e.timestamp ?? Date.now(),
      project: e.project ?? 'testproject',
    }),
  );

  writeFileSync(join(dir, 'history.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

/**
 * Clean agent home between tests.
 * IMPORTANT: Only delete CONTENTS of .claude/projects/ subdirectories and history.jsonl.
 * Do NOT delete .claude/ or .claude/projects/ directories themselves,
 * because the agent's ClaudeHeartbeat has an active fs.watch() on them.
 */
export function cleanAgentHome(agentHome: string): void {
  const projectsDir = join(agentHome, '.claude', 'projects');
  // Remove project subdirectories but keep the projects dir itself (FS watcher safe)
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir)) {
      rmSync(join(projectsDir, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(projectsDir, { recursive: true });
  }
  // Remove history.jsonl but keep .claude/ directory
  const historyFile = join(agentHome, '.claude', 'history.jsonl');
  if (existsSync(historyFile)) rmSync(historyFile);
}

/**
 * Set a file's mtime to the past so ClaudeHeartbeat considers it stale.
 * STALE_TTL_MS = 120_000 → set mtime to > 120s ago.
 */
export function makeFileStale(filePath: string, ageMs: number = 180_000): void {
  const past = new Date(Date.now() - ageMs);
  utimesSync(filePath, past, past);
}
