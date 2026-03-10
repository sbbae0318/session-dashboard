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

function makeMessage(role: string, text: string, createdTime?: number) {
  return {
    info: {
      role,
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      ...(createdTime != null ? { time: { created: createdTime } } : {}),
    },
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

    expect(entries).toHaveLength(1);  // 마지막 user 메시지
    expect(entries[0].sessionId).toBe('s1');
    expect(entries[0].sessionTitle).toBe('my chat');
    expect(entries[0].source).toBe('opencode');
    expect(entries[0].query).toBe('second question');
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

  it('last-message: 두 번 호출하면 마지막 user 메시지 반환', async () => {
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
    expect(second).toHaveLength(1);  // 마지막 메시지
    expect(second[0].query).toBe('second question');
    // 두 번째 메시지(마지막)가 수집됨
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

  it('parentID 있는 세션도 수집: 서브에이전트 세션은 isBackground=true', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([
          makeSession('main-session', 'user chat', 1000),
          { id: 'sub-session', title: 'look_at: some file', time: 2000, parentID: 'main-session' },
        ]);
      }
      if (url.includes('main-session/message')) {
        return Promise.resolve([makeMessage('user', 'real user question')]);
      }
      if (url.includes('sub-session/message')) {
        return Promise.resolve([makeMessage('user', 'tool generated message')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(2);
    const mainEntry = entries.find(e => e.sessionId === 'main-session')!;
    const subEntry = entries.find(e => e.sessionId === 'sub-session')!;
    expect(mainEntry.query).toBe('real user question');
    expect(mainEntry.isBackground).toBe(false);
    expect(subEntry.query).toBe('tool generated message');
    expect(subEntry.isBackground).toBe(true);
  });

  it('parentID 없는 세션 + 있는 세션 모두 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([
          makeSession('main-1', 'first chat', 1000),
          makeSession('main-2', 'second chat', 2000),
          { id: 'sub-1', title: 'Task 1: explore', time: 3000, parentID: 'main-1' },
        ]);
      }
      if (url.includes('main-1/message')) {
        return Promise.resolve([makeMessage('user', 'question from main-1')]);
      }
      if (url.includes('main-2/message')) {
        return Promise.resolve([makeMessage('user', 'question from main-2')]);
      }
      if (url.includes('sub-1/message')) {
        return Promise.resolve([makeMessage('user', 'sub question')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(3);
    const sessionIds = entries.map((e) => e.sessionId);
    expect(sessionIds).toContain('main-1');
    expect(sessionIds).toContain('main-2');
    expect(sessionIds).toContain('sub-1');
    const sub1Entry = entries.find(e => e.sessionId === 'sub-1')!;
    expect(sub1Entry.isBackground).toBe(true);
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

describe('OcQueryCollector — per-message timestamp', () => {
  let collector: OcQueryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new OcQueryCollector(4321);
  });

  it('info.time.created가 있으면 per-message 타임스탬프 사용', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s-ts', 'chat', 1000)]);
      }
      return Promise.resolve([
        makeMessage('user', 'first', 5000),
        makeMessage('user', 'second', 6000),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);  // 마지막 user 메시지
    // 마지막 메시지('second' at 6000) 반환
    expect(entries[0].timestamp).toBe(6000);
    expect(entries[0].query).toBe('second');
  });

  it('info.time.created가 없으면 session 타임스탬프로 폴백', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s-no-ts', 'chat', 9999)]);
      }
      return Promise.resolve([
        makeMessage('user', 'no time field'),  // time 없음
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe(9999);  // session.time 사용
  });

  it('session.time이 객체일 때 per-message time 우선', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([{ id: 's-obj', title: 'chat', time: { created: 1000, updated: 2000 } }]);
      }
      return Promise.resolve([
        makeMessage('user', 'msg with own ts', 7777),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe(7777);  // session.time.created(1000) 대신 msg.info.time.created(7777)
  });

  it('시스템 프롬프트 필터: ## **NO EXCUSES → skip', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('s-noexc', 'chat', 1000)]);
      }
      return Promise.resolve([
        makeMessage('user', '## **NO EXCUSES. NO COMPROMISES. DELIVER WHAT WAS ASKED.**', 8000),
        makeMessage('user', '실제 유저 질문', 8001),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('실제 유저 질문');
  });
});

describe('OcQueryCollector — last-message collection', () => {
  let collector: OcQueryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new OcQueryCollector(4321);
  });

  it('세션당 마지막 유효 user 메시지 수집 (중간 응답 제외)', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) return Promise.resolve([makeSession('s1')]);
      return Promise.resolve([
        makeMessage('user', '프로젝트 설정해주세요'),    // ← 건너뜀
        makeMessage('assistant', '...'),
        makeMessage('user', '핵심 질문 다시해주세요'),   // ← 건너뜀
        makeMessage('assistant', '...'),
        makeMessage('user', '네 좋아요'),               // ← 이것만 수집
      ]);
    });
    const entries = await collector.collectQueries();
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('네 좋아요');
  });

  it('첫 번째 user msg가 system이면 skip, 두 번째 유효 msg 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) return Promise.resolve([makeSession('s1')]);
      return Promise.resolve([
        makeMessage('user', '[SYSTEM DIRECTIVE: run this]'),  // ← null 반환, skip
        makeMessage('user', '실제 프롬프트'),                  // ← 이것 수집
      ]);
    });
    const entries = await collector.collectQueries();
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('실제 프롬프트');
  });
});

describe('OcQueryCollector — long session latest prompt', () => {
  let collector: OcQueryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new OcQueryCollector(4321);
  });

  it('장기 세션에서 최신(마지막) user 메시지를 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) return Promise.resolve([makeSession('long-sess', 'long running session', 1000)]);
      return Promise.resolve([
        makeMessage('user', 'Old first prompt from session start', 1000),
        makeMessage('assistant', 'response 1'),
        makeMessage('user', 'Middle prompt after some work', 2000),
        makeMessage('assistant', 'response 2'),
        makeMessage('user', 'Recent prompt after hours of work', 3000),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('Recent prompt after hours of work');
    expect(entries[0].timestamp).toBe(3000);
  });

  it('첫 번째 user msg가 system이면 skip, 마지막 유효 msg 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/session?')) return Promise.resolve([makeSession('s-sys', 'chat', 1000)]);
      return Promise.resolve([
        makeMessage('user', '[SYSTEM DIRECTIVE: run this]'),  // ← null 반환, skip
        makeMessage('user', '첫 번째 실제 프롬프트'),
        makeMessage('user', '마지막 실제 프롬프트'),
      ]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('마지막 실제 프롬프트');
  });
});

describe('OcQueryCollector — multi-project collection', () => {
  let collector: OcQueryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new OcQueryCollector(4321);
  });

  it('모든 프로젝트의 세션을 수집', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      // /project 엔드포인트
      if (url.includes('/project')) {
        return Promise.resolve([
          { worktree: '/project/alpha' },
          { worktree: '/project/beta' },
        ]);
      }
      // /session?directory=/project/alpha
      if (url.includes('directory=%2Fproject%2Falpha')) {
        return Promise.resolve([makeSession('alpha-s1', 'Alpha Session', 2000)]);
      }
      // /session?directory=/project/beta
      if (url.includes('directory=%2Fproject%2Fbeta')) {
        return Promise.resolve([makeSession('beta-s1', 'Beta Session', 3000)]);
      }
      // /session/:id/message
      if (url.includes('alpha-s1/message')) {
        return Promise.resolve([makeMessage('user', 'alpha question')]);
      }
      if (url.includes('beta-s1/message')) {
        return Promise.resolve([makeMessage('user', 'beta question')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(2);
    const queries = entries.map(e => e.query).sort();
    expect(queries).toEqual(['alpha question', 'beta question']);
  });

  it('/project 실패 시 기존 fallback 동작', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/project')) {
        return Promise.reject(new Error('not available'));
      }
      if (url.includes('/session?')) {
        return Promise.resolve([makeSession('fallback-s1', 'Fallback', 1000)]);
      }
      return Promise.resolve([makeMessage('user', 'fallback question')]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('fallback question');
  });

  it('세션 ID 중복 제거', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/project')) {
        return Promise.resolve([
          { worktree: '/project/alpha' },
          { worktree: '/project/beta' },
        ]);
      }
      // 양쪽 프로젝트에서 같은 세션 반환
      if (url.includes('/session?directory=')) {
        return Promise.resolve([makeSession('shared-s1', 'Shared Session', 2000)]);
      }
      if (url.includes('shared-s1/message')) {
        return Promise.resolve([makeMessage('user', 'shared question')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('shared question');
  });

  it('worktree가 / 인 프로젝트는 건너뜀', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes('/project')) {
        return Promise.resolve([
          { worktree: '/' },
          { worktree: '/project/valid' },
        ]);
      }
      if (url.includes('directory=%2Fproject%2Fvalid')) {
        return Promise.resolve([makeSession('valid-s1', 'Valid', 1000)]);
      }
      if (url.includes('valid-s1/message')) {
        return Promise.resolve([makeMessage('user', 'valid question')]);
      }
      return Promise.resolve([]);
    });

    const entries = await collector.collectQueries();

    // '/' worktree는 건너뛰고 /project/valid만 수집
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('valid question');
  });
});
