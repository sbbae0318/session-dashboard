/**
 * Main Fastify server for dashboard-agent
 *
 * Routes:
 *   GET  /health                — Health check (no auth)
 *   POST /api/auth/token         — Issue JWT token (no auth)
 *   GET  /api/cards?limit=50     — Read cards.jsonl
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
import { ClaudeHeartbeat } from './claude-heartbeat.js';
import { ClaudeSource } from './claude-source.js';
import type { AgentConfig, HealthResponse, CardsResponse, QueriesResponse, TokenRequest } from './types.js';

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

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
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
export async function createServer(config: AgentConfig): Promise<{ app: FastifyInstance; sessionCache: SessionCache | null }> {
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

  // Conditionally create Claude modules
  let claudeHeartbeat: ClaudeHeartbeat | null = null;
  let claudeSource: ClaudeSource | null = null;
  if (claudeEnabled) {
    claudeHeartbeat = new ClaudeHeartbeat();
    claudeSource = new ClaudeSource(config.claudeHistoryDir);
    claudeHeartbeat.start();
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

  // GET /api/cards?limit=50
  app.get<{ Querystring: { limit?: string } }>('/api/cards', async (request) => {
    const limit = parseLimit(request.query.limit);
    const filePath = join(config.historyDir, 'cards.jsonl');
    const reader = new JsonlReader<Record<string, unknown>>(filePath);
    const cards = await reader.tailLines(limit);
    const response: CardsResponse = { cards };
    return response;
  });

  // GET /api/queries?limit=50
  app.get<{ Querystring: { limit?: string } }>('/api/queries', async (request) => {
    const limit = parseLimit(request.query.limit);
    const filePath = join(config.historyDir, 'queries.jsonl');
    const reader = new JsonlReader<Record<string, unknown>>(filePath);
    const queries = await reader.tailLines(limit);
    const response: QueriesResponse = { queries };
    return response;
  });

  // GET /api/sessions — proxy to oc-serve /session, wrap in { sessions }
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

      // oc-serve returns an array; wrap in { sessions } for DashboardClient
      const sessions = Array.isArray(data) ? data : [];
      return { sessions };
    } catch {
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
      const sessions = claudeHeartbeat!.getActiveSessions();
      return { sessions };
    });

    // GET /api/claude/queries?limit=50
    app.get<{ Querystring: { limit?: string } }>('/api/claude/queries', async (request) => {
      const limit = parseLimit(request.query.limit);
      const queries = await claudeSource!.getRecentQueries(limit);
      return { queries };
    });
  }

  // Graceful shutdown
  app.addHook('onClose', async () => {
    if (sessionCache) sessionCache.stop();
    if (claudeHeartbeat) claudeHeartbeat.stop();
    if (claudeSource) claudeSource.stop();
  });

  return { app, sessionCache };
}
