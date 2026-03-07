import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { AgentConfig } from '../types.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `srv-claude-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(
  overrides: Partial<AgentConfig> & { historyDir: string },
): AgentConfig {
  return {
    port: 0,
    apiKey: '',   // empty = dev mode (no auth)
    ocServePort: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server — Claude routes', () => {
  let tmpDir: string;
  let claudeDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    claudeDir = join(tmpDir, 'claude');
    mkdirSync(claudeDir, { recursive: true });

    // Create heartbeats dir for ClaudeHeartbeat
    mkdirSync(join(tmpDir, 'heartbeats'), { recursive: true });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── source="both" registers Claude routes ──

  it('should register Claude routes when source="both"', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'both',
      }),
    );
    app = result.app;

    // Claude routes should respond
    const sessionsRes = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    expect(sessionsRes.statusCode).toBe(200);

    const queriesRes = await app.inject({ method: 'GET', url: '/api/claude/queries' });
    expect(queriesRes.statusCode).toBe(200);
  });

  // ── source="claude-code" also registers Claude routes ──

  it('should register Claude routes when source="claude-code"', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'claude-code',
      }),
    );
    app = result.app;

    const sessionsRes = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    expect(sessionsRes.statusCode).toBe(200);
  });

  // ── source="opencode" does NOT register Claude routes ──

  it('should NOT register Claude routes when source="opencode"', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const sessionsRes = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    expect(sessionsRes.statusCode).toBe(404);

    const queriesRes = await app.inject({ method: 'GET', url: '/api/claude/queries' });
    expect(queriesRes.statusCode).toBe(404);
  });

  // ── /health includes claudeSourceConnected ──

  it('should include claudeSourceConnected in /health when Claude enabled', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'both',
      }),
    );
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.claudeSourceConnected).toBe(true);
  });

  it('should NOT include claudeSourceConnected in /health when Claude disabled', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.claudeSourceConnected).toBeUndefined();
  });

  // ── /api/claude/sessions returns JSON ──

  it('should return { sessions: [] } from /api/claude/sessions', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'claude-code',
      }),
    );
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('sessions');
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  // ── /api/claude/queries returns JSON ──

  it('should return { queries: [] } from /api/claude/queries', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'claude-code',
      }),
    );
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/claude/queries' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('queries');
    expect(Array.isArray(body.queries)).toBe(true);
  });

  // ── /api/claude/queries respects limit ──

  it('should respect limit param for /api/claude/queries', async () => {
    // Write history.jsonl with entries
    const now = Date.now();
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ display: `q${i}`, timestamp: now + i, sessionId: `s${i}` }),
    ).join('\n');
    writeFileSync(join(claudeDir, 'history.jsonl'), lines + '\n', 'utf-8');

    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: claudeDir,
        source: 'claude-code',
      }),
    );
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/claude/queries?limit=3' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.queries).toHaveLength(3);
  });
});
