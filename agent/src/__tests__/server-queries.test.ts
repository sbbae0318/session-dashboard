import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentConfig } from '../types.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { QueryEntry } from '../oc-query-collector.js';

// ---------------------------------------------------------------------------
// OcQueryCollector mock — must be hoisted before createServer import
// ---------------------------------------------------------------------------

const mockCollectQueries = vi.fn();

vi.mock('../oc-query-collector.js', () => {
  const OcQueryCollector = vi.fn(function (this: { collectQueries: typeof mockCollectQueries }) {
    this.collectQueries = mockCollectQueries;
  });
  return { OcQueryCollector };
});

// PromptStore mock — return count=0 so queries always fall through to OcQueryCollector
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

// Import after mock setup
import { createServer } from '../server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `srv-queries-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(
  overrides: Partial<AgentConfig> & { historyDir: string },
): AgentConfig {
  return {
    port: 0,
    apiKey: '',   // empty = dev mode (no auth)
    ocServePort: 0,
    ...overrides,
  };
}

function makeQueryEntry(overrides: Partial<QueryEntry> = {}): QueryEntry {
  return {
    sessionId: 'session-abc',
    sessionTitle: 'Test Session',
    timestamp: Date.now(),
    query: 'What is the meaning of life?',
    isBackground: false,
    source: 'opencode',
    completedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server — /api/queries (OcQueryCollector)', () => {
  let tmpDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockCollectQueries.mockReset();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Test 1: 기본 응답 shape 확인 ──

  it('should return { queries: [...] } shape when source="opencode"', async () => {
    const entries = [makeQueryEntry(), makeQueryEntry({ sessionId: 'session-xyz', query: 'Hello world' })];
    mockCollectQueries.mockResolvedValue(entries);

    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { queries: unknown[] };
    expect(body).toHaveProperty('queries');
    expect(Array.isArray(body.queries)).toBe(true);
    expect(body.queries).toHaveLength(2);
  });

  // ── Test 2: limit 파라미터 → collectQueries(limit) 호출 확인 ──

  it('should call collectQueries with parsed limit when ?limit=10', async () => {
    mockCollectQueries.mockResolvedValue([]);

    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries?limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCollectQueries).toHaveBeenCalledWith(10);
  });

  // ── Test 3: QueryEntry shape 확인 ──

  it('should return QueryEntry with required fields (sessionId, sessionTitle, timestamp, query, isBackground)', async () => {
    const entry = makeQueryEntry({
      sessionId: 'ses-123',
      sessionTitle: 'My Session',
      timestamp: 1700000000000,
      query: 'Explain TypeScript generics',
      isBackground: false,
    });
    mockCollectQueries.mockResolvedValue([entry]);

    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { queries: QueryEntry[] };
    expect(body.queries).toHaveLength(1);

    const q = body.queries[0];
    expect(q).toHaveProperty('sessionId', 'ses-123');
    expect(q).toHaveProperty('sessionTitle', 'My Session');
    expect(q).toHaveProperty('timestamp', 1700000000000);
    expect(q).toHaveProperty('query', 'Explain TypeScript generics');
    expect(q).toHaveProperty('isBackground', false);
  });

  // ── Test 4: oc-serve 다운 (빈 배열) → { queries: [] } 응답 ──

  it('should return { queries: [] } when collectQueries returns empty array (oc-serve down)', async () => {
    mockCollectQueries.mockResolvedValue([]);

    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        source: 'opencode',
      }),
    );
    app = result.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { queries: unknown[] };
    expect(body).toEqual({ queries: [] });
  });

  // ── Test 5: source="claude-code" → OcQueryCollector 미사용, fallback ──

  it('should use JsonlReader fallback when source="claude-code" (no OcQueryCollector)', async () => {
    const result = await createServer(
      makeConfig({
        historyDir: tmpDir,
        claudeHistoryDir: tmpDir,
        source: 'claude-code',
      }),
    );
    app = result.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
    });

    // collectQueries should NOT be called (OcQueryCollector not instantiated)
    expect(mockCollectQueries).not.toHaveBeenCalled();
    // Should still return valid response (empty from missing file)
    expect(response.statusCode).toBe(200);
    const body = response.json() as { queries: unknown[] };
    expect(body).toHaveProperty('queries');
    expect(Array.isArray(body.queries)).toBe(true);
  });
});
