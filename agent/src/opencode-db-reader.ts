import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getModelPrice } from './model-pricing.js';

const DEFAULT_DB_PATH = join(homedir(), '.local/share/opencode/opencode.db');

const REQUIRED_TABLES = ['session', 'message', 'part', 'project', 'todo'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  worktree: string;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  lastActivity: number;
}

export interface SessionMeta {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string | null;
  directory: string | null;
  summaryAdditions: number;
  summaryDeletions: number;
  summaryFiles: number;
  timeCreated: number;
  timeUpdated: number;
  models: string[];
}

export interface SessionTokenStats {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  totalInput: number;
  totalOutput: number;
  totalReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  models: string[];
  agents: string[];
  msgCount: number;
  timeUpdated: number;
}

export interface ProjectTokenStats {
  projectId: string;
  worktree: string;
  totalInput: number;
  totalOutput: number;
  totalReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  sessionCount: number;
}

export interface TokensData {
  sessions: SessionTokenStats[];
  grandTotal: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

export interface CodeImpact {
  additions: number;
  deletions: number;
  files: number;
}

export interface SessionCodeImpact extends CodeImpact {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  timeUpdated: number;
}

export interface TimelineEntry {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  startTime: number;
  endTime: number | null;
  status: 'busy' | 'idle' | 'completed';
  parentId: string | null;
}

export interface RecoveryContext {
  sessionId: string;
  sessionTitle: string;
  directory: string;
  lastActivityAt: number;
  lastPrompts: string[];
  lastTools: string[];
  additions: number;
  deletions: number;
  files: number;
  todos: Array<{ content: string; status: string; priority: string }>;
}

export interface SessionMessage {
  role: string;
  content: string;
  time: number;
  tool?: string;
}

export interface EnrichmentResponse<T> {
  data: T | null;
  available: boolean;
  error?: string;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// OpenCodeDBReader
// ---------------------------------------------------------------------------

export class OpenCodeDBReader {
  private db: Database.Database | null;

  private stmtAllProjects!: Statement;
  private stmtProjectSessions!: Statement;
  private stmtSessionTokens!: Statement;
  private stmtSessionModels!: Statement;
  private stmtSessionCodeImpact!: Statement;
  private stmtAllCodeImpact!: Statement;
  private stmtAllCodeImpactByProject!: Statement;
  private stmtTimeline!: Statement;
  private stmtTimelineByProject!: Statement;
  private stmtLastUserMessages!: Statement;
  private stmtSessionTodos!: Statement;
  private stmtSessionExists!: Statement;
  private stmtProjectTokenStats!: Statement;
  private stmtTokensData!: Statement;
  private stmtAllRecoverySessions!: Statement;
  private stmtSessionRecoveryMeta!: Statement;
  private stmtSessionLastTools!: Statement;
  private stmtSessionMessages!: Statement;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db = db;
    this.registerFunctions(db);
    this.initStatements(db);
  }

  static fromDatabase(db: Database.Database): OpenCodeDBReader {
    const instance = Object.create(OpenCodeDBReader.prototype) as OpenCodeDBReader;
    instance.db = db;
    instance.registerFunctions(db);
    instance.initStatements(db);
    return instance;
  }

  private registerFunctions(db: Database.Database): void {
    db.function('model_price', (modelId: unknown, tokenType: unknown) => {
      return getModelPrice(
        String(modelId ?? ''),
        String(tokenType ?? 'input') as 'input' | 'output' | 'cacheRead' | 'cacheWrite',
      );
    });
  }

  private initStatements(db: Database.Database): void {
    this.validateSchema(db);
    this.stmtAllProjects = this.prepareAllProjectsStmt(db);
    this.stmtProjectSessions = this.prepareProjectSessionsStmt(db);
    this.stmtSessionTokens = this.prepareSessionTokensStmt(db);
    this.stmtSessionModels = this.prepareSessionModelsStmt(db);
    this.stmtSessionCodeImpact = this.prepareSessionCodeImpactStmt(db);
    this.stmtAllCodeImpact = this.prepareAllCodeImpactStmt(db);
    this.stmtAllCodeImpactByProject = this.prepareAllCodeImpactByProjectStmt(db);
    this.stmtTimeline = this.prepareTimelineStmt(db);
    this.stmtTimelineByProject = this.prepareTimelineByProjectStmt(db);
    this.stmtLastUserMessages = this.prepareLastUserMessagesStmt(db);
    this.stmtSessionTodos = this.prepareSessionTodosStmt(db);
    this.stmtSessionExists = this.prepareSessionExistsStmt(db);
    this.stmtProjectTokenStats = this.prepareProjectTokenStatsStmt(db);
    this.stmtTokensData = this.prepareTokensDataStmt(db);
    this.stmtAllRecoverySessions = this.prepareAllRecoverySessionsStmt(db);
    this.stmtSessionRecoveryMeta = this.prepareSessionRecoveryMetaStmt(db);
    this.stmtSessionLastTools = this.prepareSessionLastToolsStmt(db);
    this.stmtSessionMessages = this.prepareSessionMessagesStmt(db);
  }

  isAvailable(): boolean {
    return this.db !== null;
  }

  getAllProjects(): ProjectSummary[] {
    const rows = this.stmtAllProjects.all() as Array<{
      id: string; worktree: string; session_count: number;
      total_input: number | null; total_output: number | null;
      calculated_cost: number | null; last_activity: number | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      worktree: r.worktree,
      sessionCount: r.session_count,
      totalInputTokens: r.total_input ?? 0,
      totalOutputTokens: r.total_output ?? 0,
      totalCost: r.calculated_cost ?? 0,
      lastActivity: r.last_activity ?? 0,
    }));
  }

  getProjectSessions(projectId: string): SessionMeta[] {
    const rows = this.stmtProjectSessions.all(projectId) as Array<{
      id: string; project_id: string; parent_id: string | null;
      title: string | null; directory: string | null;
      summary_additions: number | null; summary_deletions: number | null;
      summary_files: number | null; time_created: number; time_updated: number;
    }>;

    return rows.map(r => {
      const modelRow = this.stmtSessionModels.get(r.id) as { models: string | null } | undefined;
      const models = modelRow?.models
        ? modelRow.models.split(',').filter(Boolean)
        : [];

      return {
        id: r.id,
        projectId: r.project_id,
        parentId: r.parent_id,
        title: r.title,
        directory: r.directory,
        summaryAdditions: r.summary_additions ?? 0,
        summaryDeletions: r.summary_deletions ?? 0,
        summaryFiles: r.summary_files ?? 0,
        timeCreated: r.time_created,
        timeUpdated: r.time_updated,
        models,
      };
    });
  }

  getSessionTokenStats(sessionId: string): SessionTokenStats | null {
    const row = this.stmtSessionTokens.get(sessionId) as {
      session_id: string; session_title: string | null; project_id: string;
      directory: string | null; total_input: number | null; total_output: number | null;
      total_reasoning: number | null; cache_read: number | null; cache_write: number | null;
      calculated_cost: number | null; models: string | null;
      msg_count: number; time_updated: number | null;
    } | undefined;

    if (!row || (row.total_input === null && row.total_output === null && row.cache_read === null)) return null;

    const models = row.models
      ? row.models.split(',').filter(Boolean)
      : [];

    return {
      sessionId: row.session_id,
      sessionTitle: row.session_title ?? '',
      projectId: row.project_id,
      directory: row.directory ?? '',
      totalInput: row.total_input ?? 0,
      totalOutput: row.total_output ?? 0,
      totalReasoning: row.total_reasoning ?? 0,
      cacheRead: row.cache_read ?? 0,
      cacheWrite: row.cache_write ?? 0,
      totalCost: row.calculated_cost ?? 0,
      models,
      agents: [],
      msgCount: row.msg_count,
      timeUpdated: row.time_updated ?? 0,
    };
  }

  getAllProjectsTokenStats(): ProjectTokenStats[] {
    const rows = this.stmtProjectTokenStats.all() as Array<{
      project_id: string; worktree: string;
      total_input: number | null; total_output: number | null;
      total_reasoning: number | null; cache_read: number | null;
      cache_write: number | null; calculated_cost: number | null;
      session_count: number;
    }>;

    return rows
      .filter(r =>
        (r.total_input ?? 0) > 0 || (r.total_output ?? 0) > 0 || (r.cache_read ?? 0) > 0,
      )
      .map(r => ({
        projectId: r.project_id,
        worktree: r.worktree,
        totalInput: r.total_input ?? 0,
        totalOutput: r.total_output ?? 0,
        totalReasoning: r.total_reasoning ?? 0,
        cacheRead: r.cache_read ?? 0,
        cacheWrite: r.cache_write ?? 0,
        totalCost: r.calculated_cost ?? 0,
        sessionCount: r.session_count,
      }));
  }

  getTokensData(): TokensData {
    const rows = this.stmtTokensData.all() as Array<{
      session_id: string; session_title: string | null; project_id: string;
      directory: string | null; total_input: number | null; total_output: number | null;
      total_reasoning: number | null; cache_read: number | null; cache_write: number | null;
      calculated_cost: number | null; models: string | null;
      msg_count: number; time_updated: number | null;
    }>;

    const sessions: SessionTokenStats[] = rows
      .filter(r =>
        (r.total_input ?? 0) > 0 || (r.total_output ?? 0) > 0 || (r.cache_read ?? 0) > 0,
      )
      .map(r => ({
        sessionId: r.session_id,
        sessionTitle: r.session_title ?? '',
        projectId: r.project_id,
        directory: r.directory ?? '',
        totalInput: r.total_input ?? 0,
        totalOutput: r.total_output ?? 0,
        totalReasoning: r.total_reasoning ?? 0,
        cacheRead: r.cache_read ?? 0,
        cacheWrite: r.cache_write ?? 0,
        totalCost: r.calculated_cost ?? 0,
        models: r.models ? r.models.split(',').filter(Boolean) : [],
        agents: [],
        msgCount: r.msg_count,
        timeUpdated: r.time_updated ?? 0,
      }));

    const grandTotal = {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    };
    for (const s of sessions) {
      grandTotal.input += s.totalInput;
      grandTotal.output += s.totalOutput;
      grandTotal.reasoning += s.totalReasoning;
      grandTotal.cacheRead += s.cacheRead;
      grandTotal.cacheWrite += s.cacheWrite;
      grandTotal.cost += s.totalCost;
    }

    return { sessions, grandTotal };
  }

  getSessionCodeImpact(sessionId: string): CodeImpact | null {
    const row = this.stmtSessionCodeImpact.get(sessionId) as {
      summary_additions: number | null;
      summary_deletions: number | null;
      summary_files: number | null;
    } | undefined;

    if (!row) return null;
    if (row.summary_additions === null && row.summary_deletions === null && row.summary_files === null) return null;

    return {
      additions: row.summary_additions ?? 0,
      deletions: row.summary_deletions ?? 0,
      files: row.summary_files ?? 0,
    };
  }

  getAllSessionsCodeImpact(options: { limit?: number; offset?: number; projectId?: string }): SessionCodeImpact[] {
    const { limit = 50, offset = 0, projectId } = options;

    const rows = projectId
      ? this.stmtAllCodeImpactByProject.all(projectId, limit, offset) as Array<{
          id: string; project_id: string; title: string | null;
          summary_additions: number; summary_deletions: number; summary_files: number;
          time_created: number; time_updated: number;
        }>
      : this.stmtAllCodeImpact.all(limit, offset) as Array<{
          id: string; project_id: string; title: string | null;
          summary_additions: number; summary_deletions: number; summary_files: number;
          time_created: number; time_updated: number;
        }>;

    return rows.map(r => ({
      sessionId: r.id,
      sessionTitle: r.title ?? r.id.slice(0, 8),
      projectId: r.project_id,
      directory: r.project_id,
      additions: r.summary_additions,
      deletions: r.summary_deletions,
      files: r.summary_files,
      timeUpdated: r.time_updated ?? r.time_created,
    }));
  }

  getSessionTimeline(options: { from: number; to: number; projectId?: string; since?: number }): TimelineEntry[] {
    const { from, to, projectId, since } = options;

    type TimelineRow = {
      id: string; project_id: string; title: string | null;
      time_created: number; time_updated: number;
      summary_additions: number | null; summary_deletions: number | null;
      summary_files: number | null;
    };

    let rows: TimelineRow[];

    if (since !== undefined) {
      if (projectId) {
        rows = this.db!.prepare(`
          SELECT id, project_id, title, time_created, time_updated,
            summary_additions, summary_deletions, summary_files
          FROM session
          WHERE time_created >= ? AND time_created <= ? AND project_id = ? AND time_updated >= ?
          ORDER BY time_created ASC
        `).all(from, to, projectId, since) as TimelineRow[];
      } else {
        rows = this.db!.prepare(`
          SELECT id, project_id, title, time_created, time_updated,
            summary_additions, summary_deletions, summary_files
          FROM session
          WHERE time_created >= ? AND time_created <= ? AND time_updated >= ?
          ORDER BY time_created ASC
        `).all(from, to, since) as TimelineRow[];
      }
    } else {
      rows = projectId
        ? this.stmtTimelineByProject.all(from, to, projectId) as TimelineRow[]
        : this.stmtTimeline.all(from, to) as TimelineRow[];
    }

    const now = Date.now();
    return rows.map(r => {
      const endTime = r.time_updated && r.time_updated !== r.time_created ? r.time_updated : null;
      const lastActivity = r.time_updated ?? r.time_created;
      const idleThreshold = 5 * 60 * 1000;
      const status: 'busy' | 'idle' | 'completed' =
        (now - lastActivity) < idleThreshold ? 'busy' : endTime ? 'completed' : 'idle';
      return {
        sessionId: r.id,
        sessionTitle: r.title ?? r.id.slice(0, 8),
        projectId: r.project_id,
        directory: r.project_id,
        startTime: r.time_created,
        endTime,
        status,
        parentId: null,
      };
    });
  }

  getSessionRecoveryContext(sessionId: string): RecoveryContext | null {
    const row = this.stmtSessionRecoveryMeta.get(sessionId) as {
      id: string; title: string | null; directory: string | null;
      time_updated: number; summary_additions: number | null;
      summary_deletions: number | null; summary_files: number | null;
    } | undefined;
    if (!row) return null;

    const msgRows = this.stmtLastUserMessages.all(sessionId) as Array<{ data: string }>;
    const lastUserMessages: string[] = [];
    for (const m of msgRows) {
      try {
        const parsed = JSON.parse(m.data) as { content?: string };
        if (parsed.content) lastUserMessages.push(parsed.content);
      } catch { /* skip malformed JSON */ }
    }

    const toolRows = this.stmtSessionLastTools.all(sessionId) as Array<{ tool_name: string }>;
    const lastTools = toolRows.map(t => t.tool_name).filter(Boolean);

    const todoRows = this.stmtSessionTodos.all(sessionId) as Array<{
      content: string; status: string; priority: string;
    }>;

    return {
      sessionId,
      sessionTitle: row.title ?? sessionId.slice(0, 8),
      directory: row.directory ?? '',
      lastActivityAt: row.time_updated,
      lastPrompts: lastUserMessages,
      lastTools,
      additions: row.summary_additions ?? 0,
      deletions: row.summary_deletions ?? 0,
      files: row.summary_files ?? 0,
      todos: todoRows.map(t => ({ content: t.content, status: t.status, priority: t.priority })),
    };
  }

  getAllRecoveryContexts(options?: { limit?: number; idleThresholdMs?: number }): RecoveryContext[] {
    const limit = options?.limit ?? 20;
    const idleThresholdMs = options?.idleThresholdMs ?? 600_000;
    const cutoffTime = Date.now() - idleThresholdMs;

    const rows = this.stmtAllRecoverySessions.all(cutoffTime, limit) as Array<{
      id: string;
      title: string | null;
      directory: string | null;
      time_updated: number;
      summary_additions: number | null;
      summary_deletions: number | null;
      summary_files: number | null;
    }>;

    return rows.map(row => {
      const msgRows = this.stmtLastUserMessages.all(row.id) as Array<{ data: string }>;
      const lastUserMessages: string[] = [];
      for (const m of msgRows) {
        try {
          const parsed = JSON.parse(m.data) as { content?: string };
          if (parsed.content) lastUserMessages.push(parsed.content);
        } catch { /* skip malformed */ }
      }

      const toolRows = this.stmtSessionLastTools.all(row.id) as Array<{ tool_name: string }>;
      const lastTools = toolRows.map(t => t.tool_name).filter(Boolean);

      const todoRows = this.stmtSessionTodos.all(row.id) as Array<{
        content: string; status: string; priority: string;
      }>;

      return {
        sessionId: row.id,
        sessionTitle: row.title ?? row.id.slice(0, 8),
        directory: row.directory ?? '',
        lastActivityAt: row.time_updated,
        lastPrompts: lastUserMessages,
        lastTools,
        additions: row.summary_additions ?? 0,
        deletions: row.summary_deletions ?? 0,
        files: row.summary_files ?? 0,
        todos: todoRows.map(t => ({ content: t.content, status: t.status, priority: t.priority })),
      };
    });
  }

  getSessionMessages(sessionId: string, options?: { limit?: number }): SessionMessage[] {
    const limit = options?.limit ?? 30;
    const rows = this.stmtSessionMessages.all(sessionId, limit) as Array<{
      time_created: number;
      data: string;
    }>;

    const messages: SessionMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as {
          role?: string;
          content?: string;
          tool?: string;
        };
        if (!parsed.role) continue;
        const content = typeof parsed.content === 'string'
          ? parsed.content.slice(0, 500)
          : '';
        const msg: SessionMessage = {
          role: parsed.role,
          content,
          time: row.time_created,
        };
        if (parsed.tool) msg.tool = parsed.tool;
        messages.push(msg);
      } catch { /* skip malformed */ }
    }

    return messages.reverse();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Schema Validation
  // ---------------------------------------------------------------------------

  private validateSchema(db: Database.Database): void {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map(t => t.name));

    const missing = REQUIRED_TABLES.filter(t => !tableNames.has(t));
    if (missing.length > 0) {
      throw new Error(`Missing required tables: ${missing.join(', ')}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Prepared Statement Factories
  // ---------------------------------------------------------------------------

  private prepareAllProjectsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        p.id, p.worktree,
        COUNT(DISTINCT s.id) AS session_count,
        SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)
          + COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS total_input,
        SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS total_output,
        SUM(
          (
            COALESCE(json_extract(m.data, '$.tokens.input'), 0) * model_price(json_extract(m.data, '$.modelID'), 'input') +
            COALESCE(json_extract(m.data, '$.tokens.output'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheRead') +
            COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheWrite')
          ) / 1000000.0
        ) AS calculated_cost,
        MAX(s.time_updated) AS last_activity
      FROM project p
      LEFT JOIN session s ON s.project_id = p.id
      LEFT JOIN message m ON m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
      GROUP BY p.id
    `);
  }

  private prepareProjectSessionsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, parent_id, title, directory,
        summary_additions, summary_deletions, summary_files,
        time_created, time_updated
      FROM session WHERE project_id = ?
      ORDER BY time_created DESC
    `);
  }

  private prepareSessionTokensStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        m.session_id,
        s.title AS session_title,
        s.project_id,
        s.directory,
        SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS total_input,
        SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS total_output,
        SUM(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) AS total_reasoning,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS cache_read,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) AS cache_write,
        SUM(
          (
            COALESCE(json_extract(m.data, '$.tokens.input'), 0) * model_price(json_extract(m.data, '$.modelID'), 'input') +
            COALESCE(json_extract(m.data, '$.tokens.output'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheRead') +
            COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheWrite')
          ) / 1000000.0
        ) AS calculated_cost,
        GROUP_CONCAT(DISTINCT json_extract(m.data, '$.modelID')) AS models,
        COUNT(m.id) AS msg_count,
        s.time_updated
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'assistant'
      GROUP BY m.session_id
    `);
  }

  private prepareSessionModelsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT GROUP_CONCAT(DISTINCT json_extract(data, '$.modelID')) AS models
      FROM message
      WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
    `);
  }

  private prepareSessionCodeImpactStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT summary_additions, summary_deletions, summary_files
      FROM session WHERE id = ?
    `);
  }

  private prepareAllCodeImpactStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, title, summary_additions, summary_deletions, summary_files, time_created, time_updated
      FROM session
      WHERE (COALESCE(summary_additions, 0) + COALESCE(summary_deletions, 0)) > 0
      ORDER BY time_created DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareAllCodeImpactByProjectStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, title, summary_additions, summary_deletions, summary_files, time_created, time_updated
      FROM session
      WHERE project_id = ? AND (COALESCE(summary_additions, 0) + COALESCE(summary_deletions, 0)) > 0
      ORDER BY time_created DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareTimelineStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, title, time_created, time_updated,
        summary_additions, summary_deletions, summary_files
      FROM session
      WHERE time_created >= ? AND time_created <= ?
      ORDER BY time_created ASC
    `);
  }

  private prepareTimelineByProjectStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, title, time_created, time_updated,
        summary_additions, summary_deletions, summary_files
      FROM session
      WHERE time_created >= ? AND time_created <= ? AND project_id = ?
      ORDER BY time_created ASC
    `);
  }

  private prepareLastUserMessagesStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT data FROM message
      WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
      ORDER BY time_created DESC LIMIT 5
    `);
  }

  private prepareSessionTodosStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT content, status, priority FROM todo
      WHERE session_id = ?
      ORDER BY position ASC
    `);
  }

  private prepareSessionExistsStmt(db: Database.Database): Statement {
    return db.prepare('SELECT COUNT(*) AS cnt FROM session WHERE id = ?');
  }

  private prepareProjectTokenStatsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        p.id AS project_id, p.worktree,
        SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS total_input,
        SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS total_output,
        SUM(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) AS total_reasoning,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS cache_read,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) AS cache_write,
        SUM(
          (
            COALESCE(json_extract(m.data, '$.tokens.input'), 0) * model_price(json_extract(m.data, '$.modelID'), 'input') +
            COALESCE(json_extract(m.data, '$.tokens.output'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheRead') +
            COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheWrite')
          ) / 1000000.0
        ) AS calculated_cost,
        COUNT(DISTINCT s.id) AS session_count
      FROM project p
      JOIN session s ON s.project_id = p.id
      JOIN message m ON m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
      GROUP BY p.id
    `);
  }

  private prepareTokensDataStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        s.id AS session_id,
        s.title AS session_title,
        s.project_id,
        s.directory,
        SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS total_input,
        SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS total_output,
        SUM(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) AS total_reasoning,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS cache_read,
        SUM(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) AS cache_write,
        SUM(
          (
            COALESCE(json_extract(m.data, '$.tokens.input'), 0) * model_price(json_extract(m.data, '$.modelID'), 'input') +
            COALESCE(json_extract(m.data, '$.tokens.output'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) * model_price(json_extract(m.data, '$.modelID'), 'output') +
            COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheRead') +
            COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) * model_price(json_extract(m.data, '$.modelID'), 'cacheWrite')
          ) / 1000000.0
        ) AS calculated_cost,
        GROUP_CONCAT(DISTINCT json_extract(m.data, '$.modelID')) AS models,
        COUNT(m.id) AS msg_count,
        s.time_updated
      FROM session s
      JOIN message m ON m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
      GROUP BY s.id
      ORDER BY s.time_updated DESC
    `);
  }

  private prepareSessionRecoveryMetaStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, title, directory, time_updated,
        summary_additions, summary_deletions, summary_files
      FROM session WHERE id = ?
    `);
  }

  private prepareAllRecoverySessionsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, title, directory, time_updated,
        summary_additions, summary_deletions, summary_files
      FROM session
      WHERE time_updated <= ?
      ORDER BY time_updated DESC
      LIMIT ?
    `);
  }

  private prepareSessionLastToolsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT DISTINCT json_extract(data, '$.tool') AS tool_name
      FROM message
      WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
        AND json_extract(data, '$.tool') IS NOT NULL
      ORDER BY time_created DESC
      LIMIT 5
    `);
  }

  private prepareSessionMessagesStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC
      LIMIT ?
    `);
  }
}
