import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActiveSessionsModule } from '../modules/active-sessions/index.js';
import type { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock MachineManager ──
function createMockMachineManager(overrides?: {
  getMachines?: () => readonly MachineConfig[];
  pollAllSessions?: () => Promise<{
    sessions: Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }>;
    statuses: Record<string, { type: string; machineId: string }>;
  }>;
  pollSessionDetails?: () => Promise<Record<string, {
    status: 'busy' | 'idle' | 'retry';
    lastPrompt: string | null;
    lastPromptTime: number;
    currentTool: string | null;
    directory: string | null;
    updatedAt: number;
    machineId: string;
  }>>;
}): MachineManager {
  return {
    getMachines: overrides?.getMachines ?? vi.fn().mockReturnValue([]),
    pollAllSessions: overrides?.pollAllSessions ?? vi.fn().mockResolvedValue({ sessions: [], statuses: {} }),
    pollSessionDetails: overrides?.pollSessionDetails ?? vi.fn().mockResolvedValue({}),
    getMachineStatuses: vi.fn().mockReturnValue([]),
    setStatusChangeCallback: vi.fn(),
    pollAllQueries: vi.fn().mockResolvedValue([]),
  } as unknown as MachineManager;
}

describe('ActiveSessionsModule - buildSessionMap() orphan session synthesis', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) {
      await module.stop();
    }
    vi.clearAllMocks();
  });

  // ── Test A: SSE-only orphan sessions are synthesized but filtered from cachedSessions (title: null) ──
  it('Test A: SSE-only orphan sessions with null title are filtered from cachedSessions', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan': {
          status: 'busy',
          lastPrompt: 'hello',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;

    // Orphan sessions have title: null → filtered out from cachedSessions
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan');
    expect(orphan).toBeUndefined();
  });

  // ── Test B: Sessions in both REST and SSE are NOT duplicated ──
  it('Test B: Sessions in both REST and SSE are NOT duplicated', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_both',
            sessionId: 'ses_both',
            title: 'Both Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_both': { type: 'active', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_both': {
          status: 'busy',
          lastPrompt: 'hello',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const matchingSessions = sessions.filter((s: any) => s.sessionId === 'ses_both');

    // Should only appear once — no duplication
    expect(matchingSessions).toHaveLength(1);
  });

  // ── Test C: Synthesized orphan sessions with null title are filtered from cachedSessions ──
  it('Test C: Synthesized orphan sessions with null title are filtered from cachedSessions', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan': {
          status: 'busy',
          lastPrompt: 'hello',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;

    // Orphan session has title: null → must be filtered out
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan');
    expect(orphan).toBeUndefined();

    // cachedSessions should be empty (no titled sessions)
    expect(sessions).toHaveLength(0);
  });

  // ── Test D: Sessions with valid titles are included in cachedSessions ──
  it('Test D: Sessions with valid titles are included in cachedSessions', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_titled',
            sessionId: 'ses_titled',
            title: 'My Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_titled': { type: 'active', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('ses_titled');
    expect(sessions[0].title).toBe('My Session');
  });

  // ── Test E: Sessions with null title from REST results are filtered out ──
  it('Test E: Sessions with null title from REST results are filtered out', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_notitled',
            sessionId: 'ses_notitled',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_notitled': { type: 'active', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    expect(sessions).toHaveLength(0);
    expect(sessions.find((s: any) => s.sessionId === 'ses_notitled')).toBeUndefined();
  });

  // ── Test F: Mixed scenario — only titled sessions survive filtering ──
  it('Test F: Mixed scenario — only titled sessions survive filtering', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_titled',
            sessionId: 'ses_titled',
            title: 'Real Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test/project1',
            time: { created: 1000, updated: 3000 },
          },
          {
            id: 'ses_null_title',
            sessionId: 'ses_null_title',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test/project2',
            time: { created: 1000, updated: 2000 },
          },
          {
            id: 'ses_empty_title',
            sessionId: 'ses_empty_title',
            title: '',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test/project3',
            time: { created: 1000, updated: 1500 },
          },
        ],
        statuses: {
          'ses_titled': { type: 'active', machineId: 'mac-1' },
          'ses_null_title': { type: 'active', machineId: 'mac-1' },
          'ses_empty_title': { type: 'active', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        // SSE-only orphan session (inherently null title)
        'ses_sse_orphan': {
          status: 'busy',
          lastPrompt: 'orphan prompt',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test/orphan',
          updatedAt: 2500,
          machineId: 'mac-1',
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;

    // Only the titled session should survive filtering
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('ses_titled');
    expect(sessions[0].title).toBe('Real Session');

    // Null title, empty title, and orphan sessions must be filtered out
    expect(sessions.find((s: any) => s.sessionId === 'ses_null_title')).toBeUndefined();
    expect(sessions.find((s: any) => s.sessionId === 'ses_empty_title')).toBeUndefined();
    expect(sessions.find((s: any) => s.sessionId === 'ses_sse_orphan')).toBeUndefined();
  });
});
