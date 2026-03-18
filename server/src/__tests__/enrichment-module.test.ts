import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { EnrichmentModule } from '../modules/enrichment/index.js';
import type { MachineManager } from '../machines/machine-manager.js';
import type { SSEManager } from '../sse/event-stream.js';
import type { MachineConfig } from '../config/machines.js';
import type { EnrichmentResponse, TokensData, ProjectSummary, SessionSegmentsResponse } from '../modules/enrichment/types.js';

const TEST_MACHINE: MachineConfig = {
  id: 'mac-test',
  alias: 'Test Mac',
  host: '10.0.0.1',
  port: 3098,
  apiKey: 'test-key',
  source: 'opencode',
};

function createMockMachineManager(overrides?: {
  getMachines?: () => readonly MachineConfig[];
  fetchFromMachine?: <T>(machine: MachineConfig, path: string) => Promise<T>;
}): MachineManager {
  return {
    getMachines: overrides?.getMachines ?? vi.fn().mockReturnValue([TEST_MACHINE]),
    fetchFromMachine: overrides?.fetchFromMachine ?? vi.fn().mockResolvedValue({ data: null, available: false, cachedAt: 0 }),
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

describe('EnrichmentModule — pollFeature', () => {
  let module: EnrichmentModule;
  let mockMachineManager: MachineManager;
  let mockSseManager: SSEManager;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('updates cache on successful poll', async () => {
    const tokensResponse: EnrichmentResponse<TokensData> = {
      data: {
        sessions: [],
        grandTotal: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 5, cost: 0.05 },
      },
      available: true,
      cachedAt: Date.now(),
    };

    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue(tokensResponse),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    await module.pollFeature('tokens');

    const cache = module.getCache();
    const machineCache = cache.get('mac-test');
    expect(machineCache).toBeDefined();
    expect(machineCache!.tokens).toEqual(tokensResponse);
    expect(machineCache!.lastUpdated).toBeGreaterThan(0);
  });

  it('broadcasts SSE event on successful poll', async () => {
    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue({ data: null, available: false, cachedAt: 0 }),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    await module.pollFeature('projects');

    expect(mockSseManager.broadcast).toHaveBeenCalledWith('enrichment.updated', {
      machineId: 'mac-test',
      feature: 'projects',
      cachedAt: expect.any(Number),
    });
  });

  it('gracefully skips failed machines and preserves existing cache', async () => {
    const existingResponse: EnrichmentResponse<ProjectSummary[]> = {
      data: [{ id: 'p1', worktree: '/test', sessionCount: 1, activeSessionCount: 0, lastActivityAt: 1000, totalTokens: 100, totalCost: 0.01, totalAdditions: 10, totalDeletions: 5 }],
      available: true,
      cachedAt: 1000,
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(existingResponse)
      .mockRejectedValueOnce(new Error('agent down'));

    mockMachineManager = createMockMachineManager({
      fetchFromMachine: fetchMock,
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    await module.pollFeature('projects');
    const cacheAfterFirst = module.getCache().get('mac-test');
    expect(cacheAfterFirst!.projects).toEqual(existingResponse);

    await module.pollFeature('projects');
    const cacheAfterFailure = module.getCache().get('mac-test');
    expect(cacheAfterFailure!.projects).toEqual(existingResponse);
  });

  it('polls multiple machines independently', async () => {
    const machine2: MachineConfig = { id: 'mac-2', alias: 'Mac 2', host: '10.0.0.2', port: 3098, apiKey: 'key2', source: 'opencode' };

    const fetchMock = vi.fn()
      .mockImplementation(async (machine: MachineConfig) => {
        if (machine.id === 'mac-test') {
          return { data: null, available: true, cachedAt: Date.now() };
        }
        throw new Error('agent down');
      });

    mockMachineManager = createMockMachineManager({
      getMachines: () => [TEST_MACHINE, machine2],
      fetchFromMachine: fetchMock,
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    await module.pollFeature('timeline');

    const cache = module.getCache();
    expect(cache.get('mac-test')?.timeline).toBeDefined();
    expect(cache.has('mac-2')).toBe(false);
  });
});

describe('EnrichmentModule — registerRoutes', () => {
  let module: EnrichmentModule;
  let mockMachineManager: MachineManager;
  let mockSseManager: SSEManager;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('GET /api/enrichment/:machineId returns cached data', async () => {
    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue({
        data: { sessions: [], grandTotal: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
        available: true,
        cachedAt: 1000,
      }),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    await module.pollFeature('tokens');

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/mac-test' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.tokens).toBeDefined();
    expect(body.tokens.available).toBe(true);
    await app.close();
  });

  it('GET /api/enrichment/:machineId returns empty cache for unknown machine', async () => {
    mockMachineManager = createMockMachineManager();
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/unknown-machine' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.tokens).toBeNull();
    expect(body.impact).toBeNull();
    expect(body.timeline).toBeNull();
    expect(body.projects).toBeNull();
    expect(body.recovery).toBeNull();
    expect(body.lastUpdated).toBe(0);
    await app.close();
  });

  it('GET /api/enrichment returns all machine caches', async () => {
    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue({ data: null, available: false, cachedAt: 0 }),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    await module.pollFeature('tokens');

    const response = await app.inject({ method: 'GET', url: '/api/enrichment' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body['mac-test']).toBeDefined();
    await app.close();
  });

  it('GET /api/enrichment/:machineId/:feature returns individual feature data', async () => {
    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue({ data: [], available: true, cachedAt: 2000 }),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    await module.pollFeature('impact');

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/mac-test/impact' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.available).toBe(true);
    await app.close();
  });

  it('GET /api/enrichment/:machineId/:feature returns null for unknown machine', async () => {
    mockMachineManager = createMockMachineManager();
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/no-such-machine/tokens' });
    const body = response.body;

    expect(response.statusCode).toBe(200);
    expect(body).toBe('null');
    await app.close();
  });
});

describe('EnrichmentModule — timeline-segments routes', () => {
  let module: EnrichmentModule;
  let mockMachineManager: MachineManager;
  let mockSseManager: SSEManager;

  afterEach(async () => {
    if (module) await module.stop();
    vi.clearAllMocks();
  });

  it('GET /api/enrichment/:machineId/timeline-segments returns 400 without sessionId', async () => {
    mockMachineManager = createMockMachineManager();
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/mac-test/timeline-segments' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'sessionId query parameter is required' });
    await app.close();
  });

  it('GET /api/enrichment/:machineId/timeline-segments proxies to machine', async () => {
    const segmentsResponse: SessionSegmentsResponse = {
      sessionId: 'ses_abc',
      segments: [{ startTime: 1000, endTime: 2000, type: 'working' }],
    };

    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue(segmentsResponse),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/enrichment/mac-test/timeline-segments?sessionId=ses_abc',
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.sessionId).toBe('ses_abc');
    expect(body.segments).toHaveLength(1);
    expect(mockMachineManager.fetchFromMachine).toHaveBeenCalledWith(
      TEST_MACHINE,
      '/api/enrichment/timeline-segments?sessionId=ses_abc',
    );
    await app.close();
  });

  it('GET /api/enrichment/:machineId/timeline-segments returns error for unknown machine', async () => {
    mockMachineManager = createMockMachineManager();
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/enrichment/unknown-machine/timeline-segments?sessionId=ses_abc',
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.error).toBe('Machine not found');
    await app.close();
  });

  it('GET /api/enrichment/merged/timeline-segments returns 400 without sessionId', async () => {
    mockMachineManager = createMockMachineManager();
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/api/enrichment/merged/timeline-segments' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'sessionId query parameter is required' });
    await app.close();
  });

  it('GET /api/enrichment/merged/timeline-segments returns first non-empty result with machine info', async () => {
    const machine2: MachineConfig = { id: 'mac-2', alias: 'Mac 2', host: '10.0.0.2', port: 3098, apiKey: 'key2', source: 'opencode' };

    const fetchMock = vi.fn().mockImplementation(async (machine: MachineConfig) => {
      if (machine.id === 'mac-test') {
        return { sessionId: 'ses_abc', segments: [] };
      }
      return {
        sessionId: 'ses_abc',
        segments: [{ startTime: 1000, endTime: 2000, type: 'working' }],
      };
    });

    mockMachineManager = createMockMachineManager({
      getMachines: () => [TEST_MACHINE, machine2],
      fetchFromMachine: fetchMock,
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/enrichment/merged/timeline-segments?sessionId=ses_abc',
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.segments).toHaveLength(1);
    expect(body.machineId).toBe('mac-2');
    expect(body.machineAlias).toBe('Mac 2');
    await app.close();
  });

  it('GET /api/enrichment/merged/timeline-segments returns empty when no machine has segments', async () => {
    mockMachineManager = createMockMachineManager({
      fetchFromMachine: vi.fn().mockResolvedValue({ sessionId: 'ses_abc', segments: [] }),
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/enrichment/merged/timeline-segments?sessionId=ses_abc',
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.segments).toEqual([]);
    expect(body.machineId).toBeNull();
    await app.close();
  });

  it('GET /api/enrichment/merged/timeline-segments handles machine failures gracefully', async () => {
    const machine2: MachineConfig = { id: 'mac-2', alias: 'Mac 2', host: '10.0.0.2', port: 3098, apiKey: 'key2', source: 'opencode' };

    const fetchMock = vi.fn().mockImplementation(async (machine: MachineConfig) => {
      if (machine.id === 'mac-test') {
        throw new Error('agent down');
      }
      return {
        sessionId: 'ses_abc',
        segments: [{ startTime: 1000, endTime: 2000, type: 'working' }],
      };
    });

    mockMachineManager = createMockMachineManager({
      getMachines: () => [TEST_MACHINE, machine2],
      fetchFromMachine: fetchMock,
    });
    mockSseManager = createMockSseManager();
    module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    const app = Fastify();
    module.registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/enrichment/merged/timeline-segments?sessionId=ses_abc',
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.segments).toHaveLength(1);
    expect(body.machineId).toBe('mac-2');
    await app.close();
  });
});

describe('EnrichmentModule — lifecycle', () => {
  it('start sets up polling timers and stop clears them', async () => {
    const mockMachineManager = createMockMachineManager({
      getMachines: () => [],
    });
    const mockSseManager = createMockSseManager();
    const module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    await module.start();

    const timers = (module as any).timers as NodeJS.Timeout[];
    expect(timers.length).toBe(5);

    await module.stop();
    expect(timers.length).toBe(0);
  });

  it('module id is "enrichment"', () => {
    const mockMachineManager = createMockMachineManager();
    const mockSseManager = createMockSseManager();
    const module = new EnrichmentModule(mockMachineManager, mockSseManager, ':memory:');

    expect(module.id).toBe('enrichment');
  });
});
