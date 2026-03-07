import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../types.js";
import type { HistoryCard } from "./cards-reader.js";
import type { MachineManager } from "../../machines/machine-manager.js";

export class SessionCardsModule implements BackendModule {
  readonly id = "session-cards";
  private readonly machineManager: MachineManager;
  private pollInterval: NodeJS.Timeout | null = null;
  private cachedCards: HistoryCard[] = [];
  private onNewCard: ((card: HistoryCard) => void) | null = null;

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.get<{ Querystring: { limit?: string } }>(
      "/api/history",
      async (request) => {
        const limit = parseInt(request.query.limit ?? "20", 10);
        return { cards: this.cachedCards.slice(0, limit) };
      },
    );
  }

  /** Set callback for new card events (SSE broadcast) */
  setNewCardCallback(cb: (card: HistoryCard) => void): void {
    this.onNewCard = cb;
  }

  async start(): Promise<void> {
    await this.pollCards();
    this.pollInterval = setInterval(() => {
      this.pollCards().catch(err => {
        console.error("[SessionCards] Poll error:", err);
      });
    }, 5_000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollCards(): Promise<void> {
    const rawCards = await this.machineManager.pollAllCards(100);
    const newCards: HistoryCard[] = rawCards.map(raw => ({
      version: (raw.version as 1 | 2) ?? 1,
      sessionId: (raw.sessionID as string) ?? (raw.sessionId as string) ?? "",
      sessionTitle: (raw.sessionTitle as string) ?? undefined,
      startTime: (raw.startTime as number) ?? 0,
      endTime: (raw.endTime as number) ?? 0,
      endedAt: (raw.endedAt as string) ?? "",
      duration: (raw.duration as string) ?? "",
      summary: (raw.summary as string) ?? "",
      tools: (raw.tools as string[]) ?? [],
      source: (raw.source as string) ?? undefined,
      project: raw.project as HistoryCard["project"],
      parentSessionID: (raw.parentSessionID as string) ?? undefined,
      endReason: (raw.endReason as string) ?? undefined,
      tokenUsage: raw.tokenUsage as HistoryCard["tokenUsage"],
      machineId: raw.machineId,
      machineHost: raw.machineHost,
      machineAlias: raw.machineAlias,
    }));

    // Detect new cards by composite key (sessionId + endTime)
    const previousKeys = new Set(this.cachedCards.map(c => `${c.sessionId}-${c.endTime}`));
    for (const card of newCards) {
      if (card.sessionId && !previousKeys.has(`${card.sessionId}-${card.endTime}`)) {
        this.onNewCard?.(card);
      }
    }

    this.cachedCards = newCards;
  }
}
