import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MachineManager, type MachineStatus } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

// ── Test fixtures ──

function createMachines(): readonly MachineConfig[] {
  return [
    { id: 'mac-studio', alias: 'Mac Studio', host: '192.168.1.10', port: 3100, apiKey: 'key-studio', source: 'opencode' },
    { id: 'mac-mini', alias: 'Mac Mini', host: '192.168.1.11', port: 3100, apiKey: 'key-mini', source: 'opencode' },
  ];
}

/**
 * Simulate a successful HTTP response from mockHttpGet.
 * httpGet signature: httpGet(url, options, callback) → returns request object
 */
function mockSuccessResponse(body: string): void {
  mockHttpGet.mockImplementationOnce(
    (_url: string, _opts: unknown, callback: (res: unknown) => void) => {
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
    },
  );
}

function mockErrorResponse(errorMessage: string): void {
  mockHttpGet.mockImplementationOnce(
    (_url: string, _opts: unknown, _callback: unknown) => {
      const request = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') {
            handler(new Error(errorMessage));
          }
        }),
      };
      return request;
    },
  );
}

/**
 * URL-based routing mock for pollMachine's parallel Promise.all calls.
 * Maps URL patterns to response bodies. Unmatched URLs get an error.
 */
function setupUrlRouter(routes: Record<string, string>, errors?: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      if (errors) {
        for (const [pattern, errorMsg] of Object.entries(errors)) {
          if (url.includes(pattern)) {
            const request = {
              on: vi.fn((event: string, handler: (err: Error) => void) => {
                if (event === 'error') {
                  handler(new Error(errorMsg));
                }
              }),
            };
            return request;
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

      const request = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') {
            handler(new Error(`No mock for URL: ${url}`));
          }
        }),
      };
      return request;
    },
  );
}

describe('MachineManager', () => {
  let manager: MachineManager;
  const machines = createMachines();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    manager = new MachineManager(machines);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize all machines as disconnected', () => {
      const statuses = manager.getMachineStatuses();

      expect(statuses).toHaveLength(2);
      for (const status of statuses) {
        expect(status.connected).toBe(false);
        expect(status.lastSeen).toBeNull();
        expect(status.error).toBeNull();
      }
    });

    it('should preserve machine metadata in initial statuses', () => {
      const statuses = manager.getMachineStatuses();

      const studio = statuses.find(s => s.machineId === 'mac-studio');
      expect(studio).toBeDefined();
      expect(studio?.machineAlias).toBe('Mac Studio');
      expect(studio?.machineHost).toBe('192.168.1.10');

      const mini = statuses.find(s => s.machineId === 'mac-mini');
      expect(mini).toBeDefined();
      expect(mini?.machineAlias).toBe('Mac Mini');
      expect(mini?.machineHost).toBe('192.168.1.11');
    });
  });

  describe('getMachines()', () => {
    it('should return the original machine configs', () => {
      const result = manager.getMachines();
      expect(result).toEqual(machines);
    });
  });

  describe('getMachineStatuses()', () => {
    it('should return a copy (not mutate internal state)', () => {
      const statuses1 = manager.getMachineStatuses();
      const statuses2 = manager.getMachineStatuses();
      expect(statuses1).not.toBe(statuses2);
      expect(statuses1).toEqual(statuses2);
    });
  });

  describe('pollAllSessions()', () => {
    it('should mark all machines connected when all respond', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({ 'sess-1': { type: 'active' } }),
        'http://192.168.1.10:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-1', sessionId: 'sess-1', title: 'Work' }]),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([{ id: 'proj2', worktree: '/path/to/proj2' }]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({ 'sess-2': { type: 'idle' } }),
        'http://192.168.1.11:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-2', sessionId: 'sess-2', title: 'Debug' }]),
      });

      const result = await manager.pollAllSessions();

      const statuses = manager.getMachineStatuses();
      expect(statuses.every(s => s.connected)).toBe(true);
      expect(statuses.every(s => s.error === null)).toBe(true);

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].machineId).toBe('mac-studio');
      expect(result.sessions[1].machineId).toBe('mac-mini');
    });

    it('should handle partial failure (one machine down)', async () => {
      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
          'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({ 'sess-1': { type: 'active' } }),
          'http://192.168.1.10:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-1', sessionId: 'sess-1' }]),
        },
        {
          '192.168.1.11': 'ECONNREFUSED',
        },
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await manager.pollAllSessions();
      warnSpy.mockRestore();

      const statuses = manager.getMachineStatuses();
      const studio = statuses.find(s => s.machineId === 'mac-studio');
      const mini = statuses.find(s => s.machineId === 'mac-mini');

      expect(studio?.connected).toBe(true);
      // With projectsCache fallback, pollMachine succeeds with empty results
      // Machine is still marked connected (no throw from pollMachine)
      expect(mini?.connected).toBe(true);

      // Studio returns 1 session, Mini returns 0 (graceful degradation)
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].machineId).toBe('mac-studio');
    });

    it('should tag sessions with machineId, machineAlias, machineHost', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        'http://192.168.1.10:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-1', sessionId: 'sess-1', title: 'Work' }]),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({}),
      });

      const result = await manager.pollAllSessions();

      expect(result.sessions[0]).toMatchObject({
        machineId: 'mac-studio',
        machineAlias: 'Mac Studio',
        machineHost: '192.168.1.10',
      });
    });

    it('should tag statuses with machineId', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({ 'sess-1': { type: 'active' } }),
        'http://192.168.1.10:3100/proxy/session?directory': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([{ id: 'proj2', worktree: '/path/to/proj2' }]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({ 'sess-2': { type: 'idle' } }),
        'http://192.168.1.11:3100/proxy/session?directory': JSON.stringify([]),
      });

      const result = await manager.pollAllSessions();

      expect(result.statuses['sess-1']).toMatchObject({
        type: 'active',
        machineId: 'mac-studio',
      });
      expect(result.statuses['sess-2']).toMatchObject({
        type: 'idle',
        machineId: 'mac-mini',
      });
    });
  });

  describe('setStatusChangeCallback()', () => {
    it('should fire callback after pollAllSessions', async () => {
      const callback = vi.fn();
      manager.setStatusChangeCallback(callback);

      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({}),
      });

      await manager.pollAllSessions();

      expect(callback).toHaveBeenCalledOnce();
      const statuses = callback.mock.calls[0][0] as readonly MachineStatus[];
      expect(statuses).toHaveLength(2);
    });

    it('should provide updated statuses to callback', async () => {
      const callback = vi.fn();
      manager.setStatusChangeCallback(callback);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
          'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        },
        {
          '192.168.1.11': 'ECONNREFUSED',
        },
      );

      await manager.pollAllSessions();
      warnSpy.mockRestore();

      const statuses = callback.mock.calls[0][0] as readonly MachineStatus[];
      const studio = statuses.find(s => s.machineId === 'mac-studio');
      const mini = statuses.find(s => s.machineId === 'mac-mini');
      expect(studio?.connected).toBe(true);
      // With projectsCache fallback, pollMachine succeeds → connected remains true
      expect(mini?.connected).toBe(true);
  });


  describe('pollAllQueries()', () => {
    it('should aggregate queries from multiple machines with machineId tagging', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'q1', timestamp: 1000, query: 'Hello' },
          ],
        }),
        'http://192.168.1.11:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'q2', timestamp: 2000, query: 'World' },
          ],
        }),
      });

      const queries = await manager.pollAllQueries();

      expect(queries).toHaveLength(2);
      expect(queries.find(q => q.sessionId === 'q1')?.machineId).toBe('mac-studio');
      expect(queries.find(q => q.sessionId === 'q2')?.machineId).toBe('mac-mini');
    });

    it('should sort queries by timestamp descending', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'q1', timestamp: 1000 }],
        }),
        'http://192.168.1.11:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'q2', timestamp: 3000 }, { sessionId: 'q3', timestamp: 2000 }],
        }),
      });

      const queries = await manager.pollAllQueries();

      expect(queries[0].sessionId).toBe('q2');
      expect(queries[1].sessionId).toBe('q3');
      expect(queries[2].sessionId).toBe('q1');
    });

    it('should handle empty response from one machine', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/api/queries': JSON.stringify({ queries: [] }),
        'http://192.168.1.11:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'q1', timestamp: 1000 }],
        }),
      });

      const queries = await manager.pollAllQueries();
      expect(queries).toHaveLength(1);
      expect(queries[0].machineId).toBe('mac-mini');
    });
  });

  describe('pollSessionDetails()', () => {
    it('should aggregate session details from multiple machines', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/session/details': JSON.stringify({
          'sess-1': { status: 'busy', lastPrompt: 'Hello', lastPromptTime: 1000, currentTool: 'bash', directory: '/proj1', updatedAt: 1000 },
        }),
        'http://192.168.1.11:3100/proxy/session/details': JSON.stringify({
          'sess-2': { status: 'idle', lastPrompt: null, lastPromptTime: 0, currentTool: null, directory: '/proj2', updatedAt: 2000 },
        }),
      });

      const result = await manager.pollSessionDetails();

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['sess-1']).toMatchObject({
        status: 'busy',
        lastPrompt: 'Hello',
        directory: '/proj1',
        machineId: 'mac-studio',
      });
      expect(result['sess-2']).toMatchObject({
        status: 'idle',
        lastPrompt: null,
        directory: '/proj2',
        machineId: 'mac-mini',
      });
    });

    it('should handle one machine failing silently', async () => {
      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/session/details': JSON.stringify({
            'sess-1': { status: 'busy', lastPrompt: 'Test', lastPromptTime: 500, currentTool: null, directory: '/proj1', updatedAt: 500 },
          }),
        },
        {
          '192.168.1.11': 'ECONNREFUSED',
        },
      );

      const result = await manager.pollSessionDetails();

      expect(Object.keys(result)).toHaveLength(1);
      expect(result['sess-1']).toMatchObject({
        status: 'busy',
        machineId: 'mac-studio',
      });
      expect(result['sess-2']).toBeUndefined();
    });

    it('should return empty object when all machines fail', async () => {
      setupUrlRouter({}, {
        '192.168.1.10': 'timeout',
        '192.168.1.11': 'timeout',
      });

      const result = await manager.pollSessionDetails();

      expect(result).toEqual({});
    });

    it('should parse new wrapper format with meta and inject sseConnected', async () => {
      const wrappedResponse = {
        meta: { sseConnected: true, lastSseEventAt: 1700000000000, sseConnectedAt: 1700000000000 },
        sessions: {
          'sess-1': { status: 'busy', lastPrompt: 'Hello', lastPromptTime: 1000, currentTool: 'bash', directory: '/proj1', updatedAt: 1000 },
          'sess-2': { status: 'idle', lastPrompt: null, lastPromptTime: 0, currentTool: null, directory: '/proj2', updatedAt: 2000 },
        },
      };
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/session/details': JSON.stringify(wrappedResponse),
        'http://192.168.1.11:3100/proxy/session/details': JSON.stringify({
          meta: { sseConnected: false, lastSseEventAt: 0, sseConnectedAt: 0 },
          sessions: {
            'sess-3': { status: 'idle', lastPrompt: null, lastPromptTime: 0, currentTool: null, directory: '/proj3', updatedAt: 3000 },
          },
        }),
      });

      const result = await manager.pollSessionDetails();

      expect(result['sess-1']?.sseConnected).toBe(true);
      expect(result['sess-2']?.sseConnected).toBe(true);
      expect(result['sess-3']?.sseConnected).toBe(false);
    });

    it('should handle old flat format without meta (backward compat)', async () => {
      // Old format: flat Record<string, SessionDetail> without meta wrapper
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/session/details': JSON.stringify({
          'sess-1': { status: 'busy', lastPrompt: 'Hello', lastPromptTime: 1000, currentTool: null, directory: '/proj1', updatedAt: 1000 },
        }),
        'http://192.168.1.11:3100/proxy/session/details': JSON.stringify({
          'sess-2': { status: 'idle', lastPrompt: null, lastPromptTime: 0, currentTool: null, directory: '/proj2', updatedAt: 2000 },
        }),
      });

      const result = await manager.pollSessionDetails();

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['sess-1']).toMatchObject({ status: 'busy', lastPrompt: 'Hello' });
      expect(result['sess-2']).toMatchObject({ status: 'idle', lastPrompt: null });
      // No sseConnected field in old format
      expect(result['sess-1']?.sseConnected).toBeUndefined();
    });
  });

  describe('grace period (consecutiveFailures)', () => {
    it('should keep previously-connected machine connected during grace period', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({}),
      });
      await manager.pollAllSessions();

      let statuses = manager.getMachineStatuses();
      expect(statuses.find(s => s.machineId === 'mac-mini')?.connected).toBe(true);

      // With projectsCache fallback, /proxy/projects failure is caught gracefully
      // pollMachine succeeds with empty results → machine stays connected
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
          'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        },
        { '192.168.1.11': 'ECONNREFUSED' },
      );
      await manager.pollAllSessions();

      statuses = manager.getMachineStatuses();
      const miniAfter1 = statuses.find(s => s.machineId === 'mac-mini');
      // Machine stays connected because pollMachine catches the error gracefully
      expect(miniAfter1?.connected).toBe(true);

      // Warn log should mention the failure
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.find(c => String(c[0]).includes('Mac Mini'));
      expect(warnMsg).toBeDefined();
      warnSpy.mockRestore();
    });

    it('should reset failure counter on successful poll', async () => {
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({}),
      });
      await manager.pollAllSessions();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Fail twice (under threshold)
      for (let i = 0; i < 2; i++) {
        setupUrlRouter(
          {
            'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
            'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
          },
          { '192.168.1.11': 'ECONNREFUSED' },
        );
        await manager.pollAllSessions();
      }

      // Succeed → counter resets
      setupUrlRouter({
        'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        'http://192.168.1.11:3100/proxy/projects': JSON.stringify([]),
        'http://192.168.1.11:3100/proxy/session/status': JSON.stringify({}),
      });
      await manager.pollAllSessions();

      let statuses = manager.getMachineStatuses();
      expect(statuses.find(s => s.machineId === 'mac-mini')?.connected).toBe(true);

      // Fail twice again — should still be in grace (counter was reset)
      for (let i = 0; i < 2; i++) {
        setupUrlRouter(
          {
            'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
            'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
          },
          { '192.168.1.11': 'ECONNREFUSED' },
        );
        await manager.pollAllSessions();
      }

      statuses = manager.getMachineStatuses();
      expect(statuses.find(s => s.machineId === 'mac-mini')?.connected).toBe(true);
      warnSpy.mockRestore();
    });

    it('should log warnings on /proxy/projects failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
          'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        },
        { '192.168.1.11': 'ECONNREFUSED' },
      );
      await manager.pollAllSessions();

      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.find(c => String(c[0]).includes('Mac Mini'));
      expect(warnMsg).toBeDefined();
      // Should contain the 'no cache' or 'using cached' message from projectsCache fallback
      expect(String(warnMsg![0])).toContain('/proxy/projects failed');

      warnSpy.mockRestore();
    });

    it('should keep never-connected machine connected on /proxy/projects failure (graceful degradation)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupUrlRouter(
        {
          'http://192.168.1.10:3100/proxy/projects': JSON.stringify([]),
          'http://192.168.1.10:3100/proxy/session/status': JSON.stringify({}),
        },
        { '192.168.1.11': 'ECONNREFUSED' },
      );
      await manager.pollAllSessions();
      warnSpy.mockRestore();

      const statuses = manager.getMachineStatuses();
      const mini = statuses.find(s => s.machineId === 'mac-mini');
      // With projectsCache fallback, pollMachine succeeds → connected becomes true
      expect(mini?.connected).toBe(true);
    });
  });
});
});

describe('MachineManager — projectsCache fallback (Task 2)', () => {
  let manager: MachineManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Single machine for focused tests
    manager = new MachineManager([
      { id: 'mac-studio', alias: 'Mac Studio', host: '192.168.1.10', port: 3100, apiKey: 'key-studio', source: 'opencode' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test Q: Successful /proxy/projects updates cache ──
  it('Test Q: Successful /proxy/projects populates projectsCache', async () => {
    setupUrlRouter({
      '/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
      '/proxy/session/status': JSON.stringify({}),
      '/proxy/session?directory': JSON.stringify([]),
    });

    await manager.pollAllSessions();

    // Verify cache is populated by checking that a second call with /proxy/projects failing uses cached data
    setupUrlRouter(
      { '/proxy/session/status': JSON.stringify({}), '/proxy/session?directory': JSON.stringify([]) },
      { '/proxy/projects': 'HTTP 502: Bad Gateway' },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await manager.pollAllSessions();

    // Should still succeed using cached projects (not empty)
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('using cached'))).toBe(true);
    warnSpy.mockRestore();
  });

  // ── Test R: /proxy/projects failure with cache uses cached projects ──
  it('Test R: /proxy/projects failure falls back to cached projects', async () => {
    // First: populate cache
    setupUrlRouter({
      '/proxy/projects': JSON.stringify([{ id: 'proj1', worktree: '/path/to/proj1' }]),
      '/proxy/session/status': JSON.stringify({ 'sess-1': { type: 'busy' } }),
      '/proxy/session?directory': JSON.stringify([{ id: 'sess-1', title: 'Work' }]),
    });

    const result1 = await manager.pollAllSessions();
    expect(result1.sessions).toHaveLength(1);

    // Second: /proxy/projects fails, but cache should be used
    setupUrlRouter(
      {
        '/proxy/session/status': JSON.stringify({ 'sess-1': { type: 'busy' } }),
        '/proxy/session?directory': JSON.stringify([{ id: 'sess-1', title: 'Work' }]),
      },
      { '/proxy/projects': 'HTTP 502: Bad Gateway' },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result2 = await manager.pollAllSessions();

    // Should still return sessions using cached projects
    expect(result2.sessions).toHaveLength(1);
    expect(result2.sessions[0].id).toBe('sess-1');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('using cached 1 projects'))).toBe(true);
    warnSpy.mockRestore();
  });

  // ── Test S: /proxy/projects failure with no cache returns empty gracefully ──
  it('Test S: /proxy/projects failure with no cache skips OpenCode poll gracefully', async () => {
    // No prior successful poll — no cache
    setupUrlRouter(
      {},
      { '/proxy/projects': 'HTTP 502: Bad Gateway' },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await manager.pollAllSessions();

    // Should return empty sessions (graceful skip, no crash)
    expect(result.sessions).toHaveLength(0);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('no cache'))).toBe(true);
    warnSpy.mockRestore();
  });
});
