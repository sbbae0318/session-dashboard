import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MachineManager, type MachineStatus } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

// ── Machine fixtures by source type ──

function makeOpenCodeMachine(): MachineConfig {
  return { id: 'oc-machine', alias: 'OC Machine', host: '10.0.0.1', port: 3100, apiKey: 'key-oc', source: 'opencode' };
}

function makeClaudeMachine(): MachineConfig {
  return { id: 'claude-machine', alias: 'Claude Machine', host: '10.0.0.2', port: 3100, apiKey: 'key-claude', source: 'claude-code' };
}

function makeBothMachine(): MachineConfig {
  return { id: 'both-machine', alias: 'Both Machine', host: '10.0.0.3', port: 3100, apiKey: 'key-both', source: 'both' };
}

// ── HTTP mock helpers (same pattern as machine-manager.test.ts) ──

function setupUrlRouter(routes: Record<string, string>, errors?: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      // Check errors first
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
      return {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error(`No mock for URL: ${url}`));
        }),
      };
    },
  );
}

describe('MachineManager — source-aware polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('MachineStatus source field', () => {
    it('should have source="opencode" for opencode machines', () => {
      const manager = new MachineManager([makeOpenCodeMachine()]);
      const statuses = manager.getMachineStatuses();

      expect(statuses).toHaveLength(1);
      expect(statuses[0].source).toBe('opencode');
    });

    it('should have source="claude-code" for claude-code machines', () => {
      const manager = new MachineManager([makeClaudeMachine()]);
      const statuses = manager.getMachineStatuses();

      expect(statuses).toHaveLength(1);
      expect(statuses[0].source).toBe('claude-code');
    });

    it('should have source="both" for both machines', () => {
      const manager = new MachineManager([makeBothMachine()]);
      const statuses = manager.getMachineStatuses();

      expect(statuses).toHaveLength(1);
      expect(statuses[0].source).toBe('both');
    });

    it('should preserve source after successful poll', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({ sessions: [] }),
      });

      await manager.pollAllSessions();

      const statuses = manager.getMachineStatuses();
      expect(statuses[0].source).toBe('claude-code');
      expect(statuses[0].connected).toBe(true);
    });

    it('should preserve source after failed poll', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      setupUrlRouter({}, { '10.0.0.2': 'ECONNREFUSED' });

      await manager.pollAllSessions();

      const statuses = manager.getMachineStatuses();
      expect(statuses[0].source).toBe('claude-code');
      expect(statuses[0].connected).toBe(false);
    });
  });

  describe('source="opencode" skips Claude endpoints', () => {
    it('should call oc-serve endpoints only, not Claude endpoints', async () => {
      const manager = new MachineManager([makeOpenCodeMachine()]);

      setupUrlRouter({
        'http://10.0.0.1:3100/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/proj1' }]),
        'http://10.0.0.1:3100/proxy/session/status': JSON.stringify({}),
        'http://10.0.0.1:3100/proxy/session?directory': JSON.stringify([]),
      });

      await manager.pollAllSessions();

      // Verify no calls to Claude endpoints
      const calledUrls = mockHttpGet.mock.calls.map(c => c[0] as string);
      expect(calledUrls.some(u => u.includes('/api/claude/'))).toBe(false);
      expect(calledUrls.some(u => u.includes('/proxy/projects'))).toBe(true);
    });

    it('pollAllCards should fetch from opencode machine', async () => {
      const manager = new MachineManager([makeOpenCodeMachine()]);

      setupUrlRouter({
        'http://10.0.0.1:3100/api/cards': JSON.stringify({
          cards: [{ sessionId: 'c1', startTime: 1000 }],
        }),
      });

      const cards = await manager.pollAllCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].machineId).toBe('oc-machine');
    });

    it('pollAllQueries should only call /api/queries (not /api/claude/queries)', async () => {
      const manager = new MachineManager([makeOpenCodeMachine()]);

      setupUrlRouter({
        'http://10.0.0.1:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'q1', timestamp: 1000, query: 'Hello' }],
        }),
      });

      const queries = await manager.pollAllQueries();

      expect(queries).toHaveLength(1);
      const calledUrls = mockHttpGet.mock.calls.map(c => c[0] as string);
      expect(calledUrls.some(u => u.includes('/api/claude/queries'))).toBe(false);
    });
  });

  describe('source="claude-code" skips oc-serve endpoints', () => {
    it('should call Claude endpoints only, not oc-serve endpoints', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{ sessionId: 'cs-1', cwd: '/project', startTime: 1000, lastHeartbeat: 2000 }],
        }),
      });

      await manager.pollAllSessions();

      const calledUrls = mockHttpGet.mock.calls.map(c => c[0] as string);
      expect(calledUrls.some(u => u.includes('/proxy/projects'))).toBe(false);
      expect(calledUrls.some(u => u.includes('/api/claude/sessions'))).toBe(true);
    });

    it('should add source="claude-code" to sessions from Claude endpoint', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{ sessionId: 'cs-1', cwd: '/project', startTime: 1000, lastHeartbeat: 2000 }],
        }),
      });

      const result = await manager.pollAllSessions();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].source).toBe('claude-code');
      expect(result.sessions[0].id).toBe('cs-1');
    });

    it('pollAllCards should skip claude-code machines (no cards endpoint)', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      const cards = await manager.pollAllCards();
      expect(cards).toEqual([]);
      // No HTTP calls should have been made
      expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it('pollAllQueries should call /api/claude/queries (not /api/queries)', async () => {
      const manager = new MachineManager([makeClaudeMachine()]);

      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/queries': JSON.stringify({
          queries: [{ sessionId: 'cq1', timestamp: 2000, query: 'Claude query', source: 'claude-code' }],
        }),
      });

      const queries = await manager.pollAllQueries();

      expect(queries).toHaveLength(1);
      const calledUrls = mockHttpGet.mock.calls.map(c => c[0] as string);
      expect(calledUrls.some(u => u.includes('/api/claude/queries'))).toBe(true);
      expect(calledUrls.every(u => !u.includes('/api/queries?'))).toBe(true);
    });
  });

  describe('source="both" merges both data sources', () => {
    it('should call both oc-serve and Claude endpoints', async () => {
      const manager = new MachineManager([makeBothMachine()]);

      setupUrlRouter({
        // oc-serve endpoints
        'http://10.0.0.3:3100/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/proj1' }]),
        'http://10.0.0.3:3100/proxy/session/status': JSON.stringify({ 'oc-sess': { type: 'active' } }),
        'http://10.0.0.3:3100/proxy/session?directory': JSON.stringify([{ id: 'oc-sess', title: 'OC Work' }]),
        // Claude endpoints
        'http://10.0.0.3:3100/api/claude/sessions': JSON.stringify({
          sessions: [{ sessionId: 'claude-sess', cwd: '/project', startTime: 1000, lastHeartbeat: 2000 }],
        }),
      });

      const result = await manager.pollAllSessions();

      // Both types of sessions should be present
      expect(result.sessions).toHaveLength(2);
      const ocSession = result.sessions.find(s => s.id === 'oc-sess');
      const claudeSession = result.sessions.find(s => s.id === 'claude-sess');
      expect(ocSession).toBeDefined();
      expect(claudeSession).toBeDefined();
      expect(claudeSession?.source).toBe('claude-code');
    });

    it('pollAllQueries should call both /api/queries and /api/claude/queries', async () => {
      const manager = new MachineManager([makeBothMachine()]);

      setupUrlRouter({
        'http://10.0.0.3:3100/api/queries': JSON.stringify({
          queries: [{ sessionId: 'oq1', timestamp: 1000, query: 'OC query' }],
        }),
        'http://10.0.0.3:3100/api/claude/queries': JSON.stringify({
          queries: [{ sessionId: 'cq1', timestamp: 2000, query: 'Claude query', source: 'claude-code' }],
        }),
      });

      const queries = await manager.pollAllQueries();

      expect(queries).toHaveLength(2);
      // Should be sorted by timestamp descending
      expect(queries[0].sessionId).toBe('cq1'); // timestamp 2000
      expect(queries[1].sessionId).toBe('oq1'); // timestamp 1000
    });

    it('pollAllCards should only fetch from oc-serve (not claude)', async () => {
      const manager = new MachineManager([makeBothMachine()]);

      setupUrlRouter({
        'http://10.0.0.3:3100/api/cards': JSON.stringify({
          cards: [{ sessionId: 'card1', startTime: 1000 }],
        }),
      });

      const cards = await manager.pollAllCards();

      expect(cards).toHaveLength(1);
      const calledUrls = mockHttpGet.mock.calls.map(c => c[0] as string);
      expect(calledUrls.some(u => u.includes('/api/cards'))).toBe(true);
      expect(calledUrls.some(u => u.includes('/api/claude/cards'))).toBe(false);
    });

    it('pollSessionDetails should merge opencode + claude session details', async () => {
      const manager = new MachineManager([makeBothMachine()]);

      setupUrlRouter({
        // oc-serve session details
        'http://10.0.0.3:3100/proxy/session/details': JSON.stringify({
          'oc-sess': { status: 'busy', lastPrompt: 'OC prompt', lastPromptTime: 1000, currentTool: 'bash', directory: '/proj1', updatedAt: 1000 },
        }),
        // Claude sessions (synthesized into details)
        'http://10.0.0.3:3100/api/claude/sessions': JSON.stringify({
          sessions: [{ sessionId: 'claude-sess', cwd: '/project', startTime: 2000, lastHeartbeat: 3000 }],
        }),
      });

      const details = await manager.pollSessionDetails();

      expect(Object.keys(details)).toHaveLength(2);
      expect(details['oc-sess']).toMatchObject({ status: 'busy', lastPrompt: 'OC prompt' });
      expect(details['claude-sess']).toMatchObject({
        status: 'busy',
        lastPrompt: null,
        currentTool: null,
        directory: '/project',
      });
    });

    it('should still return OpenCode sessions when Claude endpoint fails', async () => {
      const manager = new MachineManager([makeBothMachine()]);

      setupUrlRouter(
        {
          // oc-serve endpoints succeed
          'http://10.0.0.3:3100/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/proj1' }]),
          'http://10.0.0.3:3100/proxy/session/status': JSON.stringify({ 'oc-sess': { type: 'active' } }),
          'http://10.0.0.3:3100/proxy/session?directory': JSON.stringify([{ id: 'oc-sess', title: 'OC Work' }]),
        },
        {
          // Claude endpoint fails (simulates 404 or connection refused)
          '/api/claude/sessions': 'HTTP 404: Not Found',
        },
      );

      const result = await manager.pollAllSessions();

      // OpenCode sessions should still be present
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe('oc-sess');
      expect(result.sessions[0].title).toBe('OC Work');

      // Machine should still be connected (not marked disconnected)
      const statuses = manager.getMachineStatuses();
      const bothMachine = statuses.find(s => s.machineId === 'both-machine');
      expect(bothMachine?.connected).toBe(true);
    });
  });

  describe('mixed machines (different sources)', () => {
    it('should handle opencode + claude-code machines independently', async () => {
      const manager = new MachineManager([makeOpenCodeMachine(), makeClaudeMachine()]);

      setupUrlRouter({
        // OC machine
        'http://10.0.0.1:3100/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/proj1' }]),
        'http://10.0.0.1:3100/proxy/session/status': JSON.stringify({ 'oc-s1': { type: 'active' } }),
        'http://10.0.0.1:3100/proxy/session?directory': JSON.stringify([{ id: 'oc-s1', title: 'OC Session' }]),
        // Claude machine
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{ sessionId: 'cl-s1', cwd: '/project', startTime: 1000, lastHeartbeat: 2000 }],
        }),
      });

      const result = await manager.pollAllSessions();

      expect(result.sessions).toHaveLength(2);

      const ocSession = result.sessions.find(s => s.machineId === 'oc-machine');
      const claudeSession = result.sessions.find(s => s.machineId === 'claude-machine');
      expect(ocSession).toBeDefined();
      expect(claudeSession).toBeDefined();
      expect(claudeSession?.source).toBe('claude-code');

      // Statuses
      const statuses = manager.getMachineStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.find(s => s.machineId === 'oc-machine')?.source).toBe('opencode');
      expect(statuses.find(s => s.machineId === 'claude-machine')?.source).toBe('claude-code');
    });
  });
});
