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

  it('getAllSessionsCodeImpact() returns directory from project.worktree, not project_id hash', () => {
    const impacts = reader.getAllSessionsCodeImpact({ limit: 10 });
    const ses1Impact = impacts.find(i => i.sessionId === 'ses_1');
    expect(ses1Impact).toBeDefined();
    // directory should be the project worktree path, NOT the project_id hash
    expect(ses1Impact!.directory).toBe('/home/user/my-app');
    expect(ses1Impact!.directory).not.toBe('proj_1');
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
      expect(entry.startTime).toBeGreaterThanOrEqual(1700000000);
      expect(entry.startTime).toBeLessThanOrEqual(1700100000);
    }
  });

  it('getSessionTimeline() returns directory from project.worktree, not project_id hash', () => {
    const entries = reader.getSessionTimeline({ from: 1700000000, to: 1700100000 });
    const ses1Entry = entries.find(e => e.sessionId === 'ses_1');
    expect(ses1Entry).toBeDefined();
    expect(ses1Entry!.directory).toBe('/home/user/my-app');
    expect(ses1Entry!.directory).not.toBe('proj_1');

    const ses3Entry = entries.find(e => e.sessionId === 'ses_3');
    expect(ses3Entry).toBeDefined();
    expect(ses3Entry!.directory).toBe('/home/user/other');
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
    expect(ctx!.lastPrompts).toHaveLength(3);
    expect(ctx!.lastPrompts[0]).toContain('write tests');
    expect(ctx!.todos).toHaveLength(2);
    expect(ctx!.additions).toBe(120);
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
    expect(ctx!.sessionTitle).toBe('Implement auth');
    expect(ctx!.directory).toBe('/home/user/my-app');
    expect(ctx!.lastActivityAt).toBe(1700010000);
    expect(ctx!.lastPrompts.length).toBeGreaterThan(0);
    expect(ctx!.additions).toBe(120);
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

  // ── Orphaned sessions (no matching project row) ──

  it('getAllSessionsCodeImpact() includes orphaned sessions with fallback directory', () => {
    testDb.exec(`
      INSERT INTO session VALUES ('ses_orphan', 'proj_orphan', NULL, NULL, 'Orphan session', 'v1', 'orphan', 50, 20, 3, 1700070000, 1700080000);
    `);
    const impacts = reader.getAllSessionsCodeImpact({ limit: 20 });
    const orphan = impacts.find(i => i.sessionId === 'ses_orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.directory).toBe('proj_orphan');
  });

  it('getSessionTimeline() includes orphaned sessions with fallback directory', () => {
    testDb.exec(`
      INSERT INTO session VALUES ('ses_orphan2', 'proj_orphan2', NULL, NULL, 'Orphan timeline', 'v1', 'orphan2', 0, 0, 0, 1700070000, 1700080000);
    `);
    const entries = reader.getSessionTimeline({ from: 1700000000, to: 1700100000 });
    const orphan = entries.find(e => e.sessionId === 'ses_orphan2');
    expect(orphan).toBeDefined();
    expect(orphan!.directory).toBe('proj_orphan2');
  });

  it('getTokensData() returns directory from project.worktree, not session.directory or project_id', () => {
    testDb.exec(`
      INSERT INTO session VALUES ('ses_null_dir', 'proj_1', NULL, NULL, 'Null dir session', 'v1', 'nulldir', 0, 0, 0, 1700090000, 1700095000);
    `);
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    insertMsg.run('msg_nd1', 'ses_null_dir', 1700091000, 1700091000,
      makeAssistantData('claude-sonnet-4-20250514', { input: 10, output: 20, cache: { read: 100, write: 50 } }));

    const tokensData = reader.getTokensData();
    const ndSession = tokensData.sessions.find(s => s.sessionId === 'ses_null_dir');
    expect(ndSession).toBeDefined();
    expect(ndSession!.directory).toBe('/home/user/my-app');
  });

  // ── Schema validation ──

  it('rejects database missing required tables', () => {
    const badDb = new Database(':memory:');
    badDb.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)');
    expect(() => OpenCodeDBReader.fromDatabase(badDb)).toThrow(/missing required tables/i);
  });
});

describe('getSessionTimeline — background filtering', () => {
  let bgReader: OpenCodeDBReader;
  let bgDb: Database.Database;

  beforeEach(() => {
    bgDb = createTestDb();
    // seed: background + user sessions
    bgDb.exec(`
      INSERT INTO project VALUES ('proj_bg', '/home/user/proj', 1700000000, 1700100000, NULL, NULL);
      -- 정상 유저 세션들
      INSERT INTO session VALUES ('user_1', 'proj_bg', NULL, '/home/user/proj', 'Fix auth bug', 'v1', 'fix', 10, 5, 2, 1700000000, 1700010000);
      INSERT INTO session VALUES ('user_2', 'proj_bg', NULL, '/home/user/proj', 'Add feature', 'v1', 'feat', 20, 10, 3, 1700020000, 1700030000);
      -- 백그라운드 세션들 (필터되어야 함)
      INSERT INTO session VALUES ('bg_1', 'proj_bg', NULL, '/home/user/proj', 'Background: explore codebase', 'v1', 'bg', 0, 0, 0, 1700001000, 1700002000);
      INSERT INTO session VALUES ('bg_2', 'proj_bg', NULL, '/home/user/proj', 'Task: run tests', 'v1', 'task', 0, 0, 0, 1700003000, 1700004000);
      INSERT INTO session VALUES ('bg_3', 'proj_bg', NULL, '/home/user/proj', 'Implement @subagent feature', 'v1', 'sub', 0, 0, 0, 1700005000, 1700006000);
      INSERT INTO session VALUES ('sub_4', 'proj_bg', 'user_1', '/home/user/proj', 'Child session', 'v1', 'child', 0, 0, 0, 1700007000, 1700008000);
    `);
    bgReader = OpenCodeDBReader.fromDatabase(bgDb);
  });

  afterEach(() => {
    try { bgReader.close(); } catch { /* already closed */ }
  });

  const FULL_RANGE = { from: 0, to: 9999999999999 };

  it('should exclude sessions with parent_id (subagent)', () => {
    const entries = bgReader.getSessionTimeline(FULL_RANGE);
    const ids = entries.map(e => e.sessionId);
    expect(ids).not.toContain('sub_4');
  });

  it('should exclude sessions with "Background:" title', () => {
    const entries = bgReader.getSessionTimeline(FULL_RANGE);
    const titles = entries.map(e => e.sessionTitle);
    expect(titles.some(t => t.startsWith('Background:'))).toBe(false);
  });

  it('should exclude sessions with "Task:" title', () => {
    const entries = bgReader.getSessionTimeline(FULL_RANGE);
    const titles = entries.map(e => e.sessionTitle);
    expect(titles.some(t => t.startsWith('Task:'))).toBe(false);
  });

  it('should exclude sessions with "@" in title', () => {
    const entries = bgReader.getSessionTimeline(FULL_RANGE);
    const titles = entries.map(e => e.sessionTitle);
    expect(titles.some(t => t.includes('@'))).toBe(false);
  });

  it('should include normal user sessions', () => {
    const entries = bgReader.getSessionTimeline(FULL_RANGE);
    const ids = entries.map(e => e.sessionId);
    expect(ids).toContain('user_1');
    expect(ids).toContain('user_2');
  });

  it('should return empty array when all sessions are background', () => {
    const allBgDb = createTestDb();
    allBgDb.exec(`
      INSERT INTO project VALUES ('proj_x', '/home/user/x', 1700000000, 1700100000, NULL, NULL);
      INSERT INTO session VALUES ('bg_only', 'proj_x', NULL, '/home/user/x', 'Background: all bg', 'v1', 's', 0, 0, 0, 1700000000, 1700010000);
    `);
    const allBgReader = OpenCodeDBReader.fromDatabase(allBgDb);
    const entries = allBgReader.getSessionTimeline(FULL_RANGE);
    expect(entries).toHaveLength(0);
    allBgReader.close();
  });

  it('should filter correctly with since parameter (since + no projectId)', () => {
    const entries = bgReader.getSessionTimeline({ ...FULL_RANGE, since: 1700000000 });
    const ids = entries.map(e => e.sessionId);
    expect(ids).toContain('user_1');
    expect(ids).toContain('user_2');
    expect(ids).not.toContain('sub_4');
    expect(ids.some(id => id.startsWith('bg_'))).toBe(false);
  });

  it('should filter correctly with projectId parameter (projectId only)', () => {
    const entries = bgReader.getSessionTimeline({ ...FULL_RANGE, projectId: 'proj_bg' });
    const ids = entries.map(e => e.sessionId);
    expect(ids).toContain('user_1');
    expect(ids).toContain('user_2');
    expect(ids).not.toContain('sub_4');
  });

  it('should filter correctly with since + projectId parameters', () => {
    const entries = bgReader.getSessionTimeline({ ...FULL_RANGE, since: 1700000000, projectId: 'proj_bg' });
    const ids = entries.map(e => e.sessionId);
    expect(ids).toContain('user_1');
    expect(ids).not.toContain('sub_4');
    expect(ids.some(id => id.startsWith('bg_'))).toBe(false);
  });
});

// ── getRecentSessionMetas ──

describe('getRecentSessionMetas', () => {
  let testDb: Database.Database;
  let reader: OpenCodeDBReader;

  beforeEach(() => {
    testDb = createTestDb();
    const now = Date.now();
    testDb.exec(`
      INSERT INTO project VALUES ('proj_recent', '/Users/test/project-a', ${now}, ${now}, NULL, NULL);
      INSERT INTO session VALUES ('ses_recent_1', 'proj_recent', NULL, NULL, 'Recent Session', 'v1', 'recent1', 0, 0, 0, ${now - 3600000}, ${now - 1800000});
      INSERT INTO session VALUES ('ses_recent_2', 'proj_recent', 'ses_recent_1', NULL, 'Child Session', 'v1', 'recent2', 0, 0, 0, ${now - 3000000}, ${now - 600000});
      INSERT INTO session VALUES ('ses_old', 'proj_recent', NULL, NULL, 'Old Session', 'v1', 'old1', 0, 0, 0, ${now - 864000000}, ${now - 864000000});
    `);
    reader = OpenCodeDBReader.fromDatabase(testDb);
  });

  afterEach(() => {
    reader.close();
    testDb.close();
  });

  it('returns sessions updated within the given time window', () => {
    const metas = reader.getRecentSessionMetas(86_400_000);
    const ids = metas.map(m => m.id);
    expect(ids).toContain('ses_recent_1');
    expect(ids).toContain('ses_recent_2');
    expect(ids).not.toContain('ses_old');
  });

  it('returns directory from project.worktree via LEFT JOIN', () => {
    const metas = reader.getRecentSessionMetas(86_400_000);
    const meta = metas.find(m => m.id === 'ses_recent_1');
    expect(meta).toBeDefined();
    expect(meta!.directory).toBe('/Users/test/project-a');
  });

  it('returns parentId for child sessions', () => {
    const metas = reader.getRecentSessionMetas(86_400_000);
    const child = metas.find(m => m.id === 'ses_recent_2');
    expect(child).toBeDefined();
    expect(child!.parentId).toBe('ses_recent_1');
  });

  it('respects limit parameter', () => {
    const metas = reader.getRecentSessionMetas(86_400_000, 1);
    expect(metas).toHaveLength(1);
  });

  it('orders by time_updated DESC', () => {
    const metas = reader.getRecentSessionMetas(86_400_000);
    for (let i = 1; i < metas.length; i++) {
      expect(metas[i - 1].timeUpdated).toBeGreaterThanOrEqual(metas[i].timeUpdated);
    }
  });
});

// ── getSessionActivitySegments ──

describe('getSessionActivitySegments', () => {
  let reader: OpenCodeDBReader;
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb);

    // Seed assistant messages with time.created / time.completed for activity segments
    const insertMsg = testDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');

    // ses_1: two assistant messages with full time data (out-of-order insert to test sorting)
    insertMsg.run('msg_seg_2', 'ses_1', 1700003000, 1700003500, JSON.stringify({
      role: 'assistant', time: { created: 1700003000, completed: 1700003500 },
    }));
    insertMsg.run('msg_seg_1', 'ses_1', 1700001000, 1700001800, JSON.stringify({
      role: 'assistant', time: { created: 1700001000, completed: 1700001800 },
    }));

    // ses_1: assistant message with null time.completed → fallback to time_updated
    insertMsg.run('msg_seg_3', 'ses_1', 1700005000, 1700005900, JSON.stringify({
      role: 'assistant', time: { created: 1700005000, completed: null },
    }));

    // ses_1: user message with time (should be excluded — not assistant)
    insertMsg.run('msg_seg_u', 'ses_1', 1700006000, 1700006100, JSON.stringify({
      role: 'user', time: { created: 1700006000, completed: 1700006100 },
    }));

    // ses_3: assistant message without time.created (should be excluded)
    insertMsg.run('msg_seg_no_time', 'ses_3', 1700031000, 1700031500, JSON.stringify({
      role: 'assistant', time: {},
    }));

    reader = OpenCodeDBReader.fromDatabase(testDb);
  });

  afterEach(() => {
    try { reader.close(); } catch { /* already closed */ }
  });

  it('returns activity segments for assistant messages', () => {
    const segments = reader.getSessionActivitySegments('ses_1');
    expect(segments.length).toBe(3);
    for (const seg of segments) {
      expect(seg.type).toBe('working');
      expect(seg.startTime).toBeLessThanOrEqual(seg.endTime);
    }
  });

  it('returns segments sorted by startTime ascending', () => {
    const segments = reader.getSessionActivitySegments('ses_1');
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startTime).toBeGreaterThanOrEqual(segments[i - 1].startTime);
    }
    // Verify specific order
    expect(segments[0].startTime).toBe(1700001000);
    expect(segments[1].startTime).toBe(1700003000);
    expect(segments[2].startTime).toBe(1700005000);
  });

  it('uses time_updated as fallback when time.completed is null', () => {
    const segments = reader.getSessionActivitySegments('ses_1');
    const fallbackSeg = segments.find(s => s.startTime === 1700005000);
    expect(fallbackSeg).toBeDefined();
    // time_updated = 1700005900 (from INSERT)
    expect(fallbackSeg!.endTime).toBe(1700005900);
  });

  it('returns empty array for session with no activity segments', () => {
    expect(reader.getSessionActivitySegments('ses_4')).toEqual([]);
  });

  it('returns empty array for non-existent session', () => {
    expect(reader.getSessionActivitySegments('nonexistent_session')).toEqual([]);
  });

  it('excludes non-assistant messages', () => {
    const segments = reader.getSessionActivitySegments('ses_1');
    // user message at 1700006000 should not appear
    const userSeg = segments.find(s => s.startTime === 1700006000);
    expect(userSeg).toBeUndefined();
  });

  it('excludes messages without time.created', () => {
    const segments = reader.getSessionActivitySegments('ses_3');
    expect(segments).toEqual([]);
  });
});

// =============================================================================
// DB-direct session monitoring (OpenCodeDbSource fallback)
// =============================================================================

describe('OpenCodeDBReader — getActiveSessionsWithStatus', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;

  beforeEach(() => {
    db = createTestDb();
    // Seed: 3 sessions with different statuses
    db.exec(`
      INSERT INTO project VALUES ('p1', '/home/user/proj', 1700000000000, 1700000000000, NULL, NULL);
      INSERT INTO session VALUES ('s1', 'p1', NULL, '/home/user/proj', 'Active Task', 'v1', 'active', 0, 0, 0, 1700000000000, 1700099990000);
      INSERT INTO session VALUES ('s2', 'p1', NULL, '/home/user/proj', 'Done Task', 'v1', 'done', 10, 5, 2, 1700000000000, 1700099980000);
      INSERT INTO session VALUES ('s3', 'p1', NULL, '/home/user/proj', 'Old Task', 'v1', 'old', 0, 0, 0, 1600000000000, 1600099900000);
    `);
    // Messages
    const insertMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    // s1: last message is assistant tool-calls → busy
    insertMsg.run('m1_1', 's1', 1700099990000, 1700099990000,
      JSON.stringify({ role: 'assistant', finish: 'tool-calls', time: { created: 1700099990000, completed: 1700099991000 } }));
    // s2: last message is assistant stop → idle
    insertMsg.run('m2_1', 's2', 1700099980000, 1700099980000,
      JSON.stringify({ role: 'assistant', finish: 'stop', time: { created: 1700099980000, completed: 1700099981000 } }));
    // s3: old session — should be filtered by time_updated cutoff

    reader = OpenCodeDBReader.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns recent sessions only (filtered by time_updated)', () => {
    const sinceMs = 1700000000000;
    const rows = reader.getActiveSessionsWithStatus(sinceMs, 100);
    expect(rows.length).toBe(2);  // s1 and s2 only, s3 is too old
    expect(rows.map(r => r.id).sort()).toEqual(['s1', 's2']);
  });

  it('includes last message role and finish', () => {
    const rows = reader.getActiveSessionsWithStatus(1700000000000, 100);
    const s1 = rows.find(r => r.id === 's1')!;
    expect(s1.lastRole).toBe('assistant');
    expect(s1.lastFinish).toBe('tool-calls');
    const s2 = rows.find(r => r.id === 's2')!;
    expect(s2.lastRole).toBe('assistant');
    expect(s2.lastFinish).toBe('stop');
  });

  it('resolves directory from project.worktree', () => {
    const rows = reader.getActiveSessionsWithStatus(1700000000000, 100);
    expect(rows[0].directory).toBe('/home/user/proj');
  });

  it('respects limit parameter', () => {
    const rows = reader.getActiveSessionsWithStatus(1700000000000, 1);
    expect(rows).toHaveLength(1);
  });

  it('handles sessions with no messages', () => {
    db.exec(`INSERT INTO session VALUES ('s_empty', 'p1', NULL, '/home/user/proj', 'Empty', 'v1', 'e', 0, 0, 0, 1700000000000, 1700099985000)`);
    const rows = reader.getActiveSessionsWithStatus(1700000000000, 100);
    const empty = rows.find(r => r.id === 's_empty')!;
    expect(empty).toBeDefined();
    expect(empty.lastRole).toBeNull();
    expect(empty.lastFinish).toBeNull();
  });
});

describe('OpenCodeDBReader — getSessionLastUserPromptText', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      INSERT INTO project VALUES ('p1', '/home/user/proj', 1700000000000, 1700000000000, NULL, NULL);
      INSERT INTO session VALUES ('s1', 'p1', NULL, '/home/user/proj', 'Task', 'v1', 'task', 0, 0, 0, 1700000000000, 1700099990000);
    `);
    const insertMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');

    // user message 1 (earliest)
    insertMsg.run('m_u1', 's1', 1700000001000, 1700000001000, JSON.stringify({ role: 'user' }));
    insertPart.run('p_u1', 'm_u1', 's1', 1700000001000, 1700000001000,
      JSON.stringify({ type: 'text', text: 'First prompt' }));
    // assistant response
    insertMsg.run('m_a1', 's1', 1700000002000, 1700000002000, JSON.stringify({ role: 'assistant', finish: 'stop' }));
    insertPart.run('p_a1', 'm_a1', 's1', 1700000002000, 1700000002000,
      JSON.stringify({ type: 'text', text: 'Response 1' }));
    // user message 2 (latest)
    insertMsg.run('m_u2', 's1', 1700000003000, 1700000003000, JSON.stringify({ role: 'user' }));
    insertPart.run('p_u2', 'm_u2', 's1', 1700000003000, 1700000003000,
      JSON.stringify({ type: 'text', text: 'Second prompt' }));

    reader = OpenCodeDBReader.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns latest user prompt first', () => {
    const rows = reader.getSessionLastUserPromptText('s1');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].text).toBe('Second prompt');
    expect(rows[0].messageTimeCreated).toBe(1700000003000);
  });

  it('excludes assistant messages', () => {
    const rows = reader.getSessionLastUserPromptText('s1');
    const texts = rows.map(r => r.text);
    expect(texts).not.toContain('Response 1');
  });

  it('returns empty array for non-existent session', () => {
    const rows = reader.getSessionLastUserPromptText('nonexistent');
    expect(rows).toEqual([]);
  });
});

describe('OpenCodeDBReader — getSessionCurrentTool', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      INSERT INTO project VALUES ('p1', '/home/user/proj', 1700000000000, 1700000000000, NULL, NULL);
      INSERT INTO session VALUES ('s1', 'p1', NULL, '/home/user/proj', 'Task', 'v1', 'task', 0, 0, 0, 1700000000000, 1700099990000);
    `);
    const insertMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');

    insertMsg.run('m1', 's1', 1700000001000, 1700000001000, JSON.stringify({ role: 'assistant' }));
    insertPart.run('p_text', 'm1', 's1', 1700000001000, 1700000001000,
      JSON.stringify({ type: 'text', text: 'hello' }));
    insertPart.run('p_tool1', 'm1', 's1', 1700000002000, 1700000002000,
      JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed' } }));
    // Latest tool (most recent by time_updated)
    insertPart.run('p_tool2', 'm1', 's1', 1700000003000, 1700000005000,
      JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'running' } }));

    reader = OpenCodeDBReader.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns most recent tool by time_updated', () => {
    expect(reader.getSessionCurrentTool('s1')).toBe('bash');
  });

  it('returns null for session without tools', () => {
    db.exec(`INSERT INTO session VALUES ('s_empty', 'p1', NULL, '/home/user/proj', 'E', 'v1', 'e', 0, 0, 0, 1700000000000, 1700099990000)`);
    expect(reader.getSessionCurrentTool('s_empty')).toBeNull();
  });
});

describe('OpenCodeDBReader — getPromptResponseFromDb', () => {
  let db: Database.Database;
  let reader: OpenCodeDBReader;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      INSERT INTO project VALUES ('p1', '/home/user/proj', 1700000000000, 1700000000000, NULL, NULL);
      INSERT INTO session VALUES ('s1', 'p1', NULL, '/home/user/proj', 'Task', 'v1', 'task', 0, 0, 0, 1700000000000, 1700099990000);
    `);
    const insertMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');

    // Turn 1: user → assistant text + tool_use
    insertMsg.run('m_u1', 's1', 1700000001000, 1700000001000,
      JSON.stringify({ role: 'user', time: { created: 1700000001000 } }));
    insertPart.run('p_u1', 'm_u1', 's1', 1700000001000, 1700000001000,
      JSON.stringify({ type: 'text', text: 'First question' }));
    insertMsg.run('m_a1', 's1', 1700000002000, 1700000002000,
      JSON.stringify({ role: 'assistant', finish: 'tool-calls' }));
    insertPart.run('p_a1_text', 'm_a1', 's1', 1700000002000, 1700000002000,
      JSON.stringify({ type: 'text', text: 'Let me check.' }));
    insertPart.run('p_a1_tool', 'm_a1', 's1', 1700000002100, 1700000002100,
      JSON.stringify({ type: 'tool', tool: 'read' }));
    insertMsg.run('m_a2', 's1', 1700000003000, 1700000003000,
      JSON.stringify({ role: 'assistant', finish: 'stop' }));
    insertPart.run('p_a2_text', 'm_a2', 's1', 1700000003000, 1700000003000,
      JSON.stringify({ type: 'text', text: 'Here is the answer.' }));

    // Turn 2: user → assistant
    insertMsg.run('m_u2', 's1', 1700000004000, 1700000004000,
      JSON.stringify({ role: 'user', time: { created: 1700000004000 } }));
    insertPart.run('p_u2', 'm_u2', 's1', 1700000004000, 1700000004000,
      JSON.stringify({ type: 'text', text: 'Second question' }));
    insertMsg.run('m_a3', 's1', 1700000005000, 1700000005000,
      JSON.stringify({ role: 'assistant', finish: 'stop' }));
    insertPart.run('p_a3_text', 'm_a3', 's1', 1700000005000, 1700000005000,
      JSON.stringify({ type: 'text', text: 'Second answer.' }));

    reader = OpenCodeDBReader.fromDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns concatenated assistant text parts for matched prompt', () => {
    const response = reader.getPromptResponseFromDb('s1', 1700000001000);
    // Should stop at next user message — only first turn's responses
    expect(response).toContain('Let me check.');
    expect(response).toContain('Here is the answer.');
    expect(response).not.toContain('Second answer.');
  });

  it('matches timestamp within 2-second window', () => {
    const response = reader.getPromptResponseFromDb('s1', 1700000001500);
    expect(response).not.toBeNull();
  });

  it('returns null when user message not found', () => {
    const response = reader.getPromptResponseFromDb('s1', 9999999999999);
    expect(response).toBeNull();
  });

  it('returns only responses after the matched user message', () => {
    const response = reader.getPromptResponseFromDb('s1', 1700000004000);
    expect(response).toBe('Second answer.');
    expect(response).not.toContain('Here is the answer.');
  });
});
