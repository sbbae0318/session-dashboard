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
    heartbeat = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'empty-projects'));
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
    // Heartbeat 5 hours old → stale (TTL is 4 hours)
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_stale',
      pid: 10,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 6 * 60 * 60 * 1000,
      lastHeartbeat: now - 5 * 60 * 60 * 1000,
    });
    // Fresh heartbeat
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_fresh',
      pid: 20,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 1 * 60 * 60 * 1000,
      lastHeartbeat: now - 1 * 60 * 60 * 1000,
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
    const hb = new ClaudeHeartbeat(noDir, join(tmpDir, 'empty-projects'));

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

describe('ClaudeHeartbeat — project scanning', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should detect active sessions from recently modified project JSONL files', async () => {
    const sessionId = 'abc123-def456';
    const projectDir = join(projectsDir, '-Users-user-project-foo');
    mkdirSync(projectDir, { recursive: true });

    // Write a conversation JSONL (recently modified = active)
    const conversation = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    // No heartbeat files — only project JSONL
    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.sessionId).toBe(sessionId);
    expect(session.source).toBe('claude-code');
    expect(session.status).toBe('idle'); // last entry is assistant text
    expect(session.lastFileModified).toBeGreaterThan(0); // JSONL mtime
    hb.stop();
  });

  it('should detect busy status from project JSONL when last entry is user message', async () => {
    const sessionId = 'busy-session-001';
    const projectDir = join(projectsDir, '-Users-user-project-bar');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'do more work' } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.status).toBe('busy');
    hb.stop();
  });

  it('should not detect sessions from project JSONL files older than STALE_TTL_MS', async () => {
    const sessionId = 'old-session-001';
    const projectDir = join(projectsDir, '-Users-user-project-old');
    mkdirSync(projectDir, { recursive: true });

    const filePath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n', 'utf-8');

    // Manually set mtime to 5 hours ago (older than STALE_TTL_MS = 4 hours)
    const { utimesSync } = await import('node:fs');
    const oldTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, oldTime, oldTime);

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(hb.getActiveSessions()).toHaveLength(0);
    hb.stop();
  });
});

describe('ClaudeHeartbeat — title extraction', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should extract title from first user message in JSONL', async () => {
    const sessionId = 'title-test-001';
    const projectDir = join(projectsDir, '-Users-user-project-title');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', message: { content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Sure!' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.title).toBe('Fix the login bug');
    hb.stop();
  });

  it('should extract title from array content with text part', async () => {
    const sessionId = 'title-array-001';
    const projectDir = join(projectsDir, '-Users-user-project-array');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'Deploy to production' }] },
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.title).toBe('Deploy to production');
    hb.stop();
  });

  it('should return null title when no user message exists', async () => {
    const sessionId = 'title-none-001';
    const projectDir = join(projectsDir, '-Users-user-project-none');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.title).toBeNull();
    hb.stop();
  });

  it('should truncate title to 100 characters', async () => {
    const sessionId = 'title-long-001';
    const projectDir = join(projectsDir, '-Users-user-project-long');
    mkdirSync(projectDir, { recursive: true });

    const longMessage = 'A'.repeat(200);
    const conversation = [
      JSON.stringify({ type: 'user', message: { content: longMessage } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.title).toBe('A'.repeat(100));
    hb.stop();
  });
});

describe('ClaudeHeartbeat — lastPromptTime extraction', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should extract lastPromptTime from last user entry timestamp in ms', async () => {
    const sessionId = 'prompt-time-001';
    const projectDir = join(projectsDir, '-Users-user-project-pt');
    mkdirSync(projectDir, { recursive: true });

    const ts1 = '2026-03-08T16:08:50.930Z';
    const ts2 = '2026-03-08T17:30:00.000Z';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: ts1, message: { content: 'first prompt' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-08T16:10:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'user', timestamp: ts2, message: { content: 'second prompt' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-08T17:31:00.000Z', message: { content: [{ type: 'text', text: 'reply2' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.lastPromptTime).toBe(new Date(ts2).getTime());
    hb.stop();
  });

  it('should return null lastPromptTime when no user entry exists', async () => {
    const sessionId = 'prompt-time-none';
    const projectDir = join(projectsDir, '-Users-user-project-ptn');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-08T16:10:00.000Z', message: { content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.lastPromptTime).toBeNull();
    hb.stop();
  });

  it('should return null lastPromptTime when user entry has no timestamp field', async () => {
    const sessionId = 'prompt-time-nots';
    const projectDir = join(projectsDir, '-Users-user-project-ptnt');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', message: { content: 'no timestamp here' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.lastPromptTime).toBeNull();
    hb.stop();
  });
});

describe('ClaudeHeartbeat — lastFileModified', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should set lastFileModified from JSONL mtime when heartbeat file exists', async () => {
    const now = Date.now();
    const sessionId = 'lfm-test-001';
    const projectDir = join(projectsDir, '-tmp-test-project');
    mkdirSync(projectDir, { recursive: true });

    // Write JSONL file
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: new Date(now - 60000).toISOString(), message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 30000).toISOString(), message: { content: [{ type: 'text', text: 'Hi!' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    // Write heartbeat with lastHeartbeat far in the future
    writeHeartbeat(tmpDir, {
      sessionId,
      pid: 100,
      cwd: '/tmp/test-project',
      project: 'test-project',
      startTime: now - 120000,
      lastHeartbeat: now + 999999, // heartbeat is much newer than JSONL
    });

    const hb = new ClaudeHeartbeat(tmpDir, projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    const session = hb.getActiveSessions()[0]!;
    // lastFileModified should be the JSONL mtime, NOT lastHeartbeat
    expect(session.lastFileModified).toBeLessThan(now + 999999);
    expect(session.lastFileModified).toBeGreaterThan(0);
    // lastHeartbeat should still be the heartbeat value
    expect(session.lastHeartbeat).toBe(now + 999999);
    hb.stop();
  });

  it('should fallback lastFileModified to lastHeartbeat when JSONL is missing', async () => {
    const now = Date.now();
    const sessionId = 'lfm-fallback-001';

    // Write heartbeat without corresponding JSONL
    writeHeartbeat(tmpDir, {
      sessionId,
      pid: 101,
      cwd: '/tmp/no-project',
      project: 'no-project',
      startTime: now - 60000,
      lastHeartbeat: now,
    });

    const hb = new ClaudeHeartbeat(tmpDir, projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    });

    const session = hb.getActiveSessions()[0]!;
    // No JSONL file → fallback to lastHeartbeat
    expect(session.lastFileModified).toBe(now);
    hb.stop();
  });
});

describe('ClaudeHeartbeat — lastResponseTime extraction', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should extract lastResponseTime from last assistant entry timestamp', async () => {
    const sessionId = 'resp-time-001';
    const projectDir = join(projectsDir, '-Users-user-project-rt');
    mkdirSync(projectDir, { recursive: true });

    const assistantTs = '2026-03-08T15:35:09.082Z';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-08T15:30:00.000Z', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-08T15:30:05.000Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-03-08T15:35:00.000Z', message: { content: 'again' } }),
      JSON.stringify({ type: 'assistant', timestamp: assistantTs, message: { content: [{ type: 'text', text: 'reply' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.lastResponseTime).toBe(new Date(assistantTs).getTime());
    hb.stop();
  });

  it('should return null when no assistant entry exists', async () => {
    const sessionId = 'resp-time-none';
    const projectDir = join(projectsDir, '-Users-user-project-rtn');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-08T15:30:00.000Z', message: { content: 'hello' } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.lastResponseTime).toBeNull();
    hb.stop();
  });

  it('should return null when assistant entry has no timestamp', async () => {
    const sessionId = 'resp-time-nots';
    const projectDir = join(projectsDir, '-Users-user-project-rtnt');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-08T15:30:00.000Z', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    expect(hb.getActiveSessions()[0]!.lastResponseTime).toBeNull();
    hb.stop();
  });
});

describe('ClaudeHeartbeat — PID liveness + eviction', () => {
  let tmpDir: string;
  let heartbeat: ClaudeHeartbeat;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    heartbeat = new ClaudeHeartbeat(tmpDir, join(tmpDir, 'empty-projects'));
  });

  afterEach(() => {
    heartbeat.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should NOT evict session when PID is alive even if TTL expired', async () => {
    const now = Date.now();
    // Use current process PID (guaranteed alive)
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_alive',
      pid: process.pid,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 6 * 60 * 60 * 1000,
      lastHeartbeat: now - 5 * 60 * 60 * 1000,
      lastFileModified: now - 5 * 60 * 60 * 1000,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    // PID alive → TTL 초과해도 evict 안 됨
    expect(heartbeat.getActiveSessions()).toHaveLength(1);
    expect(heartbeat.getActiveSessions()[0]!.sessionId).toBe('ses_alive');
  });

  it('should evict session when PID is dead AND TTL expired', async () => {
    const now = Date.now();
    // Use a PID that almost certainly does not exist
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_dead',
      pid: 999999999,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 6 * 60 * 60 * 1000,
      lastHeartbeat: now - 5 * 60 * 60 * 1000,
      lastFileModified: now - 5 * 60 * 60 * 1000,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    // PID dead + TTL 초과 → evict
    expect(heartbeat.getActiveSessions()).toHaveLength(0);
  });

  it('should keep session when PID is dead but TTL not expired', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_recent',
      pid: 999999999,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 2 * 60 * 60 * 1000,
      lastHeartbeat: now - 1 * 60 * 60 * 1000,
      lastFileModified: now - 1 * 60 * 60 * 1000,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    // PID dead + TTL 미초과 → 유지
    expect(heartbeat.getActiveSessions()).toHaveLength(1);
    expect(heartbeat.getActiveSessions()[0]!.sessionId).toBe('ses_recent');
  });

  it('should evict pid=0 session when TTL expired', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_zero_stale',
      pid: 0,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 6 * 60 * 60 * 1000,
      lastHeartbeat: now - 5 * 60 * 60 * 1000,
      lastFileModified: now - 5 * 60 * 60 * 1000,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    // pid=0 → PID 체크 스킵 + TTL 초과 → evict
    expect(heartbeat.getActiveSessions()).toHaveLength(0);
  });

  it('should keep pid=0 session when TTL not expired', async () => {
    const now = Date.now();
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_zero_fresh',
      pid: 0,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 2 * 60 * 60 * 1000,
      lastHeartbeat: now - 1 * 60 * 60 * 1000,
      lastFileModified: now - 1 * 60 * 60 * 1000,
    });

    heartbeat.start();
    await vi.waitFor(() => {
      expect(heartbeat.getActiveSessions()).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (heartbeat as any).evictStale();

    // pid=0 + TTL 미초과 → 유지
    expect(heartbeat.getActiveSessions()).toHaveLength(1);
    expect(heartbeat.getActiveSessions()[0]!.sessionId).toBe('ses_zero_fresh');
  });
});

describe('ClaudeHeartbeat — parseConversationFile (single-pass)', () => {
  let tmpDir: string;
  let hb: ClaudeHeartbeat;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    hb = new ClaudeHeartbeat(join(tmpDir, 'heartbeats'), join(tmpDir, 'projects'));
  });

  afterEach(() => {
    hb.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('happy path: user+assistant → status=idle, correct title, lastPrompt, timestamps', async () => {
    const ts1 = '2026-03-10T10:00:00.000Z';
    const ts2 = '2026-03-10T10:01:00.000Z';
    const ts3 = '2026-03-10T10:05:00.000Z';
    const ts4 = '2026-03-10T10:06:00.000Z';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: ts1, message: { content: 'First user prompt' } }),
      JSON.stringify({ type: 'assistant', timestamp: ts2, message: { content: [{ type: 'text', text: 'Reply 1' }] } }),
      JSON.stringify({ type: 'user', timestamp: ts3, message: { content: 'Second user prompt' } }),
      JSON.stringify({ type: 'assistant', timestamp: ts4, message: { content: [{ type: 'text', text: 'Reply 2' }] } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'conv.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.status).toBe('idle');
    expect(result.title).toBe('First user prompt');
    expect(result.lastPrompt).toBe('Second user prompt');
    expect(result.lastPromptTime).toBe(new Date(ts3).getTime());
    expect(result.lastResponseTime).toBe(new Date(ts4).getTime());
  });

  it('empty file → status=busy, title=null, lastPrompt=null', async () => {
    const filePath = join(tmpDir, 'empty.jsonl');
    writeFileSync(filePath, '', 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.status).toBe('busy');
    expect(result.title).toBeNull();
    expect(result.lastPrompt).toBeNull();
    expect(result.lastPromptTime).toBeNull();
    expect(result.lastResponseTime).toBeNull();
  });

  it('incomplete last line → uses previous complete line for status', async () => {
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
      '{"type": "user", "timestamp": "2026-03-10T10:02:00.000Z", "message": {"content": "broken',
    ].join('\n');

    const filePath = join(tmpDir, 'incomplete.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    // Last parseable entry is assistant text → idle
    expect(result.status).toBe('idle');
  });

  it('user-only → status=busy, lastResponseTime=null', async () => {
    const ts = '2026-03-10T10:00:00.000Z';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'only user message' } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'user-only.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.status).toBe('busy');
    expect(result.title).toBe('only user message');
    expect(result.lastPrompt).toBe('only user message');
    expect(result.lastPromptTime).toBe(new Date(ts).getTime());
    expect(result.lastResponseTime).toBeNull();
  });

  it('assistant-only → status=idle, lastPromptTime=null, lastPrompt=null', async () => {
    const ts = '2026-03-10T10:00:00.000Z';
    const conversation = [
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'assistant-only.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.status).toBe('idle');
    expect(result.title).toBeNull();
    expect(result.lastPrompt).toBeNull();
    expect(result.lastPromptTime).toBeNull();
    expect(result.lastResponseTime).toBe(new Date(ts).getTime());
  });

  it('tool_use assistant → status=busy', async () => {
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: 'fix bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'tool_use', name: 'mcp_bash', id: 'tool_1', input: {} }] } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'tool-use.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.status).toBe('busy');
  });

  it('lastPrompt 200자 제한: 200자 초과 → truncate', async () => {
    const longContent = 'X'.repeat(300);
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: longContent } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'long-prompt.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.lastPrompt).toHaveLength(200);
    expect(result.lastPrompt).toBe('X'.repeat(200));
    // title은 100자 제한
    expect(result.title).toHaveLength(100);
    expect(result.title).toBe('X'.repeat(100));
  });

  it('array content lastPrompt: content가 array인 경우 text part 추출', async () => {
    const conversation = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-03-10T10:00:00.000Z',
        message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'Describe this image' }] },
      }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'I see...' }] } }),
    ].join('\n') + '\n';

    const filePath = join(tmpDir, 'array-content.jsonl');
    writeFileSync(filePath, conversation, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (hb as any).parseConversationFile(filePath);
    expect(result).not.toBeNull();
    expect(result.lastPrompt).toBe('Describe this image');
    expect(result.title).toBe('Describe this image');
  });
});

describe('ClaudeHeartbeat — lastPrompt filtering', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should pass through normal user prompt as lastPrompt', async () => {
    const sessionId = 'lp-normal-001';
    const projectDir = join(projectsDir, '-Users-user-project-lp');
    mkdirSync(projectDir, { recursive: true });

    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'Sure!' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.lastPrompt).toBe('Fix the login bug');
    hb.stop();
  });

  it('should filter system prompt to null (SYSTEM DIRECTIVE)', async () => {
    const sessionId = 'lp-system-001';
    const projectDir = join(projectsDir, '-Users-user-project-lps');
    mkdirSync(projectDir, { recursive: true });

    const systemContent = '[SYSTEM DIRECTIVE: do not respond] This is a system message';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: 'Normal first message' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:05:00.000Z', message: { content: systemContent } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.lastPrompt).toBeNull();
    hb.stop();
  });

  it('should strip [search-mode] prefix from lastPrompt', async () => {
    const sessionId = 'lp-search-001';
    const projectDir = join(projectsDir, '-Users-user-project-lpm');
    mkdirSync(projectDir, { recursive: true });

    const searchContent = '[search-mode]\n---\nActual question';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: searchContent } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.lastPrompt).toBe('Actual question');
    hb.stop();
  });

  it('should truncate lastPrompt to 200 chars (via parseConversationFile)', async () => {
    const sessionId = 'lp-truncate-001';
    const projectDir = join(projectsDir, '-Users-user-project-lpt');
    mkdirSync(projectDir, { recursive: true });

    const longContent = 'A'.repeat(300);
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: longContent } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    // 200자 제한은 parseConversationFile에서 적용, extractUserPrompt()는 그 위에 적용
    expect(session.lastPrompt).not.toBeNull();
    expect(session.lastPrompt!.length).toBeLessThanOrEqual(200);
    hb.stop();
  });

  it('should filter <system-reminder> prefix to null', async () => {
    const sessionId = 'lp-sysrem-001';
    const projectDir = join(projectsDir, '-Users-user-project-lpsr');
    mkdirSync(projectDir, { recursive: true });

    const systemContent = '<system-reminder>\nSome system content here';
    const conversation = [
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:00:00.000Z', message: { content: 'Normal first' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-03-10T10:05:00.000Z', message: { content: systemContent } }),
    ].join('\n') + '\n';
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), conversation, 'utf-8');

    const hb = new ClaudeHeartbeat(join(tmpDir, 'empty-heartbeats'), projectsDir);
    hb.start();
    await vi.waitFor(() => {
      expect(hb.getActiveSessions()).toHaveLength(1);
    }, { timeout: 3000 });

    const session = hb.getActiveSessions()[0]!;
    expect(session.lastPrompt).toBeNull();
    hb.stop();
  });
});
