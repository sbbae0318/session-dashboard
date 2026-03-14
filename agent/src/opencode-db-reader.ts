import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  models: string[];
}

export interface ProjectTokenStats {
  projectId: string;
  worktree: string;
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  sessionCount: number;
}

export interface CodeImpact {
  additions: number;
  deletions: number;
  files: number;
}

export interface SessionCodeImpact extends CodeImpact {
  sessionId: string;
  projectId: string;
  title: string | null;
  timeCreated: number;
}

export interface TimelineEntry {
  sessionId: string;
  projectId: string;
  title: string | null;
  timeCreated: number;
  timeUpdated: number;
  additions: number;
  deletions: number;
  files: number;
}

export interface RecoveryContext {
  sessionId: string;
  title: string | null;
  lastUserMessages: string[];
  codeImpact: CodeImpact | null;
  todos: Array<{ content: string; status: string; priority: string }>;
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

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db = db;
    this.initStatements(db);
  }

  static fromDatabase(db: Database.Database): OpenCodeDBReader {
    const instance = Object.create(OpenCodeDBReader.prototype) as OpenCodeDBReader;
    instance.db = db;
    instance.initStatements(db);
    return instance;
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
  }

  isAvailable(): boolean {
    return this.db !== null;
  }

  getAllProjects(): ProjectSummary[] {
    const rows = this.stmtAllProjects.all() as Array<{
      id: string; worktree: string; session_count: number;
      total_input: number | null; total_output: number | null;
      total_cost: number | null; last_activity: number | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      worktree: r.worktree,
      sessionCount: r.session_count,
      totalInputTokens: r.total_input ?? 0,
      totalOutputTokens: r.total_output ?? 0,
      totalCost: r.total_cost ?? 0,
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
      total_input: number | null; total_output: number | null;
      total_cost: number | null;
    } | undefined;

    if (!row || (row.total_input === null && row.total_output === null)) return null;

    const modelRow = this.stmtSessionModels.get(sessionId) as { models: string | null } | undefined;
    const models = modelRow?.models
      ? modelRow.models.split(',').filter(Boolean)
      : [];

    return {
      totalInput: row.total_input ?? 0,
      totalOutput: row.total_output ?? 0,
      totalCost: row.total_cost ?? 0,
      models,
    };
  }

  getAllProjectsTokenStats(): ProjectTokenStats[] {
    const rows = this.stmtProjectTokenStats.all() as Array<{
      project_id: string; worktree: string;
      total_input: number | null; total_output: number | null;
      total_cost: number | null; session_count: number;
    }>;

    return rows
      .filter(r => (r.total_input ?? 0) > 0 || (r.total_output ?? 0) > 0)
      .map(r => ({
        projectId: r.project_id,
        worktree: r.worktree,
        totalInput: r.total_input ?? 0,
        totalOutput: r.total_output ?? 0,
        totalCost: r.total_cost ?? 0,
        sessionCount: r.session_count,
      }));
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
          time_created: number;
        }>
      : this.stmtAllCodeImpact.all(limit, offset) as Array<{
          id: string; project_id: string; title: string | null;
          summary_additions: number; summary_deletions: number; summary_files: number;
          time_created: number;
        }>;

    return rows.map(r => ({
      sessionId: r.id,
      projectId: r.project_id,
      title: r.title,
      additions: r.summary_additions,
      deletions: r.summary_deletions,
      files: r.summary_files,
      timeCreated: r.time_created,
    }));
  }

  getSessionTimeline(options: { from: number; to: number; projectId?: string }): TimelineEntry[] {
    const { from, to, projectId } = options;

    const rows = projectId
      ? this.stmtTimelineByProject.all(from, to, projectId) as Array<{
          id: string; project_id: string; title: string | null;
          time_created: number; time_updated: number;
          summary_additions: number | null; summary_deletions: number | null;
          summary_files: number | null;
        }>
      : this.stmtTimeline.all(from, to) as Array<{
          id: string; project_id: string; title: string | null;
          time_created: number; time_updated: number;
          summary_additions: number | null; summary_deletions: number | null;
          summary_files: number | null;
        }>;

    return rows.map(r => ({
      sessionId: r.id,
      projectId: r.project_id,
      title: r.title,
      timeCreated: r.time_created,
      timeUpdated: r.time_updated,
      additions: r.summary_additions ?? 0,
      deletions: r.summary_deletions ?? 0,
      files: r.summary_files ?? 0,
    }));
  }

  getSessionRecoveryContext(sessionId: string): RecoveryContext | null {
    const exists = this.stmtSessionExists.get(sessionId) as { cnt: number } | undefined;
    if (!exists || exists.cnt === 0) return null;

    const session = this.stmtSessionCodeImpact.get(sessionId) as {
      summary_additions: number | null; summary_deletions: number | null;
      summary_files: number | null;
    } | undefined;

    const msgRows = this.stmtLastUserMessages.all(sessionId) as Array<{ data: string }>;
    const lastUserMessages: string[] = [];
    for (const row of msgRows) {
      try {
        const parsed = JSON.parse(row.data) as { content?: string; role?: string };
        if (parsed.content) lastUserMessages.push(parsed.content);
      } catch { /* skip malformed JSON */ }
    }

    const todoRows = this.stmtSessionTodos.all(sessionId) as Array<{
      content: string; status: string; priority: string;
    }>;

    const codeImpact = session && (session.summary_additions !== null || session.summary_deletions !== null)
      ? { additions: session.summary_additions ?? 0, deletions: session.summary_deletions ?? 0, files: session.summary_files ?? 0 }
      : null;

    const titleRow = this.stmtSessionCodeImpact.get(sessionId) as { title?: string } | undefined;

    return {
      sessionId,
      title: (titleRow as { title?: string } | undefined)?.title ?? null,
      lastUserMessages,
      codeImpact,
      todos: todoRows.map(t => ({ content: t.content, status: t.status, priority: t.priority })),
    };
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
        SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS total_input,
        SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS total_output,
        SUM(COALESCE(json_extract(m.data, '$.cost'), 0)) AS total_cost,
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
        SUM(json_extract(data, '$.tokens.input')) AS total_input,
        SUM(json_extract(data, '$.tokens.output')) AS total_output,
        SUM(json_extract(data, '$.cost')) AS total_cost
      FROM message
      WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
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
      SELECT id, project_id, title, summary_additions, summary_deletions, summary_files, time_created
      FROM session
      WHERE (COALESCE(summary_additions, 0) + COALESCE(summary_deletions, 0)) > 0
      ORDER BY time_created DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareAllCodeImpactByProjectStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, project_id, title, summary_additions, summary_deletions, summary_files, time_created
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
        SUM(COALESCE(json_extract(m.data, '$.cost'), 0)) AS total_cost,
        COUNT(DISTINCT s.id) AS session_count
      FROM project p
      JOIN session s ON s.project_id = p.id
      JOIN message m ON m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
      GROUP BY p.id
    `);
  }
}
