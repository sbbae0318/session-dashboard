/**
 * contract-validators 유닛 테스트
 *
 * api-contract.ts에 정의된 타입에 대해 validator가
 * 올바르게 통과/실패하는지 검증합니다.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSession,
  validateQueryEntry,
  validateMachineInfo,
  validateHealthResponse,
  validateSessionsResponse,
  validateQueriesResponse,
  validateMachinesResponse,
} from '../shared/contract-validators.js';

// =============================================================================
// Fixtures
// =============================================================================

function validSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'ses_abc123',
    parentSessionId: null,
    childSessionIds: [],
    title: 'Test session',
    projectCwd: '/home/user/project',
    status: 'idle',
    waitingForInput: false,
    apiStatus: 'idle',
    currentTool: null,
    startTime: 1700000000000,
    lastActivityTime: 1700000060000,
    lastPrompt: null,
    lastPromptTime: null,
    duration: null,
    summary: null,
    source: 'opencode',
    machineId: 'macbook',
    machineHost: '192.168.0.63',
    machineAlias: 'MacBook Pro',
    machineConnected: true,
    ...overrides,
  };
}

function validQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'ses_abc123',
    sessionTitle: 'Test session',
    timestamp: 1700000000000,
    query: 'hello world',
    isBackground: false,
    source: 'opencode',
    completedAt: null,
    machineId: 'macbook',
    machineHost: '192.168.0.63',
    machineAlias: 'MacBook Pro',
    ...overrides,
  };
}

function validMachine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'macbook',
    alias: 'MacBook Pro',
    host: '192.168.0.63',
    status: 'connected',
    lastSeen: 1700000000000,
    error: null,
    ...overrides,
  };
}

// =============================================================================
// DashboardSession
// =============================================================================

describe('validateSession', () => {
  it('valid OpenCode session passes', () => {
    expect(validateSession(validSession()).valid).toBe(true);
  });

  it('valid Claude session passes', () => {
    const result = validateSession(validSession({
      source: 'claude-code',
      hooksActive: true,
      sessionId: 'uuid-style-id',
    }));
    expect(result.valid).toBe(true);
  });

  it('active + busy session passes', () => {
    const result = validateSession(validSession({
      status: 'active',
      apiStatus: 'busy',
      currentTool: 'Bash',
      waitingForInput: false,
    }));
    expect(result.valid).toBe(true);
  });

  it('waiting session passes', () => {
    const result = validateSession(validSession({
      waitingForInput: true,
      apiStatus: 'busy',
    }));
    expect(result.valid).toBe(true);
  });

  it('apiStatus=null passes', () => {
    expect(validateSession(validSession({ apiStatus: null })).valid).toBe(true);
  });

  it('apiStatus=retry passes', () => {
    expect(validateSession(validSession({ apiStatus: 'retry' })).valid).toBe(true);
  });

  it('hooksActive optional — omitting is valid', () => {
    const s = validSession();
    delete s.hooksActive;
    expect(validateSession(s).valid).toBe(true);
  });

  // ── 실패 케이스 ──

  it('fails on missing sessionId', () => {
    const result = validateSession(validSession({ sessionId: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('sessionId');
  });

  it('fails on invalid status', () => {
    const result = validateSession(validSession({ status: 'running' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('status');
  });

  it('fails on invalid source', () => {
    const result = validateSession(validSession({ source: 'unknown' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('source');
  });

  it('fails on invalid apiStatus', () => {
    const result = validateSession(validSession({ apiStatus: 'active' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('apiStatus');
  });

  it('fails on non-boolean waitingForInput', () => {
    const result = validateSession(validSession({ waitingForInput: 'true' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('waitingForInput');
  });

  it('machineConnected=false passes', () => {
    const result = validateSession(validSession({ machineConnected: false }));
    expect(result.valid).toBe(true);
  });

  it('fails on missing machineConnected', () => {
    const s = validSession();
    delete s.machineConnected;
    const result = validateSession(s);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'machineConnected')).toBe(true);
  });

  it('fails on string startTime', () => {
    const result = validateSession(validSession({ startTime: '2024-01-01' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('startTime');
  });

  it('fails on non-array childSessionIds', () => {
    const result = validateSession(validSession({ childSessionIds: 'not-array' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('childSessionIds');
  });

  it('collects multiple errors', () => {
    const result = validateSession(validSession({
      sessionId: '',
      status: 'bad',
      source: 42,
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// QueryEntry
// =============================================================================

describe('validateQueryEntry', () => {
  it('valid query passes', () => {
    expect(validateQueryEntry(validQuery()).valid).toBe(true);
  });

  it('claude-code source passes', () => {
    expect(validateQueryEntry(validQuery({ source: 'claude-code' })).valid).toBe(true);
  });

  it('completedAt number passes', () => {
    expect(validateQueryEntry(validQuery({ completedAt: 1700000001000 })).valid).toBe(true);
  });

  it('fails on missing query', () => {
    const result = validateQueryEntry(validQuery({ query: 42 }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('query');
  });

  it('fails on invalid source', () => {
    const result = validateQueryEntry(validQuery({ source: 'gpt' }));
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// MachineInfo
// =============================================================================

describe('validateMachineInfo', () => {
  it('connected machine passes', () => {
    expect(validateMachineInfo(validMachine()).valid).toBe(true);
  });

  it('disconnected machine with error passes', () => {
    const result = validateMachineInfo(validMachine({
      status: 'disconnected',
      error: 'ECONNREFUSED',
      lastSeen: null,
    }));
    expect(result.valid).toBe(true);
  });

  it('fails on invalid status', () => {
    const result = validateMachineInfo(validMachine({ status: 'online' }));
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// HealthResponse
// =============================================================================

describe('validateHealthResponse', () => {
  it('valid health passes', () => {
    const result = validateHealthResponse({
      status: 'ok',
      uptime: 12345,
      timestamp: 1700000000000,
      connectedMachines: 2,
      totalMachines: 2,
    });
    expect(result.valid).toBe(true);
  });

  it('fails on bad status', () => {
    const result = validateHealthResponse({
      status: 'error',
      uptime: 0,
      timestamp: 0,
      connectedMachines: 0,
      totalMachines: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('status');
  });
});

// =============================================================================
// Envelope Validators
// =============================================================================

describe('validateSessionsResponse', () => {
  it('empty sessions passes', () => {
    expect(validateSessionsResponse({ sessions: [] }).valid).toBe(true);
  });

  it('valid sessions passes', () => {
    const result = validateSessionsResponse({
      sessions: [validSession(), validSession({ sessionId: 'ses_def456', source: 'claude-code' })],
    });
    expect(result.valid).toBe(true);
  });

  it('fails on non-array', () => {
    const result = validateSessionsResponse({ sessions: 'not-array' });
    expect(result.valid).toBe(false);
  });

  it('error field includes index', () => {
    const result = validateSessionsResponse({
      sessions: [validSession(), validSession({ sessionId: '' })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toMatch(/sessions\[1\]/);
  });
});

describe('validateQueriesResponse', () => {
  it('empty queries passes', () => {
    expect(validateQueriesResponse({ queries: [] }).valid).toBe(true);
  });

  it('valid queries passes', () => {
    expect(validateQueriesResponse({ queries: [validQuery()] }).valid).toBe(true);
  });
});

describe('validateMachinesResponse', () => {
  it('valid machines passes', () => {
    expect(validateMachinesResponse({ machines: [validMachine()] }).valid).toBe(true);
  });
});
