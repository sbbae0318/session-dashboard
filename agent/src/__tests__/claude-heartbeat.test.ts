import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeHeartbeat, type ClaudeSessionInfo } from '../claude-heartbeat.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-hb-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHeartbeat(
  dir: string,
  data: Partial<ClaudeSessionInfo> & { sessionId: string },
): void {
  const filename = `${data.sessionId}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(data), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeHeartbeat', () => {
  let tmpDir: string;
  let heartbeat: ClaudeHeartbeat;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    heartbeat = new ClaudeHeartbeat(tmpDir);
  });

  afterEach(() => {
    heartbeat.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── initial scan ──

  it('should find existing heartbeat files on initial scan', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_001',
      pid: 1234,
      cwd: '/tmp',
      project: 'test-project',
      startTime: now - 60_000,
      lastHeartbeat: now,
    });
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_002',
      pid: 5678,
      cwd: '/tmp/other',
      project: 'other-project',
      startTime: now - 30_000,
      lastHeartbeat: now,
    });

    // start() triggers initialScan asynchronously — give it time
    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(2);
    });

    const ids = heartbeat.getActiveSessions().map((s) => s.sessionId).sort();
    expect(ids).toEqual(['ses_001', 'ses_002']);
  });

  // ── getActiveSessions ──

  it('should return sessions with source "claude-code"', async () => {
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_src',
      pid: 42,
      cwd: '/tmp',
      project: 'p',
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    const session = heartbeat.getActiveSessions()[0]!;
    expect(session.source).toBe('claude-code');
    expect(session.sessionId).toBe('ses_src');
  });

  // ── empty after stop ──

  it('should clear sessions after stop()', async () => {
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_stop',
      pid: 1,
      cwd: '/',
      project: 'x',
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    heartbeat.stop();
    expect(heartbeat.getActiveSessions()).toHaveLength(0);
  });

  // ── stale eviction ──

  it('should evict sessions with stale heartbeats', async () => {
    const now = Date.now();
    // Heartbeat 3 minutes old → stale (TTL is 120s)
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_stale',
      pid: 10,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 300_000,
      lastHeartbeat: now - 180_000,
    });
    // Fresh heartbeat
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_fresh',
      pid: 20,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 10_000,
      lastHeartbeat: now,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions().length).toBeGreaterThanOrEqual(1);
    });

    // Manually trigger eviction via private method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    const remaining = heartbeat.getActiveSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sessionId).toBe('ses_fresh');
  });

  // ── invalid JSON ──

  it('should ignore files with invalid JSON', async () => {
    writeFileSync(join(tmpDir, 'bad.json'), 'NOT VALID JSON', 'utf-8');
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_good',
      pid: 1,
      cwd: '/',
      project: 'x',
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    expect(heartbeat.getActiveSessions()[0]!.sessionId).toBe('ses_good');
  });

  // ── missing sessionId ──

  it('should ignore heartbeat files with empty sessionId', async () => {
    writeHeartbeat(tmpDir, {
      sessionId: '',
      pid: 1,
      cwd: '/',
      project: 'x',
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
    });

    heartbeat.start();
    // Wait a tick for initialScan to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(heartbeat.getActiveSessions()).toHaveLength(0);
  });

  // ── non-existent directory ──

  it('should not crash when heartbeats directory does not exist', async () => {
    const noDir = join(tmpDir, 'does-not-exist');
    const hb = new ClaudeHeartbeat(noDir);

    // Should not throw
    hb.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(hb.getActiveSessions()).toHaveLength(0);
    hb.stop();
  });

  // ── non-json files ignored ──

  it('should ignore non-json files in the directory', async () => {
    writeFileSync(join(tmpDir, 'notes.txt'), 'hello', 'utf-8');
    writeFileSync(join(tmpDir, 'data.csv'), 'a,b,c', 'utf-8');

    heartbeat.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(heartbeat.getActiveSessions()).toHaveLength(0);
  });

  // ── external refresh ──

  it('should detect updated lastHeartbeat from external refresh', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_refresh',
      pid: 99,
      cwd: '/tmp',
      project: 'refresh-project',
      startTime: now - 10_000,
      lastHeartbeat: now,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // Simulate external process updating the heartbeat file
    const updatedTime = now + 60_000;
    writeFileSync(
      join(tmpDir, 'ses_refresh.json'),
      JSON.stringify({
        sessionId: 'ses_refresh',
        pid: 99,
        cwd: '/tmp',
        project: 'refresh-project',
        startTime: now - 10_000,
        lastHeartbeat: updatedTime,
      }),
      'utf-8',
    );

    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()[0]!.lastHeartbeat).toBe(updatedTime);
    });
  });

  // ── status detection ──

  it('should detect idle status when last entry is assistant text', async () => {
    const now = Date.now();
    const sessionId = 'ses_status_test';
    const projectDir = join(tmpDir, 'projects', '-tmp-test-project');
    mkdirSync(projectDir, { recursive: true });

    // Write a conversation JSONL with assistant as last meaningful entry
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: new Date(now - 2000).toISOString(), message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 1000).toISOString(), message: { content: [{ type: 'text', text: 'Hi there!' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    // Write heartbeat
    writeHeartbeat(tmpDir, {
      sessionId,
      pid: 42,
      cwd: '/tmp/test-project',
      project: 'test-project',
      startTime: now,
      lastHeartbeat: now,
    });

    // Create heartbeat with custom projects dir
    const hb = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'projects'));
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    const session = hb.getActiveSessions()[0]!;
    expect(session.status).toBe('idle');
    hb.stop();
  });

  it('should detect busy status when last entry is user message', async () => {
    const now = Date.now();
    const sessionId = 'ses_busy_test';
    const projectDir = join(tmpDir, 'projects', '-tmp-test-project');
    mkdirSync(projectDir, { recursive: true });

    // Write conversation with user as last entry
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: new Date(now - 2000).toISOString(), message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 1000).toISOString(), message: { content: [{ type: 'text', text: 'Hi!' }] } }),
      JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), message: { content: 'do something' } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    writeHeartbeat(tmpDir, {
      sessionId,
      pid: 43,
      cwd: '/tmp/test-project',
      project: 'test-project',
      startTime: now,
      lastHeartbeat: now,
    });

    const hb = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'projects'));
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    expect(hb.getActiveSessions()[0]!.status).toBe('busy');
    hb.stop();
  });

  it('should detect busy status when assistant uses tool_use', async () => {
    const now = Date.now();
    const sessionId = 'ses_tool_test';
    const projectDir = join(tmpDir, 'projects', '-tmp-test-project');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { content: 'fix the bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: [{ type: 'tool_use', name: 'mcp_bash', id: 'tool_1', input: {} }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    writeHeartbeat(tmpDir, {
      sessionId,
      pid: 44,
      cwd: '/tmp/test-project',
      project: 'test-project',
      startTime: now,
      lastHeartbeat: now,
    });

    const hb = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'projects'));
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    expect(hb.getActiveSessions()[0]!.status).toBe('busy');
    hb.stop();
  });

  it('should default to busy when conversation file is missing', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_no_conv',
      pid: 45,
      cwd: '/tmp/no-conversation',
      project: 'test-project',
      startTime: now,
      lastHeartbeat: now,
    });

    // No conversation file created — should default to busy
    const hb = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'projects'));
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    expect(hb.getActiveSessions()[0]!.status).toBe('busy');
    hb.stop();
  });
});
