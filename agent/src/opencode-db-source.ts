/**
 * OpenCodeDbSource — opencode.db 직접 폴링 기반 세션 모니터.
 *
 * oc-serve가 없거나 죽었을 때 fallback으로 동작.
 * SSE 대신 mtime 기반 변경 감지로 주기적 폴링 수행.
 *
 * 반환 데이터 형태:
 *   - getSessionDetails(): SessionCache의 SessionDetail과 호환
 *   - getSupplementData(): OcQueryCollector의 SupplementData와 호환
 */

import { statSync } from 'node:fs';
import type { OpenCodeDBReader } from './opencode-db-reader.js';
import type { SessionDetail } from './session-cache.js';
import type { SupplementData } from './oc-query-collector.js';
import { extractUserPrompt } from './prompt-extractor.js';
import {
  DB_SOURCE_DEFAULTS,
  type DbMessageFinish,
  type DbMessageRole,
  type DbMonitoredSession,
  type DbSessionStatus,
  type DbSourceConfig,
} from './contracts/opencode-db-contracts.js';

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * 마지막 메시지 정보 기반으로 세션 상태 판정.
 *
 * 판정 로직:
 *   - role=user → busy (응답 대기 중)
 *   - assistant + finish='stop' → idle
 *   - assistant + finish='tool-calls' → busy
 *   - assistant + finish=null → busy (스트리밍 중)
 *   - assistant + finish='length'|'unknown' → idle (비정상 종료)
 *   - 마지막 업데이트가 idleThresholdMs 이상 경과 → idle 강제 (stale)
 */
export function determineStatus(
  lastRole: DbMessageRole | null,
  lastFinish: DbMessageFinish | null,
  lastMessageTimeMs: number,
  nowMs: number,
  idleThresholdMs: number,
): DbSessionStatus {
  // Stale 강제 idle
  if (nowMs - lastMessageTimeMs > idleThresholdMs) return 'idle';

  // 메시지 없음 → idle (빈 세션)
  if (lastRole === null) return 'idle';

  // user가 마지막 → assistant 응답 대기 중
  if (lastRole === 'user') return 'busy';

  // assistant 메시지
  if (lastFinish === 'stop') return 'idle';
  if (lastFinish === 'length' || lastFinish === 'unknown') return 'idle';
  // 'tool-calls' 또는 null(streaming) → busy
  return 'busy';
}

// ---------------------------------------------------------------------------
// OpenCodeDbSource class
// ---------------------------------------------------------------------------

export class OpenCodeDbSource {
  private readonly reader: OpenCodeDBReader;
  private readonly dbPath: string;
  private readonly pollIntervalMs: number;
  private readonly idleThresholdMs: number;
  private readonly recentWindowMs: number;
  private readonly maxSessions: number;

  private pollTimer: NodeJS.Timeout | null = null;
  private lastMtime: number = 0;

  /** sessionId → DbMonitoredSession 매핑 */
  private sessions: Map<string, DbMonitoredSession> = new Map();

  /** 세션이 idle → busy 전이 시 호출되는 콜백 (collection trigger) */
  private onSessionBusyCallback: (() => void) | null = null;

  constructor(reader: OpenCodeDBReader, config: DbSourceConfig) {
    this.reader = reader;
    this.dbPath = config.dbPath;
    this.pollIntervalMs = config.pollIntervalMs ?? DB_SOURCE_DEFAULTS.pollIntervalMs;
    this.idleThresholdMs = config.idleThresholdMs ?? DB_SOURCE_DEFAULTS.idleThresholdMs;
    this.recentWindowMs = config.recentWindowMs ?? DB_SOURCE_DEFAULTS.recentWindowMs;
    this.maxSessions = config.maxSessions ?? DB_SOURCE_DEFAULTS.maxSessions;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.pollTimer) return;
    // 초기 동기화
    this.refreshSessions();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Public API (SessionCache 호환 형태)
  // -------------------------------------------------------------------------

  onSessionBusy(cb: () => void): void {
    this.onSessionBusyCallback = cb;
  }

  /**
   * SessionCache.getSessionDetails()와 호환되는 형태로 반환.
   * meta.sseConnected는 항상 false (SSE 아님).
   */
  getSessionDetails(): {
    meta: { sseConnected: false; lastSseEventAt: number; sseConnectedAt: number };
    sessions: Record<string, SessionDetail>;
  } {
    const result: Record<string, SessionDetail> = {};
    for (const [id, s] of this.sessions) {
      result[id] = this.toSessionDetail(s);
    }
    return {
      meta: { sseConnected: false, lastSseEventAt: 0, sseConnectedAt: 0 },
      sessions: result,
    };
  }

  /**
   * OcQueryCollector.getSupplementData와 호환되는 형태로 반환.
   * lastPrompt가 있는 세션만 포함하면 message fetch 없이 QueryEntry 생성 가능.
   */
  getSupplementData(): Record<string, SupplementData> {
    const result: Record<string, SupplementData> = {};
    for (const [id, s] of this.sessions) {
      if (!s.lastPrompt) continue;
      result[id] = {
        lastPrompt: s.lastPrompt,
        lastPromptTime: s.lastPromptTime,
        status: s.status,
        title: s.title,
      };
    }
    return result;
  }

  /** 디버그/테스트용 — 내부 세션 맵 복사본 반환 */
  getMonitoredSessions(): DbMonitoredSession[] {
    return Array.from(this.sessions.values());
  }

  // -------------------------------------------------------------------------
  // Polling internals
  // -------------------------------------------------------------------------

  /** mtime 변경 시에만 refresh 실행 */
  private poll(): void {
    if (!this.hasDbChanged()) return;
    this.refreshSessions();
  }

  /** DB 파일 mtime이 마지막 확인 시점보다 변경되었는지 검사 */
  private hasDbChanged(): boolean {
    try {
      const stat = statSync(this.dbPath);
      if (stat.mtimeMs > this.lastMtime) {
        this.lastMtime = stat.mtimeMs;
        return true;
      }
      return false;
    } catch {
      // 파일 접근 실패 → 변경 없음으로 간주
      return false;
    }
  }

  /** DB를 읽어 sessions 맵 갱신 */
  private refreshSessions(): void {
    const now = Date.now();
    const sinceMs = now - this.recentWindowMs;

    let rows;
    try {
      rows = this.reader.getActiveSessionsWithStatus(sinceMs, this.maxSessions);
    } catch (err) {
      console.error('[opencode-db-source] query failed:', err);
      return;
    }

    // 현재 조회된 세션 ID 집합
    const currentIds = new Set<string>();
    let anyIdleToBusy = false;

    for (const row of rows) {
      currentIds.add(row.id);

      // status 판정 기준 시각: lastMsgTimeCreated → lastMsgTimeUpdated → timeUpdated
      const lastMsgTime = row.lastMsgTimeCreated
        ?? row.lastMsgTimeUpdated
        ?? row.timeUpdated;

      const status = determineStatus(
        row.lastRole,
        row.lastFinish,
        lastMsgTime,
        now,
        this.idleThresholdMs,
      );

      // 전이 감지 (이전 상태가 idle이고 현재 busy이면 flag)
      const prev = this.sessions.get(row.id);
      if (status === 'busy' && prev?.status === 'idle') {
        anyIdleToBusy = true;
      }

      // lastPrompt 조회 (최신 user 텍스트, 시스템 프롬프트 필터링)
      const { lastPrompt, lastPromptTime } = this.fetchLastUserPrompt(row.id);

      // currentTool: busy 세션에만 조회 (idle 세션은 null)
      const currentTool = status === 'busy'
        ? this.reader.getSessionCurrentTool(row.id)
        : null;

      const monitored: DbMonitoredSession = {
        sessionId: row.id,
        projectId: row.projectId,
        parentId: row.parentId,
        title: row.title || null,
        directory: row.directory || null,
        status,
        lastPrompt,
        lastPromptTime,
        currentTool,
        waitingForInput: false,
        createdAt: row.timeCreated,
        lastActiveAt: row.timeUpdated,
      };

      this.sessions.set(row.id, monitored);
    }

    // 윈도우 밖으로 나간 세션 제거
    for (const id of this.sessions.keys()) {
      if (!currentIds.has(id)) {
        this.sessions.delete(id);
      }
    }

    // busy 전이 감지 → 콜백 호출
    if (anyIdleToBusy && this.onSessionBusyCallback) {
      this.onSessionBusyCallback();
    }
  }

  /**
   * 세션의 최신 user 프롬프트 텍스트 조회 (시스템 프롬프트 필터링 적용).
   * @returns { lastPrompt, lastPromptTime } — 없으면 null/0
   */
  private fetchLastUserPrompt(sessionId: string): {
    lastPrompt: string | null;
    lastPromptTime: number;
  } {
    try {
      const rows = this.reader.getSessionLastUserPromptText(sessionId);
      for (const row of rows) {
        const extracted = extractUserPrompt(row.text);
        if (extracted !== null) {
          return {
            lastPrompt: extracted,
            lastPromptTime: row.messageTimeCreated,
          };
        }
      }
      return { lastPrompt: null, lastPromptTime: 0 };
    } catch {
      return { lastPrompt: null, lastPromptTime: 0 };
    }
  }

  /** DbMonitoredSession → SessionCache의 SessionDetail 변환 */
  private toSessionDetail(s: DbMonitoredSession): SessionDetail {
    return {
      status: s.status,
      lastPrompt: s.lastPrompt,
      lastPromptTime: s.lastPromptTime,
      currentTool: s.currentTool,
      directory: s.directory,
      waitingForInput: s.waitingForInput,
      updatedAt: s.lastActiveAt,
      title: s.title,
      parentSessionId: s.parentId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    };
  }
}
