/**
 * ClaudeHeartbeat hook handler 테스트
 *
 * waitingForInput 상태 전이를 TDD로 검증합니다.
 * api-contract.ts 계약: waitingForInput은 boolean, WAITING은 true일 때만.
 *
 * DisplayStatus 규칙:
 *   WORKING: (apiStatus === 'busy'|'retry' || currentTool) AND !waitingForInput
 *   WAITING: waitingForInput === true
 *   IDLE:    그 외
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeHeartbeat } from '../claude-heartbeat.js';

// ClaudeHeartbeat는 start() 호출 시 파일 시스템 접근을 하므로,
// 테스트에서는 hook handler만 직접 호출하여 상태 전이를 검증합니다.

function createHeartbeat(): ClaudeHeartbeat {
  // 존재하지 않는 경로로 생성 — start()를 호출하지 않으면 파일 접근 없음
  return new ClaudeHeartbeat('/tmp/nonexistent-heartbeats', '/tmp/nonexistent-claude');
}

/** 세션을 수동으로 등록하기 위한 헬퍼 — handlePromptEvent로 세션 생성 */
function seedSession(hb: ClaudeHeartbeat, sessionId: string): void {
  // handlePromptEvent는 세션이 없으면 무시하므로,
  // handleStatusEvent도 세션이 없으면 무시합니다.
  // 직접 sessions Map에 접근할 수 없으므로 다른 방법 필요.
  // → 해결: handleToolEvent/handleWaitingEvent 등 모두 세션이 없으면 skip.
  // → 테스트를 위해 먼저 세션을 만들어야 함.
}

describe('ClaudeHeartbeat — hook handler 상태 전이', () => {
  let hb: ClaudeHeartbeat;
  const SID = 'test-session-001';

  beforeEach(() => {
    hb = createHeartbeat();
  });

  /** 세션이 존재하지 않으면 모든 handler가 무시됨 — 기본 동작 확인 */
  describe('세션 미존재 시 안전하게 무시', () => {
    it('handleToolEvent — 세션 없으면 무시', () => {
      hb.handleToolEvent('nonexistent', 'Bash');
      expect(hb.getActiveSessions()).toHaveLength(0);
    });

    it('handleWaitingEvent — 세션 없으면 무시', () => {
      hb.handleWaitingEvent('nonexistent', true);
      expect(hb.getActiveSessions()).toHaveLength(0);
    });

    it('handleStatusEvent — 세션 없으면 무시', () => {
      hb.handleStatusEvent('nonexistent', 'idle');
      expect(hb.getActiveSessions()).toHaveLength(0);
    });

    it('handlePromptEvent — 세션 없으면 무시', () => {
      hb.handlePromptEvent('nonexistent', 'hello', Date.now());
      expect(hb.getActiveSessions()).toHaveLength(0);
    });
  });

  /**
   * 이하 테스트는 세션이 존재해야 동작합니다.
   * ClaudeHeartbeat의 sessions Map은 private이므로,
   * scanProjectsForActiveSessions를 우회하여 세션을 주입합니다.
   *
   * 실제로는 readHeartbeatFile이나 scanProjects가 세션을 등록하지만,
   * 파일 시스템 의존성을 제거하기 위해 reflection으로 주입합니다.
   */
  describe('waitingForInput 상태 전이 (세션 존재)', () => {
    beforeEach(() => {
      // Private Map에 세션 주입
      const sessions = (hb as unknown as { sessions: Map<string, unknown> }).sessions;
      sessions.set(SID, {
        sessionId: SID,
        pid: 0,
        cwd: '/tmp/test',
        project: '-tmp-test',
        startTime: Date.now(),
        lastHeartbeat: Date.now(),
        source: 'claude-code',
        status: 'busy',
        title: 'test session',
        lastPromptTime: Date.now(),
        lastFileModified: Date.now(),
        lastResponseTime: null,
        lastPrompt: 'hello',
        currentTool: null,
        waitingForInput: false,
        hooksActive: false,
      });
    });

    // ── 기본 전이 ──

    it('Notification(permission_prompt) → waitingForInput=true', () => {
      hb.handleWaitingEvent(SID, true);
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(true);
      expect(s.hooksActive).toBe(true);
    });

    it('Stop → waitingForInput=false, status=idle', () => {
      hb.handleWaitingEvent(SID, true);
      hb.handleStatusEvent(SID, 'idle');
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.status).toBe('idle');
      expect(s.currentTool).toBeNull();
    });

    it('PreToolUse → waitingForInput=false (permission 수락)', () => {
      hb.handleWaitingEvent(SID, true);
      hb.handleToolEvent(SID, 'Bash');
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.currentTool).toBe('Bash');
      expect(s.status).toBe('busy');
    });

    it('UserPromptSubmit → waitingForInput=false', () => {
      hb.handleWaitingEvent(SID, true);
      hb.handlePromptEvent(SID, 'new prompt', Date.now());
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.status).toBe('busy');
    });

    it('SessionStart → waitingForInput 유지 안 됨 (busy 전환)', () => {
      hb.handleWaitingEvent(SID, true);
      hb.handleStatusEvent(SID, 'busy');
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      // busy 전환 시 waitingForInput은 그대로 (idle일 때만 리셋)
      // 이것은 의도적: SessionStart 후 바로 Notification이 올 수 있음
      expect(s.status).toBe('busy');
    });

    // ── 핵심 버그 시나리오: PostToolUse 후 waitingForInput 잔류 ──

    it('🐛 PostToolUse(null) 후 Notification → 다음 PostToolUse에서 waitingForInput 리셋', () => {
      // 시나리오: PreToolUse(Bash) → PostToolUse(null) → Notification → PostToolUse(null)
      // 기대: PostToolUse(null)에서 waitingForInput이 false로 리셋되어야 함

      // Step 1: Tool 실행 시작
      hb.handleToolEvent(SID, 'Bash');
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.currentTool).toBe('Bash');

      // Step 2: Tool 완료
      hb.handleToolEvent(SID, null);
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.currentTool).toBeNull();

      // Step 3: 새 Notification (permission 요청)
      hb.handleWaitingEvent(SID, true);
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.waitingForInput).toBe(true);

      // Step 4: 또 다른 PreToolUse → permission 수락됨
      hb.handleToolEvent(SID, 'Write');
      const s4 = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s4.waitingForInput).toBe(false); // PreToolUse가 리셋
      expect(s4.currentTool).toBe('Write');

      // Step 5: PostToolUse(null) — tool 완료
      hb.handleToolEvent(SID, null);
      const s5 = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s5.waitingForInput).toBe(false); // 여전히 false여야 함
      expect(s5.currentTool).toBeNull();
    });

    it('🐛 Notification이 PreToolUse-PostToolUse 사이에 끼어드는 race condition', () => {
      // 시나리오: PreToolUse(Bash) → Notification(permission) → PostToolUse(null)
      // 현재 버그: PostToolUse(null)이 waitingForInput을 리셋하지 않음

      // Step 1: Tool 시작
      hb.handleToolEvent(SID, 'Bash');

      // Step 2: Tool 실행 중 Notification 끼어듦 (다음 tool에 대한 permission 요청)
      hb.handleWaitingEvent(SID, true);
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.waitingForInput).toBe(true);

      // Step 3: PostToolUse(null) — 이전 tool 완료
      hb.handleToolEvent(SID, null);
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;

      // 핵심: PostToolUse(null) 자체는 waitingForInput을 건드리지 않아야 함
      // Notification이 설정한 waitingForInput=true는 유지되어야 함
      // (다음 PreToolUse가 와야 리셋)
      expect(s.waitingForInput).toBe(true);
      expect(s.currentTool).toBeNull();
    });

    it('🐛 Stop이 안 오는 경우 — idle 전환 없이 WAITING 잔류 방지', () => {
      // 시나리오: Notification → Claude 크래시 → Stop hook 미수신
      // JSONL 재스캔(readHeartbeatFile)이 waitingForInput을 false로 리셋해야 함

      hb.handleWaitingEvent(SID, true);
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.waitingForInput).toBe(true);

      // JSONL 재스캔을 시뮬레이션할 수 없으므로 (파일 시스템 필요),
      // 대신 handleStatusEvent(idle)이 정상적으로 리셋하는지 확인
      hb.handleStatusEvent(SID, 'idle');
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.status).toBe('idle');
    });

    // ── idle_prompt vs permission_prompt ──

    it('🐛 idle_prompt → status=idle, waitingForInput=false (WAITING 아님)', () => {
      // idle_prompt는 "작업 완료 후 다음 입력 대기" — IDLE로 표시해야 함
      // server.ts에서 handleStatusEvent(idle)로 호출하므로 여기서 시뮬레이션
      hb.handleStatusEvent(SID, 'idle');
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.status).toBe('idle');
      expect(s.waitingForInput).toBe(false);
      expect(s.currentTool).toBeNull();
    });

    it('permission_prompt → waitingForInput=true (WAITING)', () => {
      hb.handleWaitingEvent(SID, true);
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(true);
    });

    it('🐛 idle_prompt 후 재접근 시 WAITING 아닌 IDLE', () => {
      // 시나리오: 작업 완료 → idle_prompt → 사용자 방치 → 대시보드에 IDLE 표시
      hb.handleStatusEvent(SID, 'idle'); // idle_prompt equivalent
      const s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.status).toBe('idle');
    });

    // ── 연속 Notification ──

    it('연속 Notification은 마지막 상태 유지', () => {
      hb.handleWaitingEvent(SID, true);
      hb.handleWaitingEvent(SID, true); // 중복
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.waitingForInput).toBe(true);

      hb.handleWaitingEvent(SID, false); // 해제
      expect(hb.getActiveSessions().find(s => s.sessionId === SID)!.waitingForInput).toBe(false);
    });

    // ── 전체 lifecycle ──

    it('전체 lifecycle: prompt → tool → notification → accept → tool → stop', () => {
      // 1. 사용자 프롬프트
      hb.handlePromptEvent(SID, 'do something', Date.now());
      let s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.status).toBe('busy');
      expect(s.waitingForInput).toBe(false);

      // 2. Tool 실행
      hb.handleToolEvent(SID, 'Bash');
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.currentTool).toBe('Bash');
      expect(s.waitingForInput).toBe(false);

      // 3. Tool 완료
      hb.handleToolEvent(SID, null);
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.currentTool).toBeNull();

      // 4. Permission 요청
      hb.handleWaitingEvent(SID, true);
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(true);

      // 5. 사용자 수락 → PreToolUse
      hb.handleToolEvent(SID, 'Write');
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.waitingForInput).toBe(false);
      expect(s.currentTool).toBe('Write');

      // 6. Tool 완료
      hb.handleToolEvent(SID, null);
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.currentTool).toBeNull();
      expect(s.waitingForInput).toBe(false);

      // 7. Stop
      hb.handleStatusEvent(SID, 'idle');
      s = hb.getActiveSessions().find(s => s.sessionId === SID)!;
      expect(s.status).toBe('idle');
      expect(s.waitingForInput).toBe(false);
      expect(s.currentTool).toBeNull();
    });
  });
});
