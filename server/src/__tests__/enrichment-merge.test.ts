import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { EnrichmentModule } from '../modules/enrichment/index.js';
import type { MachineManager } from '../machines/machine-manager.js';
import type { SSEManager } from '../sse/event-stream.js';
import type { MachineConfig } from '../config/machines.js';
import type {
  EnrichmentResponse,
  TokensData,
  TimelineEntry,
  SessionCodeImpact,
  ProjectSummary,
  RecoveryContext,
} from '../modules/enrichment/types.js';

const MACHINE_A: MachineConfig = {
  id: 'mac-a',
  alias: 'MacBook A',
  host: '10.0.0.1',
  port: 3098,
  apiKey: 'key-a',
  source: 'opencode',
};

const MACHINE_B: MachineConfig = {
  id: 'mac-b',
  alias: 'MacBook B',
  host: '10.0.0.2',
  port: 3098,
  apiKey: 'key-b',
  source: 'opencode',
};

function createMockMachineManager(machines: readonly MachineConfig[]): MachineManager {
  return {
    getMachines: vi.fn().mockReturnValue(machines),
    fetchFromMachine: vi.fn().mockResolvedValue({ data: null, available: false, cachedAt: 0 }),
    getMachineStatuses: vi.fn().mockReturnValue([]),
    setStatusChangeCallback: vi.fn(),
    pollAll: vi.fn().mockResolvedValue({ sessions: [], statuses: {}, cachedDetails: {} }),
    pollAllSessions: vi.fn().mockResolvedValue({ sessions: [], statuses: {} }),
    pollAllQueries: vi.fn().mockResolvedValue([]),
    pollSessionDetails: vi.fn().mockResolvedValue({}),
  } as unknown as MachineManager;
}

function createMockSseManager(): SSEManager {
  return {
    broadcast: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
  } as unknown as SSEManager;
}

function seedCache(
  module: EnrichmentModule,
  machineId: string,
  feature: string,
  response: EnrichmentResponse<unknown>,
): void {
  const cache = module.getCache() as unknown as Map<string, Record<string, unknown>>;
  const existing = cache.get(machineId) ?? {
    tokens: null, impact: null, timeline: null, projects: null, recovery: null, lastUpdated: 0,
  };
  cache.set(machineId, { ...existing, [feature]: response, lastUpdated: Date.now() });
}

describe('EnrichmentModule — getMergedData', () => {
  let module: EnrichmentModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('returns empty result when no cache exists', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A, MACHINE_B]),
      createMockSseManager(),
    );

    const result = module.getMergedData('timeline');

    expect(result.available).toBe(false);
    expect(result.machineCount).toBe(0);
    expect(result.data).toEqual([]);
    expect(result.cachedAt).toBe(0);
  });

  it('merges single machine timeline with machineId/machineAlias', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A]),
      createMockSseManager(),
    );

    const entries: TimelineEntry[] = [
      { sessionId: 's1', sessionTitle: 'Test', projectId: 'p1', directory: '/proj', startTime: 1000, endTime: 2000, status: 'completed', parentId: null },
    ];
    seedCache(module, 'mac-a', 'timeline', { data: entries, available: true, cachedAt: 5000 });

    const result = module.getMergedData('timeline');

    expect(result.available).toBe(true);
    expect(result.machineCount).toBe(1);
    expect(Array.isArray(result.data)).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].machineId).toBe('mac-a');
    expect(data[0].machineAlias).toBe('MacBook A');
    expect(data[0].sessionId).toBe('s1');
  });

  it('merges multi-machine timeline sorted by startTime ascending', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A, MACHINE_B]),
      createMockSseManager(),
    );

    const entriesA: TimelineEntry[] = [
      { sessionId: 'a1', sessionTitle: 'A1', projectId: 'p1', directory: '/a', startTime: 3000, endTime: 4000, status: 'completed', parentId: null },
      { sessionId: 'a2', sessionTitle: 'A2', projectId: 'p1', directory: '/a', startTime: 1000, endTime: 2000, status: 'completed', parentId: null },
    ];
    const entriesB: TimelineEntry[] = [
      { sessionId: 'b1', sessionTitle: 'B1', projectId: 'p2', directory: '/b', startTime: 2000, endTime: 3000, status: 'idle', parentId: null },
    ];

    seedCache(module, 'mac-a', 'timeline', { data: entriesA, available: true, cachedAt: 5000 });
    seedCache(module, 'mac-b', 'timeline', { data: entriesB, available: true, cachedAt: 6000 });

    const result = module.getMergedData('timeline');

    expect(result.available).toBe(true);
    expect(result.machineCount).toBe(2);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    expect(data[0].startTime).toBe(1000);
    expect(data[0].machineId).toBe('mac-a');
    expect(data[1].startTime).toBe(2000);
    expect(data[1].machineId).toBe('mac-b');
    expect(data[2].startTime).toBe(3000);
    expect(data[2].machineId).toBe('mac-a');
  });

  it('returns remaining machine data when one machine has no cache (graceful degradation)', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A, MACHINE_B]),
      createMockSseManager(),
    );

    const entriesA: TimelineEntry[] = [
      { sessionId: 'a1', sessionTitle: 'A1', projectId: 'p1', directory: '/a', startTime: 1000, endTime: 2000, status: 'completed', parentId: null },
    ];
    seedCache(module, 'mac-a', 'timeline', { data: entriesA, available: true, cachedAt: 5000 });

    const result = module.getMergedData('timeline');

    expect(result.available).toBe(true);
    expect(result.machineCount).toBe(1);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].machineId).toBe('mac-a');
  });

  it('aggregates tokens grandTotal across machines', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A, MACHINE_B]),
      createMockSseManager(),
    );

    const tokensA: TokensData = {
      sessions: [],
      grandTotal: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 5, cost: 0.05 },
    };
    const tokensB: TokensData = {
      sessions: [],
      grandTotal: { input: 300, output: 400, reasoning: 100, cacheRead: 20, cacheWrite: 15, cost: 0.10 },
    };

    seedCache(module, 'mac-a', 'tokens', { data: tokensA, available: true, cachedAt: 5000 });
    seedCache(module, 'mac-b', 'tokens', { data: tokensB, available: true, cachedAt: 6000 });

    const result = module.getMergedData('tokens');

    expect(result.available).toBe(true);
    expect(result.machineCount).toBe(2);
    const data = result.data as { machines: Array<Record<string, unknown>>; grandTotal: Record<string, number> };
    expect(data.machines).toHaveLength(2);
    expect(data.grandTotal.input).toBe(400);
    expect(data.grandTotal.output).toBe(600);
    expect(data.grandTotal.reasoning).toBe(150);
    expect(data.grandTotal.cacheRead).toBe(30);
    expect(data.grandTotal.cacheWrite).toBe(20);
    expect(data.grandTotal.cost).toBeCloseTo(0.15);
  });

  it('sorts impact by timeUpdated descending', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A, MACHINE_B]),
      createMockSseManager(),
    );

    const impactA: SessionCodeImpact[] = [
      { sessionId: 'a1', sessionTitle: 'A1', projectId: 'p1', directory: '/a', additions: 10, deletions: 5, files: 3, timeUpdated: 1000 },
    ];
    const impactB: SessionCodeImpact[] = [
      { sessionId: 'b1', sessionTitle: 'B1', projectId: 'p2', directory: '/b', additions: 20, deletions: 10, files: 5, timeUpdated: 3000 },
    ];

    seedCache(module, 'mac-a', 'impact', { data: impactA, available: true, cachedAt: 5000 });
    seedCache(module, 'mac-b', 'impact', { data: impactB, available: true, cachedAt: 6000 });

    const result = module.getMergedData('impact');
    const data = result.data as Array<Record<string, unknown>>;
    expect(data[0].timeUpdated).toBe(3000);
    expect(data[1].timeUpdated).toBe(1000);
  });

  it('sorts projects by sessionCount descending', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A]),
      createMockSseManager(),
    );

    const projects: ProjectSummary[] = [
      { id: 'p1', worktree: '/proj1', sessionCount: 5, activeSessionCount: 1, lastActivityAt: 1000, totalTokens: 100, totalCost: 0.01, totalAdditions: 10, totalDeletions: 5 },
      { id: 'p2', worktree: '/proj2', sessionCount: 15, activeSessionCount: 3, lastActivityAt: 2000, totalTokens: 500, totalCost: 0.05, totalAdditions: 50, totalDeletions: 20 },
    ];

    seedCache(module, 'mac-a', 'projects', { data: projects, available: true, cachedAt: 5000 });

    const result = module.getMergedData('projects');
    const data = result.data as Array<Record<string, unknown>>;
    expect(data[0].sessionCount).toBe(15);
    expect(data[1].sessionCount).toBe(5);
  });

  it('sorts recovery by lastActivityAt descending', () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A]),
      createMockSseManager(),
    );

    const recovery: RecoveryContext[] = [
      { sessionId: 'r1', sessionTitle: 'R1', directory: '/r1', lastActivityAt: 1000, lastPrompts: [], lastTools: [], additions: 0, deletions: 0, files: 0, todos: [] },
      { sessionId: 'r2', sessionTitle: 'R2', directory: '/r2', lastActivityAt: 5000, lastPrompts: [], lastTools: [], additions: 0, deletions: 0, files: 0, todos: [] },
    ];

    seedCache(module, 'mac-a', 'recovery', { data: recovery, available: true, cachedAt: 5000 });

    const result = module.getMergedData('recovery');
    const data = result.data as Array<Record<string, unknown>>;
    expect(data[0].lastActivityAt).toBe(5000);
    expect(data[1].lastActivityAt).toBe(1000);
  });
});

describe('EnrichmentModule — merged route', () => {
  let module: EnrichmentModule;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('GET /api/enrichment/merged/:feature returns merged data via HTTP', async () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A]),
      createMockSseManager(),
    );

    const entries: TimelineEntry[] = [
      { sessionId: 's1', sessionTitle: 'T1', projectId: 'p1', directory: '/d', startTime: 1000, endTime: 2000, status: 'completed', parentId: null },
    ];
    seedCache(module, 'mac-a', 'timeline', { data: entries, available: true, cachedAt: 5000 });

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/merged/timeline' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.available).toBe(true);
    expect(body.machineCount).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].machineId).toBe('mac-a');
    await app.close();
  });

  it('GET /api/enrichment/merged/:feature returns error for invalid feature', async () => {
    module = new EnrichmentModule(
      createMockMachineManager([MACHINE_A]),
      createMockSseManager(),
    );

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/merged/invalid' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.error).toBe('Invalid feature');
    expect(body.available).toBe(false);
    await app.close();
  });

  it('existing per-machine route still works alongside merged route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ data: [], available: true, cachedAt: 1000 });
    const mm = createMockMachineManager([MACHINE_A]);
    (mm.fetchFromMachine as ReturnType<typeof vi.fn>).mockImplementation(fetchMock);
    module = new EnrichmentModule(mm, createMockSseManager());

    const app = Fastify();
    module.registerRoutes(app);
    await module.pollFeature('timeline');

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/mac-a/timeline' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.available).toBe(true);
    await app.close();
  });
});
