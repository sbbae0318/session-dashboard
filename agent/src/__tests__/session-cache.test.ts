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
    expect(Object.keys(cache.getSessionDetails())).toHaveLength(0);
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

    expect(Object.keys(cache.getSessionDetails())).toHaveLength(0);
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

    const entry = cache.getSessionDetails()['sess-abc'];
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

    const entry = cache.getSessionDetails()['sess-1'];
    expect(entry.status).toBe('idle');
    expect(entry.currentTool).toBeNull();
    expect(entry.directory).toBe('/project/bar');
  });

  // ── 6. message.updated(role=user) → REST fallback → lastPrompt ──

  it('fetches last user prompt via REST on message.updated', async () => {
    const userMessages = [
      {
        info: { role: 'user', sessionID: 'sess-1' },
        parts: [{ type: 'text', text: 'Build a todo app' }],
      },
    ];

    // bootstrap /project → [], then fetchLastUserPrompt → messages
    mockFetchJson
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

    const entry = cache.getSessionDetails()['sess-1'];
    expect(entry).toBeDefined();
    expect(entry.lastPrompt).toBe('Build a todo app');
    expect(entry.lastPromptTime).toBeGreaterThan(0);
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

    const entry = cache.getSessionDetails()['sess-2'];
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

    expect(Object.keys(cache.getSessionDetails())).toHaveLength(2);

    // TTL=86_400_000ms, eviction interval=60_000ms
    // At 86_460_000ms the eviction runs and entries exceed 24h TTL
    vi.advanceTimersByTime(86_460_000);
    await flushPromises();

    expect(Object.keys(cache.getSessionDetails())).toHaveLength(0);
  });

  // ── 9. getSessionDetails() format ──

  it('returns Record<string, SessionDetail> with correct shape', async () => {
    const mockRes = createMockResponse();
    cache = startCache(mockRes);
    await flushPromises();

    const empty: Record<string, SessionDetail> = cache.getSessionDetails();
    expect(empty).toEqual({});

    simulateSseEvent(mockRes, {
      directory: '/project/test',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sess-fmt', status: { type: 'idle' } },
      },
    });

    const details = cache.getSessionDetails();
    const entry = details['sess-fmt'];
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

    expect(cache.getSessionDetails()['sess-t']?.currentTool).toBe('bash');

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

    expect(cache.getSessionDetails()['sess-t']?.currentTool).toBeNull();
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

    expect(cache.getSessionDetails()['sess-persist']?.status).toBe('busy');
    cache.stop();

    // Recreate with same DB path
    const mockRes2 = createMockResponse();
    setupSseMock(mockRes2);
    cache = new SessionCache(4096, tmpDbPath);
    cache.start();
    await flushPromises();

    const entry = cache.getSessionDetails()['sess-persist'];
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
});
