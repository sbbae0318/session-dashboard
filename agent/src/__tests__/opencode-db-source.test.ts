import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeDBReader } from '../opencode-db-reader.js';
import { OpenCodeDbSource, determineStatus } from '../opencode-db-source.js';

// =============================================================================
// determineStatus — pure function tests
// =============================================================================

describe('determineStatus', () => {
  const IDLE_THRESHOLD = 5 * 60 * 1000;
  const NOW = 1700000000000;

  it('returns idle for null lastRole (no messages)', () => {
    expect(determineStatus(null, null, NOW, NOW, IDLE_THRESHOLD)).toBe('idle');
  });

  it('returns busy when last message is user', () => {
    expect(determineStatus('user', null, NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('busy');
  });

  it('returns idle when assistant finish=stop', () => {
    expect(determineStatus('assistant', 'stop', NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('idle');
  });

  it('returns busy when assistant finish=tool-calls', () => {
    expect(determineStatus('assistant', 'tool-calls', NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('busy');
  });

  it('returns busy when assistant finish=null (streaming)', () => {
    expect(determineStatus('assistant', null, NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('busy');
  });

  it('returns idle when assistant finish=length (abnormal)', () => {
    expect(determineStatus('assistant', 'length', NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('idle');
  });

  it('returns idle when assistant finish=unknown (abnormal)', () => {
    expect(determineStatus('assistant', 'unknown', NOW - 1000, NOW, IDLE_THRESHOLD)).toBe('idle');
  });

  it('forces idle when stale (last message > threshold ago)', () => {
    const stale = NOW - (6 * 60 * 1000); // 6 min ago
    expect(determineStatus('user', null, stale, NOW, IDLE_THRESHOLD)).toBe('idle');
    expect(determineStatus('assistant', 'tool-calls', stale, NOW, IDLE_THRESHOLD)).toBe('idle');
  });

  it('does NOT force idle within threshold', () => {
    const recent = NOW - (4 * 60 * 1000); // 4 min ago
    expect(determineStatus('user', null, recent, NOW, IDLE_THRESHOLD)).toBe('busy');
  });
});

// =============================================================================
// OpenCodeDbSource — integration tests
// =============================================================================

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER,
      sandboxes TEXT, vcs TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
      directory TEXT, title TEXT, version TEXT, slug TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE todo (
      session_id TEXT, content TEXT, status TEXT,
      priority TEXT, position INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
  `);
  return db;
}

function seedSession(db: Database.Database, opts: {
  sessionId: string;
  role: 'user' | 'assistant';
  finish?: string;
  msgTimeCreated: number;
  sessionTimeUpdated: number;
  userText?: string;
}) {
  db.prepare('INSERT OR IGNORE INTO project VALUES (?, ?, ?, ?, NULL, NULL)').run(
    'p1', '/tmp/proj', 1700000000000, 1700000000000,
  );
  db.prepare('INSERT OR IGNORE INTO session VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, 0, ?, ?)').run(
    opts.sessionId, 'p1', '/tmp/proj', `Session ${opts.sessionId}`, 'v1', opts.sessionId,
    opts.msgTimeCreated, opts.sessionTimeUpdated,
  );
  const data = JSON.stringify({
    role: opts.role,
    ...(opts.finish !== undefined ? { finish: opts.finish } : {}),
    time: { created: opts.msgTimeCreated },
  });
  const msgId = `msg_${opts.sessionId}_${opts.msgTimeCreated}`;
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    msgId, opts.sessionId, opts.msgTimeCreated, opts.msgTimeCreated, data,
  );
  if (opts.userText && opts.role === 'user') {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
      `part_${msgId}`, msgId, opts.sessionId, opts.msgTimeCreated, opts.msgTimeCreated,
      JSON.stringify({ type: 'text', text: opts.userText }),
    );
  }
}

describe('OpenCodeDbSource — getSessionDetails', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;
  let source: OpenCodeDbSource;
  let dbFilePath: string;

  beforeEach(() => {
    // Use file-based DB so mtime tracking works
    dbFilePath = join(tmpdir(), `opencode-db-source-test-${Date.now()}.db`);
    // Create empty file for the reader
    writeFileSync(dbFilePath, '');
    unlinkSync(dbFilePath);

    db = createTestDb();
    const now = Date.now();
    // Active session: user message, recent → busy
    seedSession(db, {
      sessionId: 's_active',
      role: 'user',
      msgTimeCreated: now - 1000,
      sessionTimeUpdated: now - 1000,
      userText: 'Hello there',
    });
    // Done session: assistant stop, recent → idle
    seedSession(db, {
      sessionId: 's_done',
      role: 'assistant',
      finish: 'stop',
      msgTimeCreated: now - 2000,
      sessionTimeUpdated: now - 2000,
    });

    reader = OpenCodeDBReader.fromDatabase(db);
    source = new OpenCodeDbSource(reader, {
      dbPath: dbFilePath, // Won't be accessed if we manually call refreshSessions
      pollIntervalMs: 10_000, // Don't auto-poll during test
    });
  });

  afterEach(() => {
    source.stop();
    db.close();
    try { unlinkSync(dbFilePath); } catch { /* ignore */ }
  });

  it('returns SessionDetail-shaped sessions', () => {
    source.start(); // triggers initial refreshSessions()
    const result = source.getSessionDetails();
    expect(result.meta.sseConnected).toBe(false);
    expect(Object.keys(result.sessions).length).toBe(2);
  });

  it('maps busy status correctly', () => {
    source.start();
    const result = source.getSessionDetails();
    expect(result.sessions['s_active'].status).toBe('busy');
    expect(result.sessions['s_done'].status).toBe('idle');
  });

  it('extracts lastPrompt from part table', () => {
    source.start();
    const result = source.getSessionDetails();
    expect(result.sessions['s_active'].lastPrompt).toBe('Hello there');
  });

  it('sets waitingForInput to false always', () => {
    source.start();
    const result = source.getSessionDetails();
    for (const s of Object.values(result.sessions)) {
      expect(s.waitingForInput).toBe(false);
    }
  });

  it('returns directory from project.worktree', () => {
    source.start();
    const result = source.getSessionDetails();
    expect(result.sessions['s_active'].directory).toBe('/tmp/proj');
  });
});

describe('OpenCodeDbSource — getSupplementData', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;
  let source: OpenCodeDbSource;
  let dbFilePath: string;

  beforeEach(() => {
    dbFilePath = join(tmpdir(), `opencode-db-source-supp-${Date.now()}.db`);
    db = createTestDb();
    const now = Date.now();
    seedSession(db, {
      sessionId: 's_with_prompt',
      role: 'user',
      msgTimeCreated: now - 1000,
      sessionTimeUpdated: now - 1000,
      userText: 'Test prompt',
    });
    seedSession(db, {
      sessionId: 's_no_prompt',
      role: 'assistant',
      finish: 'stop',
      msgTimeCreated: now - 2000,
      sessionTimeUpdated: now - 2000,
    });

    reader = OpenCodeDBReader.fromDatabase(db);
    source = new OpenCodeDbSource(reader, {
      dbPath: dbFilePath,
      pollIntervalMs: 10_000,
    });
    source.start();
  });

  afterEach(() => {
    source.stop();
    db.close();
    try { unlinkSync(dbFilePath); } catch { /* ignore */ }
  });

  it('only includes sessions with lastPrompt', () => {
    const supplement = source.getSupplementData();
    expect(supplement['s_with_prompt']).toBeDefined();
    expect(supplement['s_no_prompt']).toBeUndefined();
  });

  it('returns SupplementData shape (lastPrompt, lastPromptTime, status, title)', () => {
    const supplement = source.getSupplementData();
    const entry = supplement['s_with_prompt'];
    expect(entry.lastPrompt).toBe('Test prompt');
    expect(entry.lastPromptTime).toBeGreaterThan(0);
    expect(entry.status).toBe('busy');
    expect(entry.title).toBe('Session s_with_prompt');
  });
});

describe('OpenCodeDbSource — mtime-based polling', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;
  let dbFilePath: string;

  beforeEach(() => {
    dbFilePath = join(tmpdir(), `opencode-db-source-mtime-${Date.now()}.db`);
    writeFileSync(dbFilePath, 'dummy');
    db = createTestDb();
    reader = OpenCodeDBReader.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbFilePath); } catch { /* ignore */ }
  });

  it('does not skip initial refresh even without mtime change', () => {
    const now = Date.now();
    seedSession(db, {
      sessionId: 's_test',
      role: 'user',
      msgTimeCreated: now - 1000,
      sessionTimeUpdated: now - 1000,
    });
    const source = new OpenCodeDbSource(reader, {
      dbPath: dbFilePath,
      pollIntervalMs: 10_000,
    });
    source.start();
    const result = source.getSessionDetails();
    expect(Object.keys(result.sessions).length).toBe(1);
    source.stop();
  });

  it('handles missing DB file gracefully', () => {
    const source = new OpenCodeDbSource(reader, {
      dbPath: '/nonexistent/path/opencode.db',
      pollIntervalMs: 10_000,
    });
    source.start();
    // Should not throw — hasDbChanged returns false on stat failure
    expect(source.getMonitoredSessions().length).toBeGreaterThanOrEqual(0);
    source.stop();
  });
});
