/**
 * 프론트엔드 타입 — shared/api-contract.ts에서 공유 타입을 re-export하고,
 * 프론트엔드 전용 타입(Memo 등)만 여기서 정의합니다.
 */

// 공유 타입 re-export (백엔드 ↔ 프론트엔드 계약)
export type {
  DashboardSession,
  QueryEntry,
  MachineInfo,
  SessionSource,
  ApiStatus,
  SessionStatus,
  DisplayStatusLabel,
  HealthResponse,
  SessionsResponse,
  QueriesResponse,
  MachinesResponse,
  SSEEventMap,
  SSEEventName,
} from '../../src/shared/api-contract.js';

export type {
  TurnSummaryPayload,
  SessionTurnsResponse,
  PromptTurnSummary,
  PromptAuditResponse,
  ToolInvocationEntry,
  SubagentRunEntry,
  TranscriptBodyResponse,
  TranscriptEvent,
} from '../../src/shared/api-contract.js';

// ── 프론트엔드 전용 타입 (Memo 등) ──

export interface Memo {
  id: string;
  projectId: string;
  projectSlug: string;
  machineId: string;
  title: string;
  date: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoWithContent extends Memo {
  content: string;
}

export interface MemoWithSnippet extends Memo {
  snippet: string;
}

export interface MemoProject {
  projectId: string;
  projectSlug: string;
  machineId: string;
  memoCount: number;
  latestDate: string;
}
