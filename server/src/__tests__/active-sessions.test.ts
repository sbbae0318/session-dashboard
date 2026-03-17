import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActiveSessionsModule } from '../modules/active-sessions/index.js';
import type { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock MachineManager ──
function createMockMachineManager(overrides?: {
  getMachines?: () => readonly MachineConfig[];
  getMachineStatuses?: () => readonly { machineId: string; connected: boolean; machineAlias: string; machineHost: string; lastSeen: number | null; error: string | null; source: string }[];
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
    waitingForInput?: boolean;
    machineId: string;
  }>>;
}): MachineManager {
  const pollAllSessionsFn = overrides?.pollAllSessions ?? vi.fn().mockResolvedValue({ sessions: [], statuses: {} });
  const pollSessionDetailsFn = overrides?.pollSessionDetails ?? vi.fn().mockResolvedValue({});

  return {
    getMachines: overrides?.getMachines ?? vi.fn().mockReturnValue([]),
    pollAllSessions: pollAllSessionsFn,
    pollSessionDetails: pollSessionDetailsFn,
    pollAll: vi.fn().mockImplementation(async () => {
      const sessionResult = await pollAllSessionsFn();
      const detailsResult = await pollSessionDetailsFn();
      return {
        sessions: sessionResult.sessions,
        statuses: sessionResult.statuses,
        cachedDetails: detailsResult,
      };
    }),
    getMachineStatuses: overrides?.getMachineStatuses ?? vi.fn().mockReturnValue([]),
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

  // ── Test A: SSE-only orphan sessions with apiStatus survive filter (apiStatus !== null) ──
  it('Test A: SSE-only orphan sessions with apiStatus survive ghost filter', async () => {
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

    // Orphan sessions have title: null but apiStatus: 'busy' → survive filter
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan');
    expect(orphan).toBeDefined();
    expect(orphan.apiStatus).toBe('busy');
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

  // ── Test C: Synthesized orphan sessions with apiStatus survive filter ──
  it('Test C: Synthesized orphan sessions with apiStatus survive ghost filter', async () => {
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

    // Orphan session has title: null but apiStatus: 'busy' → survives filter
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan');
    expect(orphan).toBeDefined();
    expect(orphan.apiStatus).toBe('busy');

    // cachedSessions should have 1 session (the orphan with apiStatus)
    expect(sessions).toHaveLength(1);
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

  // ── Test E: Sessions with null title but apiStatus survive filter; those without apiStatus are filtered ──
  it('Test E: Sessions with null title and no apiStatus are filtered out', async () => {
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
        statuses: {},  // No status → apiStatus will be null
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    expect(sessions).toHaveLength(0);
    expect(sessions.find((s: any) => s.sessionId === 'ses_notitled')).toBeUndefined();
  });

  // ── Test F: Mixed scenario — sessions with title OR apiStatus survive, others filtered ──
  it('Test F: Mixed scenario — sessions with title or apiStatus survive filtering', async () => {
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
            id: 'ses_null_title_active',
            sessionId: 'ses_null_title_active',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test/project2',
            time: { created: 1000, updated: 2000 },
          },
          {
            id: 'ses_null_title_no_status',
            sessionId: 'ses_null_title_no_status',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test/project3',
            time: { created: 1000, updated: 1500 },
          },
        ],
        statuses: {
          'ses_titled': { type: 'active', machineId: 'mac-1' },
          'ses_null_title_active': { type: 'busy', machineId: 'mac-1' },
          // ses_null_title_no_status has no status entry
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;

    // Titled session survives (title !== null)
    expect(sessions.find((s: any) => s.sessionId === 'ses_titled')).toBeDefined();

    // Null title + apiStatus 'busy' survives (apiStatus !== null)
    expect(sessions.find((s: any) => s.sessionId === 'ses_null_title_active')).toBeDefined();

    // Null title + no apiStatus → filtered out
    expect(sessions.find((s: any) => s.sessionId === 'ses_null_title_no_status')).toBeUndefined();

    expect(sessions).toHaveLength(2);
  });
});

describe('ActiveSessionsModule — sseConnected staleness handling', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) {
      await module.stop();
    }
    vi.clearAllMocks();
  });

  // ── Test G: sseConnected=false falls back to REST status ──
  it('Test G: sseConnected=false falls back to REST status for apiStatus', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_stale',
            sessionId: 'ses_stale',
            title: 'Stale Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_stale': { type: 'idle', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_stale': {
          status: 'busy',
          lastPrompt: 'stale prompt',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          sseConnected: false,  // SSE disconnected — cache is stale
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_stale');

    expect(session).toBeDefined();
    // Should use REST status ('idle'), NOT stale cache ('busy')
    expect(session.apiStatus).toBe('idle');
  });

  // ── Test H: sseConnected=false skips orphan synthesis ──
  it('Test H: sseConnected=false skips orphan session synthesis', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_ghost': {
          status: 'busy',
          lastPrompt: 'ghost prompt',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          sseConnected: false,  // SSE disconnected — should NOT synthesize orphan
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;

    // Ghost session should NOT be synthesized because sseConnected=false
    expect(sessions.find((s: any) => s.sessionId === 'ses_ghost')).toBeUndefined();
    expect(sessions).toHaveLength(0);
  });

  // ── Test I: sseConnected=true preserves existing cache-trusting behavior ──
  it('Test I: sseConnected=true uses cache status (existing behavior preserved)', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_live',
            sessionId: 'ses_live',
            title: 'Live Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_live': { type: 'idle', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_live': {
          status: 'busy',
          lastPrompt: 'live prompt',
          lastPromptTime: 1000,
          currentTool: 'Edit',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          sseConnected: true,  // SSE connected — trust cache
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_live');

    expect(session).toBeDefined();
    // Should use cache status ('busy'), NOT REST ('idle')
    expect(session.apiStatus).toBe('busy');
    expect(session.currentTool).toBe('Edit');
  });

  // ── Test J: sseConnected=undefined (backward compat) trusts cache ──
  it('Test J: sseConnected=undefined (backward compat) trusts cache status', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_compat',
            sessionId: 'ses_compat',
            title: 'Compat Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_compat': { type: 'idle', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_compat': {
          status: 'retry',
          lastPrompt: 'compat prompt',
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          // sseConnected NOT set — old agent without Wave 2 changes
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_compat');

    expect(session).toBeDefined();
    // sseConnected is undefined → !== false → trust cache (backward compat)
    expect(session.apiStatus).toBe('retry');
  });
});

describe('ActiveSessionsModule — orphan source field (Task 1)', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  // ── Test K: Orphan sessions synthesized from SSE cache have source: 'opencode' ──
  it('Test K: Orphan sessions have source field set to opencode', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({ sessions: [], statuses: {} }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan_src': {
          status: 'busy',
          lastPrompt: 'test prompt',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    // Access internal buildSessionMap to check orphan before filtering
    const sessionMap = (module as any).buildSessionMap(
      [],
      {},
      {
        'ses_orphan_src': {
          status: 'busy',
          lastPrompt: 'test prompt',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
        },
      },
    );

    const orphan = sessionMap.get('ses_orphan_src');
    expect(orphan).toBeDefined();
    expect(orphan.source).toBe('opencode');
  });

  // ── Test L: Orphan with source:'opencode' + apiStatus survives ghost filter ──
  it('Test L: Orphan with apiStatus survives ghost filter even without title', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({ sessions: [], statuses: {} }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan_active': {
          status: 'busy',
          lastPrompt: 'working',
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
    // Orphan has title:null but apiStatus:'busy' — should survive the new filter
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan_active');
    expect(orphan).toBeDefined();
    expect(orphan.source).toBe('opencode');
    expect(orphan.apiStatus).toBe('busy');
    expect(orphan.title).toBeNull();
  });
});

describe('ActiveSessionsModule — ghost filter + previousSessionMap (Task 3)', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  // ── Test M: apiStatus !== null + title === null survives filter ──
  it('Test M: Session with apiStatus but no title survives ghost filter', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_no_title',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: { 'ses_no_title': { type: 'busy', machineId: 'mac-1' } },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_no_title': {
          status: 'busy',
          lastPrompt: 'working',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_no_title');
    expect(session).toBeDefined();
    expect(session.apiStatus).toBe('busy');
    expect(session.title).toBeNull();
  });

  // ── Test N: apiStatus === null + title === null + source !== 'claude-code' is filtered out ──
  it('Test N: Session with no apiStatus and no title is filtered out', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_ghost',
            title: null,
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    expect(sessions.find((s: any) => s.sessionId === 'ses_ghost')).toBeUndefined();
  });

  // ── Test O: Machine poll failure preserves previous sessions ──
  it('Test O: Previous sessions preserved when connected machine returns 0 sessions', async () => {
    const pollAllSessionsFn = vi.fn();
    const getMachineStatusesFn = vi.fn();

    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: getMachineStatusesFn,
      pollAllSessions: pollAllSessionsFn,
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    // First poll: return sessions normally
    pollAllSessionsFn.mockResolvedValueOnce({
      sessions: [
        {
          id: 'ses_existing',
          title: 'Existing Session',
          machineId: 'mac-1',
          machineAlias: 'Test Mac',
          machineHost: '10.0.0.1',
          directory: '/Users/test',
          time: { created: 1000, updated: 2000 },
        },
      ],
      statuses: {},
    });
    getMachineStatusesFn.mockReturnValueOnce([
      { machineId: 'mac-1', connected: true, machineAlias: 'Test Mac', machineHost: '10.0.0.1', lastSeen: Date.now(), error: null, source: 'opencode' },
    ]);

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    let sessions: any[] = (module as any).cachedSessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('ses_existing');

    // Second poll: machine returns 0 sessions (poll failure) but still connected
    pollAllSessionsFn.mockResolvedValueOnce({
      sessions: [],
      statuses: {},
    });
    getMachineStatusesFn.mockReturnValueOnce([
      { machineId: 'mac-1', connected: true, machineAlias: 'Test Mac', machineHost: '10.0.0.1', lastSeen: Date.now(), error: null, source: 'opencode' },
    ]);

    await (module as any).poll();

    sessions = (module as any).cachedSessions;
    // Previous session should be preserved
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('ses_existing');
  });

  // ── Test P: Successful poll replaces previous data ──
  it('Test P: Successful poll with new sessions replaces previous data', async () => {
    const pollAllSessionsFn = vi.fn();
    const getMachineStatusesFn = vi.fn();

    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: getMachineStatusesFn,
      pollAllSessions: pollAllSessionsFn,
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    // First poll
    pollAllSessionsFn.mockResolvedValueOnce({
      sessions: [
        {
          id: 'ses_old',
          title: 'Old Session',
          machineId: 'mac-1',
          machineAlias: 'Test Mac',
          machineHost: '10.0.0.1',
          directory: '/Users/test',
          time: { created: 1000, updated: 2000 },
        },
      ],
      statuses: {},
    });
    getMachineStatusesFn.mockReturnValueOnce([
      { machineId: 'mac-1', connected: true, machineAlias: 'Test Mac', machineHost: '10.0.0.1', lastSeen: Date.now(), error: null, source: 'opencode' },
    ]);

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    // Second poll: new sessions returned
    pollAllSessionsFn.mockResolvedValueOnce({
      sessions: [
        {
          id: 'ses_new',
          title: 'New Session',
          machineId: 'mac-1',
          machineAlias: 'Test Mac',
          machineHost: '10.0.0.1',
          directory: '/Users/test',
          time: { created: 3000, updated: 4000 },
        },
      ],
      statuses: {},
    });
    getMachineStatusesFn.mockReturnValueOnce([
      { machineId: 'mac-1', connected: true, machineAlias: 'Test Mac', machineHost: '10.0.0.1', lastSeen: Date.now(), error: null, source: 'opencode' },
    ]);

    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    expect(sessions.find((s: any) => s.sessionId === 'ses_new')).toBeDefined();
    const old = sessions.find((s: any) => s.sessionId === 'ses_old');
    expect(old).toBeDefined();
    expect(old.status).toBe('idle');
    expect(old.apiStatus).toBeNull();
  });

  it('Test P2: Session memory expires after TTL (5 min)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pollAllSessionsFn = vi.fn();
    const getMachineStatusesFn = vi.fn();

    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: getMachineStatusesFn,
      pollAllSessions: pollAllSessionsFn,
      pollSessionDetails: vi.fn().mockResolvedValue({}),
    });

    pollAllSessionsFn.mockResolvedValueOnce({
      sessions: [{ id: 'ses_mem', title: 'Memory Test', machineId: 'mac-1', machineAlias: 'Mac', machineHost: '10.0.0.1', directory: '/test', time: { created: 1000, updated: 2000 } }],
      statuses: {},
    });
    getMachineStatusesFn.mockReturnValue([
      { machineId: 'mac-1', connected: true, machineAlias: 'Mac', machineHost: '10.0.0.1', lastSeen: Date.now(), error: null, source: 'opencode' },
    ]);

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();
    expect((module as any).cachedSessions.find((s: any) => s.sessionId === 'ses_mem')).toBeDefined();

    vi.advanceTimersByTime(301_000);

    pollAllSessionsFn.mockResolvedValueOnce({ sessions: [], statuses: {} });
    await (module as any).poll();

    expect((module as any).cachedSessions.find((s: any) => s.sessionId === 'ses_mem')).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('ActiveSessionsModule — waitingForInput forwarding', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  // ── Test Q: waitingForInput=true in cachedDetails propagates to DashboardSession ──
  it('Test Q: waitingForInput=true from cachedDetails is forwarded to DashboardSession', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_waiting',
            sessionId: 'ses_waiting',
            title: 'Waiting Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_waiting': { type: 'idle', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_waiting': {
          status: 'idle',
          lastPrompt: 'waiting prompt',
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          waitingForInput: true,
          sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_waiting');

    expect(session).toBeDefined();
    expect(session.waitingForInput).toBe(true);
  });

  // ── Test R: waitingForInput defaults to false when not in cachedDetails ──
  it('Test R: waitingForInput defaults to false when absent from cachedDetails', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_no_wait',
            sessionId: 'ses_no_wait',
            title: 'No Wait Session',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_no_wait': { type: 'busy', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_no_wait': {
          status: 'busy',
          lastPrompt: 'working',
          lastPromptTime: 1000,
          currentTool: 'bash',
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          sseConnected: true,
          // waitingForInput NOT set
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const session = sessions.find((s: any) => s.sessionId === 'ses_no_wait');

    expect(session).toBeDefined();
    expect(session.waitingForInput).toBe(false);
  });

  // ── Test S: waitingForInput forwarded for orphan sessions too ──
  it('Test S: waitingForInput=true forwarded for orphan sessions synthesized from cache', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan_wait': {
          status: 'idle',
          lastPrompt: 'orphan waiting',
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          waitingForInput: true,
          sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan_wait');

    expect(orphan).toBeDefined();
    expect(orphan.waitingForInput).toBe(true);
    expect(orphan.apiStatus).toBe('idle');
  });

  // ── Test T: orphan session restores title from previousSessionMap ──
  it('Test T: orphan session title is restored from previousSessionMap on second poll', async () => {
    const pollAllSessionsMock = vi.fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            id: 'ses_orphan_title',
            sessionId: 'ses_orphan_title',
            machineId: 'mac-1',
            machineAlias: 'Test Mac',
            machineHost: '10.0.0.1',
            title: 'My Orphan Session',
            directory: '/Users/test',
            time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: { 'ses_orphan_title': { type: 'idle', machineId: 'mac-1' } },
      })
      .mockResolvedValueOnce({
        sessions: [],
        statuses: {},
      });

    const pollSessionDetailsMock = vi.fn()
      .mockResolvedValueOnce({
        'ses_orphan_title': {
          status: 'idle',
          lastPrompt: null,
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          waitingForInput: false,
          sseConnected: true,
        },
      })
      .mockResolvedValueOnce({
        'ses_orphan_title': {
          status: 'idle',
          lastPrompt: null,
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          waitingForInput: false,
          sseConnected: true,
        },
      });

    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: pollAllSessionsMock,
      pollSessionDetails: pollSessionDetailsMock,
    });

    module = new ActiveSessionsModule(mockMachineManager);
    // First poll: session appears in REST → stored in previousSessionMap with title
    await (module as any).poll();
    // Second poll: session disappears from REST but stays in SSE cache → orphan
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_orphan_title');

    expect(orphan).toBeDefined();
    expect(orphan.title).toBe('My Orphan Session');
  });

  // ── Test U: first-time orphan has title=null (no previousSessionMap entry) ──
  it('Test U: first-time orphan session has title=null when not in previousSessionMap', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'both' },
      ],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_brand_new_orphan': {
          status: 'idle',
          lastPrompt: null,
          lastPromptTime: 1000,
          currentTool: null,
          directory: '/Users/test',
          updatedAt: 2000,
          machineId: 'mac-1',
          waitingForInput: false,
          sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const orphan = sessions.find((s: any) => s.sessionId === 'ses_brand_new_orphan');

    expect(orphan).toBeDefined();
    expect(orphan.title).toBeNull();
  });
});

describe('ActiveSessionsModule — background session regression', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('child sessions with parentSessionId are included with parentSessionId set', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_parent',
            title: 'Parent Session',
            parentID: null,
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 1000, updated: 3000 },
          },
          {
            id: 'ses_child',
            title: 'T22: backtest-guide (@subagent)',
            parentID: 'ses_parent',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 2000, updated: 2500 },
          },
        ],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_parent': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 3000,
          machineId: 'mac-1', sseConnected: true,
        },
        'ses_child': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 2500,
          machineId: 'mac-1', sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const child = sessions.find((s: any) => s.sessionId === 'ses_child');
    const parent = sessions.find((s: any) => s.sessionId === 'ses_parent');

    expect(parent).toBeDefined();
    expect(parent.parentSessionId).toBeNull();

    expect(child).toBeDefined();
    expect(child.parentSessionId).toBe('ses_parent');
  });

  it('orphan child sessions (parent evicted) still have parentSessionId set', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_orphan_child',
            title: 'T22: backtest-guide (@subagent)',
            parentID: 'ses_evicted_parent',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 2000, updated: 2500 },
          },
        ],
        statuses: {},
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_orphan_child': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 2500,
          machineId: 'mac-1', sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const child = sessions.find((s: any) => s.sessionId === 'ses_orphan_child');

    expect(child).toBeDefined();
    expect(child.parentSessionId).toBe('ses_evicted_parent');
  });
});

describe('ActiveSessionsModule — idle session status regression', () => {
  let module: ActiveSessionsModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('idle sessions have status "idle", not "active"', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_idle',
            title: 'Idle Session',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 1000, updated: 2000 },
          },
          {
            id: 'ses_busy',
            title: 'Busy Session',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 1000, updated: 3000 },
          },
        ],
        statuses: {
          'ses_idle': { type: 'idle', machineId: 'mac-1' },
          'ses_busy': { type: 'busy', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_idle': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 2000,
          machineId: 'mac-1', sseConnected: true,
        },
        'ses_busy': {
          status: 'busy', lastPrompt: 'working', lastPromptTime: 3000,
          currentTool: 'bash', directory: '/project', updatedAt: 3000,
          machineId: 'mac-1', sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const idle = sessions.find((s: any) => s.sessionId === 'ses_idle');
    const busy = sessions.find((s: any) => s.sessionId === 'ses_busy');

    expect(idle).toBeDefined();
    expect(idle.status).toBe('idle');

    expect(busy).toBeDefined();
    expect(busy.status).toBe('active');
  });

  it('allStatuses with only idle entries produces zero active sessions', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [
        { id: 'mac-1', alias: 'Test Mac', host: '10.0.0.1', port: 3100, apiKey: 'key', source: 'opencode' },
      ],
      getMachineStatuses: () => [],
      pollAllSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'ses_a', title: 'Session A',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 1000, updated: 2000 },
          },
          {
            id: 'ses_b', title: 'Session B',
            machineId: 'mac-1', machineAlias: 'Test Mac', machineHost: '10.0.0.1',
            directory: '/project', time: { created: 1000, updated: 2000 },
          },
        ],
        statuses: {
          'ses_a': { type: 'idle', machineId: 'mac-1' },
          'ses_b': { type: 'idle', machineId: 'mac-1' },
        },
      }),
      pollSessionDetails: vi.fn().mockResolvedValue({
        'ses_a': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 2000,
          machineId: 'mac-1', sseConnected: true,
        },
        'ses_b': {
          status: 'idle', lastPrompt: null, lastPromptTime: 0,
          currentTool: null, directory: '/project', updatedAt: 2000,
          machineId: 'mac-1', sseConnected: true,
        },
      }),
    });

    module = new ActiveSessionsModule(mockMachineManager);
    await (module as any).poll();

    const sessions: any[] = (module as any).cachedSessions;
    const activeSessions = sessions.filter((s: any) => s.status === 'active');

    expect(activeSessions).toHaveLength(0);
    expect(sessions.every((s: any) => s.status === 'idle')).toBe(true);
  });
});
