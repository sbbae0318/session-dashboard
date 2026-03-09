import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../types.js";
import { MachineManager } from "../../machines/machine-manager.js";
import type { CachedSessionDetail } from "../../machines/machine-manager.js";

// DashboardSession type (matches frontend/src/types.ts)
interface DashboardSession {
  sessionId: string;
  parentSessionId: string | null;
  childSessionIds: string[];
  title: string | null;
  projectCwd: string | null;
  status: "active" | "completed" | "orphaned";
  startTime: number;
  lastActivityTime: number;
  currentTool: string | null;
  duration: string | null;
  summary: string | null;
  apiStatus: "idle" | "busy" | "retry" | null;
  lastPrompt: string | null;
  lastPromptTime: number | null;

  source?: "opencode" | "claude-code";

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

export class ActiveSessionsModule implements BackendModule {
  readonly id = "active-sessions";
  private readonly machineManager: MachineManager;
  private pollInterval: NodeJS.Timeout | null = null;
  private cachedSessions: DashboardSession[] = [];
  private onUpdate: ((sessions: DashboardSession[]) => void) | null = null;

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get("/api/sessions", async () => {
      return { sessions: this.cachedSessions };
    });
  }

  /** Set callback for session updates (SSE broadcast) */
  setUpdateCallback(cb: (sessions: DashboardSession[]) => void): void {
    this.onUpdate = cb;
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
    const [sessionResult, detailsResult] = await Promise.allSettled([
      this.machineManager.pollAllSessions(),
      this.machineManager.pollSessionDetails(),
    ]);

    const { sessions: rawSessions, statuses: allStatuses } =
      sessionResult.status === 'fulfilled'
        ? sessionResult.value
        : { sessions: [], statuses: {} as Record<string, { type: string; machineId: string }> };

    const cachedDetails =
      detailsResult.status === 'fulfilled' ? detailsResult.value : {};

    const sessionMap = this.buildSessionMap(rawSessions, allStatuses, cachedDetails);

    // Build parent-child tree
    for (const session of sessionMap.values()) {
      const parentId = session.parentSessionId;
      if (parentId && sessionMap.has(parentId)) {
        sessionMap.get(parentId)!.childSessionIds.push(session.sessionId);
      }
    }

    // Filter out ghost/background sessions (no title = not a real user session)
    // Claude Code sessions legitimately lack titles — always keep them
    // Then sort by lastActivityTime descending
    this.cachedSessions = [...sessionMap.values()]
      .filter(s => s.source === 'claude-code' || (s.title !== null && s.title !== ''))
      .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
    this.onUpdate?.(this.cachedSessions);
  }

  /** Build session map from raw data, statuses, and cached details. */
  private buildSessionMap(
    rawSessions: Record<string, unknown>[],
    allStatuses: Record<string, { type: string; machineId: string }>,
    cachedDetails: Record<string, CachedSessionDetail & { machineId: string }>,
  ): Map<string, DashboardSession> {
    const activeIds = new Set(Object.keys(allStatuses));
    const sessionMap = new Map<string, DashboardSession>();

    for (const s of rawSessions) {
      const id = String(s.id ?? '');
      if (!id || sessionMap.has(id)) continue;

      const cached = cachedDetails[id];
      const isActive = activeIds.has(id) || cached?.status === 'busy';
      const isClaudeCode = (s.source as string) === 'claude-code';

      // apiStatus: prefer cache (SSE-sourced) over REST polling — but ONLY if SSE is connected
      let apiStatus: DashboardSession['apiStatus'] = null;
      if (!isClaudeCode) {
        if (cached && cached.sseConnected !== false) {
          // SSE connected (or sseConnected not present for backward compat) — trust cache
          apiStatus = cached.status as DashboardSession['apiStatus'];
        } else if (isActive) {
          // No cache or SSE disconnected — use REST polling status
          apiStatus = (allStatuses[id]?.type ?? null) as DashboardSession['apiStatus'];
        }
      }

      sessionMap.set(id, {
        sessionId: id,
        parentSessionId: (s.parentID as string) ?? null,
        childSessionIds: [],
        title: (s.title as string) ?? null,
        projectCwd: (s.directory as string) ?? null,
        status: isActive ? 'active' : 'completed',
        startTime: isClaudeCode
          ? (s.startTime as number) ?? Date.now()
          : (s.time as { created?: number })?.created ?? Date.now(),
        lastActivityTime: isClaudeCode
          ? (s.lastResponseTime as number) ?? (s.lastFileModified as number) ?? Date.now()
          : (s.time as { updated?: number })?.updated ?? Date.now(),
        currentTool: isClaudeCode ? null : (cached?.currentTool ?? (allStatuses[id]?.type === 'busy' ? 'working' : null)),
        duration: null,
        summary: null,
        apiStatus,
        lastPrompt: cached?.lastPrompt ?? null,
        lastPromptTime: isClaudeCode
          ? (s.lastPromptTime as number | null) ?? null
          : cached?.lastPromptTime ?? null,
        source: isClaudeCode ? 'claude-code' : 'opencode',
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
        title: null,
        projectCwd: cached.directory,
        status: 'active',
        startTime: cached.updatedAt,
        lastActivityTime: cached.updatedAt,
        currentTool: cached.currentTool,
        duration: null,
        summary: null,
        apiStatus: cached.status as DashboardSession['apiStatus'],
        lastPrompt: cached.lastPrompt,
        lastPromptTime: cached?.lastPromptTime ?? null,
        machineId: cached.machineId,
        machineHost: machine?.host ?? '',
        machineAlias: machine?.alias ?? '',
      });
    }

    return sessionMap;
}
}
