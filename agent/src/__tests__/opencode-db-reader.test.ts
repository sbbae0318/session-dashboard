import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { OpenCodeDBReader } from '../opencode-db-reader.js';

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

function seedTestData(db: Database.Database): void {
  db.exec(`
    INSERT INTO project VALUES ('proj_1', '/home/user/my-app', 1700000000, 1700100000, NULL, NULL);
    INSERT INTO project VALUES ('proj_2', '/home/user/other', 1700000000, 1700050000, NULL, NULL);
  `);

  db.exec(`
    INSERT INTO session VALUES ('ses_1', 'proj_1', NULL, '/home/user/my-app', 'Implement auth', 'v1', 'implement-auth', 120, 30, 5, 1700000000, 1700010000);
    INSERT INTO session VALUES ('ses_2', 'proj_1', 'ses_1', '/home/user/my-app', 'Fix bug', 'v1', 'fix-bug', 10, 5, 2, 1700010000, 1700020000);
    INSERT INTO session VALUES ('ses_3', 'proj_2', NULL, '/home/user/other', 'Setup project', 'v1', 'setup', 0, 0, 0, 1700030000, 1700040000);
    INSERT INTO session VALUES ('ses_4', 'proj_1', NULL, '/home/user/my-app', 'Empty session', 'v1', 'empty', NULL, NULL, NULL, 1700050000, 1700060000);
  `);

  const assistantMsg = (id: string, sessionId: string, time: number, tokens: { input: number; output: number }, cost: number, model: string) =>
    `INSERT INTO message VALUES ('${id}', '${sessionId}', ${time}, ${time}, '${JSON.stringify({
      role: 'assistant', modelID: model, providerID: 'anthropic', cost,
      tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: 0, write: 0 } },
    }).replace(/'/g, "''")}')`;

  const userMsg = (id: string, sessionId: string, time: number, text: string) =>
    `INSERT INTO message VALUES ('${id}', '${sessionId}', ${time}, ${time}, '${JSON.stringify({
      role: 'user', content: text,
    }).replace(/'/g, "''")}')`;

  db.exec(assistantMsg('msg_1', 'ses_1', 1700001000, { input: 1000, output: 500 }, 0.05, 'claude-sonnet-4-20250514'));
  db.exec(assistantMsg('msg_2', 'ses_1', 1700002000, { input: 2000, output: 800 }, 0.08, 'claude-sonnet-4-20250514'));
  db.exec(assistantMsg('msg_3', 'ses_2', 1700011000, { input: 500, output: 200 }, 0.02, 'claude-opus-4-20250514'));

  db.exec(userMsg('msg_u1', 'ses_1', 1700000500, 'implement user authentication'));
  db.exec(userMsg('msg_u2', 'ses_1', 1700001500, 'add password hashing'));
  db.exec(userMsg('msg_u3', 'ses_1', 1700002500, 'write tests for auth module'));
  db.exec(userMsg('msg_u4', 'ses_2', 1700010500, 'fix the login bug'));

  db.exec(`
    INSERT INTO todo VALUES ('ses_1', 'Implement login', 'completed', 'high', 0, 1700001000, 1700002000);
    INSERT INTO todo VALUES ('ses_1', 'Add tests', 'in_progress', 'medium', 1, 1700002000, 1700003000);
  `);
}

describe('OpenCodeDBReader', () => {
  let reader: OpenCodeDBReader;
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb);
    reader = OpenCodeDBReader.fromDatabase(testDb);
  });

  afterEach(() => {
    try { reader.close(); } catch { /* already closed */ }
  });

  // ── 1. Construction + schema validation ──

  it('creates from in-memory database with valid schema', () => {
    expect(reader.isAvailable()).toBe(true);
  });

  it('isAvailable() returns false after close', () => {
    reader.close();
    expect(reader.isAvailable()).toBe(false);
  });

  // ── 2. getAllProjects ──

  it('getAllProjects() returns project summaries with session counts and token totals', () => {
    const projects = reader.getAllProjects();
    expect(projects).toHaveLength(2);

    const proj1 = projects.find(p => p.id === 'proj_1')!;
    expect(proj1.worktree).toBe('/home/user/my-app');
    expect(proj1.sessionCount).toBe(3);
    expect(proj1.totalInputTokens).toBeGreaterThan(0);
    expect(proj1.totalOutputTokens).toBeGreaterThan(0);
    expect(proj1.totalCost).toBeGreaterThan(0);
    expect(proj1.lastActivity).toBe(1700060000);

    const proj2 = projects.find(p => p.id === 'proj_2')!;
    expect(proj2.sessionCount).toBe(1);
  });

  // ── 3. getProjectSessions ──

  it('getProjectSessions() returns sessions for a project with model info', () => {
    const sessions = reader.getProjectSessions('proj_1');
    expect(sessions).toHaveLength(3);

    const ses1 = sessions.find(s => s.id === 'ses_1')!;
    expect(ses1.title).toBe('Implement auth');
    expect(ses1.models).toContain('claude-sonnet-4-20250514');
  });

  it('getProjectSessions() returns empty array for unknown project', () => {
    expect(reader.getProjectSessions('nonexistent')).toEqual([]);
  });

  // ── 4. getSessionTokenStats ──

  it('getSessionTokenStats() returns token breakdown for a session', () => {
    const stats = reader.getSessionTokenStats('ses_1');
    expect(stats).not.toBeNull();
    expect(stats!.totalInput).toBe(3000);
    expect(stats!.totalOutput).toBe(1300);
    expect(stats!.totalCost).toBeCloseTo(0.13, 5);
    expect(stats!.models).toContain('claude-sonnet-4-20250514');
  });

  it('getSessionTokenStats() returns null for session with no assistant messages', () => {
    expect(reader.getSessionTokenStats('ses_3')).toBeNull();
  });

  // ── 5. getAllProjectsTokenStats ──

  it('getAllProjectsTokenStats() aggregates tokens per project', () => {
    const stats = reader.getAllProjectsTokenStats();
    expect(stats.length).toBeGreaterThanOrEqual(1);

    const proj1Stats = stats.find(s => s.projectId === 'proj_1')!;
    expect(proj1Stats.totalInput).toBe(3500);
    expect(proj1Stats.totalOutput).toBe(1500);
    expect(proj1Stats.totalCost).toBeCloseTo(0.15, 5);
  });

  // ── 6. getSessionCodeImpact ──

  it('getSessionCodeImpact() returns additions/deletions/files', () => {
    const impact = reader.getSessionCodeImpact('ses_1');
    expect(impact).not.toBeNull();
    expect(impact!.additions).toBe(120);
    expect(impact!.deletions).toBe(30);
    expect(impact!.files).toBe(5);
  });

  it('getSessionCodeImpact() returns null for session with null code impact', () => {
    expect(reader.getSessionCodeImpact('ses_4')).toBeNull();
  });

  it('getSessionCodeImpact() returns null for nonexistent session', () => {
    expect(reader.getSessionCodeImpact('nonexistent')).toBeNull();
  });

  // ── 7. getAllSessionsCodeImpact ──

  it('getAllSessionsCodeImpact() returns non-empty impacts with pagination', () => {
    const impacts = reader.getAllSessionsCodeImpact({ limit: 10 });
    expect(impacts.length).toBeGreaterThanOrEqual(2);
    for (const impact of impacts) {
      expect(impact.additions + impact.deletions).toBeGreaterThan(0);
    }
  });

  it('getAllSessionsCodeImpact() filters by projectId', () => {
    const impacts = reader.getAllSessionsCodeImpact({ projectId: 'proj_2' });
    expect(impacts).toHaveLength(0);
  });

  // ── 8. getSessionTimeline ──

  it('getSessionTimeline() returns entries within time range', () => {
    const entries = reader.getSessionTimeline({ from: 1700000000, to: 1700100000 });
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry.timeCreated).toBeGreaterThanOrEqual(1700000000);
      expect(entry.timeCreated).toBeLessThanOrEqual(1700100000);
    }
  });

  it('getSessionTimeline() filters by projectId', () => {
    const entries = reader.getSessionTimeline({ from: 0, to: 2000000000, projectId: 'proj_2' });
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('ses_3');
  });

  it('getSessionTimeline() returns empty for out-of-range', () => {
    expect(reader.getSessionTimeline({ from: 9999999999, to: 9999999999 })).toEqual([]);
  });

  // ── 9. getSessionRecoveryContext ──

  it('getSessionRecoveryContext() returns last user messages and todos', () => {
    const ctx = reader.getSessionRecoveryContext('ses_1');
    expect(ctx).not.toBeNull();
    expect(ctx!.lastUserMessages).toHaveLength(3);
    expect(ctx!.lastUserMessages[0]).toContain('write tests');
    expect(ctx!.todos).toHaveLength(2);
    expect(ctx!.codeImpact).not.toBeNull();
    expect(ctx!.codeImpact!.additions).toBe(120);
  });

  it('getSessionRecoveryContext() returns null for nonexistent session', () => {
    expect(reader.getSessionRecoveryContext('nonexistent')).toBeNull();
  });

  // ── 10. close() ──

  it('close() prevents further operations', () => {
    reader.close();
    expect(() => reader.getAllProjects()).toThrow();
  });

  // ── 11. Empty database ──

  it('handles empty database gracefully', () => {
    const emptyDb = createTestDb();
    const emptyReader = OpenCodeDBReader.fromDatabase(emptyDb);

    expect(emptyReader.getAllProjects()).toEqual([]);
    expect(emptyReader.getProjectSessions('any')).toEqual([]);
    expect(emptyReader.getSessionTokenStats('any')).toBeNull();
    expect(emptyReader.getAllProjectsTokenStats()).toEqual([]);
    expect(emptyReader.getAllSessionsCodeImpact({})).toEqual([]);
    expect(emptyReader.getSessionTimeline({ from: 0, to: 9999999999 })).toEqual([]);
    expect(emptyReader.getSessionRecoveryContext('any')).toBeNull();

    emptyReader.close();
  });

  // ── 12. Invalid DB path ──

  it('constructor with invalid path throws', () => {
    expect(() => new OpenCodeDBReader('/nonexistent/path/db.sqlite')).toThrow();
  });

  // ── 13. Schema validation ──

  it('rejects database missing required tables', () => {
    const badDb = new Database(':memory:');
    badDb.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)');
    expect(() => OpenCodeDBReader.fromDatabase(badDb)).toThrow(/missing required tables/i);
  });
});
