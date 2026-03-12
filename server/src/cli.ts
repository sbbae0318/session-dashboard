#!/usr/bin/env node
// session-dashboard CLI entrypoint

import { resolve } from 'node:path';
import { ActiveSessionsModule } from './modules/active-sessions/index.js';
import { RecentPromptsModule } from './modules/recent-prompts/index.js';
import type { BackendModule } from './modules/types.js';
import { SSEManager } from './sse/event-stream.js';
import { createServer, startServer, stopServer } from './server.js';
import { acquireLock, setupCleanupHandlers } from './singleton.js';
import { loadMachinesConfig } from './config/machines.js';
import { MachineManager } from './machines/machine-manager.js';

const DEFAULT_PORT = 3097;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "start";

  switch (command) {
    case "start": {
      const port = parseInt(args[1] ?? String(DEFAULT_PORT), 10);

      // Acquire singleton lock
      const locked = await acquireLock();
      if (!locked) {
        console.log("session-dashboard is already running");
        process.exit(0);
      }

      // Load machines config and create MachineManager
      const machinesConfigPath = resolve(process.env.MACHINES_CONFIG ?? './machines.yml');
      const machinesConfig = loadMachinesConfig(machinesConfigPath);
      const machineManager = new MachineManager(machinesConfig);

      // Create modules
      const activeSessions = new ActiveSessionsModule(machineManager);
      const recentPrompts = new RecentPromptsModule(machineManager);
      const modules: BackendModule[] = [activeSessions, recentPrompts];

      // Create SSE manager
      const sseManager = new SSEManager();

      // Wire module events → SSE broadcasts
      activeSessions.setUpdateCallback((sessions) => {
        sseManager.broadcast("session.update", sessions);
      });
      recentPrompts.setNewQueryCallback((query) => {
        sseManager.broadcast("query.new", query);
      });
      activeSessions.setNewPromptCallback((query) => {
        sseManager.broadcast("query.new", query);
      });
      machineManager.setStatusChangeCallback((statuses) => {
        sseManager.broadcast('machine.status', statuses.map(s => ({
          id: s.machineId,
          alias: s.machineAlias,
          host: s.machineHost,
          status: s.connected ? 'connected' : 'disconnected',
          lastSeen: s.lastSeen,
          error: s.error,
          source: s.source,
        })));
      });

      // Create and start server
      const startTime = Date.now();
      const app = await createServer(modules, sseManager, { startTime, machineManager });

      // Start SSE heartbeat
      sseManager.start();

      // Start all modules
      for (const mod of modules) {
        await mod.start?.();
      }

      // Setup graceful shutdown
      setupCleanupHandlers(async () => {
        for (const mod of modules) {
          await mod.stop?.();
        }
        sseManager.stop();
        await stopServer(app);
      });

      // Start listening
      await startServer(app, port);
      break;
    }
    case "help":
    default:
      console.log("Usage: session-dashboard [start [port]]");
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
