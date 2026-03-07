import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { DashboardClient } from '../src/api/client.js';
import type { DashboardSession, QueryEntry, MachineInfo } from '../src/types.js';

function mockSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    sessionId: 'ses_test',
    parentSessionId: null,
    childSessionIds: [],
    title: 'Test Session',
    projectCwd: '/Users/test/project/my-app',
    status: 'active',
    startTime: Date.now() - 60000,
    lastActivityTime: Date.now(),
    currentTool: null,
    duration: null,
    summary: null,
    apiStatus: 'idle',
    lastPrompt: null,
    machineId: 'm1',
    machineHost: 'localhost',
    machineAlias: 'local',
    ...overrides,
  };
}

describe('DashboardClient', () => {
  let client: DashboardClient;

  beforeEach(() => {
    client = new DashboardClient('http://localhost:3097');
  });

  describe('fetchSessions()', () => {
    test('returns sessions array on success', async () => {
      const sessions = [mockSession({ sessionId: 'ses_001' }), mockSession({ sessionId: 'ses_002' })];
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ sessions }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const result = await client.fetchSessions();
      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe('ses_001');
      expect(result[1].sessionId).toBe('ses_002');
    });

    test('returns [] when fetch throws network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await client.fetchSessions();
      expect(result).toEqual([]);
    });

    test('returns [] when response is not ok (500)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
        )
      );

      const result = await client.fetchSessions();
      expect(result).toEqual([]);
    });

    test('returns [] when response is 404', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('Not Found', { status: 404, statusText: 'Not Found' })
        )
      );

      const result = await client.fetchSessions();
      expect(result).toEqual([]);
    });
  });

  describe('fetchQueries()', () => {
    test('returns queries array with default limit', async () => {
      const queries: QueryEntry[] = [
        {
          sessionId: 'ses_001',
          sessionTitle: 'Test',
          timestamp: Date.now(),
          query: 'hello world',
          isBackground: false,
          machineId: 'm1',
          machineHost: 'localhost',
          machineAlias: 'local',
        },
      ];
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ queries }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const result = await client.fetchQueries();
      expect(result).toHaveLength(1);
      expect(result[0].query).toBe('hello world');
    });

    test('passes limit parameter in URL', async () => {
      let capturedUrl = '';
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(JSON.stringify({ queries: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });

      await client.fetchQueries(10);
      expect(capturedUrl).toContain('limit=10');
    });

    test('returns [] on error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Connection refused')));

      const result = await client.fetchQueries(30);
      expect(result).toEqual([]);
    });
  });

  describe('fetchHealth()', () => {
    test('returns health info on success', async () => {
      const health = { status: 'ok', uptime: 12345, connectedMachines: 2, totalMachines: 3 };
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(health), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const result = await client.fetchHealth();
      expect(result).not.toBeNull();
      expect(result?.status).toBe('ok');
      expect(result?.connectedMachines).toBe(2);
    });

    test('returns null on error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Timeout')));

      const result = await client.fetchHealth();
      expect(result).toBeNull();
    });

    test('returns null when response is not ok', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }))
      );

      const result = await client.fetchHealth();
      expect(result).toBeNull();
    });
  });

  describe('fetchMachines()', () => {
    test('returns machines array on success', async () => {
      const machines: MachineInfo[] = [
        { id: 'm1', alias: 'local', host: 'localhost', status: 'connected', lastSeen: Date.now(), error: null },
      ];
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ machines }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const result = await client.fetchMachines();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m1');
    });

    test('returns [] on error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await client.fetchMachines();
      expect(result).toEqual([]);
    });
  });
});
