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
  app.get("/health", async () => {
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
  app.get("/api/machines", async () => {
    const statuses = options.machineManager.getMachineStatuses();
    return {
      machines: statuses.map(s => ({
        id: s.machineId,
        alias: s.machineAlias,
        host: s.machineHost,
        status: s.connected ? 'connected' : 'disconnected',
        lastSeen: s.lastSeen,
        error: s.error,
        // NOTE: apiKey is NOT exposed (security)
      })),
    };
  });

  // ── Register module routes ──
  for (const mod of modules) {
    mod.registerRoutes(app);
  }

  // ── SSE endpoint ──
  // Do NOT await/return — SSEManager takes over the raw response
  app.get("/api/events", (request, reply) => {
    sseManager.addClient(reply);
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
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[Server] Listening on http://0.0.0.0:${port}`);
}

export async function stopServer(app: FastifyInstance): Promise<void> {
  await app.close();
  console.log("[Server] Stopped");
}
