/**
 * SSE client that subscribes to oc-serve's /global/event endpoint,
 * caches session details in-memory, and exposes them via REST.
 *
 * Pattern: "Subscribe first, bootstrap second" — SSE connection opens
 * before REST bootstrap so no events are missed.
 */

import { get as httpGet, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { fetchJson } from './oc-serve-proxy.js';
import { SessionStore } from './session-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionDetail {
  status: 'busy' | 'idle' | 'retry';
  lastPrompt: string | null;
  lastPromptTime: number;
  currentTool: string | null;
  directory: string | null;
  updatedAt: number;
}

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

interface SseEvent {
  directory?: string;
  payload: {
    type: string;
    properties: Record<string, unknown>;
  };
}

interface OcServeProject {
  id: string;
  worktree: string;
  vcs: unknown;
  time: unknown;
  sandboxes: unknown;
}

interface OcServeMessage {
  info: { role: string; sessionID: string; time?: { created: number } };
  parts?: Array<{ type: string; text?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_TIMEOUT_MS = 60_000;
const TTL_MS = 86_400_000;
const EVICTION_INTERVAL_MS = 60_000;
const MAX_CACHE_SIZE = 500;
const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const PROMPT_MAX_LENGTH = 200;

const SYSTEM_PROMPT_PREFIXES = [
  '[SYSTEM DIRECTIVE:',
  '<command-instruction>',
  'Continue if you have next steps',
  '<ultrawork-mode>',
  '[search-mode]',
  '[analyze-mode]',
  '<session-context>',
  '<system-reminder>',
  '[system-directive',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSystemPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return SYSTEM_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function defaultSessionDetail(directory: string | null): SessionDetail {
  return {
    status: 'idle',
    lastPrompt: null,
    lastPromptTime: 0,
    currentTool: null,
    directory,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// SessionCache
// ---------------------------------------------------------------------------

export class SessionCache {
  private store: SessionStore;
  private connectionState: ConnectionState = 'disconnected';
  private response: IncomingMessage | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY;
  private sseBuffer = '';
  private sseDataLines: string[] = [];

  constructor(private ocServePort: number = 4096, dbPath?: string) {
    this.store = new SessionStore(dbPath);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    this.connectSse();
    this.evictionTimer = setInterval(() => this.evict(), EVICTION_INTERVAL_MS);
  }

  stop(): void {
    this.destroyConnection();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.connectionState = 'disconnected';
    this.store.close();
  }

  getSessionDetails(): Record<string, SessionDetail> {
    return this.store.getAll();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get('/proxy/session/details', async () => {
      return this.getSessionDetails();
    });
  }

  // -------------------------------------------------------------------------
  // SSE Connection
  // -------------------------------------------------------------------------

  private connectSse(): void {
    const url = `http://127.0.0.1:${this.ocServePort}/global/event`;
    this.sseBuffer = '';
    this.sseDataLines = [];

    const request = httpGet(url, (res) => {
      this.response = res;
      this.connectionState = 'connected';
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.resetHeartbeat();

      console.log('[SessionCache] SSE connected');

      void this.bootstrap();

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => this.parseSseChunk(chunk));

      res.on('end', () => {
        console.log('[SessionCache] SSE connection ended');
        this.onDisconnect();
      });

      res.on('error', (err) => {
        console.error('[SessionCache] SSE stream error:', err.message);
        this.onDisconnect();
      });
    });

    request.on('error', (err) => {
      console.error('[SessionCache] SSE connection error:', err.message);
      this.onDisconnect();
    });
  }

  /** Parse an SSE chunk handling TCP fragmentation via line-based buffering. */
  private parseSseChunk(chunk: string): void {
    this.resetHeartbeat();
    this.sseBuffer += chunk;

    const lines = this.sseBuffer.split('\n');
    this.sseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        this.sseDataLines.push(line.slice(6));
      } else if (line === '' && this.sseDataLines.length > 0) {
        const eventData = this.sseDataLines.join('\n');
        this.sseDataLines = [];
        this.handleRawEvent(eventData);
      }
    }
  }

  private destroyConnection(): void {
    if (this.response) {
      this.response.destroy();
      this.response = null;
    }
  }

  private onDisconnect(): void {
    this.destroyConnection();
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.connectionState === 'disconnected') return;

    this.connectionState = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay = this.reconnectDelay;
    console.log(`[SessionCache] Reconnecting in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      this.connectSse();
    }, delay);
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      console.log('[SessionCache] Heartbeat timeout — reconnecting');
      this.onDisconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Event Parsing & Dispatch
  // -------------------------------------------------------------------------

  private handleRawEvent(raw: string): void {
    let event: SseEvent;
    try {
      event = JSON.parse(raw) as SseEvent;
    } catch {
      // Malformed JSON — skip this event, keep connection alive
      return;
    }

    const eventType = event.payload?.type;
    if (!eventType) return;

    const props = event.payload.properties;
    const directory = event.directory ?? null;

    switch (eventType) {
      case 'session.status':
        this.handleSessionStatus(props, directory);
        break;
      case 'session.idle':
        this.handleSessionIdle(props, directory);
        break;
      case 'message.updated':
        this.handleMessageUpdated(props, directory);
        break;
      case 'message.part.updated':
        this.handleMessagePartUpdated(props, directory);
        break;
      default:
        break;
    }
  }

  private handleSessionStatus(props: Record<string, unknown>, directory: string | null): void {
    const sessionID = props['sessionID'] as string | undefined;
    const statusObj = props['status'] as { type?: string } | undefined;
    if (!sessionID || !statusObj?.type) return;

    const statusType = statusObj.type as SessionDetail['status'];
    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);
    this.store.upsert(sessionID, {
      ...existing,
      status: statusType,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
    });
  }

  private handleSessionIdle(props: Record<string, unknown>, directory: string | null): void {
    const sessionID = props['sessionID'] as string | undefined;
    if (!sessionID) return;

    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);
    this.store.upsert(sessionID, {
      ...existing,
      status: 'idle',
      currentTool: null,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
    });
  }

  private handleMessageUpdated(props: Record<string, unknown>, directory: string | null): void {
    const info = props['info'] as { role?: string; sessionID?: string } | undefined;
    if (!info?.sessionID || info.role !== 'user') return;

    // REST fallback — message.updated has no text
    void this.fetchFirstUserPrompt(info.sessionID, directory);
  }

  private handleMessagePartUpdated(props: Record<string, unknown>, directory: string | null): void {
    const part = props['part'] as {
      sessionID?: string;
      type?: string;
      tool?: string;
      state?: { status?: string };
    } | undefined;

    if (!part?.sessionID || part.type !== 'tool') return;

    const sessionID = part.sessionID;
    const toolStatus = part.state?.status;
    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);

    if (toolStatus === 'running') {
      this.store.upsert(sessionID, {
        ...existing,
        currentTool: part.tool ?? null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    } else if (toolStatus === 'completed') {
      this.store.upsert(sessionID, {
        ...existing,
        currentTool: null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // REST Fallback for Prompt Text
  // -------------------------------------------------------------------------

  private async fetchFirstUserPrompt(sessionID: string, directory: string | null): Promise<void> {
    // 이미 lastPrompt가 저장된 세션은 REST 재호출 skip (멱등성 최적화)
    const existing = this.store.get(sessionID);
    if (existing?.lastPrompt) return;

    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session/${sessionID}/message`;
      const data = (await fetchJson(url, {}, 3000)) as OcServeMessage[];
      if (!Array.isArray(data)) return;

      const firstUserMsg = data.find((m) => m.info?.role === 'user');
      if (!firstUserMsg) return;

      const text = firstUserMsg.parts?.[0]?.text;
      if (!text || isSystemPrompt(text)) return;

      const existingDetail = this.store.get(sessionID) ?? defaultSessionDetail(directory);
      this.store.upsert(sessionID, {
        ...existingDetail,
        lastPrompt: text.slice(0, PROMPT_MAX_LENGTH),
        lastPromptTime: firstUserMsg.info?.time?.created ?? Date.now(),
        directory: directory ?? existingDetail.directory,
        updatedAt: Date.now(),
      });
    } catch {
      // REST fetch failed — skip, don't break cache
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  private async bootstrap(): Promise<void> {
    try {
      const baseUrl = `http://127.0.0.1:${this.ocServePort}`;
      const projects = (await fetchJson(`${baseUrl}/project`, {}, 3000)) as OcServeProject[];

      if (!Array.isArray(projects)) return;

      const validProjects = projects.filter((p) => p.worktree && p.worktree !== '/');

      const statusPromises = validProjects.map((project) =>
        this.bootstrapProject(baseUrl, project.worktree),
      );

      await Promise.allSettled(statusPromises);
      console.log(`[SessionCache] Bootstrap complete — ${this.store.count()} sessions cached`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SessionCache] Bootstrap failed:', msg);
    }
  }

  private async bootstrapProject(baseUrl: string, worktree: string): Promise<void> {
    const url = `${baseUrl}/session/status?directory=${encodeURIComponent(worktree)}`;
    const statusMap = (await fetchJson(url, {}, 3000)) as Record<string, { type: string }>;

    if (!statusMap || typeof statusMap !== 'object') return;

    for (const [sessionID, statusObj] of Object.entries(statusMap)) {
      const statusType = statusObj?.type as SessionDetail['status'] | undefined;
      if (!statusType) continue;

      const existing = this.store.get(sessionID);
      this.store.upsert(sessionID, {
        status: statusType,
        lastPrompt: existing?.lastPrompt ?? null,
        lastPromptTime: existing?.lastPromptTime ?? 0,
        currentTool: existing?.currentTool ?? null,
        directory: worktree,
        updatedAt: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Eviction
  // -------------------------------------------------------------------------

  private evict(): void {
    this.store.evict(TTL_MS);

    if (this.store.count() > MAX_CACHE_SIZE) {
      const all = this.store.getAll();
      const entries = Object.entries(all);
      if (entries.length > MAX_CACHE_SIZE) {
        const sorted = entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        const toRemove = sorted.slice(0, entries.length - MAX_CACHE_SIZE);
        for (const [id] of toRemove) {
          this.store.delete(id);
        }
      }
    }
  }
}
