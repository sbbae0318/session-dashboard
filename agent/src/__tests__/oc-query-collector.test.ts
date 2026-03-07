import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fetchJson (hoisted before imports) ──
const mockFetchJson = vi.fn();
vi.mock('../oc-serve-proxy.js', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

import { OcQueryCollector, type QueryEntry } from '../oc-query-collector.js';

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
      expect.stringContaining('oc-serve unreachable'),
    );
    warnSpy.mockRestore();
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

  it('incremental: 같은 세션 두 번 호출 시 새 메시지만 추가', async () => {
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

    // 두 번째 호출 → 새 메시지만 반환
    const second = await collector.collectQueries();
    expect(second).toHaveLength(1);
    expect(second[0].query).toBe('second question');
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
});
