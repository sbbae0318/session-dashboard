/**
 * Main Fastify server for dashboard-agent
 *
 * Routes:
 *   GET  /health                — Health check (no auth)
 *   POST /api/auth/token         — Issue JWT token (no auth)
 *   GET  /api/queries?limit=50   — Read queries.jsonl
 *   GET  /api/sessions           — Proxy to oc-serve /session, wrap in { sessions }
 *   GET  /api/machines           — Proxy to oc-serve /project, wrap in { machines }
 *   GET  /proxy/session/status   — Proxy to oc-serve
 *   GET  /proxy/session          — Proxy to oc-serve
 *   GET  /proxy/session/:id      — Proxy to oc-serve
 *   GET  /proxy/session/details  — Cached session details (SSE-based)
 *   POST /proxy/*                — JWT-authenticated POST proxy routes
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { authPreHandler, createAuthToken } from './auth.js';
import { JsonlReader } from './jsonl-reader.js';
import { fetchJson, registerProxyRoutes, registerPostProxyRoutes, checkOcServeConnection } from './oc-serve-proxy.js';
import { SessionCache } from './session-cache.js';
import { OcQueryCollector, type QueryEntry } from './oc-query-collector.js';
import { PromptStore } from './prompt-store.js';
import { ClaudeHeartbeat } from './claude-heartbeat.js';
import { ProcessScanner } from './process-scanner.js';
import { ClaudeSource } from './claude-source.js';
import { spawn } from 'node:child_process';
import { OpenCodeDBReader, type EnrichmentResponse, type TokensData, type SearchResult } from './opencode-db-reader.js';
import type { AgentConfig, HealthResponse, QueriesResponse, TokenRequest } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read package.json version
 */
function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const MAX_LIMIT = 2_000;
const DEFAULT_LIMIT = 50;
const PROMPT_COLLECTION_INTERVAL_MS = 30_000; // 30 seconds
const OC_SERVE_CACHE_TTL = 10_000; // 10 seconds

/**
 * Cached oc-serve connection status
 */
let ocServeConnectedCache: { value: boolean; updatedAt: number } = {
  value: false,
  updatedAt: 0,
};

async function getOcServeConnected(): Promise<boolean> {
  const now = Date.now();
  if (now - ocServeConnectedCache.updatedAt < OC_SERVE_CACHE_TTL) {
    return ocServeConnectedCache.value;
  }

  const connected = await checkOcServeConnection();
  ocServeConnectedCache = { value: connected, updatedAt: now };
  return connected;
}

/**
 * Parse and clamp limit query parameter
 */
function parseLimit(raw: unknown): number {
  const num = typeof raw === 'string' ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(num) || num < 1) return DEFAULT_LIMIT;
  return Math.min(num, MAX_LIMIT);
}

/**
 * Create and configure the Fastify server
 */
export async function createServer(config: AgentConfig): Promise<{ app: FastifyInstance; sessionCache: SessionCache | null; promptStore: PromptStore | null }> {
  const version = getVersion();
  const startTime = Date.now();
  const ocServePort = config.ocServePort ?? 4096;

  // Determine which modules are active based on config.source
  const ocServeEnabled = config.source !== 'claude-code';
  const claudeEnabled = config.source === 'claude-code' || config.source === 'both';

  // Conditionally create SessionCache (depends on oc-serve)
  let sessionCache: SessionCache | null = null;
  if (ocServeEnabled) {
    sessionCache = new SessionCache(ocServePort);
  }

  // Conditionally create OcQueryCollector (depends on oc-serve)
  let ocQueryCollector: OcQueryCollector | null = null;
  if (ocServeEnabled) {
    ocQueryCollector = new OcQueryCollector(
      ocServePort,
      // SessionCache의 모든 세션 데이터 전달
      // lastPrompt가 있는 세션은 oc-serve message fetch 없이 직접 QueryEntry로 변환됨
      () => sessionCache!.getSessionDetails().sessions,
    );
  }

  // Conditionally create PromptStore + background collection (depends on oc-serve)
  let promptStore: PromptStore | null = null;
  let bgCollectionInterval: NodeJS.Timeout | null = null;
  let busyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  if (ocServeEnabled && ocQueryCollector) {
    promptStore = new PromptStore();

    const doCollection = async (): Promise<void> => {
      try {
        const entries = await ocQueryCollector!.collectQueries(200);

        // Claude 쿼리 수집 (claudeEnabled인 경우)
        if (claudeEnabled && claudeSource) {
          const claudeEntries = await claudeSource.getRecentQueries(200);
          const claudeQueryEntries: QueryEntry[] = claudeEntries.map((e) => ({
            sessionId: e.sessionId,
            sessionTitle: e.sessionTitle,
            timestamp: e.timestamp,
            query: e.query,
            isBackground: e.isBackground,
            source: 'claude-code' as const,
            completedAt: e.completedAt,
          }));
          entries.push(...claudeQueryEntries);
        }

        const inserted = promptStore!.upsertMany(entries);
        if (inserted > 0) console.log(`[prompt-store] Stored ${inserted} new prompts`);

        // Backfill: session_title이 NULL인 기존 프롬프트에 현재 알려진 타이틀 소급 적용
        const titleMap: Record<string, string> = {};
        for (const e of entries) {
          if (e.sessionTitle && !titleMap[e.sessionId]) {
            titleMap[e.sessionId] = e.sessionTitle;
          }
        }
        if (sessionCache) {
          const cachedSessions = sessionCache.getSessionDetails().sessions;
          for (const [sid, detail] of Object.entries(cachedSessions)) {
            if (detail.title && !titleMap[sid]) {
              titleMap[sid] = detail.title;
            }
          }
        }
        if (Object.keys(titleMap).length > 0) {
          const backfilled = promptStore!.backfillTitles(titleMap);
          if (backfilled > 0) console.log(`[prompt-store] Backfilled ${backfilled} prompt title(s)`);
        }

        promptStore!.evict();
        promptStore!.trimToMax();
      } catch (err) {
        console.error('[prompt-store] Collection error:', err);
      }
    };

    // Initial collection (non-blocking)
    void doCollection();

    // Background collection every 30s
    bgCollectionInterval = setInterval(() => {
      void doCollection();
    }, PROMPT_COLLECTION_INTERVAL_MS);

    if (sessionCache) {
      sessionCache.onSessionBusy(() => {
        if (busyDebounceTimer) return;
        busyDebounceTimer = setTimeout(() => {
          busyDebounceTimer = null;
          void doCollection();
        }, 1_000);
      });
    }
  }

  // ProcessScanner: OS 프로세스 테이블 기반 보조 모니터링
  const processScanner = new ProcessScanner();
  // 주기적 스캔 시작 (10초 캐시, 첫 호출 시 자동 시작)
  const processScanInterval = setInterval(() => { void processScanner.scan(); }, 10_000);
  void processScanner.scan();

  // Always create ClaudeHeartbeat (needed for hooks receiver even when source != claude-code)
  const claudeHeartbeat = new ClaudeHeartbeat(undefined, undefined, processScanner);
  claudeHeartbeat.start();

  // ClaudeSource only needed when Claude routes are active
  let claudeSource: ClaudeSource | null = null;
  if (claudeEnabled) {
    claudeSource = new ClaudeSource(config.claudeHistoryDir);
    claudeSource.start();
  }

  const app = Fastify({ logger: true });

  // Register CORS (all origins)
  await app.register(cors, { origin: true });

  // Register JWT plugin (before auth hook)
  await app.register(fastifyJwt, {
    secret: config.jwtSecret || randomUUID(),
  });

  // Register auth preHandler for all routes (skips /health internally)
  app.addHook('preHandler', authPreHandler);

  // GET /health — no auth (skipped in authPreHandler)
  app.get('/health', async () => {
    const ocServeConnected = ocServeEnabled ? await getOcServeConnected() : false;
    const response: HealthResponse = {
      status: 'ok',
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      ocServeConnected,
      sseConnected: sessionCache ? sessionCache.getConnectionState() === 'connected' : false,
      ...(claudeEnabled ? { claudeSourceConnected: true } : {}),
    };
    return response;
  });

  // POST /api/auth/token — issue JWT token (no auth required)
  app.post<{ Body: TokenRequest }>('/api/auth/token', async (request, reply) => {
    const result = createAuthToken(app, request.body?.apiKey ?? '', config.apiKey);
    if (!result) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }
    return result;
  });


  // GET /api/queries?limit=50
  app.get<{ Querystring: { limit?: string } }>('/api/queries', async (request) => {
    const limit = parseLimit(request.query.limit);

    // 1) Instant response from SQLite (persistent store)
    if (promptStore && promptStore.count() > 0) {
      const queries = promptStore.getRecent(limit);
      const response: QueriesResponse = { queries };
      return response;
    }

    // 2) Fallback: live collection from oc-serve (before bg collection completes)
    if (ocQueryCollector) {
      const queries = await ocQueryCollector.collectQueries(limit);
      const response: QueriesResponse = { queries };
      return response;
    }

    // 3) Final fallback: queries.jsonl (Claude Code source)
    const filePath = join(config.historyDir, 'queries.jsonl');
    const reader = new JsonlReader<Record<string, unknown>>(filePath);
    const queries = await reader.tailLines(limit);
    const response: QueriesResponse = { queries };
    return response;
  });

  // GET /api/sessions — proxy to oc-serve /session, fallback to opencode.db
  app.get<{ Querystring: { directory?: string; limit?: string } }>('/api/sessions', async (request, reply) => {
    try {
      const headers: Record<string, string> = {};
      const opencodeDirHeader = request.headers['x-opencode-directory'];
      if (typeof opencodeDirHeader === 'string') {
        headers['x-opencode-directory'] = opencodeDirHeader;
      }

      const params = new URLSearchParams();
      if (request.query.directory) params.set('directory', request.query.directory);
      if (request.query.limit) params.set('limit', request.query.limit);
      const qs = params.toString();
      const url = `http://127.0.0.1:${ocServePort}/session${qs ? `?${qs}` : ''}`;
      const data = await fetchJson(url, headers, 3000);

      const sessions = Array.isArray(data) ? data : [];
      return { sessions };
    } catch {
      if (ocDbReader && ocDbReader.isAvailable()) {
        const limit = parseLimit(request.query.limit);
        const metas = ocDbReader.getRecentSessionMetas(7 * 24 * 60 * 60 * 1000, limit);
        const sessions = metas.map(m => ({
          id: m.id,
          title: m.title,
          parentID: m.parentId,
          directory: m.directory,
          time: { created: m.timeCreated, updated: m.timeUpdated },
        }));
        return { sessions, fallback: true };
      }
      return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
    }
  });

  // GET /api/machines — proxy to oc-serve /project, wrap in { machines }
  app.get('/api/machines', async (_request, reply) => {
    try {
      const data = await fetchJson(`http://127.0.0.1:${ocServePort}/project`, {}, 3000);
      const machines = Array.isArray(data) ? data : [];
      return { machines };
    } catch {
      return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
    }
  });

  // oc-serve dependent: proxy routes + session cache
  if (ocServeEnabled) {
    registerProxyRoutes(app);
    registerPostProxyRoutes(app);
    sessionCache!.registerRoutes(app);
    sessionCache!.start();
  }

  // Claude-specific routes
  if (claudeEnabled) {
    // GET /api/claude/sessions
    app.get('/api/claude/sessions', async () => {
      const sessions = claudeHeartbeat.getActiveSessions();
      return { sessions };
    });

    // GET /api/claude/queries?limit=50
    app.get<{ Querystring: { limit?: string } }>('/api/claude/queries', async (request) => {
      const limit = parseLimit(request.query.limit);
      const queries = await claudeSource!.getRecentQueries(limit);
      return { queries };
    });

  }

  // GET /api/process-status — OS process table scan results
  app.get('/api/process-status', async () => {
    const result = await processScanner.scan();
    return result;
  });

  // POST /hooks/event — Claude Code hooks receiver (always registered)
  app.post<{ Body: Record<string, unknown> }>('/hooks/event', async (request) => {
    if (!claudeHeartbeat) return { ok: false, error: 'claude not enabled' };
    const body = request.body;
    const eventName = String(body.hook_event_name ?? '');
    const sessionId = String(body.session_id ?? '');
    if (!sessionId) return { ok: false, error: 'missing session_id' };

    switch (eventName) {
      case 'PreToolUse': {
        const toolName = String(body.tool_name ?? 'unknown');
        claudeHeartbeat.handleToolEvent(sessionId, toolName);
        break;
      }
      case 'PostToolUse': {
        claudeHeartbeat.handleToolEvent(sessionId, null);
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = String(
          (body.user_prompt as Record<string, unknown>)?.content
          ?? body.prompt ?? '',
        );
        claudeHeartbeat.handlePromptEvent(sessionId, prompt, Date.now());
        break;
      }
      case 'Stop':
      case 'SubagentStop': {
        claudeHeartbeat.handleStatusEvent(sessionId, 'idle');
        break;
      }
      case 'Notification': {
        const notifType = String(body.notification_type ?? '');
        if (notifType === 'permission_prompt') {
          // permission_prompt: tool 실행 허가 대기 → WAITING
          claudeHeartbeat.handleWaitingEvent(sessionId, true);
        } else if (notifType === 'idle_prompt') {
          // idle_prompt: 작업 완료 후 다음 입력 대기 → IDLE (not WAITING)
          claudeHeartbeat.handleStatusEvent(sessionId, 'idle');
        }
        break;
      }
      case 'SessionStart': {
        claudeHeartbeat.handleStatusEvent(sessionId, 'busy');
        break;
      }
      default:
        break;
    }
    return { ok: true };
  });

  // Enrichment routes (opencode.db readonly access)
  let ocDbReader: OpenCodeDBReader | null = null;
  try {
    ocDbReader = new OpenCodeDBReader(config.openCodeDbPath);
  } catch {
    console.log('[enrichment] opencode.db not available — enrichment endpoints will return { available: false }');
  }

  if (sessionCache && ocDbReader) {
    sessionCache.setDbReader(ocDbReader);
  }

  function enrichResponse<T>(fn: () => T): EnrichmentResponse<T> {
    if (!ocDbReader || !ocDbReader.isAvailable()) {
      return { data: null, available: false, error: 'DB not available', cachedAt: Date.now() };
    }
    try {
      return { data: fn(), available: true, cachedAt: Date.now() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { data: null, available: false, error: msg, cachedAt: Date.now() };
    }
  }

  app.get('/api/enrichment', async () => {
    return enrichResponse(() => ({
      projects: ocDbReader!.getAllProjects(),
      tokenStats: ocDbReader!.getAllProjectsTokenStats(),
    }));
  });

  app.get<{ Querystring: { sessionId?: string; projectId?: string } }>(
    '/api/enrichment/tokens',
    async (request) => {
      const { sessionId, projectId } = request.query;
      if (sessionId) {
        return enrichResponse(() => ocDbReader!.getSessionTokenStats(sessionId));
      }
      if (projectId) {
        const allStats = enrichResponse(() => ocDbReader!.getAllProjectsTokenStats());
        if (allStats.data) {
          const match = allStats.data.find(s => s.projectId === projectId) ?? null;
          return { ...allStats, data: match };
        }
        return allStats;
      }
      return enrichResponse<TokensData>(() => ocDbReader!.getTokensData());
    },
  );

  app.get<{ Querystring: { limit?: string; projectId?: string } }>(
    '/api/enrichment/impact',
    async (request) => {
      const limit = parseLimit(request.query.limit);
      const { projectId } = request.query;
      return enrichResponse(() => ocDbReader!.getAllSessionsCodeImpact({ limit, projectId }));
    },
  );

  app.get<{ Querystring: { from?: string; to?: string; projectId?: string; since?: string } }>(
    '/api/enrichment/timeline',
    async (request) => {
      const from = parseInt(request.query.from || '0', 10);
      const to = parseInt(request.query.to || String(Date.now()), 10);
      const since = request.query.since ? parseInt(request.query.since, 10) : undefined;
      const { projectId } = request.query;
      return enrichResponse(() => ocDbReader!.getSessionTimeline({ from, to, projectId, since }));
    },
  );

  app.get('/api/enrichment/projects', async () => {
    return enrichResponse(() => ocDbReader!.getAllProjects());
  });

  app.get<{ Querystring: { sessionId?: string } }>(
    '/api/enrichment/timeline-segments',
    async (request, reply) => {
      const { sessionId } = request.query;
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required', available: false });
      }
      return enrichResponse(() => {
        const segments = ocDbReader!.getSessionActivitySegments(sessionId);
        return { sessionId, segments };
      });
    },
  );

  app.get<{ Querystring: { sessionId?: string; limit?: string } }>(
    '/api/enrichment/recovery',
    async (request) => {
      const { sessionId, limit } = request.query;
      if (sessionId) {
        return enrichResponse(() => ocDbReader!.getSessionRecoveryContext(sessionId));
      }
      const limitNum = parseInt(limit || '20', 10);
      return enrichResponse(() => ocDbReader!.getAllRecoveryContexts({ limit: limitNum }));
    },
  );

  const SUMMARY_CACHE_MAX = 100;
  const SUMMARY_CACHE_TTL_MS = 3_600_000;
  const summaryCache = new Map<string, { summary: string; generatedAt: number }>();
  const summaryCacheEvictionTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of summaryCache) {
      if (now - entry.generatedAt > SUMMARY_CACHE_TTL_MS) {
        summaryCache.delete(key);
      }
    }
    if (summaryCache.size > SUMMARY_CACHE_MAX) {
      const sorted = [...summaryCache.entries()].sort((a, b) => a[1].generatedAt - b[1].generatedAt);
      const toRemove = sorted.slice(0, summaryCache.size - SUMMARY_CACHE_MAX);
      for (const [key] of toRemove) summaryCache.delete(key);
    }
  }, 60_000);

  app.post<{ Params: { sessionId: string } }>(
    '/api/enrichment/recovery/:sessionId/summarize',
    async (request) => {
      const { sessionId } = request.params;

      const cached = summaryCache.get(sessionId);
      if (cached && (Date.now() - cached.generatedAt) < SUMMARY_CACHE_TTL_MS) {
        return { summary: cached.summary, generatedAt: cached.generatedAt, cached: true };
      }

      if (!ocDbReader || !ocDbReader.isAvailable()) {
        return { summary: null, error: 'DB not available' };
      }

      const exists = ocDbReader.getSessionRecoveryContext(sessionId);
      if (!exists) {
        return { summary: null, error: 'Session not found' };
      }

      const messages = ocDbReader.getSessionMessages(sessionId, { limit: 30 });
      if (messages.length === 0) {
        return { summary: null, error: 'No messages found' };
      }

      const formatted = messages.map(m => {
        const d = new Date(m.time * 1000);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `[${hh}:${mm}] (${m.role}) ${m.content}`;
      }).join('\n');

      const prompt = `다음은 OpenCode AI 코딩 세션의 메시지 기록입니다.
이 세션에서 무슨 작업을 했는지 타임라인 형식으로 간결하게 요약하세요.

규칙:
- 한국어로 작성
- 각 항목은 "[시간] 작업내용 → 결과" 형식
- 성공/실패/진행중 표시
- 최대 8줄
- 문제가 있었다면 어떤 문제인지 명시

세션: ${exists.sessionTitle ?? sessionId}
프로젝트: ${exists.directory ?? 'unknown'}

메시지 기록:
${formatted}`;

      try {
        const summary = await new Promise<string>((resolve, reject) => {
          const child = spawn('claude', ['-p', '--model', 'claude-haiku-4-5'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
          });

          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });

          child.on('close', (code) => {
            if (code === 0) {
              resolve(stdout.trim());
            } else {
              reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
            }
          });

          child.on('error', reject);
          child.stdin.write(prompt);
          child.stdin.end();
        });

        const result = { summary, generatedAt: Date.now() };
        summaryCache.set(sessionId, result);
        return { ...result, cached: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[summarize] claude -p failed:', msg);
        return { summary: null, error: 'Summary generation failed' };
      }
    },
  );

  app.get<{ Querystring: { q?: string; from?: string; to?: string; limit?: string; offset?: string } }>(
    '/api/search',
    async (request, reply) => {
      const q = request.query.q;
      if (!q || q.length < 2) {
        return reply.code(400).send({ error: 'Query must be at least 2 characters' });
      }

      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const fromTs = request.query.from ? parseInt(request.query.from, 10) : now - sevenDaysMs;
      const toTs = request.query.to ? parseInt(request.query.to, 10) : now;

      if (Number.isNaN(fromTs) || Number.isNaN(toTs)) {
        return reply.code(400).send({ error: 'Invalid from/to timestamp' });
      }

      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), MAX_LIMIT);
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

      const response = enrichResponse<{ results: SearchResult[]; total: number; hasMore: boolean }>(() => {
        const { results, total } = ocDbReader!.searchSessions({ query: q, from: fromTs, to: toTs, limit, offset });
        return { results, total, hasMore: offset + limit < total };
      });
      return response;
    },
  );

  app.addHook('onClose', async () => {
    if (bgCollectionInterval) clearInterval(bgCollectionInterval);
    if (busyDebounceTimer) clearTimeout(busyDebounceTimer);
    clearInterval(summaryCacheEvictionTimer);
    if (promptStore) promptStore.close();
    if (sessionCache) sessionCache.stop();
    claudeHeartbeat.stop();
    if (claudeSource) claudeSource.stop();
    if (ocDbReader) ocDbReader.close();
  });

  return { app, sessionCache, promptStore };
}
