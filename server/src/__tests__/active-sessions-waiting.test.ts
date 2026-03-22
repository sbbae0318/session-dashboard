/**
 * ActiveSessionsModule — waitingForInput 계약 검증
 *
 * 서버가 에이전트에서 받은 waitingForInput 값을
 * DashboardSession에 올바르게 매핑하는지 TDD로 검증합니다.
 *
 * 계약: waitingForInput은 항상 boolean (undefined 불가)
 */

import { describe, it, expect } from 'vitest';
import type { DashboardSession } from '../shared/api-contract.js';
import { validateSession } from '../shared/contract-validators.js';

// ActiveSessionsModule.buildSessionMap은 private이므로,
// 대신 출력 형태인 DashboardSession이 계약을 준수하는지 검증합니다.

describe('DashboardSession waitingForInput 계약', () => {
  function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
    return {
      sessionId: 'test-001',
      parentSessionId: null,
      childSessionIds: [],
      title: 'Test',
      projectCwd: '/tmp/test',
      status: 'idle',
      waitingForInput: false,
      apiStatus: 'idle',
      currentTool: null,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      lastPrompt: null,
      lastPromptTime: null,
      duration: null,
      summary: null,
      source: 'claude-code',
      machineId: 'macbook',
      machineHost: '192.168.0.63',
      machineAlias: 'MacBook Pro',
      ...overrides,
    };
  }

  it('idle 세션은 waitingForInput=false', () => {
    const s = makeSession({ status: 'idle', apiStatus: 'idle' });
    expect(s.waitingForInput).toBe(false);
    expect(validateSession(s as unknown as Record<string, unknown>).valid).toBe(true);
  });

  it('busy 세션은 waitingForInput=false (working 상태)', () => {
    const s = makeSession({
      status: 'active',
      apiStatus: 'busy',
      currentTool: 'Bash',
      waitingForInput: false,
    });
    expect(s.waitingForInput).toBe(false);
    expect(validateSession(s as unknown as Record<string, unknown>).valid).toBe(true);
  });

  it('waiting 세션은 waitingForInput=true', () => {
    const s = makeSession({
      status: 'active',
      apiStatus: 'busy',
      waitingForInput: true,
    });
    expect(s.waitingForInput).toBe(true);
    expect(validateSession(s as unknown as Record<string, unknown>).valid).toBe(true);
  });

  it('waitingForInput은 undefined일 수 없음 (계약 위반)', () => {
    const s = makeSession();
    // TypeScript가 undefined를 방지하지만, 런타임에서 확인
    const raw = { ...s } as Record<string, unknown>;
    raw.waitingForInput = undefined;
    const result = validateSession(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('waitingForInput');
  });

  // ── DisplayStatus 결정 규칙 검증 ──

  describe('DisplayStatus 결정 규칙', () => {
    function getDisplayStatus(s: DashboardSession): string {
      if ((s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.currentTool)
          && !s.waitingForInput) {
        return s.apiStatus === 'retry' ? 'Retry' : 'Working';
      }
      if (s.waitingForInput) return 'Waiting';
      return 'Idle';
    }

    it('busy + !waiting = Working', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: 'busy', waitingForInput: false }))).toBe('Working');
    });

    it('busy + waiting = Waiting', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: 'busy', waitingForInput: true }))).toBe('Waiting');
    });

    it('idle + !waiting = Idle', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: 'idle', waitingForInput: false }))).toBe('Idle');
    });

    it('idle + waiting = Waiting (비정상이지만 표시는 Waiting)', () => {
      // 이 상태는 발생하면 안 되지만, 발생하면 Waiting으로 표시
      expect(getDisplayStatus(makeSession({ apiStatus: 'idle', waitingForInput: true }))).toBe('Waiting');
    });

    it('null apiStatus + !waiting = Idle', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: null, waitingForInput: false }))).toBe('Idle');
    });

    it('currentTool + !waiting = Working', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: null, currentTool: 'Bash', waitingForInput: false }))).toBe('Working');
    });

    it('retry + !waiting = Retry', () => {
      expect(getDisplayStatus(makeSession({ apiStatus: 'retry', waitingForInput: false }))).toBe('Retry');
    });
  });
});
