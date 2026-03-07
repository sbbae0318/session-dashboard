import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { BackendModule } from "../modules/types.js";
import type { SSEManager } from "../sse/event-stream.js";
import type { MachineManager } from '../machines/machine-manager.js';

// ── Mock data ──

const mockCards = [
  {
    version: 1,
    sessionId: "sess-001",
    startTime: 1700000000000,
    endTime: 1700000060000,
    endedAt: "2023-11-14T22:13:20.000Z",
    duration: "1m 0s",
    summary: "Fixed bug in parser",
    tools: ["Read", "Write"],
    source: "claude-code",
  },
];

const mockQueries = [
  {
    sessionId: "q-sess-001",
    sessionTitle: "Debug session",
    timestamp: 1700000050000,
    query: "How do I fix this?",
    isBackground: false,
  },
];

const mockSessions = [
  {
    sessionId: "active-001",
    parentSessionId: null,
    childSessionIds: [],
    title: "Working session",
    projectCwd: "/home/user/project",
    status: "active" as const,
    startTime: Date.now() - 60000,
    lastActivityTime: Date.now(),
    currentTool: "Write",
    duration: "1m 0s",
    summary: null,
  },
];

// ── Mock modules (each registers its own route) ──

function createMockModules(): BackendModule[] {
  const cardsModule: BackendModule = {
    id: "session-cards",
    registerRoutes(app) {
      app.get<{ Querystring: { limit?: string } }>("/api/history", async (request) => {
        const limit = parseInt(request.query.limit ?? "20", 10);
        return { cards: mockCards.slice(0, limit) };
      });
    },
  };

  const queriesModule: BackendModule = {
    id: "recent-prompts",
    registerRoutes(app) {
      app.get<{ Querystring: { limit?: string } }>("/api/queries", async (request) => {
        const limit = parseInt(request.query.limit ?? "10", 10);
        return { queries: mockQueries.slice(0, limit) };
      });
    },
  };

  const sessionsModule: BackendModule = {
    id: "active-sessions",
    registerRoutes(app) {
      app.get("/api/sessions", async () => {
        return { sessions: mockSessions };
      });
    },
  };

  return [cardsModule, queriesModule, sessionsModule];
}

function createMockSSEManager(): SSEManager {
  return {
    addClient: vi.fn().mockReturnValue("client-id"),
    removeClient: vi.fn(),
    broadcast: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
  } as unknown as SSEManager;
}

function createMockMachineManager(): MachineManager {
  return {
    getMachineStatuses: vi.fn().mockReturnValue([]),
    setStatusChangeCallback: vi.fn(),
  } as unknown as MachineManager;
}

describe("Server API", () => {
  let app: FastifyInstance;
  let sseManager: ReturnType<typeof createMockSSEManager>;

  beforeAll(async () => {
    const modules = createMockModules();
    sseManager = createMockSSEManager();
    app = await createServer(modules, sseManager, { startTime: Date.now(), machineManager: createMockMachineManager() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /health", () => {
    it("should return status ok", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("ok");
      expect(body.uptime).toBeTypeOf("number");
      expect(body.timestamp).toBeTypeOf("number");
    });
  });

  describe("GET /api/history", () => {
    it("should return cards", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/history",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.cards).toHaveLength(1);
      expect(body.cards[0].sessionId).toBe("sess-001"); // normalized from sessionID
    });
  });

  describe("GET /api/queries", () => {
    it("should return queries", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/queries",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].sessionId).toBe("q-sess-001");
      expect(body.queries[0].query).toBe("How do I fix this?");
    });
  });

  describe("GET /api/sessions", () => {
    it("should return active sessions", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("active-001");
      expect(body.sessions[0].status).toBe("active");
      expect(body.sessions[0].currentTool).toBe("Write");
    });
  });

  describe("404 handling", () => {
    it("should return 404 JSON for unknown /api/ routes", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Not found");
    });
  });
});
