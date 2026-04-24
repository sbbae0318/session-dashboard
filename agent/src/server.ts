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
import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

import { hostname } from 'node:os';

import { authPreHandler, createAuthToken } from './auth.js';
import { parseJsonlLine } from './transcript-jsonl-parser.js';
import { JsonlReader } from './jsonl-reader.js';
import { TranscriptIngestor } from './transcript-ingestor.js';
import { fetchJson, registerProxyRoutes, registerPostProxyRoutes, checkOcServeConnection } from './oc-serve-proxy.js';
import { SessionCache } from './session-cache.js';
import { OcQueryCollector, type QueryEntry } from './oc-query-collector.js';
import { PromptStore } from './prompt-store.js';
import { SummaryEngine } from './summary-engine.js';
import { ClaudeHeartbeat } from './claude-heartbeat.js';
import { ProcessScanner } from './process-scanner.js';
import { ClaudeSource } from './claude-source.js';
import { OpenCodeDBReader, DEFAULT_OPENCODE_DB_PATH, type EnrichmentResponse, type TokensData, type SearchResult } from './opencode-db-reader.js';
import { OpenCodeDbSource } from './opencode-db-source.js';
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

// ── Transcript endpoint types & helpers ────────────────────────────────────

interface TranscriptToolUse {
  id: string;
  name: string;
  inputPreview: string;
}

interface TranscriptToolResult {
  toolUseId: string;
  contentPreview: string;
}

interface TranscriptEvent {
  uuid: string;
  parentUuid: string | null;
  type: string;
  timestamp: number;
  role: string;
  model: string | null;
  toolUses: TranscriptToolUse[];
  toolResults: TranscriptToolResult[];
  textPreview: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** ~/.claude/projects/ 아래 모든 프로젝트 폴더에서 <sessionId>.jsonl 경로 탐색 */
async function findSessionJsonl(projectsDir: string, sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** ~/.claude/projects/ 아래 모든 프로젝트 폴더에서 <sessionId>/ 디렉토리 경로 탐색 */
async function findSessionDir(projectsDir: string, sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, sessionId);
    try {
      await readdir(candidate);  // 디렉토리인지 확인 (readdir 성공 = 디렉토리 존재)
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** raw JSONL 객체를 TranscriptEvent로 변환 */
function toTranscriptEvent(obj: Record<string, unknown>): TranscriptEvent {
  const message = (obj.message ?? {}) as Record<string, unknown>;
  const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
  const role = (message.role as string | undefined) ?? (obj.type as string);
  const model = (message.model as string | undefined) ?? null;

  const toolUses: TranscriptToolUse[] = [];
  const toolResults: TranscriptToolResult[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      toolUses.push({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        inputPreview: JSON.stringify(input).slice(0, 300),
      });
    } else if (block.type === 'tool_result') {
      const resultContent = block.content;
      let preview = '';
      if (typeof resultContent === 'string') {
        preview = resultContent.slice(0, 300);
      } else if (Array.isArray(resultContent)) {
        const textBlock = (resultContent as Record<string, unknown>[]).find(b => b.type === 'text');
        preview = textBlock ? String(textBlock.text ?? '').slice(0, 300) : '';
      }
      toolResults.push({
        toolUseId: String(block.tool_use_id ?? ''),
        contentPreview: preview,
      });
    } else if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }

  // string content (user 메시지가 단순 문자열인 경우)
  if (typeof message.content === 'string' && message.content) {
    textParts.push(message.content);
  }

  const fullText = textParts.join('\n');
  const textPreview = fullText ? fullText.slice(0, 500) : null;

  const usageRaw = message.usage as Record<string, number> | undefined;
  const usage = usageRaw
    ? { inputTokens: usageRaw.input_tokens ?? 0, outputTokens: usageRaw.output_tokens ?? 0 }
    : null;

  const ts = typeof obj.timestamp === 'string' ? new Date(obj.timestamp).getTime() : (obj.timestamp as number ?? 0);

  return {
    uuid: String(obj.uuid ?? ''),
    parentUuid: (obj.parentUuid as string | null | undefined) ?? null,
    type: String(obj.type ?? ''),
    timestamp: ts,
    role,
    model,
    toolUses,
    toolResults,
    textPreview,
    usage,
  };
}

/** JSONL 파일을 읽어 TranscriptEvent[] 반환. filterFn이 null을 반환하면 스킵 */
async function readTranscriptEvents(filePath: string): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const results: Record<string, unknown>[] = [];
  for (const line of content.trimEnd().split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (!parsed) continue;
    // parseJsonlLine이 null 반환 = skip types (file-history-snapshot 등) + isSidechain
    // 이미 필터링됨 — raw object도 필요하므로 재파싱
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    results.push(raw);
  }
  return results;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// ── End transcript helpers ──────────────────────────────────────────────────

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
  // SSE 연결 시: SessionCache가 authoritative
  // SSE 미연결 시: DbSource 데이터로 보충 (server.ts에서 wire 후 callback이 dbSource 참조)
  let ocQueryCollector: OcQueryCollector | null = null;
  if (ocServeEnabled) {
    ocQueryCollector = new OcQueryCollector(
      ocServePort,
      // SessionCache + dbSource merged supplement data
      // lastPrompt가 있는 세션은 oc-serve message fetch 없이 직접 QueryEntry로 변환됨
      () => sessionCache!.getSessionDetails().sessions,
    );
  }

  // Conditionally create PromptStore + background collection (depends on oc-serve)
  let promptStore: PromptStore | null = null;
  let bgCollectionInterval: NodeJS.Timeout | null = null;
  let busyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let summaryEngine: SummaryEngine | null = null;

  if (ocServeEnabled && ocQueryCollector) {
    promptStore = new PromptStore();
    summaryEngine = new SummaryEngine(promptStore.database);

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

        // Auto-trigger progressive summaries for sessions with enough new prompts
        if (summaryEngine) {
          const sessionIds = new Set(entries.map(e => e.sessionId));
          for (const sid of sessionIds) {
            const prompts = promptStore!.getBySessionId(sid, 200);
            if (prompts.length === 0) continue;
            // Fetch tool names from OC DB (best-effort)
            const latest = summaryEngine.getLatest(sid);
            const sinceTs = latest
              ? prompts[latest.promptCount]?.timestamp ?? 0
              : 0;
            const toolNames = ocDbReader?.isAvailable()
              ? ocDbReader.getToolNamesSince(sid, sinceTs)
              : [];
            const title = prompts[0]?.sessionTitle ?? undefined;
            void summaryEngine.checkAndGenerate(
              sid,
              prompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
              { toolNames, sessionTitle: title },
            );
          }
        }
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

  // TranscriptIngestor: JSONL → TurnSummary → dashboard push
  const dashboardUrl = process.env['DASHBOARD_URL'] ?? 'http://192.168.0.2:3097';
  const machineId = process.env['MACHINE_ID'] ?? hostname();
  const transcriptIngestor = new TranscriptIngestor({
    onTurn: (turn) => {
      void (async () => {
        try {
          await fetch(`${dashboardUrl}/api/ingest/turn-summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...turn,
              machineId,
              slug: null,
              gitBranch: null,
              cwd: null,
            }),
          });
        } catch (err) {
          console.error('[TranscriptIngestor] push failed:', (err as Error).message);
        }
      })();
    },
  });

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
      ...(hookSseClients.size > 0 ? { hookSseClients: hookSseClients.size } : {}),
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

    // GET /api/claude/queries?limit=50&sessionId=X
    app.get<{ Querystring: { limit?: string; sessionId?: string } }>('/api/claude/queries', async (request) => {
      const limit = parseLimit(request.query.limit);
      const sessionId = request.query.sessionId || undefined;
      const queries = await claudeSource!.getRecentQueries(limit, sessionId);
      return { queries };
    });

    // GET /claude/transcript/:sessionId/:promptId
    // 특정 prompt turn의 모든 JSONL 이벤트를 반환
    app.get<{ Params: { sessionId: string; promptId: string } }>(
      '/claude/transcript/:sessionId/:promptId',
      async (request, reply) => {
        const { sessionId, promptId } = request.params;

        const jsonlPath = await findSessionJsonl(CLAUDE_PROJECTS_DIR, sessionId);
        if (!jsonlPath) {
          return reply.code(404).send({ error: 'Session not found' });
        }

        const rawLines = await readTranscriptEvents(jsonlPath);

        // promptId 필터링: user 라인의 promptId로 범위 결정
        // - target promptId user 라인 → in scope
        // - 다른 promptId user 라인 → out of scope
        // - assistant/system 라인 → 앞선 user 라인의 scope 상속
        const events: TranscriptEvent[] = [];
        let inScope = false;

        for (const raw of rawLines) {
          const type = raw.type as string;
          if (type === 'user') {
            const linePromptId = (raw.promptId as string | undefined) ?? null;
            inScope = linePromptId === promptId;
          }
          if (inScope) {
            events.push(toTranscriptEvent(raw));
          }
        }

        return { promptId, sessionId, events };
      },
    );

    // GET /claude/transcript/:sessionId/subagent/:agentKey
    // 서브에이전트 JSONL 파일의 모든 이벤트를 반환
    app.get<{ Params: { sessionId: string; agentKey: string } }>(
      '/claude/transcript/:sessionId/subagent/:agentKey',
      async (request, reply) => {
        const { sessionId, agentKey } = request.params;

        const sessionDir = await findSessionDir(CLAUDE_PROJECTS_DIR, sessionId);
        if (!sessionDir) {
          return reply.code(404).send({ error: 'Session directory not found' });
        }

        const subagentPath = join(sessionDir, 'subagents', `agent-${agentKey}.jsonl`);
        try {
          await access(subagentPath);
        } catch {
          return reply.code(404).send({ error: 'Subagent file not found' });
        }

        const rawLines = await readTranscriptEvents(subagentPath);
        const events = rawLines.map(toTranscriptEvent);
        return { agentKey, sessionId, events };
      },
    );

  }

  // GET /api/process-status — OS process table scan results
  app.get('/api/process-status', async () => {
    const result = await processScanner.scan();
    return result;
  });

  // GET /api/prompt-response?sessionId=X&timestamp=Y&source=claude-code|opencode
  app.get<{ Querystring: { sessionId?: string; timestamp?: string; source?: string } }>(
    '/api/prompt-response',
    async (request) => {
      const { sessionId, timestamp, source } = request.query;
      if (!sessionId || !timestamp) return { response: null, error: 'missing params' };
      const ts = parseInt(timestamp, 10);
      if (Number.isNaN(ts)) return { response: null, error: 'invalid timestamp' };

      // Claude Code: JSONL에서 response 추출
      if (source === 'claude-code' && claudeHeartbeat) {
        const response = await claudeHeartbeat.fetchResponse(sessionId, ts);
        return { response };
      }

      // OpenCode: oc-serve 메시지 API에서 response 추출
      if (ocServeEnabled) {
        try {
          const data = await fetchJson(
            `http://127.0.0.1:${config.ocServePort}/session/${sessionId}/message`,
            {},
            10_000,
          );
          if (!Array.isArray(data)) throw new Error('oc-serve invalid response');
          const messages = data as Array<{ info?: { role?: string; time?: { created?: number } }; parts?: Array<{ type?: string; text?: string }> }>;

          // timestamp에 매칭되는 user 메시지 찾기
          let userIdx = -1;
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.info?.role !== 'user') continue;
            const msgTs = msg.info?.time?.created ?? 0;
            if (Math.abs(msgTs - ts) < 2000) { userIdx = i; break; }
          }
          if (userIdx < 0) throw new Error('user message not found in oc-serve');

          // user 이후 첫 assistant 메시지의 text parts 추출
          const textParts: string[] = [];
          for (let i = userIdx + 1; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.info?.role === 'user') break;
            if (msg.info?.role !== 'assistant') continue;
            for (const part of msg.parts ?? []) {
              if (part.type === 'text' && typeof part.text === 'string') {
                textParts.push(part.text);
              }
            }
          }
          if (textParts.length === 0) throw new Error('no assistant text parts');
          const response = textParts.join('\n\n');
          return { response: response.length > 30_000 ? response.slice(0, 30_000) + '\n\n... (truncated)' : response };
        } catch {
          // oc-serve 실패 → DB 직접 조회 fallback
          if (ocDbReader && ocDbReader.isAvailable()) {
            const response = ocDbReader.getPromptResponseFromDb(sessionId, ts);
            if (response !== null) return { response };
          }
          return { response: null, error: 'oc-serve fetch failed' };
        }
      }

      // oc-serve 비활성 + DB만 사용 가능한 경우
      if (ocDbReader && ocDbReader.isAvailable()) {
        const response = ocDbReader.getPromptResponseFromDb(sessionId, ts);
        return { response };
      }

      return { response: null };
    },
  );

  // ── Hook-event SSE broadcast (B': real-time push to server) ──
  const hookSseClients = new Map<string, import('fastify').FastifyReply>();

  function broadcastHookUpdate(sid: string): void {
    if (!claudeHeartbeat || hookSseClients.size === 0) return;
    const session = claudeHeartbeat.getSession(sid);
    if (!session) return;
    const msg = `event: hook.sessionUpdate\ndata: ${JSON.stringify(session)}\n\n`;
    for (const [id, reply] of hookSseClients) {
      try { reply.raw.write(msg); }
      catch { hookSseClients.delete(id); }
    }
  }

  // GET /api/claude/events — SSE stream for hook events
  app.get('/api/claude/events', (request, reply) => {
    const clientId = randomUUID();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);
    hookSseClients.set(clientId, reply);
    request.raw.on('close', () => hookSseClients.delete(clientId));
  });

  // Hook SSE heartbeat (30s)
  const hookSseHeartbeat = setInterval(() => {
    for (const [id, reply] of hookSseClients) {
      try { reply.raw.write(':heartbeat\n\n'); }
      catch { hookSseClients.delete(id); }
    }
  }, 30_000);
  app.addHook('onClose', () => clearInterval(hookSseHeartbeat));

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
        broadcastHookUpdate(sessionId);
        break;
      }
      case 'PostToolUse': {
        claudeHeartbeat.handleToolEvent(sessionId, null);
        broadcastHookUpdate(sessionId);
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = String(
          (body.user_prompt as Record<string, unknown>)?.content
          ?? body.prompt ?? '',
        );
        claudeHeartbeat.handlePromptEvent(sessionId, prompt, Date.now());
        broadcastHookUpdate(sessionId);
        void (async () => {
          try {
            const jsonlPath = await findSessionJsonl(CLAUDE_PROJECTS_DIR, sessionId);
            const sessionDir = await findSessionDir(CLAUDE_PROJECTS_DIR, sessionId);
            if (jsonlPath && sessionDir) {
              transcriptIngestor.processFile(sessionId, jsonlPath, sessionDir);
            }
          } catch { /* isolation: ingestor errors must not affect hook processing */ }
        })();
        break;
      }
      case 'Stop':
      case 'SubagentStop': {
        claudeHeartbeat.handleStatusEvent(sessionId, 'idle');
        broadcastHookUpdate(sessionId);
        void (async () => {
          try {
            const jsonlPath = await findSessionJsonl(CLAUDE_PROJECTS_DIR, sessionId);
            const sessionDir = await findSessionDir(CLAUDE_PROJECTS_DIR, sessionId);
            if (jsonlPath && sessionDir) {
              transcriptIngestor.processFile(sessionId, jsonlPath, sessionDir);
            }
          } catch { /* isolation: ingestor errors must not affect hook processing */ }
        })();
        break;
      }
      case 'Notification': {
        const notifType = String(body.notification_type ?? '');
        if (notifType === 'permission_prompt') {
          claudeHeartbeat.handleWaitingEvent(sessionId, true);
          broadcastHookUpdate(sessionId);
        } else if (notifType === 'idle_prompt') {
          claudeHeartbeat.handleStatusEvent(sessionId, 'idle');
          broadcastHookUpdate(sessionId);
        }
        break;
      }
      case 'SessionStart': {
        claudeHeartbeat.handleStatusEvent(sessionId, 'busy');
        broadcastHookUpdate(sessionId);
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

  // DB-direct session monitoring fallback (oc-serve 없이 opencode.db 폴링)
  let dbSource: OpenCodeDbSource | null = null;
  if (ocServeEnabled && ocDbReader && ocDbReader.isAvailable()) {
    dbSource = new OpenCodeDbSource(ocDbReader, {
      dbPath: config.openCodeDbPath ?? DEFAULT_OPENCODE_DB_PATH,
    });
    dbSource.start();
    // Duck-typed check: tests may inject mock sessionCache without setDbSource
    if (sessionCache && typeof sessionCache.setDbSource === 'function') {
      sessionCache.setDbSource(dbSource);
    }
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

  // ── Progressive Summary endpoints ──

  // GET /api/session-summaries — 모든 세션의 최신 요약
  app.get('/api/session-summaries', async () => {
    if (!summaryEngine) return { summaries: [] };
    return { summaries: summaryEngine.getAllLatest() };
  });

  // GET /api/session-summaries/:sessionId — 특정 세션 요약 (latest + history)
  app.get<{ Params: { sessionId: string } }>(
    '/api/session-summaries/:sessionId',
    async (request) => {
      const { sessionId } = request.params;
      if (!summaryEngine) return { latest: null, history: [] };
      return {
        latest: summaryEngine.getLatest(sessionId),
        history: summaryEngine.getHistory(sessionId),
      };
    },
  );

  // POST /api/session-summaries/:sessionId — 수동 강제 생성
  app.post<{ Params: { sessionId: string } }>(
    '/api/session-summaries/:sessionId',
    async (request) => {
      const { sessionId } = request.params;
      if (!summaryEngine || !promptStore) {
        return { summary: null, error: 'SummaryEngine not available' };
      }

      const prompts = promptStore.getBySessionId(sessionId, 200);
      if (prompts.length === 0) {
        return { summary: null, error: 'No prompts found for session' };
      }

      const toolNames = ocDbReader?.isAvailable()
        ? ocDbReader.getToolNamesSince(sessionId, 0)
        : [];
      const title = prompts[0]?.sessionTitle ?? undefined;

      const result = await summaryEngine.generate(
        sessionId,
        prompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
        { toolNames, sessionTitle: title },
      );

      if (!result) return { summary: null, error: 'Generation failed' };
      return result;
    },
  );

  // Legacy: POST /api/session-summary/:sessionId — 이전 API 호환 (SummaryEngine 위임)
  app.post<{ Params: { sessionId: string } }>(
    '/api/session-summary/:sessionId',
    async (request) => {
      const { sessionId } = request.params;
      if (!summaryEngine || !promptStore) {
        return { summary: null, error: 'SummaryEngine not available' };
      }

      const prompts = promptStore.getBySessionId(sessionId, 200);
      if (prompts.length === 0) {
        return { summary: null, error: 'No prompts found for session' };
      }

      const toolNames = ocDbReader?.isAvailable()
        ? ocDbReader.getToolNamesSince(sessionId, 0)
        : [];
      const title = prompts[0]?.sessionTitle ?? undefined;

      const result = await summaryEngine.generate(
        sessionId,
        prompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
        { toolNames, sessionTitle: title },
      );

      if (!result) return { summary: null, error: 'Generation failed' };
      return { summary: result.summary, generatedAt: result.generatedAt, promptCount: result.promptCount };
    },
  );

  // Legacy: POST /api/enrichment/recovery/:sessionId/summarize — ContextRecovery용 (SummaryEngine 위임)
  app.post<{ Params: { sessionId: string } }>(
    '/api/enrichment/recovery/:sessionId/summarize',
    async (request) => {
      const { sessionId } = request.params;
      if (!summaryEngine || !promptStore) {
        return { summary: null, error: 'SummaryEngine not available' };
      }

      const prompts = promptStore.getBySessionId(sessionId, 200);
      if (prompts.length === 0) {
        return { summary: null, error: 'No prompts found for session' };
      }

      const toolNames = ocDbReader?.isAvailable()
        ? ocDbReader.getToolNamesSince(sessionId, 0)
        : [];
      const title = prompts[0]?.sessionTitle ?? undefined;

      const result = await summaryEngine.generate(
        sessionId,
        prompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
        { toolNames, sessionTitle: title },
      );

      if (!result) return { summary: null, error: 'Generation failed' };
      return { summary: result.summary, generatedAt: result.generatedAt };
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
    if (promptStore) promptStore.close();
    if (sessionCache) sessionCache.stop();
    if (dbSource) dbSource.stop();
    claudeHeartbeat.stop();
    if (claudeSource) claudeSource.stop();
    if (ocDbReader) ocDbReader.close();
  });

  return { app, sessionCache, promptStore };
}
