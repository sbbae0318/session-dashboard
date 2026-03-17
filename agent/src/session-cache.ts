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
import { detectActiveDirectories } from './active-directories.js';

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
  // Full-cache fields (populated from REST bootstrap + incremental fetch)
  title: string | null;
  parentSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
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

interface OcServeSessionMeta {
  id: string;
  title?: string | null;
  parentID?: string;
  directory?: string;
  time?: { created: number; updated: number } | number;
}

interface OcServeMessage {
  info: { role: string; sessionID: string; time?: { created: number } };
  parts?: Array<{ type: string; text?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_TIMEOUT_MS = 60_000;
const TTL_MS = 604_800_000;
const EVICTION_INTERVAL_MS = 60_000;
const MAX_CACHE_SIZE = 2_000;
const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const PROMPT_MAX_LENGTH = 200;
const PROJECTS_CACHE_TTL_MS = 300_000; // 5 minutes

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
    title: null,
    parentSessionId: null,
    createdAt: 0,
    lastActiveAt: 0,
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
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY;
  private sseBuffer = '';
  private sseDataLines: string[] = [];
  private sseConnectedAt: number = 0;
  private lastSseEventAt: number = 0;
  private projectsCache: { projects: OcServeProject[]; updatedAt: number } = { projects: [], updatedAt: 0 };
  private pendingMetadataFetches = new Set<string>();
  private onSessionBusyCallback: (() => void) | null = null;

  constructor(private ocServePort: number = 4096, dbPath?: string) {
    this.store = new SessionStore(dbPath);
  }

  onSessionBusy(cb: () => void): void {
    this.onSessionBusyCallback = cb;
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

    app.get('/proxy/sessions-all', async () => {
      return this.getAllSessionData();
    });
  }

  async getAllSessionData(): Promise<{
    meta: SessionDetailsMeta;
    projects: Array<{ id: string; worktree: string }>;
    activeDirectories: string[];
    sessions: Record<string, SessionDetail>;
  }> {
    const [projects, activeDirectories] = await Promise.all([
      this.getCachedProjects(),
      detectActiveDirectories(),
    ]);

    return {
      meta: {
        sseConnected: this.connectionState === 'connected',
        lastSseEventAt: this.lastSseEventAt,
        sseConnectedAt: this.sseConnectedAt,
      },
      projects: projects
        .filter(p => p.worktree && p.worktree !== '/')
        .map(p => ({ id: p.id, worktree: p.worktree })),
      activeDirectories,
      sessions: this.store.getAll(),
    };
  }

  async getCachedProjects(): Promise<OcServeProject[]> {
    const now = Date.now();
    if (now - this.projectsCache.updatedAt < PROJECTS_CACHE_TTL_MS) {
      return this.projectsCache.projects;
    }
    try {
      const baseUrl = `http://127.0.0.1:${this.ocServePort}`;
      const projects = (await fetchJson(`${baseUrl}/project`, {}, 3000)) as OcServeProject[];
      if (Array.isArray(projects)) {
        this.projectsCache = { projects, updatedAt: now };
      }
      return this.projectsCache.projects;
    } catch {
      return this.projectsCache.projects;
    }
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
      case 'question.asked':
        this.handleQuestionAsked(props, directory);
        break;
      case 'question.replied':
      case 'question.rejected':
        this.handleQuestionResolved(props, directory);
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
    const isNew = !this.store.get(sessionID);
    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);
    const wasBusy = existing.status === 'busy';
    this.store.upsert(sessionID, {
      ...existing,
      status: statusType,
      waitingForInput: statusType === 'busy' ? false : existing.waitingForInput,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    const needsMeta = isNew || !existing.title || existing.title.startsWith('New session');
    if (needsMeta) this.scheduleMetadataFetch(sessionID);
    if (statusType === 'busy' && !wasBusy) this.onSessionBusyCallback?.();
  }

  private handleSessionIdle(props: Record<string, unknown>, directory: string | null): void {
    const sessionID = props['sessionID'] as string | undefined;
    if (!sessionID) return;

    const existing = this.store.get(sessionID) ?? defaultSessionDetail(directory);
    this.store.upsert(sessionID, {
      ...existing,
      status: 'idle',
      currentTool: null,
      waitingForInput: false,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    void this.fetchLatestUserPrompt(sessionID, directory);
    this.scheduleMetadataFetch(sessionID);
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

  private handleQuestionAsked(props: Record<string, unknown>, directory: string | null): void {
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

  private handleQuestionResolved(props: Record<string, unknown>, directory: string | null): void {
    const sessionID = props['sessionID'] as string | undefined;
    if (!sessionID) return;

    const existing = this.store.get(sessionID);
    if (!existing) return;

    this.store.upsert(sessionID, {
      ...existing,
      waitingForInput: false,
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
    const cachedIds = Object.keys(this.store.getAll());
    if (cachedIds.length === 0) return;

    // Fetch all session IDs known to oc-serve across all projects
    const ocServeIds = await this.fetchAllOcServeSessionIds();
    if (ocServeIds === null) return; // oc-serve unreachable — skip to avoid false positives

    let deletedCount = 0;
    for (const id of cachedIds) {
      if (!ocServeIds.has(id)) {
        this.store.delete(id);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`[SessionCache] Purged ${deletedCount} stale session(s) not found in oc-serve`);
    }
  }

  /**
   * Fetch all session IDs from oc-serve by querying /session per project.
   * Returns null if oc-serve is unreachable (to prevent false-positive deletions).
   */
  private async fetchAllOcServeSessionIds(): Promise<Set<string> | null> {
    try {
      const baseUrl = `http://127.0.0.1:${this.ocServePort}`;
      const projects = (await fetchJson(`${baseUrl}/project`, {}, 3000)) as OcServeProject[];
      if (!Array.isArray(projects)) return null;

      const ids = new Set<string>();

      // Query sessions per project in parallel
      const results = await Promise.allSettled(
        projects
          .filter(p => p.worktree)
          .map(async (project) => {
            const dir = encodeURIComponent(project.worktree);
            const url = `${baseUrl}/session?directory=${dir}&limit=2000`;
            const sessions = (await fetchJson(url, {}, 5000)) as Array<{ id?: string }>;
            if (Array.isArray(sessions)) {
              for (const s of sessions) {
                if (s.id) ids.add(String(s.id));
              }
            }
          }),
      );

      // If zero projects succeeded, treat as unreachable
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      if (succeeded === 0 && projects.filter(p => p.worktree).length > 0) return null;

      return ids;
    } catch {
      return null; // /project fetch failed — oc-serve unreachable
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
  // Session Metadata Fetch (title, parentID, createdAt for new sessions)
  // -------------------------------------------------------------------------

  private scheduleMetadataFetch(sessionID: string): void {
    if (this.pendingMetadataFetches.has(sessionID)) return;
    this.pendingMetadataFetches.add(sessionID);
    void this.fetchSessionMetadata(sessionID).finally(() => {
      this.pendingMetadataFetches.delete(sessionID);
    });
  }

  private async fetchSessionMetadata(sessionID: string): Promise<void> {
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session/${sessionID}`;
      const data = (await fetchJson(url, {}, 3000)) as OcServeSessionMeta;
      if (!data?.id) return;

      const existing = this.store.get(sessionID);
      if (!existing) return;

      const timeObj = data.time;
      const createdAt = typeof timeObj === 'object' ? timeObj?.created ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);

      this.store.upsert(sessionID, {
        ...existing,
        title: data.title ?? existing.title,
        parentSessionId: data.parentID ?? existing.parentSessionId,
        createdAt: createdAt || existing.createdAt,
        directory: data.directory ?? existing.directory,
      });
    } catch {
      // REST fetch failed — metadata stays as-is
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

      this.projectsCache = { projects, updatedAt: Date.now() };

      const validProjects = projects.filter((p) => p.worktree && p.worktree !== '/');

      if (this.connectionState !== 'connected') return;

      const BATCH_SIZE = 4;
      for (let i = 0; i < validProjects.length; i += BATCH_SIZE) {
        const batch = validProjects.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map((project) => this.bootstrapProject(baseUrl, project.worktree)),
        );
      }
      await this.bootstrapPendingInputs(baseUrl);

      // Re-fetch metadata for sessions with placeholder titles
      const allSessions = this.store.getAll();
      const staleTitleSessions: string[] = [];
      for (const [sid, detail] of Object.entries(allSessions)) {
        if (!detail.title || detail.title.startsWith('New session')) {
          staleTitleSessions.push(sid);
        }
      }
      if (staleTitleSessions.length > 0) {
        console.log(`[SessionCache] Refreshing ${staleTitleSessions.length} stale title(s)`);
        for (const sid of staleTitleSessions) {
          this.scheduleMetadataFetch(sid);
        }
      }

      console.log(`[SessionCache] Bootstrap complete — ${this.store.count()} sessions cached`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SessionCache] Bootstrap failed:', msg);
    }
  }

  private async bootstrapPendingInputs(baseUrl: string): Promise<void> {
    const [questions, permissions] = await Promise.all([
      fetchJson(`${baseUrl}/question`, {}, 3000)
        .then(d => (Array.isArray(d) ? d : []) as Array<{ sessionID?: string }>)
        .catch(() => [] as Array<{ sessionID?: string }>),
      fetchJson(`${baseUrl}/permission`, {}, 3000)
        .then(d => (Array.isArray(d) ? d : []) as Array<{ sessionID?: string }>)
        .catch(() => [] as Array<{ sessionID?: string }>),
    ]);

    const pendingSessionIds = new Set<string>();
    for (const q of questions) {
      if (q.sessionID) pendingSessionIds.add(q.sessionID);
    }
    for (const p of permissions) {
      if (p.sessionID) pendingSessionIds.add(p.sessionID);
    }

    for (const sessionID of pendingSessionIds) {
      const existing = this.store.get(sessionID);
      if (!existing) continue;
      this.store.upsert(sessionID, {
        ...existing,
        waitingForInput: true,
        updatedAt: Date.now(),
      });
    }

    if (pendingSessionIds.size > 0) {
      console.log(`[SessionCache] Bootstrap: ${pendingSessionIds.size} session(s) waiting for input`);
    }
  }

  private async bootstrapProject(baseUrl: string, worktree: string): Promise<void> {
    const encodedDir = encodeURIComponent(worktree);
    const [statusMap, sessionList] = await Promise.all([
      fetchJson(`${baseUrl}/session/status?directory=${encodedDir}`, {}, 3000)
        .then(d => d as Record<string, { type: string }>)
        .catch(() => ({} as Record<string, { type: string }>)),
      fetchJson(`${baseUrl}/session?directory=${encodedDir}&limit=2000`, {}, 10000)
        .then(d => (Array.isArray(d) ? d : []) as OcServeSessionMeta[])
        .catch(() => [] as OcServeSessionMeta[]),
    ]);

    if (!statusMap || typeof statusMap !== 'object') return;

    const metaMap = new Map<string, OcServeSessionMeta>();
    for (const s of sessionList) {
      if (s.id) metaMap.set(s.id, s);
    }

    for (const [sessionID, statusObj] of Object.entries(statusMap)) {
      const statusType = statusObj?.type as SessionDetail['status'] | undefined;
      if (!statusType) continue;

      const existing = this.store.get(sessionID);
      const meta = metaMap.get(sessionID);

      if (existing && existing.updatedAt >= this.sseConnectedAt) {
        const titleStale = !existing.title || existing.title.startsWith('New session');
        if (meta && (titleStale || !existing.createdAt)) {
          const timeObj = meta.time;
          const createdAt = typeof timeObj === 'object' ? timeObj?.created ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
          const lastActiveAt = typeof timeObj === 'object' ? timeObj?.updated ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
          this.store.upsert(sessionID, {
            ...existing,
            title: meta.title ?? existing.title ?? null,
            parentSessionId: meta.parentID ?? existing.parentSessionId ?? null,
            createdAt: createdAt || existing.createdAt,
            lastActiveAt: lastActiveAt || existing.lastActiveAt,
          });
        }
        continue;
      }

      const timeObj = meta?.time;
      const createdAt = typeof timeObj === 'object' ? timeObj?.created ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
      const lastActiveAt = typeof timeObj === 'object' ? timeObj?.updated ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);

      this.store.upsert(sessionID, {
        status: statusType,
        lastPrompt: existing?.lastPrompt ?? null,
        lastPromptTime: existing?.lastPromptTime ?? 0,
        currentTool: existing?.currentTool ?? null,
        directory: worktree,
        waitingForInput: existing?.waitingForInput ?? false,
        updatedAt: Date.now(),
        title: meta?.title ?? existing?.title ?? null,
        parentSessionId: meta?.parentID ?? existing?.parentSessionId ?? null,
        createdAt: createdAt || (existing?.createdAt ?? 0),
        lastActiveAt: lastActiveAt || (existing?.lastActiveAt ?? 0),
      });
    }

    // Sessions in session list but not in status map (idle sessions)
    for (const meta of sessionList) {
      if (!meta.id) continue;
      const existing = this.store.get(meta.id);
      if (existing) {
        const titleStale = !existing.title || existing.title.startsWith('New session');
        if (titleStale || !existing.createdAt) {
          const timeObj = meta.time;
          const createdAt = typeof timeObj === 'object' ? timeObj?.created ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
          const lastActiveAt = typeof timeObj === 'object' ? timeObj?.updated ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
          this.store.upsert(meta.id, {
            ...existing,
            title: meta.title ?? existing.title ?? null,
            parentSessionId: meta.parentID ?? existing.parentSessionId ?? null,
            createdAt: createdAt || existing.createdAt,
            lastActiveAt: lastActiveAt || existing.lastActiveAt,
          });
        }
        continue;
      }
      const timeObj = meta.time;
      const createdAt = typeof timeObj === 'object' ? timeObj?.created ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);
      const lastActiveAt = typeof timeObj === 'object' ? timeObj?.updated ?? 0 : (typeof timeObj === 'number' ? timeObj : 0);

      this.store.upsert(meta.id, {
        status: 'idle',
        lastPrompt: null,
        lastPromptTime: 0,
        currentTool: null,
        directory: meta.directory ?? worktree,
        waitingForInput: false,
        updatedAt: Date.now(),
        title: meta.title ?? null,
        parentSessionId: meta.parentID ?? null,
        createdAt,
        lastActiveAt,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Eviction
  // -------------------------------------------------------------------------

  private evict(): void {
    this.store.evictByActivity(TTL_MS);

    if (this.store.count() > MAX_CACHE_SIZE) {
      const all = this.store.getAll();
      const entries = Object.entries(all);
      if (entries.length > MAX_CACHE_SIZE) {
        const sorted = entries.sort((a, b) => {
          const aTime = a[1].lastActiveAt || a[1].updatedAt;
          const bTime = b[1].lastActiveAt || b[1].updatedAt;
          return aTime - bTime;
        });
        const toRemove = sorted.slice(0, entries.length - MAX_CACHE_SIZE);
        for (const [id] of toRemove) {
          this.store.delete(id);
        }
      }
    }
  }
}
