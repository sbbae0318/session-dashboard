import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock node:http (hoisted before imports) ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

// ── Mock fetchJson from oc-serve-proxy ──
const mockFetchJson = vi.fn();
vi.mock('../oc-serve-proxy.js', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

import { SessionCache, type SessionDetail } from '../session-cache.js';

// ── Types ──

interface MockResponse {
  handlers: Record<string, Array<(data?: unknown) => void>>;
  setEncoding: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

// ── Helpers ──

function createMockResponse(): MockResponse {
  const handlers: Record<string, Array<(data?: unknown) => void>> = {};
  return {
    handlers,
    setEncoding: vi.fn(),
    on: vi.fn((event: string, handler: (data?: unknown) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    destroy: vi.fn(),
  };
}

function setupSseMock(mockResponse: MockResponse): void {
  mockHttpGet.mockImplementation(
    (_url: string, callback: (res: MockResponse) => void) => {
      callback(mockResponse);
      return { on: vi.fn() };
    },
  );
}

function simulateSseEvent(response: MockResponse, event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const handler of response.handlers['data'] ?? []) {
    handler(data);
  }
}

/** Flush microtask queue (resolved promises) */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function startCache(mockRes: MockResponse, port = 4096): SessionCache {
  setupSseMock(mockRes);
  const cache = new SessionCache(port, ':memory:');
  cache.start();
  return cache;
}

// ── Tests ──

describe('SessionCache', () => {
  let cache: SessionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchJson.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try { cache?.stop(); } catch { /* already closed */ }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── 1. Lifecycle ──

  it('creates instance, start() connects, stop() disconnects', async () => {
    cache = new SessionCache(4096, ':memory:');
    expect(cache.getConnectionState()).toBe('disconnected');

    const mockRes = createMockResponse();
    setupSseMock(mockRes);
    cache.start();
    await flushPromises();

    expect(cache.getConnectionState()).toBe('connected');
    expect(mockHttpGet).toHaveBeenCalledTimes(1);

    cache.stop();
    expect(cache.getConnectionState()).toBe('disconnected');
    expect(mockRes.destroy).toHaveBeenCalled();
  });

  // ── 2. SSE valid JSON — server.connected ──

  it('parses valid JSON SSE events (server.connected)', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      payload: { type: 'server.connected', properties: {} },
    });

    // Parsed without error; server.connected has no handler — cache stays empty
    expect(Object.keys(cache.getSessionDetails().sessions)).toHaveLength(0);
  });

  // ── 3. SSE malformed JSON ──

  it('skips malformed JSON gracefully without crashing', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const badChunk = 'data: {bad json}\n\n';
    for (const handler of mockRes.handlers['data'] ?? []) {
      handler(badChunk);
    }

    expect(Object.keys(cache.getSessionDetails().sessions)).toHaveLength(0);
  });

  // ── 4. session.status → cache ──

  it('caches session.status with sessionID, status, and directory', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/foo',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-abc', status: { type: 'busy' } },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-abc'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('busy');
    expect(entry.directory).toBe('/project/foo');
    expect(entry.updatedAt).toBeGreaterThan(0);
  });

  // ── 5. session.idle → cache ──

  it('sets status to idle and clears currentTool on session.idle', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Set busy first
    simulateSseEvent(mockRes, {
      directory: '/project/bar',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-1', status: { type: 'busy' } },
      },
    });

    // Then idle
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'sess-1' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-1'];
    expect(entry.status).toBe('idle');
    expect(entry.currentTool).toBeNull();
    expect(entry.directory).toBe('/project/bar');
  });

  // ── 6. message.updated(role=user) → REST fallback → lastPrompt ──

  it('여러 user 메시지 중 마지막을 lastPrompt로 저장', async () => {
    const userMessages = [
      {
        info: { role: 'user', sessionID: 'sess-1', time: { created: 11111 } },
        parts: [{ type: 'text', text: 'Build a todo app' }],
      },
      {
        info: { role: 'assistant', sessionID: 'sess-1' },
        parts: [{ type: 'text', text: 'Sure, I will build it' }],
      },
      {
        info: { role: 'user', sessionID: 'sess-1', time: { created: 22222 } },
        parts: [{ type: 'text', text: 'Add dark mode' }],
      },
    ];

    mockFetchJson
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(userMessages);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/bar',
      payload: {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: 'sess-1' } },
      },
    });

    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-1'];
    expect(entry).toBeDefined();
    // 마지막 user 메시지가 선택되어야 함 (fetchLatestUserPrompt)
    expect(entry.lastPrompt).toBe('Add dark mode');
    // 마지막 메시지 타임스탬프 사용
    expect(entry.lastPromptTime).toBe(22222);
  });

  // ── 7. isSystemPrompt filter ──

  it('does not set lastPrompt for system prompt messages', async () => {
    const systemMessages = [
      {
        info: { role: 'user', sessionID: 'sess-2' },
        parts: [{ type: 'text', text: '[SYSTEM DIRECTIVE: execute task] continue' }],
      },
    ];

    mockFetchJson
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(systemMessages);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Pre-populate entry so we can verify lastPrompt stays null
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-2', status: { type: 'busy' } },
      },
    });

    simulateSseEvent(mockRes, {
      payload: {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: 'sess-2' } },
      },
    });

    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-2'];
    expect(entry).toBeDefined();
    expect(entry.lastPrompt).toBeNull();
  });

  // ── 8. TTL eviction ──

  it('evicts cache entries older than 24 hours', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'stale-1', status: { type: 'idle' } },
      },
    });
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'stale-2', status: { type: 'busy' } },
      },
    });

    expect(Object.keys(cache.getSessionDetails().sessions)).toHaveLength(2);

    // TTL=86_400_000ms, eviction interval=60_000ms
    // At 86_460_000ms the eviction runs and entries exceed 24h TTL
    vi.advanceTimersByTime(86_460_000);
    await flushPromises();

    expect(Object.keys(cache.getSessionDetails().sessions)).toHaveLength(0);
  });

  // ── 9. getSessionDetails() format ──

  it('returns Record<string, SessionDetail> with correct shape', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const result = cache.getSessionDetails();
    expect(result.sessions).toEqual({});
    expect(result.meta).toBeDefined();

    simulateSseEvent(mockRes, {
      directory: '/project/test',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-fmt', status: { type: 'idle' } },
      },
    });

    const details = cache.getSessionDetails();
    const entry = details.sessions['sess-fmt'];
    expect(entry).toMatchObject({
      status: 'idle',
      lastPrompt: null,
      lastPromptTime: 0,
      currentTool: null,
      directory: '/project/test',
    });
    expect(typeof entry.updatedAt).toBe('number');
  });

  // ── 10. getConnectionState() ──

  it('returns disconnected initially and connected after start', async () => {
    cache = new SessionCache(4096, ':memory:');
    expect(cache.getConnectionState()).toBe('disconnected');

    const mockRes = createMockResponse();
    setupSseMock(mockRes);
    cache.start();
    await flushPromises();

    expect(cache.getConnectionState()).toBe('connected');
  });

  // ── 11. message.part.updated → currentTool tracking ──

  it('tracks currentTool via message.part.updated events', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Tool running
    simulateSseEvent(mockRes, {
      directory: '/project/x',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'sess-t',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-t']?.currentTool).toBe('bash');

    // Tool completed
    simulateSseEvent(mockRes, {
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'sess-t',
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed' },
          },
        },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-t']?.currentTool).toBeNull();
  });

  // ── 12. Persistence across recreations ──

  it('persists session status across SessionCache recreations', async () => {
    const tmpDbPath = '/tmp/test-session-cache-persist.db';
    const mockRes = createMockResponse();
    setupSseMock(mockRes);
    cache = new SessionCache(4096, tmpDbPath);
    cache.start();
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/persist',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-persist', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-persist']?.status).toBe('busy');
    cache.stop();

    // Recreate with same DB path
    const mockRes2 = createMockResponse();
    setupSseMock(mockRes2);
    cache = new SessionCache(4096, tmpDbPath);
    cache.start();
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-persist'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('busy');
    expect(entry.directory).toBe('/project/persist');

    // Cleanup
    cache.stop();
    cache = undefined as any;
    const { unlinkSync } = await import('node:fs');
    try { unlinkSync(tmpDbPath); } catch {}
    try { unlinkSync(tmpDbPath + '-wal'); } catch {}
    try { unlinkSync(tmpDbPath + '-shm'); } catch {}
  });

  // ── 13. store.close() on stop() ──

  it('closes the store on stop()', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-close', status: { type: 'idle' } },
      },
    });

    const stoppedCache = cache;
    cache.stop();
    cache = undefined as any;

    // After stop(), the store is closed — getSessionDetails() should throw
    expect(() => stoppedCache.getSessionDetails()).toThrow();
  });

  // ── 14. 멱등성 — 이미 lastPrompt가 있는 세션은 REST 호출 skip ──

  it('lastPrompt가 저장된 세션도 message.updated 시 REST 재호출', async () => {
    mockFetchJson
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // 세션을 lastPrompt가 있는 상태로 사전 설정
    simulateSseEvent(mockRes, {
      directory: '/project/idempotent',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-idem', status: { type: 'busy' } },
      },
    });

    // lastPrompt를 직접 주입하기 위해 message.updated 시뮬레이션 후 REST 응답 설정
    const userMessages = [
      {
        info: { role: 'user', sessionID: 'sess-idem', time: { created: 99999 } },
        parts: [{ type: 'text', text: 'First prompt' }],
      },
    ];
    mockFetchJson.mockResolvedValueOnce(userMessages);

    simulateSseEvent(mockRes, {
      directory: '/project/idempotent',
      payload: {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: 'sess-idem' } },
      },
    });
    await flushPromises();

    // 첫 번째 이벤트로 lastPrompt 저장됨
    expect(cache.getSessionDetails().sessions['sess-idem']?.lastPrompt).toBe('First prompt');

    // fetchJson 호출 횟수 기록 (bootstrap 1회 + fetchLatestUserPrompt 1회 = 2회)
    const callCountAfterFirst = mockFetchJson.mock.calls.length;

    // 두 번째 message.updated 이벤트 — guard 제거됨, REST 재호출 발생
    mockFetchJson.mockResolvedValueOnce(userMessages);
    simulateSseEvent(mockRes, {
      directory: '/project/idempotent',
      payload: {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: 'sess-idem' } },
      },
    });
    await flushPromises();

    // guard 제거로 fetchJson이 한 번 더 호출됨
    expect(mockFetchJson.mock.calls.length).toBe(callCountAfterFirst + 1);
  });

  // ── 15. message timestamp를 lastPromptTime으로 사용 (Date.now() 대신) ──

  it('message timestamp를 lastPromptTime으로 사용 (Date.now() 대신)', async () => {
    const fixedTimestamp = 1700000000000;
    const userMessages = [
      {
        info: { role: 'user', sessionID: 'sess-ts', time: { created: fixedTimestamp } },
        parts: [{ type: 'text', text: 'Hello with timestamp' }],
      },
    ];

    mockFetchJson
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(userMessages);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/ts',
      payload: {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: 'sess-ts' } },
      },
    });
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-ts'];
    expect(entry).toBeDefined();
    expect(entry.lastPrompt).toBe('Hello with timestamp');
    // Date.now()가 아닌 메시지 원래 타임스탬프여야 함
    expect(entry.lastPromptTime).toBe(fixedTimestamp);
  });

  // ── 16. Bootstrap race condition — SSE data fresher than REST ──

  it('bootstrap skips upsert when SSE already has fresher data', async () => {
    // Bootstrap will fetch projects, then session/status for each project
    mockFetchJson
      .mockResolvedValueOnce([
        { id: 'proj-1', worktree: '/project/race', vcs: null, time: null, sandboxes: null },
      ])
      .mockResolvedValueOnce({ 'sess-race': { type: 'idle' } });

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    // bootstrap() is now pending (async, fire-and-forget)

    // SSE event arrives BEFORE bootstrap completes — sets fresher data
    simulateSseEvent(mockRes, {
      directory: '/project/race',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-race', status: { type: 'busy' } },
      },
    });

    // Flush lets bootstrap resolve — it should skip upsert for sess-race
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-race'];
    expect(entry).toBeDefined();
    // SSE set 'busy'; bootstrap tried 'idle' but should have been skipped
    expect(entry.status).toBe('busy');
  });

  // ── 17. Bootstrap stores data on first boot (no existing cache) ──

  it('bootstrap stores data on first boot when no existing cache', async () => {
    mockFetchJson
      .mockResolvedValueOnce([
        { id: 'proj-1', worktree: '/project/fresh', vcs: null, time: null, sandboxes: null },
      ])
      .mockResolvedValueOnce({ 'sess-fresh': { type: 'busy' } });

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    // No SSE events — first boot scenario
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-fresh'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('busy');
    expect(entry.directory).toBe('/project/fresh');
  });

  // ── 18. Bootstrap early returns when connection drops mid-execution ──

  it('bootstrap early returns when connection drops mid-execution', async () => {
    const mockRes = createMockResponse();

    // Use a deferred promise to control when fetchJson resolves
    let resolveProjectsFetch!: (value: unknown) => void;
    const projectsFetchPromise = new Promise((resolve) => {
      resolveProjectsFetch = resolve;
    });
    mockFetchJson.mockReturnValueOnce(projectsFetchPromise);

    cache = startCache(mockRes);

    // SSE disconnect happens WHILE bootstrap is awaiting fetchJson('/project')
    for (const handler of mockRes.handlers['end'] ?? []) {
      handler();
    }
    // Prevent reconnect from re-establishing SSE
    mockHttpGet.mockImplementation(() => ({ on: vi.fn() }));

    // Now resolve the projects fetch — bootstrap resumes with connectionState='reconnecting'
    resolveProjectsFetch([
      { id: 'proj-1', worktree: '/project/dropped', vcs: null, time: null, sandboxes: null },
    ]);
    await flushPromises();

    // Early return prevented bootstrapProject from running
    expect(cache.getSessionDetails().sessions['sess-dropped']).toBeUndefined();
  });

  // ── 19. getSessionDetails returns meta with sseConnected=true when connected ──

  it('getSessionDetails returns meta with sseConnected=true when connected', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const result = cache.getSessionDetails();
    expect(result.meta).toBeDefined();
    expect(result.meta.sseConnected).toBe(true);
    expect(result.meta.sseConnectedAt).toBeGreaterThan(0);
    expect(typeof result.meta.lastSseEventAt).toBe('number');
  });

  // ── 20. getSessionDetails returns meta with sseConnected=false when disconnected ──

  it('getSessionDetails returns meta with sseConnected=false when disconnected', () => {
    cache = new SessionCache(4096, ':memory:');
    const result = cache.getSessionDetails();
    expect(result.meta).toBeDefined();
    expect(result.meta.sseConnected).toBe(false);
    expect(result.meta.sseConnectedAt).toBe(0);
    expect(result.meta.lastSseEventAt).toBe(0);
  });

  // ── 21. pending tool state → waitingForInput: true ──

  it('tool pending does NOT set waitingForInput (only permission.updated does)', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/pending',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'sess-pending',
            type: 'tool',
            tool: 'edit',
            state: { status: 'pending' },
          },
        },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-pending'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
    expect(entry.currentTool).toBe('edit');
  });

  // ── 22. pending → running transition resets waitingForInput ──

  it('permission.updated → running transition resets waitingForInput', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // permission.updated → waitingForInput = true
    simulateSseEvent(mockRes, {
      directory: '/project/transition',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-trans', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/transition',
      payload: {
        type: 'permission.updated',
        properties: { sessionID: 'sess-trans' },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-trans']?.waitingForInput).toBe(true);

    // running → waitingForInput = false
    simulateSseEvent(mockRes, {
      directory: '/project/transition',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'sess-trans',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-trans'];
    expect(entry.waitingForInput).toBe(false);
    expect(entry.currentTool).toBe('bash');
  });

  // ── 23. session.status busy resets waitingForInput ──

  it('resets waitingForInput=false when session.status transitions to busy', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/busy-reset',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-busy', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/busy-reset',
      payload: {
        type: 'permission.updated',
        properties: { sessionID: 'sess-busy' },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-busy']?.waitingForInput).toBe(true);

    simulateSseEvent(mockRes, {
      directory: '/project/busy-reset',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-busy', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-busy']?.waitingForInput).toBe(false);
  });

  // ── 24. permission.updated → waitingForInput: true ──

  it('sets waitingForInput=true on permission.updated event', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Pre-populate session
    simulateSseEvent(mockRes, {
      directory: '/project/perm',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-perm', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-perm']?.waitingForInput).toBe(false);

    // permission.updated → waitingForInput = true
    simulateSseEvent(mockRes, {
      directory: '/project/perm',
      payload: {
        type: 'permission.updated',
        properties: { sessionID: 'sess-perm' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-perm'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(true);
    expect(entry.status).toBe('busy'); // status 변경 없음
  });

  // ── 25. session.deleted → session removed from cache ──

  it('removes session from cache on session.deleted event', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Add session first
    simulateSseEvent(mockRes, {
      directory: '/project/del',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-del', status: { type: 'idle' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-del']).toBeDefined();

    // Delete via SSE event
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.deleted',
        properties: { info: { id: 'sess-del' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-del']).toBeUndefined();
  });

  // ── 26. session.deleted with sessionID fallback ──

  it('handles session.deleted with sessionID fallback (no info.id)', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-del2', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-del2']).toBeDefined();

    // session.deleted with sessionID (not info.id)
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.deleted',
        properties: { sessionID: 'sess-del2' },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-del2']).toBeUndefined();
  });

  // ── 27. checkDeletedSessions: session not in oc-serve → deleted ──

  it('checkDeletedSessions removes sessions not found in oc-serve session list', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Add two sessions via SSE
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-alive', status: { type: 'idle' } },
      },
    });
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-gone', status: { type: 'idle' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-alive']).toBeDefined();
    expect(cache.getSessionDetails().sessions['sess-gone']).toBeDefined();

    // checkDeletedSessions: /project → 1 project, /session → only sess-alive
    mockFetchJson
      .mockResolvedValueOnce([{ id: 'p1', worktree: '/project/test', vcs: null, time: null, sandboxes: null }])
      .mockResolvedValueOnce([{ id: 'sess-alive' }]);

    await (cache as any).checkDeletedSessions();

    expect(cache.getSessionDetails().sessions['sess-alive']).toBeDefined();
    expect(cache.getSessionDetails().sessions['sess-gone']).toBeUndefined();
  });

  // ── 28. checkDeletedSessions: oc-serve unreachable → sessions preserved ──

  it('checkDeletedSessions preserves all sessions when oc-serve is unreachable', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // Add session via SSE
    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-net', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-net']).toBeDefined();

    // /project fetch fails → oc-serve unreachable → return null → skip deletion
    mockFetchJson.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await (cache as any).checkDeletedSessions();

    expect(cache.getSessionDetails().sessions['sess-net']).toBeDefined();
    expect(cache.getSessionDetails().sessions['sess-net'].status).toBe('busy');
  });

  // ── 29. checkDeletedSessions: all project fetches fail → sessions preserved ──

  it('checkDeletedSessions preserves sessions when all project fetches fail', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-safe', status: { type: 'idle' } },
      },
    });

    // /project succeeds, but all /session fetches fail
    mockFetchJson
      .mockResolvedValueOnce([{ id: 'p1', worktree: '/project/a', vcs: null, time: null, sandboxes: null }])
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await (cache as any).checkDeletedSessions();

    // All project fetches failed → treat as unreachable → preserve
    expect(cache.getSessionDetails().sessions['sess-safe']).toBeDefined();
  });

  // ── 30. permission.updated → session.idle → waitingForInput: false ──

  it('resets waitingForInput=false when session.idle fires after permission.updated', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/idle-reset',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-idle-pending', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/idle-reset',
      payload: {
        type: 'permission.updated',
        properties: { sessionID: 'sess-idle-pending' },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-idle-pending']?.waitingForInput).toBe(true);

    simulateSseEvent(mockRes, {
      directory: '/project/idle-reset',
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'sess-idle-pending' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-idle-pending'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
    expect(entry.status).toBe('idle');
  });

  // ── 31. permission.updated → session.idle → waitingForInput: false ──

  it('resets waitingForInput=false when session.idle fires after permission.updated', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // 세션 생성 (busy)
    simulateSseEvent(mockRes, {
      directory: '/project/perm-idle',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-perm-idle', status: { type: 'busy' } },
      },
    });

    // permission.updated → waitingForInput = true
    simulateSseEvent(mockRes, {
      directory: '/project/perm-idle',
      payload: {
        type: 'permission.updated',
        properties: { sessionID: 'sess-perm-idle' },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-perm-idle']?.waitingForInput).toBe(true);

    // session.idle → waitingForInput 리셋
    simulateSseEvent(mockRes, {
      directory: '/project/perm-idle',
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'sess-perm-idle' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-perm-idle'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
    expect(entry.status).toBe('idle');
  });

  // ── 32. question.asked → waitingForInput: true ──

  it('sets waitingForInput=true on question.asked event', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // 세션 생성 (busy)
    simulateSseEvent(mockRes, {
      directory: '/project/question',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-question', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-question']?.waitingForInput).toBe(false);

    // question.asked → waitingForInput = true
    simulateSseEvent(mockRes, {
      directory: '/project/question',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'question_001',
          sessionID: 'sess-question',
          questions: [{ question: 'Pick one', header: 'Choice', options: [] }],
        },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-question'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(true);
  });

  // ── 33. question.asked creates session entry if none exists ──

  it('creates session entry on question.asked for unknown session', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/new-question',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'question_002',
          sessionID: 'sess-new-q',
          questions: [{ question: 'Choose', header: 'Q', options: [] }],
        },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-new-q'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(true);
    expect(entry.directory).toBe('/project/new-question');
  });

  // ── 34. question.replied → waitingForInput: false ──

  it('resets waitingForInput=false on question.replied event', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // 세션 생성 + question pending
    simulateSseEvent(mockRes, {
      directory: '/project/q-reply',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-reply', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/q-reply',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_003', sessionID: 'sess-q-reply', questions: [] },
      },
    });
    expect(cache.getSessionDetails().sessions['sess-q-reply']?.waitingForInput).toBe(true);

    // question.replied → waitingForInput = false
    simulateSseEvent(mockRes, {
      directory: '/project/q-reply',
      payload: {
        type: 'question.replied',
        properties: {
          sessionID: 'sess-q-reply',
          requestID: 'question_003',
          answers: [['Option A']],
        },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-q-reply'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
  });

  // ── 35. question.rejected → waitingForInput: false ──

  it('resets waitingForInput=false on question.rejected event', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    // 세션 생성 + question pending
    simulateSseEvent(mockRes, {
      directory: '/project/q-reject',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-reject', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/q-reject',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_004', sessionID: 'sess-q-reject', questions: [] },
      },
    });
    expect(cache.getSessionDetails().sessions['sess-q-reject']?.waitingForInput).toBe(true);

    // question.rejected → waitingForInput = false
    simulateSseEvent(mockRes, {
      directory: '/project/q-reject',
      payload: {
        type: 'question.rejected',
        properties: { sessionID: 'sess-q-reject', requestID: 'question_004' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-q-reject'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
  });

  // ── 36. question.asked → session.status busy → waitingForInput: false ──

  it('resets waitingForInput=false when session.status transitions to busy after question.asked', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/q-busy',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-busy', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/q-busy',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_005', sessionID: 'sess-q-busy', questions: [] },
      },
    });
    expect(cache.getSessionDetails().sessions['sess-q-busy']?.waitingForInput).toBe(true);

    // session.status busy → waitingForInput 리셋
    simulateSseEvent(mockRes, {
      directory: '/project/q-busy',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-busy', status: { type: 'busy' } },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-q-busy']?.waitingForInput).toBe(false);
  });

  // ── 37. question.asked → session.idle → waitingForInput: false ──

  it('resets waitingForInput=false when session.idle fires after question.asked', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/q-idle',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-idle', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/q-idle',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_006', sessionID: 'sess-q-idle', questions: [] },
      },
    });
    expect(cache.getSessionDetails().sessions['sess-q-idle']?.waitingForInput).toBe(true);

    // session.idle → 모든 waitingForInput 리셋
    simulateSseEvent(mockRes, {
      directory: '/project/q-idle',
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'sess-q-idle' },
      },
    });

    const entry = cache.getSessionDetails().sessions['sess-q-idle'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(false);
    expect(entry.status).toBe('idle');
  });

  // ── 38. question.replied for unknown session is a no-op ──

  it('ignores question.replied for unknown session (no crash)', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/unknown',
      payload: {
        type: 'question.replied',
        properties: { sessionID: 'sess-unknown', requestID: 'q_999', answers: [] },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-unknown']).toBeUndefined();
  });

  // ── 39. question.asked without sessionID is a no-op ──

  it('ignores question.asked without sessionID', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const sessionsBefore = Object.keys(cache.getSessionDetails().sessions).length;

    simulateSseEvent(mockRes, {
      directory: '/project/no-id',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_007', questions: [] },
      },
    });

    const sessionsAfter = Object.keys(cache.getSessionDetails().sessions).length;
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  // ── 40. question.asked → tool running → waitingForInput: false ──

  it('resets waitingForInput=false when tool starts running after question.asked', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    simulateSseEvent(mockRes, {
      directory: '/project/q-tool',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-q-tool', status: { type: 'busy' } },
      },
    });
    simulateSseEvent(mockRes, {
      directory: '/project/q-tool',
      payload: {
        type: 'question.asked',
        properties: { id: 'question_008', sessionID: 'sess-q-tool', questions: [] },
      },
    });
    expect(cache.getSessionDetails().sessions['sess-q-tool']?.waitingForInput).toBe(true);

    // tool running → waitingForInput 리셋
    simulateSseEvent(mockRes, {
      directory: '/project/q-tool',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { sessionID: 'sess-q-tool', type: 'tool', tool: 'mcp_bash', state: { status: 'running' } },
        },
      },
    });

    expect(cache.getSessionDetails().sessions['sess-q-tool']?.waitingForInput).toBe(false);
  });

  // ── 41. bootstrap sets waitingForInput for pending questions ──

  it('bootstrap sets waitingForInput=true for sessions with pending questions', async () => {
    const projectData = [{ id: 'proj-1', worktree: '/project/bootstrap-q', vcs: null, time: null, sandboxes: null }];
    const statusData = { 'sess-bq': { type: 'busy' } };
    const sessionList = [{ id: 'sess-bq', title: 'Bootstrap Q', time: { created: 1000, updated: 2000 } }];
    const pendingQuestions = [{ id: 'q_001', sessionID: 'sess-bq', questions: [] }];
    const pendingPermissions: unknown[] = [];

    mockFetchJson
      .mockResolvedValueOnce(projectData)
      .mockResolvedValueOnce(statusData)
      .mockResolvedValueOnce(sessionList)
      .mockResolvedValueOnce(pendingQuestions)
      .mockResolvedValueOnce(pendingPermissions);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-bq'];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('busy');
    expect(entry.waitingForInput).toBe(true);
  });

  // ── 42. bootstrap sets waitingForInput for pending permissions ──

  it('bootstrap sets waitingForInput=true for sessions with pending permissions', async () => {
    const projectData = [{ id: 'proj-2', worktree: '/project/bootstrap-p', vcs: null, time: null, sandboxes: null }];
    const statusData = { 'sess-bp': { type: 'busy' } };
    const sessionList = [{ id: 'sess-bp', title: 'Bootstrap P', time: { created: 1000, updated: 2000 } }];
    const pendingQuestions: unknown[] = [];
    const pendingPermissions = [{ id: 'perm_001', sessionID: 'sess-bp' }];

    mockFetchJson
      .mockResolvedValueOnce(projectData)
      .mockResolvedValueOnce(statusData)
      .mockResolvedValueOnce(sessionList)
      .mockResolvedValueOnce(pendingQuestions)
      .mockResolvedValueOnce(pendingPermissions);

    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const entry = cache.getSessionDetails().sessions['sess-bp'];
    expect(entry).toBeDefined();
    expect(entry.waitingForInput).toBe(true);
  });

});
