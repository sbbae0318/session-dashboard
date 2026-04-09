import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../types.js";
import type { QueryEntry } from "./queries-reader.js";
import type { MachineManager } from "../../machines/machine-manager.js";

export class RecentPromptsModule implements BackendModule {
  readonly id = "recent-prompts";
  private readonly machineManager: MachineManager;
  private pollInterval: NodeJS.Timeout | null = null;

  // 세션별 프롬프트 Map (sessionId → QueryEntry[])
  private queryMap: Map<string, QueryEntry[]> = new Map();
  // query.new 감지용: 세션별 최신 타임스탬프
  private latestTimestampBySession: Map<string, number> = new Map();

  private onNewQuery: ((query: QueryEntry) => void) | null = null;
  // 7일 내 활성 세션 ID 콜백 (ActiveSessionsModule에서 주입)
  private getActiveSessionIds: (() => Set<string>) | null = null;

  private static readonly MAX_TOTAL_PROMPTS = 20_000;
  private static readonly POLL_LIMIT = 500;

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get<{ Querystring: { limit?: string; sessionId?: string } }>(
      "/api/queries",
      async (request) => {
        const limit = parseInt(request.query.limit ?? "10", 10);
        const sessionId = request.query.sessionId || undefined;

        if (sessionId) {
          // 세션별 조회: queryMap에 있으면 즉시 반환
          const cached = this.queryMap.get(sessionId);
          if (cached && cached.length > 0) {
            // 세션 뷰는 시간순(ASC)으로 반환
            return { queries: cached.slice(0, limit) };
          }
          // 캐시에 없으면 에이전트에서 직접 fetch 후 queryMap에 저장
          const raw = await this.machineManager.pollAllQueries(limit, sessionId);
          const queries: QueryEntry[] = raw.map(r => normalizeRaw(r));
          if (queries.length > 0) {
            this.queryMap.set(sessionId, this.mergeQueries([], queries));
          }
          return { queries: queries.slice(0, limit) };
        }

        return { queries: this.getAllQueries().slice(0, limit) };
      },
    );
  }

  /** Set callback for new query events (SSE broadcast) */
  setNewQueryCallback(cb: (query: QueryEntry) => void): void {
    this.onNewQuery = cb;
  }

  /** ActiveSessionsModule의 getCachedSessions() 연결 (7일 내 세션 eviction 기준) */
  setActiveSessionIdsCallback(cb: () => Set<string>): void {
    this.getActiveSessionIds = cb;
  }

  async start(): Promise<void> {
    await this.pollQueries();
    this.pollInterval = setInterval(() => {
      this.pollQueries().catch(err => {
        console.error("[RecentPrompts] Poll error:", err);
      });
    }, 2_000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  triggerPoll(): void {
    this.pollQueries().catch(err => {
      console.error("[RecentPrompts] Triggered poll error:", err);
    });
  }

  private async pollQueries(): Promise<void> {
    const rawQueries = await this.machineManager.pollAllQueries(RecentPromptsModule.POLL_LIMIT);
    const newQueries: QueryEntry[] = rawQueries.map(r => normalizeRaw(r));

    // queryMap에 merge (기존 유지 + 새 것 추가)
    for (const query of newQueries) {
      const key = query.sessionId;
      const existing = this.queryMap.get(key) ?? [];
      const deduped = this.mergeQueries(existing, [query]);
      this.queryMap.set(key, deduped);

      // query.new 감지: 세션별 최신 타임스탬프 비교
      const prevTs = this.latestTimestampBySession.get(key) ?? 0;
      if (query.timestamp > prevTs) {
        this.latestTimestampBySession.set(key, query.timestamp);
        this.onNewQuery?.(query);
      }
    }

    // 7일 밖 세션 프롬프트 제거
    this.evictStaleSessionQueries();

    // 하드 캡 초과 시 가장 오래된 세션부터 제거
    this.enforceHardCap();
  }

  private mergeQueries(existing: QueryEntry[], incoming: QueryEntry[]): QueryEntry[] {
    const seen = new Set(existing.map(q => `${q.sessionId}-${q.timestamp}`));
    const merged = [...existing];
    for (const q of incoming) {
      const k = `${q.sessionId}-${q.timestamp}`;
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(q);
      }
    }
    return merged.sort((a, b) => a.timestamp - b.timestamp); // ASC for session view
  }

  private getAllQueries(): QueryEntry[] {
    const all: QueryEntry[] = [];
    for (const entries of this.queryMap.values()) {
      all.push(...entries);
    }
    return all.sort((a, b) => b.timestamp - a.timestamp); // DESC for global view
  }

  private evictStaleSessionQueries(): void {
    if (this.getActiveSessionIds) {
      const activeIds = this.getActiveSessionIds();
      for (const sessionId of this.queryMap.keys()) {
        if (!activeIds.has(sessionId)) {
          this.queryMap.delete(sessionId);
          this.latestTimestampBySession.delete(sessionId);
        }
      }
    }
  }

  private enforceHardCap(): void {
    let totalCount = 0;
    for (const entries of this.queryMap.values()) totalCount += entries.length;

    if (totalCount <= RecentPromptsModule.MAX_TOTAL_PROMPTS) return;

    // 세션별 최신 활동 시간으로 정렬, 가장 오래된 세션부터 제거
    const sessionsByAge = [...this.queryMap.entries()]
      .map(([id, entries]) => ({
        id,
        latestTs: entries.length > 0 ? Math.max(...entries.map(e => e.timestamp)) : 0,
      }))
      .sort((a, b) => a.latestTs - b.latestTs); // 오래된 순

    while (totalCount > RecentPromptsModule.MAX_TOTAL_PROMPTS && sessionsByAge.length > 0) {
      const oldest = sessionsByAge.shift()!;
      const removed = this.queryMap.get(oldest.id)?.length ?? 0;
      this.queryMap.delete(oldest.id);
      this.latestTimestampBySession.delete(oldest.id);
      totalCount -= removed;
    }
  }
}

function normalizeRaw(raw: Record<string, unknown>): QueryEntry {
  return {
    sessionId: (raw.sessionId as string) ?? "",
    sessionTitle: (raw.sessionTitle as string | null) ?? null,
    timestamp: (raw.timestamp as number) ?? 0,
    query: (raw.query as string) ?? "",
    isBackground: (raw.isBackground as boolean) ?? false,
    source: (raw.source as string) === 'claude-code' ? 'claude-code' as const : 'opencode' as const,
    completedAt: (raw.completedAt as number | null) ?? null,
    machineId: (raw.machineId as string) ?? "",
    machineHost: (raw.machineHost as string) ?? "",
    machineAlias: (raw.machineAlias as string) ?? "",
  };
}
