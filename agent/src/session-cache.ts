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
import { extractUserPrompt } from './prompt-extractor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionDetail {
  status: 'busy' | 'idle' | 'retry';
  lastPrompt: string | null;
  lastPromptTime: number;
  currentTool: string | null;
  directory: string | null;
  waitingForInput: boolean;
  updatedAt: number;
}

interface SessionDetailsMeta {
  sseConnected: boolean;
  lastSseEventAt: number;
  sseConnectedAt: number;
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
    waitingForInput: false,
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
  private deletionCheckTimer: NodeJS.Timeout | null = null;
  private deletionCheckOffset: number = 0;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY;
  private sseBuffer = '';
  private sseDataLines: string[] = [];
  private sseConnectedAt: number = 0;
  private lastSseEventAt: number = 0;

  constructor(private ocServePort: number = 4096, dbPath?: string) {
    this.store = new SessionStore(dbPath);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    this.connectSse();
    this.evictionTimer = setInterval(() => this.evict(), EVICTION_INTERVAL_MS);
    this.deletionCheckTimer = setInterval(() => { void this.checkDeletedSessions(); }, 60_000);
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
    if (this.deletionCheckTimer) {
      clearInterval(this.deletionCheckTimer);
      this.deletionCheckTimer = null;
    }
    this.connectionState = 'disconnected';
    this.store.close();
  }

  getSessionDetails(): { meta: SessionDetailsMeta; sessions: Record<string, SessionDetail> } {
    return {
      meta: {
        sseConnected: this.connectionState === 'connected',
        lastSseEventAt: this.lastSseEventAt,
        sseConnectedAt: this.sseConnectedAt,
      },
      sessions: this.store.getAll(),
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getSseConnectedAt(): number {
    return this.sseConnectedAt;
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
      this.sseConnectedAt = Date.now();
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
    this.lastSseEventAt = Date.now();
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
      case 'permission.updated':
        this.handlePermissionUpdated(props, directory);
        break;
      case 'session.deleted':
        this.handleSessionDeleted(props);
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
      // busy 전환 = 사용자가 응답해서 작업 재개된 것 → waitingForInput 리셋
      waitingForInput: statusType === 'busy' ? false : existing.waitingForInput,
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

    // idle = turn 완료 → 최신 user prompt 갱신
    void this.fetchLatestUserPrompt(sessionID, directory);
  }

  private handleMessageUpdated(props: Record<string, unknown>, directory: string | null): void {
    const info = props['info'] as { role?: string; sessionID?: string } | undefined;
    if (!info?.sessionID || info.role !== 'user') return;

    // REST fallback — message.updated has no text
    void this.fetchLatestUserPrompt(info.sessionID, directory);
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
        waitingForInput: false,
        currentTool: part.tool ?? null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    } else if (toolStatus === 'completed') {
      this.store.upsert(sessionID, {
        ...existing,
        waitingForInput: false,
        currentTool: null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    } else if (toolStatus === 'pending') {
      this.store.upsert(sessionID, {
        ...existing,
        waitingForInput: true,
        currentTool: part.tool ?? null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    }
  }

  private handlePermissionUpdated(props: Record<string, unknown>, directory: string | null): void {
    const sessionID = props['sessionID'] as string | undefined;
    if (!sessionID) return;

    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);
    this.store.upsert(sessionID, {
      ...existing,
      waitingForInput: true,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
    });
  }

  private handleSessionDeleted(props: Record<string, unknown>): void {
    const info = props['info'] as { id?: string } | undefined;
    const sessionID = info?.id ?? (props['sessionID'] as string | undefined);
    if (!sessionID) return;
    this.store.delete(sessionID);
  }

  // -------------------------------------------------------------------------
  // REST Fallback — Deletion Check
  // -------------------------------------------------------------------------

  private async checkDeletedSessions(): Promise<void> {
    const allSessions = this.store.getAll();
    const ids = Object.keys(allSessions);
    if (ids.length === 0) return;

    // round-robin: offset부터 최대 10개
    if (this.deletionCheckOffset >= ids.length) {
      this.deletionCheckOffset = 0;
    }
    const batch = ids.slice(this.deletionCheckOffset, this.deletionCheckOffset + 10);
    this.deletionCheckOffset += batch.length;

    for (const sessionID of batch) {
      try {
        const url = `http://127.0.0.1:${this.ocServePort}/session/${sessionID}`;
        await fetchJson(url, {}, 3000);
        // Session exists — keep it
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404')) {
          this.store.delete(sessionID);
        }
        // Network error or other status → preserve session (false positive 방지)
      }
    }
  }

  // -------------------------------------------------------------------------
  // REST Fallback for Prompt Text
  // -------------------------------------------------------------------------

  private async fetchLatestUserPrompt(sessionID: string, directory: string | null): Promise<void> {
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session/${sessionID}/message`;
      const data = (await fetchJson(url, {}, 3000)) as OcServeMessage[];
      if (!Array.isArray(data)) return;

      // 역순 순회로 마지막 유효 user message 찾기
      let lastUserMsg: OcServeMessage | undefined;
      for (let i = data.length - 1; i >= 0; i--) {
        const m = data[i];
        if (m.info?.role !== 'user') continue;
        const text = m.parts?.[0]?.text;
        if (!text) continue;
        if (extractUserPrompt(text) !== null) {
          lastUserMsg = m;
          break;
        }
      }
      if (!lastUserMsg) return;

      const text = lastUserMsg.parts?.[0]?.text;
      if (!text) return;

      const existingDetail = this.store.get(sessionID) ?? defaultSessionDetail(directory);
      this.store.upsert(sessionID, {
        ...existingDetail,
        lastPrompt: text.slice(0, PROMPT_MAX_LENGTH),
        lastPromptTime: lastUserMsg.info?.time?.created ?? Date.now(),
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

      if (this.connectionState !== 'connected') return;

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
      if (existing && existing.updatedAt >= this.sseConnectedAt) continue;

      this.store.upsert(sessionID, {
        status: statusType,
        lastPrompt: existing?.lastPrompt ?? null,
        lastPromptTime: existing?.lastPromptTime ?? 0,
        currentTool: existing?.currentTool ?? null,
        directory: worktree,
        waitingForInput: existing?.waitingForInput ?? false,
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
