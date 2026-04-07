import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../types.js";
import { MachineManager } from "../../machines/machine-manager.js";
import type { CachedSessionDetail } from "../../machines/machine-manager.js";
import type { QueryEntry } from "../recent-prompts/queries-reader.js";
import type { DashboardSession, SessionsResponse } from '../../shared/api-contract.js';

const SESSION_MEMORY_TTL_MS = 300_000; // 5 minutes
/** hooks 미연결 busy 세션이 이 시간 이상 비활성이면 idle로 강제 전환 */
const STALE_BUSY_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class ActiveSessionsModule implements BackendModule {
  readonly id = "active-sessions";
  private readonly machineManager: MachineManager;
  private pollInterval: NodeJS.Timeout | null = null;
  private cachedSessions: DashboardSession[] = [];
  private onUpdate: ((sessions: DashboardSession[]) => void) | null = null;
  private onNewPromptFromSession: ((query: QueryEntry) => void) | null = null;
  private previousSessionMap: Map<string, DashboardSession> = new Map();
  private previousPromptKeys: Set<string> = new Set();
  private sessionMemory: Map<string, { session: DashboardSession; lastSeenAt: number }> = new Map();

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get("/api/sessions", async (): Promise<SessionsResponse> => {
      return { sessions: this.cachedSessions };
    });
  }

  setUpdateCallback(cb: (sessions: DashboardSession[]) => void): void {
    this.onUpdate = cb;
  }

  setNewPromptCallback(cb: (query: QueryEntry) => void): void {
    this.onNewPromptFromSession = cb;
  }

  async start(): Promise<void> {
    await this.poll();
    this.pollInterval = setInterval(() => {
      this.poll().catch((err: unknown) => {
        console.error("[ActiveSessions] Poll error:", err);
      });
    }, 2_000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async poll(): Promise<void> {
    const result = await this.machineManager.pollAll();

    const rawSessions = result.sessions;
    const allStatuses = result.statuses;
    const cachedDetails = result.cachedDetails;

    const sessionMap = this.buildSessionMap(rawSessions, allStatuses, cachedDetails);

    // Build parent-child tree
    for (const session of sessionMap.values()) {
      const parentId = session.parentSessionId;
      if (parentId && sessionMap.has(parentId)) {
        sessionMap.get(parentId)!.childSessionIds.push(session.sessionId);
      }
    }

    const filtered = [...sessionMap.values()]
      .filter(s => s.source === 'claude-code' || s.title !== null || s.apiStatus !== null);

    const now = Date.now();
    for (const s of filtered) {
      this.sessionMemory.set(s.sessionId, { session: s, lastSeenAt: now });
    }

    for (const [id, entry] of this.sessionMemory) {
      if (now - entry.lastSeenAt > SESSION_MEMORY_TTL_MS) {
        this.sessionMemory.delete(id);
        continue;
      }
      const existsInCurrent = filtered.some(s => s.sessionId === id);
      if (!existsInCurrent) {
        filtered.push({ ...entry.session, status: 'idle', apiStatus: null, currentTool: null });
      }
    }

    const machineStatuses = this.machineManager.getMachineStatuses();
    const currentMachineIds = new Set(filtered.map(s => s.machineId));
    for (const ms of machineStatuses) {
      if (ms.connected && !currentMachineIds.has(ms.machineId)) {
        for (const prev of this.previousSessionMap.values()) {
          if (prev.machineId === ms.machineId && this.sessionMemory.has(prev.sessionId)) {
            filtered.push(prev);
          }
        }
      }
    }

    this.previousSessionMap = sessionMap;

    this.cachedSessions = filtered
      .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
    this.onUpdate?.(this.cachedSessions);

    if (this.onNewPromptFromSession) {
      const currentPromptKeys = new Set(
        filtered
          .filter(s => s.lastPromptTime)
          .map(s => `${s.sessionId}-${s.lastPromptTime}`),
      );
      for (const session of filtered) {
        if (!session.lastPrompt || !session.lastPromptTime) continue;
        const key = `${session.sessionId}-${session.lastPromptTime}`;
        if (!this.previousPromptKeys.has(key)) {
          this.onNewPromptFromSession({
            sessionId: session.sessionId,
            sessionTitle: session.title,
            timestamp: session.lastPromptTime,
            query: session.lastPrompt,
            isBackground: !!session.parentSessionId,
            source: session.source ?? 'opencode',
            completedAt: null,
            machineId: session.machineId,
            machineHost: session.machineHost,
            machineAlias: session.machineAlias,
          });
        }
      }
      this.previousPromptKeys = currentPromptKeys;
    }
  }

  /** Build session map from raw data, statuses, and cached details. */
  private buildSessionMap(
    rawSessions: Record<string, unknown>[],
    allStatuses: Record<string, { type: string; machineId: string }>,
    cachedDetails: Record<string, CachedSessionDetail & { machineId: string }>,
  ): Map<string, DashboardSession> {
    // Phase 3 sends ALL sessions in allStatuses (including idle).
    // Only treat busy/retry as "active" — matches pre-Phase3 behavior
    // where /session/status only returned non-idle sessions.
    const activeIds = new Set(
      Object.entries(allStatuses)
        .filter(([, v]) => v.type === 'busy' || v.type === 'retry')
        .map(([id]) => id),
    );
    const sessionMap = new Map<string, DashboardSession>();

    for (const s of rawSessions) {
      const id = String(s.id ?? '');
      if (!id || sessionMap.has(id)) continue;

      const cached = cachedDetails[id];
      const isActive = activeIds.has(id) || cached?.status === 'busy';
      const isClaudeCode = (s.source as string) === 'claude-code';

      // apiStatus: prefer cache (SSE-sourced) over REST polling — but ONLY if SSE is connected
      let apiStatus: DashboardSession['apiStatus'] = null;
      if (isClaudeCode) {
        // claude-code: no SSE cache — use REST polling status
        if (isActive) {
          apiStatus = (allStatuses[id]?.type ?? null) as DashboardSession['apiStatus'];
        }
      } else {
        if (cached && cached.sseConnected !== false) {
          // SSE connected (or sseConnected not present for backward compat) — trust cache
          apiStatus = cached.status as DashboardSession['apiStatus'];
        } else if (isActive) {
          // No cache or SSE disconnected — use REST polling status
          apiStatus = (allStatuses[id]?.type ?? null) as DashboardSession['apiStatus'];
        }
      }

      const lastActivityTime = isClaudeCode
        ? Math.max(
            (s.lastResponseTime as number) ?? 0,
            (s.lastFileModified as number) ?? 0,
            (s.lastPromptTime as number) ?? 0,
          ) || Date.now()
        : (s.time as { updated?: number })?.updated ?? Date.now();

      const hooksActive = isClaudeCode ? (cached?.hooksActive ?? false) : false;

      // Gap 5: busy + 오래된 세션 → idle 강제 전환
      // hooksActive 여부와 무관하게 lastActivityTime 기준으로 판단
      // (hooks가 fire됐더라도 Stop/idle_prompt 누락 시 영구 Working 방지)
      const isStaleBusy = isClaudeCode && isActive
        && (Date.now() - lastActivityTime > STALE_BUSY_TTL_MS);
      const effectiveActive = isActive && !isStaleBusy;
      const effectiveApiStatus = isStaleBusy ? null : apiStatus;

      sessionMap.set(id, {
        sessionId: id,
        parentSessionId: (s.parentID as string) ?? null,
        childSessionIds: [],
        title: (s.title as string) ?? null,
        projectCwd: (s.directory as string) || null,
        status: effectiveActive ? 'active' : 'idle',
        waitingForInput: isClaudeCode
          ? (cached?.waitingForInput ?? false)
          : (cached && cached.sseConnected !== false) ? (cached.waitingForInput ?? false) : false,
        startTime: isClaudeCode
          ? (s.startTime as number) ?? Date.now()
          : (s.time as { created?: number })?.created ?? Date.now(),
        lastActivityTime,
        currentTool: isClaudeCode
          ? (cached?.currentTool ?? null)
          : (cached?.currentTool ?? (allStatuses[id]?.type === 'busy' ? 'working' : null)),
        duration: null,
        summary: null,
        apiStatus: effectiveApiStatus,
        lastPrompt: cached?.lastPrompt ?? null,
        lastPromptTime: isClaudeCode
          ? (s.lastPromptTime as number | null) ?? null
          : cached?.lastPromptTime ?? null,
        source: isClaudeCode ? 'claude-code' : 'opencode',
        ...(isClaudeCode ? { hooksActive } : {}),
        processMetrics: cached?.processMetrics ?? null,
        machineId: (s.machineId as string) ?? '',
        machineHost: (s.machineHost as string) ?? '',
        machineAlias: (s.machineAlias as string) ?? '',
      });
    }

    // Synthesize sessions from SSE cache that weren't in REST results (orphan sessions)
    const machines = this.machineManager.getMachines();
    const machineLookup = new Map(machines.map(m => [m.id, m]));

    for (const [id, cached] of Object.entries(cachedDetails)) {
      if (sessionMap.has(id)) continue;
      // Skip stale cache entries — don't synthesize ghost sessions
      if (cached.sseConnected === false) continue;

      const machine = machineLookup.get(cached.machineId);

      sessionMap.set(id, {
        sessionId: id,
        parentSessionId: null,
        childSessionIds: [],
        title: this.previousSessionMap.get(id)?.title ?? null,
        projectCwd: cached.directory,
        status: 'idle',
        waitingForInput: cached.waitingForInput ?? false,
        startTime: cached.createdAt ?? cached.updatedAt,
        lastActivityTime: cached.lastActiveAt ?? cached.updatedAt,
        currentTool: cached.currentTool,
        duration: null,
        summary: null,
        apiStatus: cached.status as DashboardSession['apiStatus'],
        lastPrompt: cached.lastPrompt,
        lastPromptTime: cached?.lastPromptTime ?? null,
        machineId: cached.machineId,
        machineHost: machine?.host ?? '',
        machineAlias: machine?.alias ?? '',
        source: 'opencode',
      });
    }

    return sessionMap;
}
}
