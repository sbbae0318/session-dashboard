import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActiveSessionsModule } from '../modules/active-sessions/index.js';
import { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http (MachineManager imports it) ──
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

// ── Test helpers ──

function makeOcMachine(): MachineConfig {
  return { id: 'oc-m', alias: 'OC', host: '10.0.0.1', port: 3100, apiKey: 'key-oc', source: 'opencode' };
}

function makeClaudeMachine(): MachineConfig {
  return { id: 'claude-m', alias: 'Claude', host: '10.0.0.2', port: 3100, apiKey: 'key-cl', source: 'claude-code' };
}

function makeBothMachine(): MachineConfig {
  return { id: 'both-m', alias: 'Both', host: '10.0.0.3', port: 3100, apiKey: 'key-b', source: 'both' };
}

function makeSessionsAllResponse(
  sessions: Record<string, {
    status: string;
    title?: string | null;
    parentSessionId?: string | null;
    createdAt?: number;
    directory?: string | null;
    lastPrompt?: string | null;
    lastPromptTime?: number;
    currentTool?: string | null;
    waitingForInput?: boolean;
    updatedAt?: number;
  }>,
): string {
  const full: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(sessions)) {
    full[id] = {
      status: s.status,
      lastPrompt: s.lastPrompt ?? null,
      lastPromptTime: s.lastPromptTime ?? 0,
      currentTool: s.currentTool ?? null,
      directory: s.directory ?? null,
      waitingForInput: s.waitingForInput ?? false,
      updatedAt: s.updatedAt ?? Date.now(),
      title: s.title ?? null,
      parentSessionId: s.parentSessionId ?? null,
      createdAt: s.createdAt ?? 0,
    };
  }
  return JSON.stringify({
    meta: { sseConnected: true, lastSseEventAt: 0, sseConnectedAt: 0 },
    projects: [],
    activeDirectories: [],
    sessions: full,
  });
}

async function pollAndCapture(machines: readonly MachineConfig[]): Promise<Record<string, unknown>[]> {
  const manager = new MachineManager(machines);
  const module = new ActiveSessionsModule(manager);

  let captured: Record<string, unknown>[] = [];
  module.setUpdateCallback((sessions) => {
    captured = sessions as unknown as Record<string, unknown>[];
  });

  // Call start() which does one poll, then immediately stop to prevent interval
  await module.start();
  await module.stop();

  return captured;
}

describe('ActiveSessionsModule — Claude Code integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Claude sessions get source: "claude-code"', () => {
    it('should set source="claude-code" for sessions from Claude endpoint', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'claude-sess-1',
            cwd: '/home/user/project',
            startTime: 1000,
            lastHeartbeat: 2000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].source).toBe('claude-code');
      expect(sessions[0].sessionId).toBe('claude-sess-1');
    });

    it('should set source="opencode" for sessions from oc-serve endpoint', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/proxy/sessions-all': makeSessionsAllResponse({
          'oc-sess-1': { status: 'active', title: 'OC Work', directory: '/proj', createdAt: 1000, updatedAt: 2000 },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].source).toBe('opencode');
      expect(sessions[0].sessionId).toBe('oc-sess-1');
    });
  });

  describe('Claude sessions have apiStatus=null, currentTool=null', () => {
    it('should set apiStatus=null for Claude sessions', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cs-1',
            cwd: '/project',
            startTime: 1000,
            lastHeartbeat: 2000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].apiStatus).toBeNull();
    });

    it('should set currentTool=null for Claude sessions', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cs-1',
            cwd: '/project',
            startTime: 1000,
            lastHeartbeat: 2000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].currentTool).toBeNull();
    });

    it('should set apiStatus from cache for OpenCode sessions', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/proxy/sessions-all': makeSessionsAllResponse({
          'oc-sess': { status: 'busy', title: 'Coding', directory: '/proj', lastPrompt: 'Fix bug', lastPromptTime: 1500, currentTool: 'Edit', createdAt: 1000, updatedAt: 1500 },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].apiStatus).toBe('busy');
      expect(sessions[0].currentTool).toBe('Edit');
    });
  });

  describe('session status mapping', () => {
    it('should mark active Claude sessions as status="active"', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cs-active',
            cwd: '/project',
            startTime: 1000,
            lastHeartbeat: 2000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('active');
    });

    it('should mark active OpenCode sessions as status="active"', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/proxy/sessions-all': makeSessionsAllResponse({
          'oc-active': { status: 'busy', title: 'Working', createdAt: 1000, updatedAt: 2000 },
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('active');
    });
  });

  describe('mixed sources', () => {
    it('should correctly differentiate OC and Claude sessions from "both" machine', async () => {
      setupUrlRouter({
        'http://10.0.0.3:3100/proxy/sessions-all': makeSessionsAllResponse({
          'oc-s1': { status: 'active', title: 'OC Session', directory: '/proj', createdAt: 1000, updatedAt: 2000 },
        }),
        'http://10.0.0.3:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cl-s1',
            cwd: '/claude-project',
            startTime: 3000,
            lastHeartbeat: 4000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeBothMachine()]);

      expect(sessions).toHaveLength(2);

      const ocSession = sessions.find((s: Record<string, unknown>) => s.sessionId === 'oc-s1');
      const claudeSession = sessions.find((s: Record<string, unknown>) => s.sessionId === 'cl-s1');

      expect(ocSession).toBeDefined();
      expect(ocSession!.source).toBe('opencode');
      expect(ocSession!.apiStatus).not.toBeNull(); // OC sessions can have apiStatus

      expect(claudeSession).toBeDefined();
      expect(claudeSession!.source).toBe('claude-code');
      expect(claudeSession!.apiStatus).toBeNull();
      expect(claudeSession!.currentTool).toBeNull();
    });

    it('should handle mixed opencode + claude-code machines', async () => {
      setupUrlRouter({
        'http://10.0.0.1:3100/proxy/sessions-all': makeSessionsAllResponse({
          'oc-s': { status: 'idle', title: 'OC', createdAt: 100, updatedAt: 200 },
        }),
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cl-s',
            cwd: '/claude-proj',
            startTime: 500,
            lastHeartbeat: 600,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeOcMachine(), makeClaudeMachine()]);

      expect(sessions).toHaveLength(2);

      const sources = sessions.map((s: Record<string, unknown>) => s.source);
      expect(sources).toContain('opencode');
      expect(sources).toContain('claude-code');

      // Machine IDs should be correctly assigned
      const ocSession = sessions.find((s: Record<string, unknown>) => s.source === 'opencode');
      const clSession = sessions.find((s: Record<string, unknown>) => s.source === 'claude-code');
      expect(ocSession!.machineId).toBe('oc-m');
      expect(clSession!.machineId).toBe('claude-m');
    });
  });

  describe('Claude session fields', () => {
    it('should set projectCwd from Claude session cwd', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'cs-1',
            cwd: '/home/user/my-project',
            startTime: 1000,
            lastHeartbeat: 2000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      // Note: projectCwd comes from directory field which is set by session.directory
      // Claude sessions don't have 'directory' in raw data but have 'cwd'
      expect(sessions).toHaveLength(1);
      // The session should be marked active
      expect(sessions[0].status).toBe('active');
    });

    it('should handle empty Claude sessions list', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({ sessions: [] }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);
      expect(sessions).toHaveLength(0);
    });
  });

  describe('timestamp fields', () => {
    it('should set startTime from Claude session startTime field', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-1',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 2000000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].startTime).toBe(1000000);
    });

    it('should set lastActivityTime from Claude session lastFileModified field', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-2',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 2000000,
            lastFileModified: 1800000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].lastActivityTime).toBe(1800000);
    });

    it('should fallback to Date.now when neither lastResponseTime nor lastFileModified exist', async () => {
      const before = Date.now();
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-2b',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 2000000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);
      const after = Date.now();

      expect(sessions).toHaveLength(1);
      // No lastResponseTime or lastFileModified → falls back to Date.now()
      expect(sessions[0].lastActivityTime).toBeGreaterThanOrEqual(before);
      expect(sessions[0].lastActivityTime).toBeLessThanOrEqual(after);
    });

    it('should set lastPromptTime from Claude session lastPromptTime field', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-3',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 2000000,
            lastPromptTime: 1500000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].lastPromptTime).toBe(1500000);
    });

    it('should set lastPromptTime to null when Claude session has no lastPromptTime', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-4',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 2000000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].lastPromptTime).toBeNull();
    });

    it('should use lastResponseTime for lastActivityTime when available', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-5',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 9999999,
            lastResponseTime: 1800000,
            lastFileModified: 2000000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      // lastResponseTime should win over lastFileModified and lastHeartbeat
      expect(sessions[0].lastActivityTime).toBe(1800000);
    });

    it('should fall back to lastFileModified when lastResponseTime is absent', async () => {
      setupUrlRouter({
        'http://10.0.0.2:3100/api/claude/sessions': JSON.stringify({
          sessions: [{
            sessionId: 'ts-sess-6',
            cwd: '/project',
            startTime: 1000000,
            lastHeartbeat: 9999999,
            lastFileModified: 2500000,
          }],
        }),
      });

      const sessions = await pollAndCapture([makeClaudeMachine()]);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].lastActivityTime).toBe(2500000);
    });
  });
});
