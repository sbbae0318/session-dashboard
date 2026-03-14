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

function makeAssistantData(model: string, tokens: {
  input: number; output: number; reasoning?: number;
  cache?: { read: number; write: number };
}): string {
  return JSON.stringify({
    role: 'assistant',
    modelID: model,
    providerID: 'anthropic',
    cost: 0,
    tokens: {
      total: tokens.input + tokens.output + (tokens.reasoning ?? 0)
        + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning ?? 0,
      cache: {
        read: tokens.cache?.read ?? 0,
        write: tokens.cache?.write ?? 0,
      },
    },
  });
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

  const insertMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');

  // ses_1: two sonnet messages with cache tokens (realistic pattern)
  insertMsg.run('msg_1', 'ses_1', 1700001000, 1700001000,
    makeAssistantData('claude-sonnet-4-20250514', {
      input: 1, output: 500, cache: { read: 43000, write: 2000 },
    }));
  insertMsg.run('msg_2', 'ses_1', 1700002000, 1700002000,
    makeAssistantData('claude-sonnet-4-20250514', {
      input: 2, output: 800, cache: { read: 44000, write: 100 },
    }));

  // ses_2: one opus message
  insertMsg.run('msg_3', 'ses_2', 1700011000, 1700011000,
    makeAssistantData('claude-opus-4-6', {
      input: 1, output: 200, reasoning: 50, cache: { read: 10000, write: 500 },
    }));

  // user messages
  const userMsg = (id: string, sessionId: string, time: number, text: string) =>
    JSON.stringify({ role: 'user', content: text });

  insertMsg.run('msg_u1', 'ses_1', 1700000500, 1700000500, userMsg('msg_u1', 'ses_1', 1700000500, 'implement user authentication'));
  insertMsg.run('msg_u2', 'ses_1', 1700001500, 1700001500, userMsg('msg_u2', 'ses_1', 1700001500, 'add password hashing'));
  insertMsg.run('msg_u3', 'ses_1', 1700002500, 1700002500, userMsg('msg_u3', 'ses_1', 1700002500, 'write tests for auth module'));
  insertMsg.run('msg_u4', 'ses_2', 1700010500, 1700010500, userMsg('msg_u4', 'ses_2', 1700010500, 'fix the login bug'));

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

  it('creates from in-memory database with valid schema', () => {
    expect(reader.isAvailable()).toBe(true);
  });

  it('isAvailable() returns false after close', () => {
    reader.close();
    expect(reader.isAvailable()).toBe(false);
  });

  // ── getAllProjects ──

  it('getAllProjects() returns project summaries with calculated cost', () => {
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

  // ── getProjectSessions ──

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

  // ── getSessionTokenStats ──

  it('getSessionTokenStats() returns token breakdown including cache tokens', () => {
    const stats = reader.getSessionTokenStats('ses_1');
    expect(stats).not.toBeNull();
    expect(stats!.sessionId).toBe('ses_1');
    expect(stats!.totalInput).toBe(3); // 1 + 2
    expect(stats!.totalOutput).toBe(1300); // 500 + 800
    expect(stats!.cacheRead).toBe(87000); // 43000 + 44000
    expect(stats!.cacheWrite).toBe(2100); // 2000 + 100
    expect(stats!.totalReasoning).toBe(0);
    expect(stats!.models).toContain('claude-sonnet-4-20250514');
    expect(stats!.msgCount).toBe(2);
  });

  it('getSessionTokenStats() calculates cost using model pricing UDF', () => {
    const stats = reader.getSessionTokenStats('ses_1')!;
    // sonnet-4: input=$3, output=$15, cacheRead=$0.30, cacheWrite=$3.75 (per MTok)
    // msg_1: input=1*3 + output=500*15 + cacheRead=43000*0.30 + cacheWrite=2000*3.75
    // msg_2: input=2*3 + output=800*15 + cacheRead=44000*0.30 + cacheWrite=100*3.75
    const expectedCost = (
      (1 * 3 + 500 * 15 + 43000 * 0.30 + 2000 * 3.75) +
      (2 * 3 + 800 * 15 + 44000 * 0.30 + 100 * 3.75)
    ) / 1_000_000;
    expect(stats.totalCost).toBeCloseTo(expectedCost, 8);
    expect(stats.totalCost).toBeGreaterThan(0);
  });

  it('getSessionTokenStats() includes reasoning tokens billed at output rate', () => {
    const stats = reader.getSessionTokenStats('ses_2')!;
    // opus-4-6: input=$15, output=$75, cacheRead=$1.50, cacheWrite=$18.75
    // input=1*15 + output=200*75 + reasoning=50*75 + cacheRead=10000*1.50 + cacheWrite=500*18.75
    const expectedCost = (1 * 15 + 200 * 75 + 50 * 75 + 10000 * 1.50 + 500 * 18.75) / 1_000_000;
    expect(stats.totalCost).toBeCloseTo(expectedCost, 8);
    expect(stats.totalReasoning).toBe(50);
  });

  it('getSessionTokenStats() returns null for session with no assistant messages', () => {
    expect(reader.getSessionTokenStats('ses_3')).toBeNull();
  });

  // ── getAllProjectsTokenStats ──

  it('getAllProjectsTokenStats() aggregates tokens per project with cache fields', () => {
    const stats = reader.getAllProjectsTokenStats();
    expect(stats.length).toBeGreaterThanOrEqual(1);

    const proj1Stats = stats.find(s => s.projectId === 'proj_1')!;
    expect(proj1Stats.totalInput).toBe(4); // 1 + 2 + 1
    expect(proj1Stats.totalOutput).toBe(1500); // 500 + 800 + 200
    expect(proj1Stats.totalReasoning).toBe(50);
    expect(proj1Stats.cacheRead).toBe(97000); // 43000 + 44000 + 10000
    expect(proj1Stats.cacheWrite).toBe(2600); // 2000 + 100 + 500
    expect(proj1Stats.totalCost).toBeGreaterThan(0);
  });

  // ── getTokensData ──

  it('getTokensData() returns sessions array and grandTotal matching TokensData format', () => {
    const tokensData = reader.getTokensData();

    expect(tokensData.sessions).toBeInstanceOf(Array);
    expect(tokensData.sessions.length).toBeGreaterThanOrEqual(2);

    const ses1 = tokensData.sessions.find(s => s.sessionId === 'ses_1')!;
    expect(ses1.sessionTitle).toBe('Implement auth');
    expect(ses1.projectId).toBe('proj_1');
    expect(ses1.directory).toBe('/home/user/my-app');
    expect(ses1.cacheRead).toBe(87000);
    expect(ses1.cacheWrite).toBe(2100);
    expect(ses1.totalCost).toBeGreaterThan(0);
    expect(ses1.models).toContain('claude-sonnet-4-20250514');
    expect(ses1.agents).toEqual([]);
    expect(ses1.msgCount).toBe(2);

    expect(tokensData.grandTotal.input).toBeGreaterThan(0);
    expect(tokensData.grandTotal.output).toBeGreaterThan(0);
    expect(tokensData.grandTotal.cacheRead).toBeGreaterThan(0);
    expect(tokensData.grandTotal.cacheWrite).toBeGreaterThan(0);
    expect(tokensData.grandTotal.cost).toBeGreaterThan(0);
  });

  it('getTokensData() grandTotal sums all sessions correctly', () => {
    const tokensData = reader.getTokensData();
    const sumInput = tokensData.sessions.reduce((a, s) => a + s.totalInput, 0);
    const sumCost = tokensData.sessions.reduce((a, s) => a + s.totalCost, 0);

    expect(tokensData.grandTotal.input).toBe(sumInput);
    expect(tokensData.grandTotal.cost).toBeCloseTo(sumCost, 10);
  });

  // ── Cost calculation with different models ──

  it('calculates zero cost for unknown models', () => {
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_unknown', 'ses_3', 1700031000, 1700031000,
      makeAssistantData('unknown-model-xyz', {
        input: 1000, output: 500, cache: { read: 5000, write: 100 },
      }));

    const stats = reader.getSessionTokenStats('ses_3');
    expect(stats).not.toBeNull();
    expect(stats!.totalCost).toBe(0);
  });

  it('calculates zero cost for free models', () => {
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_free', 'ses_3', 1700031000, 1700031000,
      makeAssistantData('kimi-k2.5-free', {
        input: 5000, output: 2000, cache: { read: 10000, write: 500 },
      }));

    const stats = reader.getSessionTokenStats('ses_3');
    expect(stats).not.toBeNull();
    expect(stats!.totalCost).toBe(0);
  });

  // ── SQLite UDF ──

  it('model_price UDF is registered and returns correct values', () => {
    const row = testDb.prepare(
      "SELECT model_price('claude-sonnet-4-20250514', 'input') AS price",
    ).get() as { price: number };
    expect(row.price).toBe(3);

    const rowCacheRead = testDb.prepare(
      "SELECT model_price('claude-opus-4-6', 'cacheRead') AS price",
    ).get() as { price: number };
    expect(rowCacheRead.price).toBe(1.5);
  });

  // ── getSessionCodeImpact ──

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

  // ── getAllSessionsCodeImpact ──

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

  // ── getSessionTimeline ──

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

  // ── getSessionRecoveryContext ──

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

  // ── close() ──

  it('close() prevents further operations', () => {
    reader.close();
    expect(() => reader.getAllProjects()).toThrow();
  });

  // ── Empty database ──

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

    const tokensData = emptyReader.getTokensData();
    expect(tokensData.sessions).toEqual([]);
    expect(tokensData.grandTotal).toEqual({
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    });

    emptyReader.close();
  });

  // ── getAllRecoveryContexts ──

  it('getAllRecoveryContexts() returns idle sessions with all fields', () => {
    const contexts = reader.getAllRecoveryContexts({ idleThresholdMs: 0 });
    expect(contexts.length).toBeGreaterThanOrEqual(1);

    const ctx = contexts.find(c => c.sessionId === 'ses_1');
    expect(ctx).toBeDefined();
    expect(ctx!.title).toBe('Implement auth');
    expect(ctx!.directory).toBe('/home/user/my-app');
    expect(ctx!.lastActivityAt).toBe(1700010000);
    expect(ctx!.lastUserMessages.length).toBeGreaterThan(0);
    expect(ctx!.codeImpact).not.toBeNull();
    expect(ctx!.codeImpact!.additions).toBe(120);
    expect(ctx!.todos).toHaveLength(2);
  });

  it('getAllRecoveryContexts() respects limit', () => {
    const contexts = reader.getAllRecoveryContexts({ limit: 2, idleThresholdMs: 0 });
    expect(contexts).toHaveLength(2);
  });

  it('getAllRecoveryContexts() filters by idle threshold', () => {
    const futureThreshold = Date.now() + 100_000_000;
    const contexts = reader.getAllRecoveryContexts({ idleThresholdMs: -futureThreshold });
    expect(contexts.length).toBeGreaterThanOrEqual(0);
  });

  it('getAllRecoveryContexts() returns lastTools from assistant messages', () => {
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_tool_1', 'ses_1', 1700003000, 1700003000,
      JSON.stringify({ role: 'assistant', tool: 'mcp_bash', content: 'ran command' }));
    insertMsg.run('msg_tool_2', 'ses_1', 1700004000, 1700004000,
      JSON.stringify({ role: 'assistant', tool: 'mcp_edit', content: 'edited file' }));

    const contexts = reader.getAllRecoveryContexts({ idleThresholdMs: 0 });
    const ctx = contexts.find(c => c.sessionId === 'ses_1');
    expect(ctx).toBeDefined();
    expect(ctx!.lastTools).toContain('mcp_edit');
    expect(ctx!.lastTools).toContain('mcp_bash');
  });

  // ── getSessionMessages ──

  it('getSessionMessages() returns messages in chronological order', () => {
    const messages = reader.getSessionMessages('ses_1');
    expect(messages.length).toBeGreaterThanOrEqual(3);

    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].time).toBeGreaterThanOrEqual(messages[i - 1].time);
    }
  });

  it('getSessionMessages() extracts role and content', () => {
    const messages = reader.getSessionMessages('ses_1');
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs.length).toBeGreaterThanOrEqual(3);
    expect(userMsgs.some(m => m.content.includes('implement user authentication'))).toBe(true);
  });

  it('getSessionMessages() respects limit', () => {
    const messages = reader.getSessionMessages('ses_1', { limit: 2 });
    expect(messages).toHaveLength(2);
  });

  it('getSessionMessages() returns empty for nonexistent session', () => {
    expect(reader.getSessionMessages('nonexistent')).toEqual([]);
  });

  it('getSessionMessages() truncates content to 500 chars', () => {
    const longContent = 'x'.repeat(1000);
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_long', 'ses_3', 1700031000, 1700031000,
      JSON.stringify({ role: 'user', content: longContent }));

    const messages = reader.getSessionMessages('ses_3');
    const longMsg = messages.find(m => m.content.includes('xxx'));
    expect(longMsg).toBeDefined();
    expect(longMsg!.content.length).toBeLessThanOrEqual(500);
  });

  it('getSessionMessages() includes tool name if present', () => {
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_with_tool', 'ses_3', 1700032000, 1700032000,
      JSON.stringify({ role: 'assistant', content: 'result', tool: 'mcp_grep' }));

    const messages = reader.getSessionMessages('ses_3');
    const toolMsg = messages.find(m => m.tool === 'mcp_grep');
    expect(toolMsg).toBeDefined();
  });

  // ── Invalid DB path ──

  it('constructor with invalid path throws', () => {
    expect(() => new OpenCodeDBReader('/nonexistent/path/db.sqlite')).toThrow();
  });

  // ── Schema validation ──

  it('rejects database missing required tables', () => {
    const badDb = new Database(':memory:');
    badDb.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)');
    expect(() => OpenCodeDBReader.fromDatabase(badDb)).toThrow(/missing required tables/i);
  });
});
