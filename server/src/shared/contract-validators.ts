/**
 * Contract Validators — api-contract.ts 타입에 대한 런타임 검증 함수
 *
 * TDD에서 사용: 백엔드 응답이 계약을 준수하는지 검증.
 * 테스트 전용이 아닌 런타임에서도 사용 가능 (디버그 모드 등).
 */

import type {
  DashboardSession,
  QueryEntry,
  MachineInfo,
  HealthResponse,
  SessionsResponse,
  QueriesResponse,
  MachinesResponse,
} from './api-contract.js';

// =============================================================================
// Validation Result
// =============================================================================

export interface ValidationError {
  field: string;
  expected: string;
  actual: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: ValidationError[]): ValidationResult {
  return { valid: false, errors };
}

function check(field: string, expected: string, actual: unknown, condition: boolean): ValidationError | null {
  return condition ? null : { field, expected, actual: String(actual) };
}

// =============================================================================
// Field Validators
// =============================================================================

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && !Number.isNaN(v));
}

// =============================================================================
// DashboardSession Validator
// =============================================================================

const VALID_SESSION_STATUS = new Set(['active', 'idle']);
const VALID_API_STATUS = new Set(['idle', 'busy', 'retry']);
const VALID_SOURCE = new Set(['opencode', 'claude-code']);

export function validateSession(s: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const push = (e: ValidationError | null) => { if (e) errors.push(e); };

  // 필수 string 필드
  push(check('sessionId', 'non-empty string', s.sessionId, isString(s.sessionId) && s.sessionId.length > 0));
  push(check('machineId', 'string', s.machineId, isString(s.machineId)));
  push(check('machineHost', 'string', s.machineHost, isString(s.machineHost)));
  push(check('machineAlias', 'string', s.machineAlias, isString(s.machineAlias)));

  // 필수 enum 필드
  push(check('status', '"active" | "idle"', s.status, isString(s.status) && VALID_SESSION_STATUS.has(s.status)));
  push(check('source', '"opencode" | "claude-code"', s.source, isString(s.source) && VALID_SOURCE.has(s.source)));

  // 필수 boolean
  push(check('waitingForInput', 'boolean', s.waitingForInput, isBoolean(s.waitingForInput)));

  // 필수 number (timestamps)
  push(check('startTime', 'number (ms)', s.startTime, isNumber(s.startTime)));
  push(check('lastActivityTime', 'number (ms)', s.lastActivityTime, isNumber(s.lastActivityTime)));

  // nullable 필드
  push(check('parentSessionId', 'string | null', s.parentSessionId, isStringOrNull(s.parentSessionId)));
  push(check('title', 'string | null', s.title, isStringOrNull(s.title)));
  push(check('projectCwd', 'string | null', s.projectCwd, isStringOrNull(s.projectCwd)));
  push(check('currentTool', 'string | null', s.currentTool, isStringOrNull(s.currentTool)));
  push(check('lastPrompt', 'string | null', s.lastPrompt, isStringOrNull(s.lastPrompt)));
  push(check('lastPromptTime', 'number | null', s.lastPromptTime, isNumberOrNull(s.lastPromptTime)));
  push(check('duration', 'string | null', s.duration, isStringOrNull(s.duration)));
  push(check('summary', 'string | null', s.summary, isStringOrNull(s.summary)));

  // apiStatus: ApiStatus | null
  push(check('apiStatus', '"idle"|"busy"|"retry"|null', s.apiStatus,
    s.apiStatus === null || (isString(s.apiStatus) && VALID_API_STATUS.has(s.apiStatus))));

  // childSessionIds: string[]
  push(check('childSessionIds', 'string[]', s.childSessionIds,
    Array.isArray(s.childSessionIds) && (s.childSessionIds as unknown[]).every(isString)));

  // hooksActive: optional boolean (Claude 전용)
  if (s.hooksActive !== undefined) {
    push(check('hooksActive', 'boolean | undefined', s.hooksActive, isBoolean(s.hooksActive)));
  }

  return errors.length === 0 ? ok() : fail(errors);
}

// =============================================================================
// QueryEntry Validator
// =============================================================================

export function validateQueryEntry(q: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const push = (e: ValidationError | null) => { if (e) errors.push(e); };

  push(check('sessionId', 'string', q.sessionId, isString(q.sessionId)));
  push(check('sessionTitle', 'string | null', q.sessionTitle, isStringOrNull(q.sessionTitle)));
  push(check('timestamp', 'number', q.timestamp, isNumber(q.timestamp)));
  push(check('query', 'string', q.query, isString(q.query)));
  push(check('isBackground', 'boolean', q.isBackground, isBoolean(q.isBackground)));
  push(check('source', '"opencode" | "claude-code"', q.source, isString(q.source) && VALID_SOURCE.has(q.source)));
  push(check('completedAt', 'number | null', q.completedAt, isNumberOrNull(q.completedAt)));
  push(check('machineId', 'string', q.machineId, isString(q.machineId)));
  push(check('machineHost', 'string', q.machineHost, isString(q.machineHost)));
  push(check('machineAlias', 'string', q.machineAlias, isString(q.machineAlias)));

  return errors.length === 0 ? ok() : fail(errors);
}

// =============================================================================
// MachineInfo Validator
// =============================================================================

const VALID_MACHINE_STATUS = new Set(['connected', 'disconnected']);

export function validateMachineInfo(m: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const push = (e: ValidationError | null) => { if (e) errors.push(e); };

  push(check('id', 'string', m.id, isString(m.id)));
  push(check('alias', 'string', m.alias, isString(m.alias)));
  push(check('host', 'string', m.host, isString(m.host)));
  push(check('status', '"connected" | "disconnected"', m.status,
    isString(m.status) && VALID_MACHINE_STATUS.has(m.status)));
  push(check('lastSeen', 'number | null', m.lastSeen, isNumberOrNull(m.lastSeen)));
  push(check('error', 'string | null', m.error, isStringOrNull(m.error)));

  return errors.length === 0 ? ok() : fail(errors);
}

// =============================================================================
// HealthResponse Validator
// =============================================================================

export function validateHealthResponse(h: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const push = (e: ValidationError | null) => { if (e) errors.push(e); };

  push(check('status', '"ok"', h.status, h.status === 'ok'));
  push(check('uptime', 'number', h.uptime, isNumber(h.uptime)));
  push(check('timestamp', 'number', h.timestamp, isNumber(h.timestamp)));
  push(check('connectedMachines', 'number', h.connectedMachines, isNumber(h.connectedMachines)));
  push(check('totalMachines', 'number', h.totalMachines, isNumber(h.totalMachines)));

  return errors.length === 0 ? ok() : fail(errors);
}

// =============================================================================
// Response Envelope Validators
// =============================================================================

export function validateSessionsResponse(body: Record<string, unknown>): ValidationResult {
  if (!Array.isArray(body.sessions)) {
    return fail([{ field: 'sessions', expected: 'array', actual: typeof body.sessions }]);
  }
  const errors: ValidationError[] = [];
  for (let i = 0; i < (body.sessions as unknown[]).length; i++) {
    const result = validateSession((body.sessions as Record<string, unknown>[])[i]);
    for (const e of result.errors) {
      errors.push({ ...e, field: `sessions[${i}].${e.field}` });
    }
  }
  return errors.length === 0 ? ok() : fail(errors);
}

export function validateQueriesResponse(body: Record<string, unknown>): ValidationResult {
  if (!Array.isArray(body.queries)) {
    return fail([{ field: 'queries', expected: 'array', actual: typeof body.queries }]);
  }
  const errors: ValidationError[] = [];
  for (let i = 0; i < (body.queries as unknown[]).length; i++) {
    const result = validateQueryEntry((body.queries as Record<string, unknown>[])[i]);
    for (const e of result.errors) {
      errors.push({ ...e, field: `queries[${i}].${e.field}` });
    }
  }
  return errors.length === 0 ? ok() : fail(errors);
}

export function validateMachinesResponse(body: Record<string, unknown>): ValidationResult {
  if (!Array.isArray(body.machines)) {
    return fail([{ field: 'machines', expected: 'array', actual: typeof body.machines }]);
  }
  const errors: ValidationError[] = [];
  for (let i = 0; i < (body.machines as unknown[]).length; i++) {
    const result = validateMachineInfo((body.machines as Record<string, unknown>[])[i]);
    for (const e of result.errors) {
      errors.push({ ...e, field: `machines[${i}].${e.field}` });
    }
  }
  return errors.length === 0 ? ok() : fail(errors);
}
