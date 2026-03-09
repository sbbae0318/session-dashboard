import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

// ── Test helpers ──

const machines: readonly MachineConfig[] = [
  { id: 'machine-a', alias: 'Machine A', host: '10.0.0.1', port: 3100, apiKey: 'key-a', source: 'opencode' },
  { id: 'machine-b', alias: 'Machine B', host: '10.0.0.2', port: 3100, apiKey: 'key-b', source: 'opencode' },
];

/**
 * URL-based routing mock for deterministic parallel call handling.
 * Routes map URL substring patterns to response bodies.
 * Errors map URL substring patterns to error messages.
 */
function setupUrlRouter(routes: Record<string, string>, errors?: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      // Check if this URL should error
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

      // Find matching route
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

      // No match — error
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

describe('Multi-machine data aggregation', () => {
  let manager: MachineManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    manager = new MachineManager(machines);
  });

  afterEach(() => {
    vi.useRealTimers();
  });


  describe('Queries aggregation (pollAllQueries)', () => {
    it('should merge queries from 2 machines and sort by timestamp desc', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'qa-1', timestamp: 2000, query: 'Query A1' },
          ],
        }),
        'http://10.0.0.2:3100/api/queries': JSON.stringify({
          queries: [
            { sessionId: 'qb-1', timestamp: 4000, query: 'Query B1' },
            { sessionId: 'qb-2', timestamp: 1000, query: 'Query B2' },
          ],
        }),
      });

      const queries = await manager.pollAllQueries();

      // Sorted desc: 4000, 2000, 1000
      expect(queries).toHaveLength(3);
      expect(queries[0].sessionId).toBe('qb-1');
      expect(queries[0].timestamp).toBe(4000);
      expect(queries[1].sessionId).toBe('qa-1');
      expect(queries[1].timestamp).toBe(2000);
      expect(queries[2].sessionId).toBe('qb-2');
      expect(queries[2].timestamp).toBe(1000);
    });

    it('should tag each query with machineId, machineAlias, machineHost', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'qa', timestamp: 1000, query: 'Hello' }],
        }),
        'http://10.0.0.2:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'qb', timestamp: 2000, query: 'World' }],
        }),
      });

      const queries = await manager.pollAllQueries();

      const queryA = queries.find(q => q.sessionId === 'qa');
      expect(queryA).toMatchObject({
        machineId: 'machine-a',
        machineAlias: 'Machine A',
        machineHost: '10.0.0.1',
      });

      const queryB = queries.find(q => q.sessionId === 'qb');
      expect(queryB).toMatchObject({
        machineId: 'machine-b',
        machineAlias: 'Machine B',
        machineHost: '10.0.0.2',
      });
    });

    it('should not break when one machine returns empty queries', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({ queries: [] }),
        'http://10.0.0.2:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'qb-1', timestamp: 1000 }],
        }),
      });

      const queries = await manager.pollAllQueries();
      expect(queries).toHaveLength(1);
      expect(queries[0].machineId).toBe('machine-b');
    });

    it('should silently skip failed machine and return queries from working one', async () => {
      setupUrlRouter(
        {
          'http://10.0.0.1:3100/api/queries': JSON.stringify({
            queries: [{ sessionId: 'qa-1', timestamp: 3000 }],
          }),
        },
        {
          '10.0.0.2': 'Timeout',
        },
      );

      const queries = await manager.pollAllQueries();

      expect(queries).toHaveLength(1);
      expect(queries[0].machineId).toBe('machine-a');
    });

    it('should return empty array when all machines fail', async () => {
      setupUrlRouter({}, {
        '10.0.0.1': 'ECONNREFUSED',
        '10.0.0.2': 'ECONNREFUSED',
      });

      const queries = await manager.pollAllQueries();
      expect(queries).toEqual([]);
    });
  });

  describe('Sessions aggregation (pollAllSessions)', () => {
    it('should merge sessions from multiple machines', async () => {
      setupUrlRouter({
        // Machine A
        'http://10.0.0.1:3100/proxy/projects': JSON.stringify([{ id: 'proj-a', worktree: '/path/to/projA' }]),
        'http://10.0.0.1:3100/proxy/session/status': JSON.stringify({ 'sess-a1': { type: 'active' } }),
        'http://10.0.0.1:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-a1', sessionId: 'sess-a1', title: 'Work A' }]),
        // Machine B
        'http://10.0.0.2:3100/proxy/projects': JSON.stringify([{ id: 'proj-b', worktree: '/path/to/projB' }]),
        'http://10.0.0.2:3100/proxy/session/status': JSON.stringify({ 'sess-b1': { type: 'idle' } }),
        'http://10.0.0.2:3100/proxy/session?directory': JSON.stringify([{ id: 'sess-b1', sessionId: 'sess-b1', title: 'Work B' }]),
      });

      const result = await manager.pollAllSessions();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        sessionId: 'sess-a1',
        machineId: 'machine-a',
        machineAlias: 'Machine A',
        machineHost: '10.0.0.1',
      });
      expect(result.sessions[1]).toMatchObject({
        sessionId: 'sess-b1',
        machineId: 'machine-b',
        machineAlias: 'Machine B',
        machineHost: '10.0.0.2',
      });
    });

    it('should aggregate statuses with machineId from all machines', async () => {
      setupUrlRouter({
        // Machine A
        'http://10.0.0.1:3100/proxy/projects': JSON.stringify([{ id: 'proj-a', worktree: '/path/to/projA' }]),
        'http://10.0.0.1:3100/proxy/session/status': JSON.stringify({ 's1': { type: 'active' } }),
        'http://10.0.0.1:3100/proxy/session?directory': JSON.stringify([]),
        // Machine B
        'http://10.0.0.2:3100/proxy/projects': JSON.stringify([{ id: 'proj-b', worktree: '/path/to/projB' }]),
        'http://10.0.0.2:3100/proxy/session/status': JSON.stringify({ 's2': { type: 'idle' } }),
        'http://10.0.0.2:3100/proxy/session?directory': JSON.stringify([]),
      });

      const result = await manager.pollAllSessions();

      expect(result.statuses).toEqual({
        s1: { type: 'active', machineId: 'machine-a' },
        s2: { type: 'idle', machineId: 'machine-b' },
      });
    });
  });
});
