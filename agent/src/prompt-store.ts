/**
 * SQLite-backed persistent storage for prompt history.
 *
 * Stores user prompts collected from oc-serve sessions so they survive
 * agent restarts and can be served instantly without re-fetching from oc-serve.
 *
 * Design follows SessionStore patterns (WAL mode, prepared statements, better-sqlite3).
 */

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QueryEntry } from './oc-query-collector.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_MAX_ENTRIES = 5000;

// ---------------------------------------------------------------------------
// PromptStore
// ---------------------------------------------------------------------------

export class PromptStore {
  private readonly db: Database.Database;

  // Prepared statements (reusable for performance)
  private readonly stmtUpsert: Statement;
  private readonly stmtGetRecent: Statement;
  private readonly stmtEvict: Statement;
  private readonly stmtTrim: Statement;
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
      CREATE TABLE IF NOT EXISTS prompt_history (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        session_title TEXT,
        timestamp     INTEGER NOT NULL,
        query         TEXT NOT NULL,
        is_background INTEGER DEFAULT 0,
        source        TEXT DEFAULT 'opencode',
        collected_at  INTEGER NOT NULL
      )
    `);

    // completed_at 컬럼 추가 (기존 DB 호환)
    try {
      this.db.exec('ALTER TABLE prompt_history ADD COLUMN completed_at INTEGER');
    } catch {
      // 이미 존재하면 무시
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ph_timestamp ON prompt_history(timestamp DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ph_session ON prompt_history(session_id)
    `);

    // Prepared statements — 생성자에서 한 번만 준비
    this.stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO prompt_history
        (id, session_id, session_title, timestamp, query, is_background, source, collected_at, completed_at)
      VALUES
        (@id, @session_id, @session_title, @timestamp, @query, @is_background, @source, @collected_at, @completed_at)
    `);

    this.stmtGetRecent = this.db.prepare(
      'SELECT * FROM prompt_history ORDER BY timestamp DESC LIMIT ?',
    );

    this.stmtEvict = this.db.prepare(
      'DELETE FROM prompt_history WHERE collected_at < ?',
    );

    // trimToMax: 가장 오래된 항목부터 삭제 (MAX 초과분)
    // subquery: 최신 N개의 id를 제외하고 삭제
    this.stmtTrim = this.db.prepare(`
      DELETE FROM prompt_history
      WHERE id NOT IN (
        SELECT id FROM prompt_history ORDER BY timestamp DESC LIMIT ?
      )
    `);

    this.stmtCount = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM prompt_history',
    );
  }

  /**
   * QueryEntry 배열을 INSERT OR REPLACE로 저장.
   * 동일 id가 이미 존재하면 새 데이터로 덮어씀 (isBackground 등 수정된 값 반영).
   * @returns 실제 삽입/갱신된 행 수
   */
  upsertMany(entries: ReadonlyArray<QueryEntry>): number {
    const now = Date.now();
    let inserted = 0;

    const runBatch = this.db.transaction((items: ReadonlyArray<QueryEntry>) => {
      for (const entry of items) {
        const id = `${entry.sessionId}:${entry.timestamp}`;
        const info = this.stmtUpsert.run({
          id,
          session_id: entry.sessionId,
          session_title: entry.sessionTitle,
          timestamp: entry.timestamp,
          query: entry.query,
          is_background: entry.isBackground ? 1 : 0,
          source: entry.source,
          collected_at: now,
          completed_at: entry.completedAt ?? null,
        });
        inserted += info.changes;
      }
    });

    runBatch(entries);
    return inserted;
  }

  /**
   * 최신순으로 limit개의 프롬프트를 반환.
   */
  getRecent(limit: number = 50): QueryEntry[] {
    const rows = this.stmtGetRecent.all(limit) as PromptRow[];
    return rows.map(rowToQueryEntry);
  }

  /**
   * maxAgeMs보다 오래된 프롬프트 제거 (collected_at 기준).
   * @returns 삭제된 행 수
   */
  evict(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.stmtEvict.run(cutoff);
    return info.changes;
  }

  /**
   * maxEntries 초과 시 가장 오래된 항목 삭제.
   * @returns 삭제된 행 수
   */
  trimToMax(maxEntries: number = DEFAULT_MAX_ENTRIES): number {
    const currentCount = this.count();
    if (currentCount <= maxEntries) return 0;
    const info = this.stmtTrim.run(maxEntries);
    return info.changes;
  }

  /** 저장된 프롬프트 수 반환. */
  count(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }

  /** session_title IS NULL인 프롬프트에 타이틀 소급 적용. */
  backfillTitles(titleMap: Record<string, string>): number {
    const entries = Object.entries(titleMap);
    if (entries.length === 0) return 0;

    const stmt = this.db.prepare(
      'UPDATE prompt_history SET session_title = ? WHERE session_id = ? AND session_title IS NULL',
    );

    let updated = 0;
    const runBatch = this.db.transaction((items: Array<[string, string]>) => {
      for (const [sessionId, title] of items) {
        const info = stmt.run(title, sessionId);
        updated += info.changes;
      }
    });

    runBatch(entries);
    return updated;
  }

  /** 특정 세션의 프롬프트를 시간순으로 반환. */
  getBySessionId(sessionId: string, limit: number = 100): QueryEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM prompt_history WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?',
    );
    const rows = stmt.all(sessionId, limit) as PromptRow[];
    return rows.map(rowToQueryEntry);
  }

  /** 내부 DB 인스턴스 접근 (SummaryEngine 등 동일 DB 공유용). */
  get database(): Database.Database {
    return this.db;
  }

  /** DB 연결 종료. 이후 작업 시 에러 발생. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row type matching the SQLite schema
// ---------------------------------------------------------------------------

interface PromptRow {
  id: string;
  session_id: string;
  session_title: string | null;
  timestamp: number;
  query: string;
  is_background: number;
  source: string;
  collected_at: number;
  completed_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToQueryEntry(row: PromptRow): QueryEntry {
  return {
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    timestamp: row.timestamp,
    query: row.query,
    isBackground: row.is_background === 1,
    source: row.source as QueryEntry['source'],
    completedAt: row.completed_at ?? null,
  };
}
