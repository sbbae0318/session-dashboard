import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../types.js";
import type { QueryEntry } from "./queries-reader.js";
import type { MachineManager } from "../../machines/machine-manager.js";

export class RecentPromptsModule implements BackendModule {
  readonly id = "recent-prompts";
  private readonly machineManager: MachineManager;
  private pollInterval: NodeJS.Timeout | null = null;
  private cachedQueries: QueryEntry[] = [];
  private onNewQuery: ((query: QueryEntry) => void) | null = null;

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get<{ Querystring: { limit?: string } }>(
      "/api/queries",
      async (request) => {
        const limit = parseInt(request.query.limit ?? "10", 10);
        return { queries: this.cachedQueries.slice(0, limit) };
      },
    );
  }

  /** Set callback for new query events (SSE broadcast) */
  setNewQueryCallback(cb: (query: QueryEntry) => void): void {
    this.onNewQuery = cb;
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
    const rawQueries = await this.machineManager.pollAllQueries(100);
    const newQueries: QueryEntry[] = rawQueries.map(raw => ({
      sessionId: (raw.sessionId as string) ?? "",
      sessionTitle: (raw.sessionTitle as string | null) ?? null,
      timestamp: (raw.timestamp as number) ?? 0,
      query: (raw.query as string) ?? "",
      isBackground: (raw.isBackground as boolean) ?? false,
      source: (raw.source as string) === 'claude-code' ? 'claude-code' as const : 'opencode' as const,
      completedAt: (raw.completedAt as number | null) ?? null,
      machineId: raw.machineId,
      machineHost: raw.machineHost,
      machineAlias: raw.machineAlias,
    }));

    // Detect new queries (by sessionId+timestamp not in previous cache)
    const previousKeys = new Set(
      this.cachedQueries.map(q => `${q.sessionId}-${q.timestamp}`),
    );
    for (const query of newQueries) {
      if (!previousKeys.has(`${query.sessionId}-${query.timestamp}`)) {
        this.onNewQuery?.(query);
      }
    }

    this.cachedQueries = newQueries;
  }
}
