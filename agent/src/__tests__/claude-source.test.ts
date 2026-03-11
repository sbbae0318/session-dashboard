import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeSource, type ClaudeQueryEntry } from '../claude-source.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-src-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface HistoryLine {
  display: string;
  timestamp: number;
  sessionId: string;
  project?: string;
}

function writeHistory(dir: string, entries: HistoryLine[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, 'history.jsonl'), lines + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSource', () => {
  let tmpDir: string;
  let source: ClaudeSource;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    source = new ClaudeSource(tmpDir);
  });

  afterEach(() => {
    source.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── basic reading ──

  it('should read history.jsonl and return ClaudeQueryEntry[]', async () => {
    const now = Date.now();
    writeHistory(tmpDir, [
      { display: 'What is TypeScript?', timestamp: now - 2000, sessionId: 'ses_a' },
      { display: 'Explain generics', timestamp: now - 1000, sessionId: 'ses_b' },
      { display: 'Help me debug', timestamp: now, sessionId: 'ses_c' },
    ]);

    const entries = await source.getRecentQueries(10);

    expect(entries).toHaveLength(3);
    expect(entries[0]!.query).toBe('What is TypeScript?');
    expect(entries[1]!.query).toBe('Explain generics');
    expect(entries[2]!.query).toBe('Help me debug');
  });

  // ── source field ──

  it('should always set source to "claude-code"', async () => {
    writeHistory(tmpDir, [
      { display: 'hello', timestamp: Date.now(), sessionId: 'ses_1' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source).toBe('claude-code');
  });

  // ── sessionTitle ──

  it('should always set sessionTitle to null', async () => {
    writeHistory(tmpDir, [
      { display: 'test', timestamp: Date.now(), sessionId: 'ses_t' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries[0]!.sessionTitle).toBeNull();
  });

  // ── isBackground ──

  it('should always set isBackground to false', async () => {
    writeHistory(tmpDir, [
      { display: 'query', timestamp: Date.now(), sessionId: 'ses_bg' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries[0]!.isBackground).toBe(false);
  });

  // ── limit ──

  it('should respect the limit parameter', async () => {
    const now = Date.now();
    const entries: HistoryLine[] = Array.from({ length: 20 }, (_, i) => ({
      display: `query ${i}`,
      timestamp: now + i,
      sessionId: `ses_${i}`,
    }));
    writeHistory(tmpDir, entries);

    const result = await source.getRecentQueries(5);
    expect(result).toHaveLength(5);
    // Should return the *last* 5 entries
    expect(result[0]!.query).toBe('query 15');
    expect(result[4]!.query).toBe('query 19');
  });

  // ── empty file ──

  it('should return empty array for empty file', async () => {
    writeFileSync(join(tmpDir, 'history.jsonl'), '', 'utf-8');

    const entries = await source.getRecentQueries(10);
    expect(entries).toEqual([]);
  });

  // ── missing file ──

  it('should return empty array when history.jsonl does not exist', async () => {
    // tmpDir exists but has no history.jsonl
    const entries = await source.getRecentQueries(10);
    expect(entries).toEqual([]);
  });

  // ── maps display to query ──

  it('should map entry.display to query field', async () => {
    writeHistory(tmpDir, [
      { display: 'Tell me about Rust', timestamp: Date.now(), sessionId: 'ses_r' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries[0]!.query).toBe('Tell me about Rust');
    expect(entries[0]!.sessionId).toBe('ses_r');
  });

  // ── preserves sessionId and timestamp ──

  it('should preserve sessionId and timestamp from source entries', async () => {
    const ts = 1700000000000;
    writeHistory(tmpDir, [
      { display: 'q', timestamp: ts, sessionId: 'ses_preserve' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries[0]!.sessionId).toBe('ses_preserve');
    expect(entries[0]!.timestamp).toBe(ts);
  });

  // ── start/stop are no-ops ──

  it('start() and stop() should not throw', () => {
    expect(() => source.start()).not.toThrow();
    expect(() => source.stop()).not.toThrow();
  });

  // ── slash command filtering ──

  it('should filter out slash commands from history', async () => {
    writeHistory(tmpDir, [
      { display: '/exit', timestamp: Date.now() - 3000, sessionId: 'ses_cmd1' },
      { display: '/help', timestamp: Date.now() - 2000, sessionId: 'ses_cmd2' },
      { display: 'real query here', timestamp: Date.now() - 1000, sessionId: 'ses_real' },
      { display: '/clear', timestamp: Date.now(), sessionId: 'ses_cmd3' },
    ]);

    const entries = await source.getRecentQueries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.query).toBe('real query here');
  });

  it('should filter out empty display strings', async () => {
    writeHistory(tmpDir, [
      { display: '', timestamp: Date.now() - 2000, sessionId: 'ses_empty1' },
      { display: '   ', timestamp: Date.now() - 1000, sessionId: 'ses_empty2' },
      { display: 'valid prompt', timestamp: Date.now(), sessionId: 'ses_valid' },
    ]);

    const entries = await source.getRecentQueries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.query).toBe('valid prompt');
  });

});

describe('ClaudeSource — getRecentQueries with extractUserPrompt', () => {
  let tmpDir: string;
  let source: ClaudeSource;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    source = new ClaudeSource(tmpDir);
  });

  afterEach(() => {
    source.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should filter out system-only prompts ([SYSTEM DIRECTIVE:)', async () => {
    writeHistory(tmpDir, [
      { display: 'Normal query', timestamp: Date.now(), sessionId: 'ses_001' },
      { display: '[SYSTEM DIRECTIVE: do not respond] System message', timestamp: Date.now(), sessionId: 'ses_002' },
      { display: 'Another normal query', timestamp: Date.now(), sessionId: 'ses_003' },
    ]);

    const queries = await source.getRecentQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]!.query).toBe('Normal query');
    expect(queries[1]!.query).toBe('Another normal query');
  });

  it('should filter out <system-reminder> prompts', async () => {
    writeHistory(tmpDir, [
      { display: '<system-reminder>\nSome system content', timestamp: Date.now(), sessionId: 'ses_001' },
    ]);

    const queries = await source.getRecentQueries();
    expect(queries).toHaveLength(0);
  });

  it('should strip [search-mode] prefix and return actual content', async () => {
    writeHistory(tmpDir, [
      { display: '[search-mode]\n---\nActual search query', timestamp: Date.now(), sessionId: 'ses_001' },
    ]);

    const queries = await source.getRecentQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.query).toBe('Actual search query');
  });

  it('should filter "Continue if you have next steps" system prompt', async () => {
    writeHistory(tmpDir, [
      { display: 'Continue if you have next steps to complete', timestamp: Date.now(), sessionId: 'ses_001' },
    ]);

    const queries = await source.getRecentQueries();
    expect(queries).toHaveLength(0);
  });
});

describe('ClaudeSource — completedAt field', () => {
  let tmpDir: string;
  let source: ClaudeSource;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    source = new ClaudeSource(tmpDir);
  });

  afterEach(() => {
    source.stop();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should always set completedAt to null (not extractable from history.jsonl)', async () => {
    writeHistory(tmpDir, [
      { display: 'What is TypeScript?', timestamp: Date.now(), sessionId: 'ses_a' },
      { display: 'Explain generics', timestamp: Date.now(), sessionId: 'ses_b' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.completedAt).toBeNull();
    expect(entries[1]!.completedAt).toBeNull();
  });

  it('should include completedAt in ClaudeQueryEntry shape', async () => {
    writeHistory(tmpDir, [
      { display: 'test query', timestamp: 1700000000000, sessionId: 'ses_shape' },
    ]);

    const entries = await source.getRecentQueries(10);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // Verify full shape
    expect(entry).toEqual({
      sessionId: 'ses_shape',
      sessionTitle: null,
      timestamp: 1700000000000,
      query: 'test query',
      isBackground: false,
      source: 'claude-code',
      completedAt: null,
    });
  });
});