import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentConfig } from '../types.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const mockFetchJson = vi.fn();
vi.mock('../oc-serve-proxy.js', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  registerProxyRoutes: vi.fn(),
  registerPostProxyRoutes: vi.fn(),
  checkOcServeConnection: vi.fn().mockResolvedValue(false),
}));

vi.mock('../prompt-store.js', () => {
  const PromptStore = vi.fn(function (this: { count: () => number; upsertMany: () => number; evict: () => number; trimToMax: () => number; getRecent: () => never[]; backfillTitles: () => number; close: () => void }) {
    this.count = () => 0;
    this.upsertMany = () => 0;
    this.evict = () => 0;
    this.trimToMax = () => 0;
    this.getRecent = () => [];
    this.backfillTitles = () => 0;
    this.close = () => {};
  });
  return { PromptStore };
});

vi.mock('../session-cache.js', () => {
  const SessionCache = vi.fn(function (this: {
    start: () => void; stop: () => void; setDbReader: () => void;
    registerRoutes: () => void; getConnectionState: () => string;
    getSessionDetails: () => { sessions: Record<string, never> };
    onSessionBusy: () => void;
  }) {
    this.start = () => {};
    this.stop = () => {};
    this.setDbReader = () => {};
    this.registerRoutes = () => {};
    this.getConnectionState = () => 'disconnected';
    this.getSessionDetails = () => ({ sessions: {} });
    this.onSessionBusy = () => {};
  });
  return { SessionCache };
});

vi.mock('../oc-query-collector.js', () => {
  const OcQueryCollector = vi.fn(function (this: { collectQueries: () => Promise<never[]> }) {
    this.collectQueries = async () => [];
  });
  return { OcQueryCollector };
});

const { mockDbReaderInstance } = vi.hoisted(() => {
  const mockDbReaderInstance = {
    isAvailable: vi.fn().mockReturnValue(true),
    getRecentSessionMetas: vi.fn().mockReturnValue([]),
    getAllProjects: vi.fn().mockReturnValue([]),
    getAllProjectsTokenStats: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
  return { mockDbReaderInstance };
});

vi.mock('../opencode-db-reader.js', () => {
  return {
    OpenCodeDBReader: vi.fn(function () {
      return mockDbReaderInstance;
    }),
  };
});

import { createServer } from '../server.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `srv-sessions-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(overrides: Partial<AgentConfig> & { historyDir: string }): AgentConfig {
  return {
    port: 0,
    apiKey: '',
    ocServePort: 0,
    openCodeDbPath: '/tmp/fake-opencode.db',
    ...overrides,
  };
}

describe('server — /api/sessions DB fallback', () => {
  let tmpDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockFetchJson.mockReset();
    mockDbReaderInstance.isAvailable.mockReturnValue(true);
    mockDbReaderInstance.getRecentSessionMetas.mockReturnValue([]);
  });

  afterEach(async () => {
    if (app) await app.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should proxy to oc-serve when available', async () => {
    const ocServeSessions = [
      { id: 'ses-1', title: 'From oc-serve', parentID: null, directory: '/proj', time: { created: 1000, updated: 2000 } },
    ];
    mockFetchJson.mockResolvedValueOnce(ocServeSessions);

    const result = await createServer(makeConfig({ historyDir: tmpDir, source: 'opencode' }));
    app = result.app;

    const response = await app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: unknown[]; fallback?: boolean };
    expect(body.sessions).toHaveLength(1);
    expect(body.fallback).toBeUndefined();
  });

  it('should fallback to opencode.db when oc-serve is down', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    mockDbReaderInstance.getRecentSessionMetas.mockReturnValue([
      { id: 'ses-db-1', title: 'DB Session', parentId: null, directory: '/project/a', timeCreated: 1000, timeUpdated: 2000 },
      { id: 'ses-db-2', title: 'DB Session 2', parentId: 'ses-db-1', directory: '/project/a', timeCreated: 1100, timeUpdated: 1800 },
    ]);

    const result = await createServer(makeConfig({ historyDir: tmpDir, source: 'opencode' }));
    app = result.app;

    const response = await app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: Array<{ id: string; title: string; parentID: string | null; directory: string; time: { created: number; updated: number } }>; fallback: boolean };
    expect(body.fallback).toBe(true);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toEqual({
      id: 'ses-db-1',
      title: 'DB Session',
      parentID: null,
      directory: '/project/a',
      time: { created: 1000, updated: 2000 },
    });
    expect(body.sessions[1].parentID).toBe('ses-db-1');
  });

  it('should return 502 when both oc-serve and DB are unavailable', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    mockDbReaderInstance.isAvailable.mockReturnValue(false);

    const result = await createServer(makeConfig({ historyDir: tmpDir, source: 'opencode' }));
    app = result.app;

    const response = await app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(502);
    const body = response.json() as { code: string };
    expect(body.code).toBe('OC_SERVE_DOWN');
  });

  it('should respect limit parameter in DB fallback', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    mockDbReaderInstance.getRecentSessionMetas.mockReturnValue([
      { id: 'ses-1', title: 'S1', parentId: null, directory: '/a', timeCreated: 1000, timeUpdated: 2000 },
    ]);

    const result = await createServer(makeConfig({ historyDir: tmpDir, source: 'opencode' }));
    app = result.app;

    await app.inject({ method: 'GET', url: '/api/sessions?limit=10' });

    expect(mockDbReaderInstance.getRecentSessionMetas).toHaveBeenCalledWith(
      7 * 24 * 60 * 60 * 1000,
      10,
    );
  });
});
