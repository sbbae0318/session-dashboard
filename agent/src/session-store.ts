/**
 * SQLite-backed persistent storage for session status data.
 *
 * Replaces the in-memory Map used by SessionCache with durable storage
 * via better-sqlite3 (synchronous API — no async wrappers needed).
 */

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionDetail } from './session-cache.js';

// ---------------------------------------------------------------------------
// Row type matching the SQLite schema
// ---------------------------------------------------------------------------

interface SessionRow {
  session_id: string;
  status: string;
  last_prompt: string | null;
  last_prompt_time: number;
  current_tool: string | null;
  directory: string | null;
  waiting_for_input: number;
  updated_at: number;
  title: string | null;
  parent_session_id: string | null;
  created_at: number;
  last_active_at: number;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly db: Database.Database;

  // Prepared statements (reusable for performance)
  private readonly stmtGet: Statement;
  private readonly stmtUpsert: Statement;
  private readonly stmtGetAll: Statement;
  private readonly stmtDelete: Statement;
  private readonly stmtEvict: Statement;
  private readonly stmtEvictByActivity: Statement;
  private readonly stmtCount: Statement;

  constructor(dbPath: string = './data/session-cache.db') {
    // :memory: 는 디렉토리 생성 불필요
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);

    // WAL 모드: 읽기/쓰기 동시성 향상
    this.db.pragma('journal_mode = WAL');

    // 스키마 초기화
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_status (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_prompt TEXT,
        last_prompt_time INTEGER NOT NULL DEFAULT 0,
        current_tool TEXT,
        directory TEXT,
        waiting_for_input INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        title TEXT,
        parent_session_id TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
      )
    `);

    // 기존 DB 마이그레이션
    const migrations = [
      `ALTER TABLE session_status ADD COLUMN waiting_for_input INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE session_status ADD COLUMN title TEXT`,
      `ALTER TABLE session_status ADD COLUMN parent_session_id TEXT`,
      `ALTER TABLE session_status ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE session_status ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    // Prepared statements — 생성자에서 한 번만 준비
    this.stmtGet = this.db.prepare(
      'SELECT * FROM session_status WHERE session_id = ?',
    );

    this.stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO session_status
        (session_id, status, last_prompt, last_prompt_time, current_tool, directory, waiting_for_input, updated_at, title, parent_session_id, created_at, last_active_at)
      VALUES
        (@session_id, @status, @last_prompt, @last_prompt_time, @current_tool, @directory, @waiting_for_input, @updated_at, @title, @parent_session_id, @created_at, @last_active_at)
    `);

    this.stmtGetAll = this.db.prepare('SELECT * FROM session_status');

    this.stmtDelete = this.db.prepare(
      'DELETE FROM session_status WHERE session_id = ?',
    );

    this.stmtEvict = this.db.prepare(
      'DELETE FROM session_status WHERE updated_at < ?',
    );

    this.stmtEvictByActivity = this.db.prepare(
      'DELETE FROM session_status WHERE CASE WHEN last_active_at > 0 THEN last_active_at ELSE updated_at END < ?',
    );

    this.stmtCount = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM session_status',
    );
  }

  /** session_id로 세션 상세 조회. 없으면 null 반환. */
  get(sessionId: string): SessionDetail | null {
    const row = this.stmtGet.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return rowToDetail(row);
  }

  /** 세션 상세 삽입 또는 갱신 (INSERT OR REPLACE). */
  upsert(sessionId: string, detail: SessionDetail): void {
    this.stmtUpsert.run({
      session_id: sessionId,
      status: detail.status,
      last_prompt: detail.lastPrompt,
      last_prompt_time: detail.lastPromptTime,
      current_tool: detail.currentTool,
      directory: detail.directory,
      waiting_for_input: detail.waitingForInput ? 1 : 0,
      updated_at: detail.updatedAt,
      title: detail.title,
      parent_session_id: detail.parentSessionId,
      created_at: detail.createdAt,
      last_active_at: detail.lastActiveAt,
    });
  }

  /** 모든 세션을 Record<sessionId, SessionDetail> 형태로 반환. */
  getAll(): Record<string, SessionDetail> {
    const rows = this.stmtGetAll.all() as SessionRow[];
    const result: Record<string, SessionDetail> = {};
    for (const row of rows) {
      result[row.session_id] = rowToDetail(row);
    }
    return result;
  }

  /** session_id로 세션 삭제. */
  delete(sessionId: string): void {
    this.stmtDelete.run(sessionId);
  }

  evict(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.stmtEvict.run(cutoff);
    return info.changes;
  }

  evictByActivity(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.stmtEvictByActivity.run(cutoff);
    return info.changes;
  }

  /** 저장된 세션 수 반환. */
  count(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }

  /** DB 연결 종료. 이후 작업 시 에러 발생. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToDetail(row: SessionRow): SessionDetail {
  return {
    status: row.status as SessionDetail['status'],
    lastPrompt: row.last_prompt,
    lastPromptTime: row.last_prompt_time,
    currentTool: row.current_tool,
    directory: row.directory,
    waitingForInput: Boolean(row.waiting_for_input),
    updatedAt: row.updated_at,
    title: row.title ?? null,
    parentSessionId: row.parent_session_id ?? null,
    createdAt: row.created_at ?? 0,
    lastActiveAt: row.last_active_at ?? 0,
  };
}
