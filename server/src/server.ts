/**
 * Fastify REST API server for session-dashboard
 *
 * Routes:
 *   GET /health          — Health check
 *   GET /api/events      — SSE stream
 *   GET /                — Static files (Svelte SPA)
 *   GET /*               — SPA fallback → index.html
 *   + module-registered routes (/api/queries, /api/sessions)
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendModule } from "./modules/types.js";
import type { SSEManager } from "./sse/event-stream.js";
import type { MachineManager } from './machines/machine-manager.js';
import type { EnrichmentModule } from './modules/enrichment/index.js';
import type { HealthResponse, MachinesResponse } from './shared/api-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  readonly startTime: number;
}

export async function createServer(
  modules: readonly BackendModule[],
  sseManager: SSEManager,
  options: ServerOptions & { machineManager: MachineManager },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // CORS — allow all origins for local dashboard
  await app.register(fastifyCors, { origin: true });

  // Static file serving (dist/public/)
  // decorateReply defaults to true → enables reply.sendFile() for SPA fallback
  const publicDir = join(__dirname, "..", "dist", "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false, // let explicit routes take priority
  });

  // ── Health check ──
  app.get("/health", async (): Promise<HealthResponse> => {
    const statuses = options.machineManager.getMachineStatuses();
    return {
      status: "ok",
      uptime: Date.now() - options.startTime,
      timestamp: Date.now(),
      connectedMachines: statuses.filter(s => s.connected).length,
      totalMachines: statuses.length,
    };
  });

  // ── Machine statuses ──
  app.get("/api/machines", async (): Promise<MachinesResponse> => {
    const statuses = options.machineManager.getMachineStatuses();
    return {
      machines: statuses.map(s => ({
        id: s.machineId,
        alias: s.machineAlias,
        host: s.machineHost,
        status: s.connected ? 'connected' as const : 'disconnected' as const,
        lastSeen: s.lastSeen,
        error: s.error,
      })),
    };
  });

  // ── Prompt response fetch (proxy to agent) ──
  app.get<{ Querystring: { sessionId?: string; timestamp?: string; source?: string; machineId?: string } }>(
    "/api/prompt-response",
    async (request) => {
      const { sessionId, timestamp, source, machineId } = request.query;
      if (!sessionId || !timestamp) return { response: null, error: 'missing params' };

      const machines = options.machineManager.getMachines();
      const target = machineId
        ? machines.find(m => m.id === machineId)
        : machines[0];
      if (!target) return { response: null, error: 'no machine' };

      try {
        const qs = `sessionId=${encodeURIComponent(sessionId)}&timestamp=${timestamp}&source=${source ?? ''}`;
        const result = await options.machineManager.fetchFromMachine<{ response: string | null }>(
          target,
          `/api/prompt-response?${qs}`,
        );
        return result;
      } catch {
        return { response: null, error: 'agent fetch failed' };
      }
    },
  );

  // ── Register module routes ──
  for (const mod of modules) {
    mod.registerRoutes(app);
  }

  // ── SSE endpoint ──
  // Do NOT await/return — SSEManager takes over the raw response
  app.get("/api/events", (request, reply) => {
    const clientId = sseManager.addClient(reply);

    const enrichmentModule = modules.find(m => m.id === 'enrichment') as EnrichmentModule | undefined;
    if (enrichmentModule) {
      const cache = enrichmentModule.getCache();
      for (const [machineId, machineCache] of cache) {
        const features = ['tokens', 'impact', 'timeline', 'projects', 'recovery'] as const;
        for (const feature of features) {
          const featureData = machineCache[feature];
          if (featureData) {
            sseManager.sendToClient(clientId, 'enrichment.cache', {
              machineId,
              feature,
              cachedAt: featureData.cachedAt,
            });
          }
        }
      }
    }
  });

  // ── SPA fallback ──
  // Non-API routes that don't match static files → serve index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

export async function startServer(
  app: FastifyInstance,
  port: number = 3097,
): Promise<void> {
  const host = process.env['HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });
  console.log(`[Server] Listening on http://${host}:${port}`);
}

export async function stopServer(app: FastifyInstance): Promise<void> {
  await app.close();
  console.log("[Server] Stopped");
}
