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
    // Heartbeat 8 days old → stale (TTL is 7 days)
    writeHeartbeat(tmpDir, {
      sessionId: 'ses_stale',
      pid: 10,
      cwd: '/tmp',
      project: 'p',
      startTime: now - 9 * 24 * 60 * 60 * 1000,
      lastHeartbeat: now - 8 * 24 * 60 * 60 * 1000,
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

    // Manually set mtime to 8 days ago (older than STALE_TTL_MS = 7 days)
    const { utimesSync } = await import('node:fs');
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
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
