import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getModelPrice } from './model-pricing.js';
import type {
  DbMessageFinish,
  DbMessageRole,
} from './contracts/opencode-db-contracts.js';

export const DEFAULT_OPENCODE_DB_PATH = join(homedir(), '.local/share/opencode/opencode.db');
const DEFAULT_DB_PATH = DEFAULT_OPENCODE_DB_PATH;

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

export interface RecentSessionMeta {
  id: string;
  title: string | null;
  parentId: string | null;
  directory: string | null;
  timeCreated: number;
  timeUpdated: number;
  lastActiveAt: number;
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

export interface SearchResult {
  type: 'session' | 'prompt';
  sessionId: string;
  title: string | null;
  directory: string | null;
  timeCreated: number;
  timeUpdated: number;
  matchField: 'title' | 'query' | 'directory' | 'content';
  matchSnippet: string;
}

export interface ActivitySegment {
  startTime: number;
  endTime: number;
  type: 'working';
}

export interface SearchOptions {
  query: string;
  from: number;   // timestamp ms
  to: number;     // timestamp ms
  limit: number;
  offset: number;
}

export interface EnrichmentResponse<T> {
  data: T | null;
  available: boolean;
  error?: string;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMatchSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const pos = lowerText.indexOf(lowerQuery);
  if (pos === -1) return text.slice(0, 100);

  const start = Math.max(0, pos - 50);
  const end = Math.min(text.length, pos + query.length + 50);

  let snippet = '';
  if (start > 0) snippet += '...';
  snippet += text.slice(start, pos);
  snippet += `<mark>${text.slice(pos, pos + query.length)}</mark>`;
  snippet += text.slice(pos + query.length, end);
  if (end < text.length) snippet += '...';

  return snippet;
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
  private stmtSearchSessions!: Statement;
  private stmtSearchSessionsCount!: Statement;
  private stmtSearchMessages!: Statement;
  private stmtSearchMessagesCount!: Statement;
  private stmtRecentSessionMetas!: Statement;
  private stmtActivitySegments!: Statement;
  // DB-direct session monitoring (no oc-serve)
  private stmtActiveSessionsWithStatus!: Statement;
  private stmtSessionLastUserPromptText!: Statement;
  private stmtSessionCurrentToolPart!: Statement;
  private stmtFindUserMessageByTime!: Statement;
  private stmtAssistantTextPartsAfterMessage!: Statement;

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
    this.stmtSearchSessions = this.prepareSearchSessionsStmt(db);
    this.stmtSearchSessionsCount = this.prepareSearchSessionsCountStmt(db);
    this.stmtSearchMessages = this.prepareSearchMessagesStmt(db);
    this.stmtSearchMessagesCount = this.prepareSearchMessagesCountStmt(db);
    this.stmtRecentSessionMetas = this.prepareRecentSessionMetasStmt(db);
    this.stmtActivitySegments = this.prepareActivitySegmentsStmt(db);
    // DB-direct session monitoring
    this.stmtActiveSessionsWithStatus = this.prepareActiveSessionsWithStatusStmt(db);
    this.stmtSessionLastUserPromptText = this.prepareSessionLastUserPromptTextStmt(db);
    this.stmtSessionCurrentToolPart = this.prepareSessionCurrentToolPartStmt(db);
    this.stmtFindUserMessageByTime = this.prepareFindUserMessageByTimeStmt(db);
    this.stmtAssistantTextPartsAfterMessage = this.prepareAssistantTextPartsAfterMessageStmt(db);
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

  getRecentSessionMetas(sinceMs: number, limit = 2000): RecentSessionMeta[] {
    const cutoff = Date.now() - sinceMs;
    const rows = this.stmtRecentSessionMetas.all(cutoff, limit) as Array<{
      id: string; title: string | null; parent_id: string | null;
      directory: string | null; time_created: number; time_updated: number;
      last_active: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      parentId: r.parent_id,
      directory: r.directory,
      timeCreated: r.time_created,
      timeUpdated: r.time_updated,
      lastActiveAt: r.last_active,
    }));
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
          id: string; project_id: string; title: string | null; directory: string | null;
          summary_additions: number; summary_deletions: number; summary_files: number;
          time_created: number; time_updated: number;
        }>
      : this.stmtAllCodeImpact.all(limit, offset) as Array<{
          id: string; project_id: string; title: string | null; directory: string | null;
          summary_additions: number; summary_deletions: number; summary_files: number;
          time_created: number; time_updated: number;
        }>;

    return rows.map(r => ({
      sessionId: r.id,
      sessionTitle: r.title ?? r.id.slice(0, 8),
      projectId: r.project_id,
      directory: r.directory ?? r.project_id,
      additions: r.summary_additions,
      deletions: r.summary_deletions,
      files: r.summary_files,
      timeUpdated: r.time_updated ?? r.time_created,
    }));
  }

  getSessionTimeline(options: { from: number; to: number; projectId?: string; since?: number }): TimelineEntry[] {
    const { from, to, projectId, since } = options;

    type TimelineRow = {
      id: string; project_id: string; parent_id: string | null; title: string | null;
      directory: string | null;
      time_created: number; time_updated: number;
      summary_additions: number | null; summary_deletions: number | null;
      summary_files: number | null;
    };

    let rows: TimelineRow[];

    if (since !== undefined) {
      if (projectId) {
        rows = this.db!.prepare(`
          SELECT s.id, s.project_id, s.parent_id, s.title,
            COALESCE(p.worktree, s.directory, s.project_id) AS directory,
            s.time_created, s.time_updated,
            s.summary_additions, s.summary_deletions, s.summary_files
          FROM session s
          LEFT JOIN project p ON s.project_id = p.id
          WHERE s.time_created >= ? AND s.time_created <= ? AND s.project_id = ? AND s.time_updated >= ?
            AND s.parent_id IS NULL
            AND s.title NOT LIKE 'Background:%'
            AND s.title NOT LIKE 'Task:%'
            AND s.title NOT LIKE '%@%'
          ORDER BY s.time_created ASC
        `).all(from, to, projectId, since) as TimelineRow[];
      } else {
        rows = this.db!.prepare(`
          SELECT s.id, s.project_id, s.parent_id, s.title,
            COALESCE(p.worktree, s.directory, s.project_id) AS directory,
            s.time_created, s.time_updated,
            s.summary_additions, s.summary_deletions, s.summary_files
          FROM session s
          LEFT JOIN project p ON s.project_id = p.id
          WHERE s.time_created >= ? AND s.time_created <= ? AND s.time_updated >= ?
            AND s.parent_id IS NULL
            AND s.title NOT LIKE 'Background:%'
            AND s.title NOT LIKE 'Task:%'
            AND s.title NOT LIKE '%@%'
          ORDER BY s.time_created ASC
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
        directory: r.directory ?? r.project_id,
        startTime: r.time_created,
        endTime,
        status,
        parentId: r.parent_id ?? null,
      };
    });
  }

  getSessionActivitySegments(sessionId: string): ActivitySegment[] {
    type SegRow = { seg_start: number | null; seg_end: number | null };
    const rows = this.stmtActivitySegments.all(sessionId) as SegRow[];
    return rows
      .filter((r): r is { seg_start: number; seg_end: number } =>
        r.seg_start !== null && r.seg_end !== null)
      .map(r => ({ startTime: r.seg_start, endTime: r.seg_end, type: 'working' as const }));
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

  searchSessions(options: SearchOptions): { results: SearchResult[]; total: number } {
    const { query, from, to, limit, offset } = options;
    const pattern = `%${query}%`;
    const fetchLimit = limit + offset;

    const sessionRows = this.stmtSearchSessions.all(from, to, pattern, pattern, fetchLimit, 0) as Array<{
      id: string; title: string | null; directory: string | null;
      time_created: number; time_updated: number;
    }>;

    const sessionCountRow = this.stmtSearchSessionsCount.get(from, to, pattern, pattern) as { cnt: number };
    let totalCount = sessionCountRow.cnt;

    const results: SearchResult[] = sessionRows.map(r => {
      const matchField = r.title && r.title.toLowerCase().includes(query.toLowerCase()) ? 'title' as const : 'directory' as const;
      const matchText = matchField === 'title' ? (r.title ?? '') : (r.directory ?? '');
      return {
        type: 'session' as const,
        sessionId: r.id,
        title: r.title,
        directory: r.directory,
        timeCreated: r.time_created,
        timeUpdated: r.time_updated,
        matchField,
        matchSnippet: createMatchSnippet(matchText, query),
      };
    });

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if ((to - from) <= sevenDaysMs) {
      const msgRows = this.stmtSearchMessages.all(from, to, pattern, fetchLimit, 0) as Array<{
        id: string; title: string | null; directory: string | null;
        time_created: number; time_updated: number;
        content: string | null; role: string | null;
      }>;

      const msgCountRow = this.stmtSearchMessagesCount.get(from, to, pattern) as { cnt: number };
      totalCount += msgCountRow.cnt;

      for (const r of msgRows) {
        const matchField = r.role === 'user' ? 'query' as const : 'content' as const;
        results.push({
          type: 'prompt',
          sessionId: r.id,
          title: r.title,
          directory: r.directory,
          timeCreated: r.time_created,
          timeUpdated: r.time_updated,
          matchField,
          matchSnippet: createMatchSnippet(r.content ?? '', query),
        });
      }
    }

    results.sort((a, b) => b.timeUpdated - a.timeUpdated);

    const paged = results.slice(offset, offset + limit);
    return { results: paged, total: totalCount };
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
      SELECT s.id, s.project_id, s.title,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.summary_additions, s.summary_deletions, s.summary_files,
        s.time_created, s.time_updated
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE (COALESCE(s.summary_additions, 0) + COALESCE(s.summary_deletions, 0)) > 0
      ORDER BY s.time_created DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareAllCodeImpactByProjectStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT s.id, s.project_id, s.title,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.summary_additions, s.summary_deletions, s.summary_files,
        s.time_created, s.time_updated
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.project_id = ? AND (COALESCE(s.summary_additions, 0) + COALESCE(s.summary_deletions, 0)) > 0
      ORDER BY s.time_created DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareTimelineStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT s.id, s.project_id, s.parent_id, s.title,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.time_created, s.time_updated,
        s.summary_additions, s.summary_deletions, s.summary_files
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.time_created >= ? AND s.time_created <= ?
        AND s.parent_id IS NULL
        AND s.title NOT LIKE 'Background:%'
        AND s.title NOT LIKE 'Task:%'
        AND s.title NOT LIKE '%@%'
      ORDER BY s.time_created ASC
    `);
  }

  private prepareTimelineByProjectStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT s.id, s.project_id, s.parent_id, s.title,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.time_created, s.time_updated,
        s.summary_additions, s.summary_deletions, s.summary_files
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.time_created >= ? AND s.time_created <= ? AND s.project_id = ?
        AND s.parent_id IS NULL
        AND s.title NOT LIKE 'Background:%'
        AND s.title NOT LIKE 'Task:%'
        AND s.title NOT LIKE '%@%'
      ORDER BY s.time_created ASC
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
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
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
      LEFT JOIN project p ON s.project_id = p.id
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

  private prepareSearchSessionsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT id, title, directory, time_created, time_updated
      FROM session
      WHERE time_created >= ? AND time_created <= ?
        AND (title LIKE ? OR directory LIKE ?)
      ORDER BY time_updated DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareSearchSessionsCountStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM session
      WHERE time_created >= ? AND time_created <= ?
        AND (title LIKE ? OR directory LIKE ?)
    `);
  }

  private prepareSearchMessagesStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
        json_extract(m.data, '$.content') AS content,
        json_extract(m.data, '$.role') AS role
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE s.time_created >= ? AND s.time_created <= ?
        AND json_extract(m.data, '$.content') LIKE ?
      ORDER BY s.time_updated DESC
      LIMIT ? OFFSET ?
    `);
  }

  private prepareSearchMessagesCountStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE s.time_created >= ? AND s.time_created <= ?
        AND json_extract(m.data, '$.content') LIKE ?
    `);
  }

  private prepareRecentSessionMetasStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT s.id, s.title, s.parent_id,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.time_created, s.time_updated,
        MAX(s.time_updated, COALESCE(lm.max_time, 0)) AS last_active
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      LEFT JOIN (
        SELECT session_id, MAX(time_created) AS max_time
        FROM message GROUP BY session_id
      ) lm ON lm.session_id = s.id
      WHERE MAX(s.time_updated, COALESCE(lm.max_time, 0)) >= ?
      ORDER BY last_active DESC
      LIMIT ?
    `);
  }

  private prepareActivitySegmentsStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT json_extract(data, '$.time.created') AS seg_start,
        COALESCE(json_extract(data, '$.time.completed'), m.time_updated) AS seg_end
      FROM message m
      WHERE m.session_id = ?
        AND json_extract(data, '$.role') = 'assistant'
        AND json_extract(data, '$.time.created') IS NOT NULL
      ORDER BY seg_start ASC
    `);
  }

  // =========================================================================
  // DB-direct session monitoring (no oc-serve) — prepared statements
  // =========================================================================

  /**
   * 최근 N분 내 업데이트된 세션 + 마지막 메시지의 role/finish를 1회 쿼리로 조회.
   *
   * LEFT JOIN subquery는 각 세션별로 time_created가 가장 큰 message를 선택.
   * index(message_session_time_created_id_idx)가 MAX 스캔을 커버.
   */
  private prepareActiveSessionsWithStatusStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        s.id, s.project_id, s.parent_id, s.title,
        COALESCE(p.worktree, s.directory, s.project_id) AS directory,
        s.time_created, s.time_updated,
        lm.role AS last_role,
        lm.finish AS last_finish,
        lm.time_created AS last_msg_time_created,
        lm.time_completed AS last_msg_time_completed,
        lm.time_updated AS last_msg_time_updated
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      LEFT JOIN (
        SELECT m.session_id,
          json_extract(m.data, '$.role') AS role,
          json_extract(m.data, '$.finish') AS finish,
          json_extract(m.data, '$.time.created') AS time_created,
          json_extract(m.data, '$.time.completed') AS time_completed,
          m.time_updated
        FROM message m
        INNER JOIN (
          SELECT session_id, MAX(time_created) AS max_tc
          FROM message GROUP BY session_id
        ) latest ON m.session_id = latest.session_id AND m.time_created = latest.max_tc
      ) lm ON lm.session_id = s.id
      WHERE s.time_updated >= ?
      ORDER BY s.time_updated DESC
      LIMIT ?
    `);
  }

  /**
   * 세션의 최근 user 메시지 텍스트 파트를 조회.
   * 시스템 프롬프트 필터링은 호출자에서 `extractUserPrompt()`로 수행.
   */
  private prepareSessionLastUserPromptTextStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        m.id AS message_id,
        m.time_created AS message_time_created,
        json_extract(p.data, '$.text') AS text
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
        AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
        AND json_extract(p.data, '$.text') IS NOT NULL
      ORDER BY m.time_created DESC, p.time_created DESC
      LIMIT 5
    `);
  }

  /**
   * 세션의 가장 최근 tool part를 조회.
   * busy 세션의 currentTool 표시용.
   */
  private prepareSessionCurrentToolPartStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT
        json_extract(p.data, '$.tool') AS tool_name,
        json_extract(p.data, '$.state.status') AS status
      FROM part p
      WHERE p.session_id = ?
        AND json_extract(p.data, '$.type') = 'tool'
      ORDER BY p.time_updated DESC
      LIMIT 1
    `);
  }

  /**
   * 특정 timestamp (±2초) 내의 user 메시지 찾기.
   * prompt-response 매칭용.
   */
  private prepareFindUserMessageByTimeStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT m.id, m.time_created
      FROM message m
      WHERE m.session_id = ?
        AND json_extract(m.data, '$.role') = 'user'
        AND ABS(COALESCE(json_extract(m.data, '$.time.created'), m.time_created) - ?) < 2000
      ORDER BY m.time_created DESC
      LIMIT 1
    `);
  }

  /**
   * 주어진 message 이후의 assistant text parts를 순서대로 수집 (다음 user 메시지 전까지).
   *
   * 다음 user 메시지까지의 윈도우 계산:
   *   - session_id/time_created 이후 첫 user 메시지의 time_created를 서브쿼리로 구함
   *   - 없으면 무한대 (모든 이후 assistant 수집)
   */
  private prepareAssistantTextPartsAfterMessageStmt(db: Database.Database): Statement {
    return db.prepare(`
      SELECT json_extract(p.data, '$.text') AS text
      FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE m.session_id = ?
        AND m.time_created > ?
        AND m.time_created < COALESCE((
          SELECT MIN(m2.time_created) FROM message m2
          WHERE m2.session_id = ?
            AND m2.time_created > ?
            AND json_extract(m2.data, '$.role') = 'user'
        ), 9999999999999)
        AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') = 'text'
        AND json_extract(p.data, '$.text') IS NOT NULL
      ORDER BY m.time_created ASC, p.time_created ASC
    `);
  }

  // =========================================================================
  // DB-direct session monitoring — public methods
  // =========================================================================

  /**
   * 최근 활성 세션 + 마지막 메시지 상태 조회.
   *
   * @param sinceMs - 이 시간 이후 업데이트된 세션만 조회 (epoch ms)
   * @param limit - 최대 반환 세션 수
   */
  getActiveSessionsWithStatus(sinceMs: number, limit: number = 500): Array<{
    id: string;
    projectId: string;
    parentId: string | null;
    title: string;
    directory: string;
    timeCreated: number;
    timeUpdated: number;
    lastRole: DbMessageRole | null;
    lastFinish: DbMessageFinish | null;
    lastMsgTimeCreated: number | null;
    lastMsgTimeCompleted: number | null;
    lastMsgTimeUpdated: number | null;
  }> {
    const rows = this.stmtActiveSessionsWithStatus.all(sinceMs, limit) as Array<{
      id: string; project_id: string; parent_id: string | null;
      title: string; directory: string;
      time_created: number; time_updated: number;
      last_role: string | null; last_finish: string | null;
      last_msg_time_created: number | null;
      last_msg_time_completed: number | null;
      last_msg_time_updated: number | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      parentId: r.parent_id,
      title: r.title,
      directory: r.directory,
      timeCreated: r.time_created,
      timeUpdated: r.time_updated,
      lastRole: (r.last_role as DbMessageRole | null) ?? null,
      lastFinish: (r.last_finish as DbMessageFinish | null) ?? null,
      lastMsgTimeCreated: r.last_msg_time_created,
      lastMsgTimeCompleted: r.last_msg_time_completed,
      lastMsgTimeUpdated: r.last_msg_time_updated,
    }));
  }

  /**
   * 세션의 가장 최근 user 프롬프트 텍스트 + 타임스탬프 조회.
   * 시스템 프롬프트(<command-name>, <local-command-*> 등)는 호출자에서 필터링.
   *
   * @returns 최대 5개의 user 메시지 텍스트 후보 (최신순)
   */
  getSessionLastUserPromptText(sessionId: string): Array<{
    messageId: string;
    messageTimeCreated: number;
    text: string;
  }> {
    const rows = this.stmtSessionLastUserPromptText.all(sessionId) as Array<{
      message_id: string;
      message_time_created: number;
      text: string | null;
    }>;

    return rows
      .filter(r => r.text !== null)
      .map(r => ({
        messageId: r.message_id,
        messageTimeCreated: r.message_time_created,
        text: r.text as string,
      }));
  }

  /**
   * 세션의 현재 실행 중인 tool 이름 조회.
   * @returns tool 이름 (없으면 null)
   */
  getSessionCurrentTool(sessionId: string): string | null {
    const row = this.stmtSessionCurrentToolPart.get(sessionId) as
      | { tool_name: string | null; status: string | null }
      | undefined;
    return row?.tool_name ?? null;
  }

  /**
   * DB 직접 조회로 prompt-response 응답 텍스트 추출.
   *
   * @param sessionId - 세션 ID
   * @param promptTimestamp - user 프롬프트의 timestamp (ms)
   * @returns 30KB까지 truncate된 응답 텍스트, 없으면 null
   */
  getPromptResponseFromDb(sessionId: string, promptTimestamp: number): string | null {
    // 1) user 메시지 찾기 (±2초 윈도우)
    const userMsg = this.stmtFindUserMessageByTime.get(sessionId, promptTimestamp) as
      | { id: string; time_created: number }
      | undefined;
    if (!userMsg) return null;

    // 2) 이후의 assistant text parts 수집 (다음 user 메시지 전까지)
    const parts = this.stmtAssistantTextPartsAfterMessage.all(
      sessionId,
      userMsg.time_created,
      sessionId,
      userMsg.time_created,
    ) as Array<{ text: string | null }>;

    const textParts = parts
      .map(p => p.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);

    if (textParts.length === 0) return null;

    const response = textParts.join('\n\n');
    return response.length > 30_000
      ? response.slice(0, 30_000) + '\n\n... (truncated)'
      : response;
  }
}
