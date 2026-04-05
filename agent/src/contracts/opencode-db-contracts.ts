/**
 * Contract: OpenCode DB Direct Monitoring
 *
 * `opencode.db`를 직접 읽어 세션 모니터링을 수행할 때 사용되는 모든 데이터 스키마.
 * oc-serve가 없을 때 fallback으로 사용됨.
 *
 * 두 가지 타입 계층:
 *   1. Raw DB row shapes — SQLite가 반환하는 그대로의 row
 *   2. Derived domain types — 모듈 간 전달되는 가공된 형태
 *
 * 이 파일은 `opencode-db-reader.ts` ↔ `opencode-db-source.ts` ↔ server 간
 * 데이터 계약의 단일 진실 소스(single source of truth).
 */

// =============================================================================
// 1. Raw DB Row Shapes
// =============================================================================

/** `session` 테이블 row (필요한 컬럼만) */
export interface DbSessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly parent_id: string | null;
  readonly title: string;
  readonly directory: string;
  readonly time_created: number;
  readonly time_updated: number;
}

/**
 * 세션의 마지막 `message` row에서 추출한 status 관련 필드.
 *
 * role/finish는 message.data JSON에서 json_extract로 추출됨:
 *   - role: 'user' | 'assistant'
 *   - finish: 'stop' | 'tool-calls' | 'length' | 'unknown' | null
 */
export interface DbLastMessageRow {
  readonly session_id: string;
  readonly role: DbMessageRole | null;
  readonly finish: DbMessageFinish | null;
  readonly time_created: number | null;    // message.data.time.created
  readonly time_completed: number | null;  // message.data.time.completed
  readonly time_updated: number;           // message.time_updated (SQL column)
}

/** `part` 테이블에서 user 프롬프트 텍스트 추출 결과 */
export interface DbUserPromptRow {
  readonly message_id: string;
  readonly message_time_created: number;
  readonly text: string;
}

/** `part` 테이블에서 tool 정보 추출 결과 */
export interface DbToolPartRow {
  readonly tool_name: string | null;
  readonly status: string | null;   // 'running' | 'completed' | 'pending'
}

/** `part` 테이블에서 assistant 응답 텍스트 파트 */
export interface DbPromptResponsePartRow {
  readonly text: string;
}

// =============================================================================
// 2. Enum-like string literal types
// =============================================================================

/** message.data.role 가능한 값 */
export type DbMessageRole = 'user' | 'assistant';

/**
 * message.data.finish 가능한 값 (실측):
 *   - 'stop': 정상 완료 (턴 종료)
 *   - 'tool-calls': tool 실행 중 (다음 assistant가 이어받음)
 *   - 'length': 토큰 한계 도달
 *   - 'unknown': 비정상 종료
 *   - null: 스트리밍 중 or compaction 등
 */
export type DbMessageFinish = 'stop' | 'tool-calls' | 'length' | 'unknown';

/** DB 기반으로 판정 가능한 세션 상태 (SessionCache와 호환, 'retry' 제외) */
export type DbSessionStatus = 'busy' | 'idle';

// =============================================================================
// 3. Derived Domain Types (모듈 간 전송)
// =============================================================================

/**
 * DB 기반 모니터링 세션.
 * `SessionCache`의 `SessionDetail`과 호환되는 형태.
 *
 * 주의: `waitingForInput`은 항상 false — DB에는 permission/question 신호가 없음.
 * `currentTool`은 busy 세션에 한해 part 테이블에서 조회.
 */
export interface DbMonitoredSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly title: string | null;
  readonly directory: string | null;
  readonly status: DbSessionStatus;
  readonly lastPrompt: string | null;
  readonly lastPromptTime: number;
  readonly currentTool: string | null;
  readonly waitingForInput: false;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

/**
 * DB 기반 프롬프트 엔트리.
 * `OcQueryCollector`의 `QueryEntry`와 호환되는 형태 (source 필드 제외 — 항상 'opencode').
 */
export interface DbQueryEntry {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly timestamp: number;
  readonly query: string;
  readonly isBackground: boolean;
  readonly completedAt: number | null;
}

// =============================================================================
// 4. Configuration
// =============================================================================

export interface DbSourceConfig {
  /** opencode.db 경로 (mtime 감지용). reader와 동일해야 함. */
  readonly dbPath: string;
  /** 폴링 주기 (ms). 기본값: 3000 */
  readonly pollIntervalMs?: number;
  /** 세션이 이 시간 이상 비활성이면 idle 강제 (ms). 기본값: 300_000 (5분) */
  readonly idleThresholdMs?: number;
  /** 최근 세션 조회 윈도우 (ms). 기본값: 86_400_000 (24시간) */
  readonly recentWindowMs?: number;
  /** 조회할 최대 세션 수. 기본값: 500 */
  readonly maxSessions?: number;
}

/** 기본 설정값 */
export const DB_SOURCE_DEFAULTS = {
  pollIntervalMs: 3_000,
  idleThresholdMs: 5 * 60 * 1000,
  recentWindowMs: 24 * 60 * 60 * 1000,
  maxSessions: 500,
} as const;

// =============================================================================
// 5. Status 판정 함수 타입
// =============================================================================

/**
 * DB row → 세션 status 판정 함수 시그니처.
 *
 * 판정 로직:
 *   - role=user → busy (응답 대기)
 *   - assistant + finish='stop' → idle
 *   - assistant + finish='tool-calls' → busy
 *   - assistant + finish=null → busy (스트리밍 중)
 *   - assistant + finish='length'|'unknown' → idle (비정상 종료)
 *   - time_updated > idleThresholdMs 경과 → idle 강제
 */
export type StatusDeterminer = (
  lastRole: DbMessageRole | null,
  lastFinish: DbMessageFinish | null,
  lastMessageTimeMs: number,
  nowMs: number,
  idleThresholdMs: number,
) => DbSessionStatus;
