import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecentPromptsModule } from '../modules/recent-prompts/index.js';
import { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

// ── HTTP mock helpers ──

function setupUrlRouter(routes: Record<string, string>, errors?: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      if (errors) {
        for (const [pattern, errorMsg] of Object.entries(errors)) {
          if (url.includes(pattern)) {
            return {
              on: vi.fn((event: string, handler: (err: Error) => void) => {
                if (event === 'error') handler(new Error(errorMsg));
              }),
            };
          }
        }
      }

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
          if (event === 'error') handler(new Error(`No mock for URL: ${url}`));
        }),
      };
    },
  );
}

// ── Machine fixtures ──

function makeOcMachine(): MachineConfig {
  return { id: 'oc-m', alias: 'OC', host: '10.0.0.1', port: 3100, apiKey: 'key-oc', source: 'opencode' };
}

function makeClaudeMachine(): MachineConfig {
  return { id: 'claude-m', alias: 'Claude', host: '10.0.0.2', port: 3100, apiKey: 'key-cl', source: 'claude-code' };
}

function makeBothMachine(): MachineConfig {
  return { id: 'both-m', alias: 'Both', host: '10.0.0.3', port: 3100, apiKey: 'key-b', source: 'both' };
}

/**
 * Helper: create module, do a single poll cycle, capture queries via callback + return them.
 */
async function pollAndCapture(machines: readonly MachineConfig[]): Promise<Record<string, unknown>[]> {
  const manager = new MachineManager(machines);
  const module = new RecentPromptsModule(manager);

  const captured: Record<string, unknown>[] = [];
  module.setNewQueryCallback((query) => {
    captured.push(query as unknown as Record<string, unknown>);
  });

  await module.start();
  await module.start();
  await module.stop();

  return captured;
}

/**
 * Helper: get cached queries from the module's /api/queries route handler.
 */
async function getCachedQueries(machines: readonly MachineConfig[]): Promise<Record<string, unknown>[]> {
  const manager = new MachineManager(machines);
  const module = new RecentPromptsModule(manager);

  type RouteHandler = (request: { query: { limit?: string } }) => Promise<{ queries: unknown[] }>;
  let routeHandler: RouteHandler | null = null;

  const mockApp = {
    get: vi.fn((_path: string, handler: RouteHandler) => {
      routeHandler = handler;
    }),
  };

  module.registerRoutes(mockApp as unknown as import('fastify').FastifyInstance);

  await module.start();
  await module.stop();

  if (routeHandler) {
    const handler = routeHandler as RouteHandler;
    const result = await handler({ query: { limit: '100' } });
    return result.queries as Record<string, unknown>[];
  }
  return [];
}

describe('RecentPromptsModule — source field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Claude queries have source: "claude-code"', () => {
    it('should set source="claude-code" for queries from Claude endpoint', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cs-1', timestamp: 1000, query: 'Claude question', source: 'claude-code' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeClaudeMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('claude-code');
      expect(queries[0].query).toBe('Claude question');
    });

    it('should fire newQuery callback for Claude queries', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cs-1', timestamp: 1000, query: 'Claude prompt', source: 'claude-code' },
          ],
        }),
      });

      const captured = await pollAndCapture([makeClaudeMachine()]);

      expect(captured).toHaveLength(1);
      expect(captured[0].source).toBe('claude-code');
    });
  });

  describe('default source is "opencode" for legacy queries', () => {
    it('should set source="opencode" for queries without source field', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'oc-1', timestamp: 1000, query: 'Legacy query' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeOcMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('opencode');
    });

    it('should set source="opencode" for queries with explicit opencode source', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'oc-1', timestamp: 1000, query: 'OC query', source: 'opencode' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeOcMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('opencode');
    });
  });

  describe('normalizeQuery handles source field correctly', () => {
    it('should normalize unknown source values to "opencode"', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'q-1', timestamp: 1000, query: 'Bad source', source: 'unknown-source' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeOcMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('opencode');
    });

    it('should preserve "claude-code" source through normalization', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cq-1', timestamp: 2000, query: 'Claude task', source: 'claude-code' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeClaudeMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('claude-code');
    });
  });

  describe('mixed queries sorted by timestamp', () => {
    it('should sort mixed OC + Claude queries by timestamp descending', async () => {
      setupUrlRouter({
        'http://10.0.0.3:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'oq-1', timestamp: 1000, query: 'First OC' },
            { sessionId: 'oq-2', timestamp: 3000, query: 'Third OC' },
          ],
        }),
        'http://10.0.0.3:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cq-1', timestamp: 2000, query: 'Second Claude', source: 'claude-code' },
            { sessionId: 'cq-2', timestamp: 4000, query: 'Fourth Claude', source: 'claude-code' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeBothMachine()]);

      expect(queries).toHaveLength(4);
      expect(queries[0].sessionId).toBe('cq-2');
      expect(queries[1].sessionId).toBe('oq-2');
      expect(queries[2].sessionId).toBe('cq-1');
      expect(queries[3].sessionId).toBe('oq-1');
    });

    it('should mix queries from different machines sorted by timestamp', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'oq-1', timestamp: 1000, query: 'OC first' },
            { sessionId: 'oq-2', timestamp: 3000, query: 'OC third' },
          ],
        }),
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cq-1', timestamp: 2000, query: 'Claude second', source: 'claude-code' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeOcMachine(), makeClaudeMachine()]);

      expect(queries).toHaveLength(3);
      expect(queries[0].sessionId).toBe('oq-2');
      expect(queries[1].sessionId).toBe('cq-1');
      expect(queries[2].sessionId).toBe('oq-1');

      expect(queries[0].source).toBe('opencode');
      expect(queries[1].source).toBe('claude-code');
      expect(queries[2].source).toBe('opencode');
    });
  });

  describe('machine tagging', () => {
    it('should tag Claude queries with correct machine metadata', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [
            { sessionId: 'cq-1', timestamp: 1000, query: 'Tagged query', source: 'claude-code' },
          ],
        }),
      });

      const queries = await getCachedQueries([makeClaudeMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].machineId).toBe('claude-m');
      expect(queries[0].machineAlias).toBe('Claude');
      expect(queries[0].machineHost).toBe('10.0.0.2');
    });
  });

  describe('empty and error handling', () => {
    it('should handle empty queries from all sources', async () => {
      setupUrlRouter({
        'http://10.0.0.3:3100/api/queries': JSON.stringify({ queries: [] }),
        'http://10.0.0.3:3100/api/claude/queries': JSON.stringify({ queries: [] }),
      });

      const queries = await getCachedQueries([makeBothMachine()]);
      expect(queries).toHaveLength(0);
    });

    it('should handle one source failing gracefully', async () => {
      setupUrlRouter(
        {
          'http://10.0.0.3:3100/api/queries': JSON.stringify({
            queries: [{ sessionId: 'oq-1', timestamp: 1000, query: 'Survived' }],
          }),
        },
        {
          '/api/claude/queries': 'ECONNREFUSED',
        },
      );

      const queries = await getCachedQueries([makeBothMachine()]);

      expect(queries).toHaveLength(1);
      expect(queries[0].source).toBe('opencode');
    });
  });
});

describe('RecentPromptsModule — sessionTitle null regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should preserve sessionTitle: null (not coerce to empty string)', async () => {
    // Regression: oc-serve returns sessionTitle=null for new sessions.
    // Frontend falls back to sessionId.slice(0, 8) → raw ID shown in UI.
    // Backend must preserve null so frontend can detect and look up from sessions store.
    setupUrlRouter({
      'http://10.0.0.1:3100/api/queries': JSON.stringify({
        queries: [
          { sessionId: 'ses_349177918ffe', timestamp: 1000, query: 'http://192.168.0.63:3098/ 접속 확인', sessionTitle: null },
        ],
      }),
    });

    const queries = await getCachedQueries([makeOcMachine()]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sessionTitle).toBeNull();
    expect(queries[0].query).toBe('http://192.168.0.63:3098/ 접속 확인');
  });

  it('should pass through sessionTitle when present', async () => {
    setupUrlRouter({
      'http://10.0.0.1:3100/api/queries': JSON.stringify({
        queries: [
          { sessionId: 'ses_abc', timestamp: 2000, query: 'Some prompt', sessionTitle: 'My Session' },
        ],
      }),
    });

    const queries = await getCachedQueries([makeOcMachine()]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sessionTitle).toBe('My Session');
  });

  it('should handle mixed null and present sessionTitles', async () => {
    setupUrlRouter({
      'http://10.0.0.1:3100/api/queries': JSON.stringify({
        queries: [
          { sessionId: 'ses_no_title', timestamp: 1000, query: 'No title prompt', sessionTitle: null },
          { sessionId: 'ses_with_title', timestamp: 2000, query: 'Has title', sessionTitle: 'Titled Session' },
        ],
      }),
    });

    const queries = await getCachedQueries([makeOcMachine()]);

    expect(queries).toHaveLength(2);
    const noTitle = queries.find(q => q.sessionId === 'ses_no_title');
    const withTitle = queries.find(q => q.sessionId === 'ses_with_title');
    expect(noTitle?.sessionTitle).toBeNull();
    expect(withTitle?.sessionTitle).toBe('Titled Session');
  });
});
