import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fetchJson (hoisted before imports) ──
const mockFetchJson = vi.fn();
vi.mock('../oc-serve-proxy.js', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

import { OcQueryCollector, type QueryEntry, type SupplementData } from '../oc-query-collector.js';

// ── Helpers ──

function makeSession(id: string, title: string | null = 'chat', time: number = 1000) {
  return { id, title, time };
}

function makeMessage(role: string, text: string) {
  return {
    info: { role, id: `msg-${Math.random().toString(36).slice(2, 8)}` },
    parts: [{ type: 'text', text }],
  };
}

describe('OcQueryCollector', () => {
  let collector: OcQueryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new OcQueryCollector(4321);
  });

  it('기본 수집: user 메시지만 QueryEntry로 변환', async () => {
    // session 목록 반환
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s1', 'my chat', 1700000000)]);
      }
      // 메시지 목록 반환
      return Promise.resolve([
        makeMessage('user', 'hello world'),
        makeMessage('assistant', 'hi there'),
        makeMessage('user', 'second question'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(2);
    expect(entries[0].sessionId).toBe('s1');
    expect(entries[0].sessionTitle).toBe('my chat');
    expect(entries[0].source).toBe('opencode');
    expect(entries[0].query).toBe('hello world');
    expect(entries[1].query).toBe('second question');
  });

  it('[analyze-mode] prefix strip: 실제 user content만 추출', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s2', 'analyze', 2000)]);
      }
      return Promise.resolve([
        makeMessage('user', '[analyze-mode]\n---\nactual prompt here'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('actual prompt here');
  });

  it('시스템 프롬프트 필터: <system-reminder> → skip', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s3')]);
      }
      return Promise.resolve([
        makeMessage('user', '<system-reminder>internal stuff</system-reminder>'),
        makeMessage('user', 'real user question'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('real user question');
  });

  it('oc-serve 다운: fetchJson throw → 빈 배열 반환 (에러 throw 안 함)', async () => {
    mockFetchJson.mockRejectedValue(new Error('ECONNREFUSED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entries = await collector.collectQueries();

    expect(entries).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session list fetch failed'),
    );
    warnSpy.mockRestore();
  });

  it('session list 실패 시 SessionCache 콜백으로 폴백 수집', async () => {
    const activeSessionId = 'ses_active123';
    const supplementData: Record<string, SupplementData> = {
      [activeSessionId]: { lastPrompt: 'SessionCache에서 수집된 프롬프트', lastPromptTime: 5000 },
    };
    const collectorWithCallback = new OcQueryCollector(4321, () => supplementData);

    mockFetchJson.mockImplementation((url: string) => {
      // session list 실패
      if (url.includes('/session?limit=')) {
        return Promise.reject(new Error('ETIMEDOUT'));
      }
      return Promise.resolve([]);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entries = await collectorWithCallback.collectQueries(50);

    warnSpy.mockRestore();
    // 개별 /session/{id} fetch 없이 lastPrompt로 직접 QueryEntry 생성
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(activeSessionId);
    expect(entries[0].query).toBe('SessionCache에서 수집된 프롬프트');
    expect(entries[0].sessionTitle).toBeNull();
    expect(entries[0].isBackground).toBe(false);
  });

  it('isBackground: "Background:" title → isBackground: true', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s4', 'Background: explore task', 3000)]);
      }
      return Promise.resolve([
        makeMessage('user', 'do something'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].isBackground).toBe(true);
  });

  it('query 길이 제한: 2001자 → 2000자로 잘림', async () => {
    const longText = 'a'.repeat(2001);
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s5')]);
      }
      return Promise.resolve([
        makeMessage('user', longText),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toHaveLength(2000);
  });

  it('incremental 제거: 같은 세션 두 번 호출 시 전체 메시지 반환 (서버가 중복 제거)', async () => {
    const messages = [
      makeMessage('user', 'first question'),
    ];

    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s6', 'incremental test', 4000)]);
      }
      return Promise.resolve([...messages]);
    });

    // 첫 번째 호출
    const first = await collector.collectQueries();
    expect(first).toHaveLength(1);
    expect(first[0].query).toBe('first question');

    // 새 메시지 추가
    messages.push(makeMessage('user', 'second question'));

    // 두 번째 호출 → 전체 메시지 반환 (서버가 중복 제거 담당)
    const second = await collector.collectQueries();
    expect(second).toHaveLength(2);
    expect(second.map(q => q.query)).toContain('first question');
    expect(second.map(q => q.query)).toContain('second question');
  });

  it('개별 세션 실패 격리: 하나 실패해도 나머지 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([
          makeSession('ok-session', 'working', 5000),
          makeSession('bad-session', 'broken', 5001),
        ]);
      }
      if (url.includes('bad-session')) {
        return Promise.reject(new Error('session fetch failed'));
      }
      return Promise.resolve([
        makeMessage('user', 'from working session'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('ok-session');
    expect(entries[0].query).toBe('from working session');
  });

  it('parentID 있는 세션 필터링: 서브에이전트 세션 제외', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([
          makeSession('main-session', 'user chat', 1000),
          { id: 'sub-session', title: 'look_at: some file', time: 2000, parentID: 'main-session' },
        ]);
      }
      if (url.includes('main-session')) {
        return Promise.resolve([makeMessage('user', 'real user question')]);
      }
      // sub-session은 호출되면 안 됨
      return Promise.resolve([makeMessage('user', 'tool generated message')]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('main-session');
    expect(entries[0].query).toBe('real user question');
  });

  it('parentID 없는 세션만 수집: 메인 세션 2개 모두 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([
          makeSession('main-1', 'first chat', 1000),
          makeSession('main-2', 'second chat', 2000),
          { id: 'sub-1', title: 'Task 1: explore', time: 3000, parentID: 'main-1' },
        ]);
      }
      if (url.includes('main-1')) {
        return Promise.resolve([makeMessage('user', 'question from main-1')]);
      }
      if (url.includes('main-2')) {
        return Promise.resolve([makeMessage('user', 'question from main-2')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(2);
    const sessionIds = entries.map((e) => e.sessionId);
    expect(sessionIds).toContain('main-1');
    expect(sessionIds).toContain('main-2');
    expect(sessionIds).not.toContain('sub-1');
  });

  it('활성 세션이 session limit 밖에 있어도 콜백으로 보완하여 수집', async () => {
    const currentSessionId = 'ses_337ed4466ffeZEOR';
    const supplementData: Record<string, SupplementData> = {
      [currentSessionId]: { lastPrompt: '실제 유저 질문', lastPromptTime: 9999 },
    };
    const collectorWithCallback = new OcQueryCollector(4321, () => supplementData);

    mockFetchJson.mockImplementation((url: string) => {
      // /session?limit= → 현재 세션 미포함
      if (url.includes('/session?limit=')) {
        return Promise.resolve([
          makeSession('newer-session-1', 'other chat', 9000),
        ]);
      }
      // 메시지 조회 (newer-session-1 용)
      if (url.includes('/message')) {
        return Promise.resolve([makeMessage('user', 'other message')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collectorWithCallback.collectQueries(50);
    // 현재 세션은 SessionCache lastPrompt로 직접 수집 (개별 /session fetch 불필요)
    const currentSessionEntries = entries.filter(e => e.sessionId === currentSessionId);
    expect(currentSessionEntries).toHaveLength(1);
    expect(currentSessionEntries[0].query).toBe('실제 유저 질문');
    expect(currentSessionEntries[0].timestamp).toBe(9999);
  });

  it('콜백 없을 때 기본 수집 동작', async () => {
    // 기존 collector (콜백 없음) 사용
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?limit=')) {
        return Promise.resolve([makeSession('s1', 'chat', 1000)]);
      }
      return Promise.resolve([makeMessage('user', 'normal question')]);
    });

    const entries = await collector.collectQueries(50);
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('normal question');
  });
});

