/**
 * Dashboard Agent — Entry Point
 *
 * Lightweight HTTP agent exposing session history JSONL files
 * and proxying requests to local oc-serve.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createServer } from './server.js';
import type { AgentConfig } from './types.js';

function resolveHistoryDir(raw: string): string {
  if (raw.startsWith('~')) {
    return join(homedir(), raw.slice(1));
  }
  return raw;
}

function loadConfig(): AgentConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '3098', 10),
    apiKey: process.env['API_KEY'] ?? '',
    ocServePort: parseInt(process.env['OC_SERVE_PORT'] ?? '4096', 10),
    historyDir: resolveHistoryDir(process.env['HISTORY_DIR'] ?? '~/.opencode/history'),
    claudeHistoryDir: process.env['CLAUDE_HISTORY_DIR']
      ? resolveHistoryDir(process.env['CLAUDE_HISTORY_DIR'])
      : undefined,
    source: (process.env['SOURCE'] as AgentConfig['source']) ?? 'opencode',
    jwtSecret: process.env['JWT_SECRET'] ?? '',
    openCodeDbPath: process.env['OPENCODE_DB_PATH']
      ? resolveHistoryDir(process.env['OPENCODE_DB_PATH'])
      : undefined,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app: server } = await createServer(config);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    server.log.info('Shutting down gracefully...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  try {
    const address = await server.listen({ port: config.port, host: '0.0.0.0' });
    server.log.info(`dashboard-agent listening at ${address}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void main();
