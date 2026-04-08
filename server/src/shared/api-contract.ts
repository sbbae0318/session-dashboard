/**
 * API Contract — session-dashboard 백엔드 ↔ 프론트엔드 공유 타입
 *
 * 이 파일은 백엔드(server/)와 프론트엔드(server/frontend/)가
 * 주고받는 모든 데이터의 형태를 정의합니다.
 *
 * 규칙:
 *   - 타입 변경 시 양쪽 빌드가 깨지므로 호환성 확인 필수
 *   - optional(?) 필드는 백엔드가 조건부로 포함하는 필드
 *   - 필수 필드는 백엔드가 항상 반환을 보장
 */

// =============================================================================
// Core Domain Types
// =============================================================================

/** 세션 소스 */
export type SessionSource = 'opencode' | 'claude-code';

/** 백엔드 내부 API 상태 (oc-serve / Claude hooks 기준) */
export type ApiStatus = 'idle' | 'busy' | 'retry';

/** 프론트엔드 표시용 세션 상태 */
export type SessionStatus = 'active' | 'idle';

// =============================================================================
// REST API Response Types
// =============================================================================

// ── GET /health ──

export interface HealthResponse {
  status: 'ok';
  uptime: number;          // ms since server start
  timestamp: number;       // current time (ms)
  connectedMachines: number;
  totalMachines: number;
}

// ── GET /api/sessions ──

export interface DashboardSession {
  sessionId: string;
  parentSessionId: string | null;
  childSessionIds: string[];
  title: string | null;
  projectCwd: string | null;

  status: SessionStatus;
  waitingForInput: boolean;
  apiStatus: ApiStatus | null;
  currentTool: string | null;

  startTime: number;           // ms timestamp
  lastActivityTime: number;    // ms timestamp
  lastPrompt: string | null;
  lastPromptTime: number | null;

  duration: string | null;
  summary: string | null;

  source: SessionSource;
  /** Claude 세션 전용: hooks 연결 여부. OpenCode 세션에는 없음 */
  hooksActive?: boolean;
  /** OS 프로세스 테이블 메트릭. 프로세스 미발견 시 null */
  processMetrics?: { alive: boolean; cpuPercent: number; rssKb: number } | null;
  /** title 변경 직후 일시적 플래그 (3초 후 자동 해제) */
  recentlyRenamed?: boolean;

  // Machine 식별
  machineId: string;
  machineHost: string;
  machineAlias: string;
  /** 해당 세션이 속한 머신의 연결 상태 */
  machineConnected: boolean;
}

export interface SessionsResponse {
  sessions: DashboardSession[];
}

// ── GET /api/queries ──

export interface QueryEntry {
  sessionId: string;
  sessionTitle: string | null;
  timestamp: number;          // ms
  query: string;
  isBackground: boolean;
  source: SessionSource;
  completedAt: number | null; // ms

  // Machine 식별
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

export interface QueriesResponse {
  queries: QueryEntry[];
}

// ── GET /api/machines ──

export interface MachineInfo {
  id: string;
  alias: string;
  host: string;
  status: 'connected' | 'disconnected';
  lastSeen: number | null;
  error: string | null;
  source?: SessionSource | 'both';
}

export interface MachinesResponse {
  machines: MachineInfo[];
}

// ── POST /api/search ──

export interface SearchRequest {
  query: string;
  timeRange: '1h' | '24h' | '7d' | '30d' | '90d';
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  results: QueryEntry[];
  total: number;
  hasMore: boolean;
}

// =============================================================================
// SSE Event Types (GET /api/events)
// =============================================================================

export interface SSEEventMap {
  'session.update': DashboardSession[];
  'query.new': QueryEntry;
  'machine.status': MachineInfo[];
  'enrichment.updated': {
    machineId: string;
    feature: string;
    cachedAt: number;
  };
  'enrichment.merged.updated': {
    feature: string;
    machineCount: number;
    cachedAt: number;
  };
  'enrichment.cache': {
    machineId: string;
    feature: string;
    cachedAt: number;
  };
}

export type SSEEventName = keyof SSEEventMap;

// =============================================================================
// Display Status (프론트엔드 전용 — 렌더링 규칙 문서화)
// =============================================================================

/**
 * 프론트엔드 DisplayStatus 결정 규칙 (우선순위 순):
 *
 *   RENAME:       recentlyRenamed === true (최우선, 3초 TTL)
 *   DISCONNECTED: machineConnected === false (머신 연결 끊김 — stale 데이터)
 *   WORKING:      (apiStatus === 'busy' || apiStatus === 'retry' || currentTool != null)
 *                 AND waitingForInput === false
 *   WAITING:      waitingForInput === true
 *   IDLE:         그 외
 */
export type DisplayStatusLabel = 'Working' | 'Retry' | 'Waiting' | 'Idle' | 'Rename' | 'Disconnected';
