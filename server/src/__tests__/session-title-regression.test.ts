/**
 * Regression test: 세션 title이 올바르게 매핑되는지 확인
 *
 * 재현 시나리오:
 * 1. Claude 세션이 대시보드에 아예 안 보이는 문제 (source 설정 누락)
 * 2. 세션 이름 대신 ID가 표시되는 문제 (custom-title 미지원)
 * 3. OpenCode "New session" 제목이 그대로 노출되는 문제
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActiveSessionsModule } from '../modules/active-sessions/index.js';
import { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

function setupUrlRouter(routes: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          const response = {
            statusCode: 200,
            statusMessage: 'OK',
            on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
              if (event === 'data') handler(Buffer.from(body));
              if (event === 'end') handler();
            }),
          };
          callback(response);
          return { on: vi.fn() };
        }
      }
      return {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error(`No mock for: ${url}`));
        }),
      };
    },
  );
}

function makeBothMachine(): MachineConfig {
  return { id: 'test-m', alias: 'Test', host: '10.0.0.1', port: 3100, apiKey: 'k', source: 'both' };
}

function makeOcMachine(): MachineConfig {
  return { id: 'oc-m', alias: 'OC', host: '10.0.0.1', port: 3100, apiKey: 'k', source: 'opencode' };
}

function makeClaudeMachine(): MachineConfig {
  return { id: 'cl-m', alias: 'Claude', host: '10.0.0.2', port: 3100, apiKey: 'k', source: 'claude-code' };
}

function makeOcSessionsAll(sessions: Record<string, { title?: string | null; status?: string; directory?: string | null; updatedAt?: number; createdAt?: number }>): string {
  const full: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(sessions)) {
    full[id] = {
      status: s.status ?? 'active',
      title: s.title ?? null,
      directory: s.directory ?? null,
      updatedAt: s.updatedAt ?? Date.now(),
      createdAt: s.createdAt ?? 0,
      parentSessionId: null,
      lastPrompt: null,
      lastPromptTime: 0,
      currentTool: null,
      waitingForInput: false,
    };
  }
  return JSON.stringify({
    meta: { sseConnected: true, lastSseEventAt: 0, sseConnectedAt: 0 },
    projects: [],
    activeDirectories: [],
    sessions: full,
  });
}

function makeClaudeSessions(sessions: { sessionId: string; title?: string | null; cwd?: string; lastPrompt?: string | null }[]): string {
  return JSON.stringify({
    sessions: sessions.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd ?? '/project',
      startTime: 1000,
      lastHeartbeat: 2000,
      title: s.title ?? null,
      lastPrompt: s.lastPrompt ?? null,
    })),
  });
}

async function pollAndCapture(machines: readonly MachineConfig[]): Promise<Record<string, unknown>[]> {
  const manager = new MachineManager(machines);
  const module = new ActiveSessionsModule(manager);
  let captured: Record<string, unknown>[] = [];
  module.setUpdateCallback((sessions) => {
    captured = sessions as unknown as Record<string, unknown>[];
  });
  await module.start();
  await module.stop();
  return captured;
}

describe('Session title regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Claude 세션 title 매핑', () => {
    it('should propagate custom title from agent to dashboard', async () => {
      setupUrlRouter({
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'cs-1', title: 'add-project-path-filter-web' },
          { sessionId: 'cs-2', title: 'fix-regression-bug' },
        ]),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(2);
      const s1 = sessions.find(s => s.sessionId === 'cs-1')!;
      const s2 = sessions.find(s => s.sessionId === 'cs-2')!;
      expect(s1.title).toBe('add-project-path-filter-web');
      expect(s2.title).toBe('fix-regression-bug');
    });

    it('should not show session ID as title when title is null', async () => {
      setupUrlRouter({
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'cs-no-title', title: null, lastPrompt: 'Fix the login bug' },
        ]),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      // title이 null이면 null이어야 함 (ID를 title로 사용하면 안됨)
      // 프론트엔드에서 lastPrompt 또는 ID 축약을 표시하는 것은 UI 책임
      expect(sessions[0].title).toBeNull();
      expect(sessions[0].sessionId).not.toBe(sessions[0].title);
    });

    it('should preserve Claude session title through "both" source machine', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-1': { title: 'OpenCode 작업', status: 'active' },
        }),
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'cl-1', title: 'Claude 작업' },
        ]),
      });

      const sessions = await pollAndCapture([makeBothMachine()]);

      expect(sessions).toHaveLength(2);
      const claude = sessions.find(s => s.source === 'claude-code')!;
      const oc = sessions.find(s => s.source === 'opencode')!;
      expect(claude.title).toBe('Claude 작업');
      expect(oc.title).toBe('OpenCode 작업');
    });
  });

  describe('OpenCode 세션 title 매핑', () => {
    it('should propagate real titles from oc-serve', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-1': { title: 'oc-serve 없이 세션 수집 문제', status: 'active' },
          'oc-2': { title: 'Oh-my-Opencode 분석', status: 'idle' },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(2);
      const s1 = sessions.find(s => s.sessionId === 'oc-1')!;
      const s2 = sessions.find(s => s.sessionId === 'oc-2')!;
      expect(s1.title).toBe('oc-serve 없이 세션 수집 문제');
      expect(s2.title).toBe('Oh-my-Opencode 분석');
    });

    it('should preserve "New session" title as-is (not replace with ID)', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-new': { title: 'New session - 2026-03-20T05:54:26.204Z', status: 'idle' },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(1);
      // "New session"은 oc-serve가 보내는 기본 title — 그대로 전달
      expect(sessions[0].title).toBe('New session - 2026-03-20T05:54:26.204Z');
      // ID가 title이 되면 안됨
      expect(sessions[0].title).not.toBe('oc-new');
    });

    it('should handle null title in OpenCode sessions', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-null': { title: null, status: 'active' },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBeNull();
    });
  });

  describe('Claude + OpenCode 혼합 환경에서 title 정확성', () => {
    it('should maintain correct titles across both sources on same machine', async () => {
      const ocTitles = {
        'oc-a': { title: 'Frontend 리팩터링', status: 'active' as const },
        'oc-b': { title: 'API 엔드포인트 추가', status: 'idle' as const },
      };
      const claudeTitles = [
        { sessionId: 'cl-a', title: 'session-dashboard 디버깅' },
        { sessionId: 'cl-b', title: 'canopi-작업' },
      ];

      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll(ocTitles),
        'api/claude/sessions': makeClaudeSessions(claudeTitles),
      });

      const sessions = await pollAndCapture([makeBothMachine()]);

      expect(sessions).toHaveLength(4);

      // OpenCode 세션 title 검증
      expect(sessions.find(s => s.sessionId === 'oc-a')!.title).toBe('Frontend 리팩터링');
      expect(sessions.find(s => s.sessionId === 'oc-b')!.title).toBe('API 엔드포인트 추가');

      // Claude 세션 title 검증
      expect(sessions.find(s => s.sessionId === 'cl-a')!.title).toBe('session-dashboard 디버깅');
      expect(sessions.find(s => s.sessionId === 'cl-b')!.title).toBe('canopi-작업');

      // source 필드도 정확해야 함
      expect(sessions.find(s => s.sessionId === 'oc-a')!.source).toBe('opencode');
      expect(sessions.find(s => s.sessionId === 'cl-a')!.source).toBe('claude-code');
    });

    it('should not mix up titles between OC and Claude sessions', async () => {
      // 같은 이름의 세션이 OC와 Claude 양쪽에 있는 극단적 케이스
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'shared-id': { title: 'OC version of task', status: 'active' },
        }),
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'shared-id', title: 'Claude version of task' },
        ]),
      });

      const sessions = await pollAndCapture([makeBothMachine()]);

      // 동일 ID라도 source가 다르면 별도 세션 (또는 하나만 남더라도 title 혼동 없어야 함)
      for (const s of sessions) {
        if (s.source === 'opencode') {
          expect(s.title).toBe('OC version of task');
        } else if (s.source === 'claude-code') {
          expect(s.title).toBe('Claude version of task');
        }
      }
    });
  });

  describe('Claude 세션 존재 여부', () => {
    it('should include Claude sessions when machine source is "both"', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-1': { title: 'OC', status: 'active' },
        }),
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'cl-1', title: 'Claude Task', cwd: '/project' },
        ]),
      });

      const sessions = await pollAndCapture([makeBothMachine()]);
      const claudeSessions = sessions.filter(s => s.source === 'claude-code');

      // 핵심: Claude 세션이 0개이면 안됨
      expect(claudeSessions.length).toBeGreaterThan(0);
      expect(claudeSessions[0].title).toBe('Claude Task');
    });

    it('should include Claude sessions when machine source is "claude-code"', async () => {
      setupUrlRouter({
        'api/claude/sessions': makeClaudeSessions([
          { sessionId: 'cl-only', title: 'Solo Claude', cwd: '/solo' },
        ]),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].source).toBe('claude-code');
      expect(sessions[0].title).toBe('Solo Claude');
    });

    it('should NOT have Claude sessions when machine source is "opencode"', async () => {
      setupUrlRouter({
        'proxy/sessions-all': makeOcSessionsAll({
          'oc-only': { title: 'OC Only', status: 'active' },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);
      const claudeSessions = sessions.filter(s => s.source === 'claude-code');

      expect(claudeSessions).toHaveLength(0);
    });
  });
});
