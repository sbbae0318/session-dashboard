#!/usr/bin/env node
// session-dashboard CLI entrypoint

import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ActiveSessionsModule } from './modules/active-sessions/index.js';
import { RecentPromptsModule } from './modules/recent-prompts/index.js';
import { EnrichmentModule } from './modules/enrichment/index.js';
import { MemoModule } from './modules/memos/index.js';
import { SearchModule } from './modules/search/index.js';
import type { BackendModule } from './modules/types.js';
import type { DashboardSession } from './shared/api-contract.js';
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

      // Create SSE manager + modules
      const sseManager = new SSEManager();
      const activeSessions = new ActiveSessionsModule(machineManager);
      const recentPrompts = new RecentPromptsModule(machineManager);
      const dbPath = process.env.ENRICHMENT_DB_PATH ?? './data/enrichment-cache.db';
      mkdirSync(dirname(dbPath), { recursive: true });
      const enrichment = new EnrichmentModule(machineManager, sseManager, dbPath);

      const memoDbPath = process.env.MEMO_DB_PATH ?? dbPath;
      const memoDb = new Database(memoDbPath);
      memoDb.pragma('journal_mode = WAL');
      const memoDir = process.env.MEMO_DIR ?? resolve(homedir(), '.session-dashboard', 'memos');
      mkdirSync(memoDir, { recursive: true });
      const defaultMachineId = machinesConfig[0]?.id ?? 'default';
      const memos = new MemoModule(memoDb, memoDir, defaultMachineId);
      const search = new SearchModule(machineManager);

      const modules: BackendModule[] = [activeSessions, recentPrompts, enrichment, memos, search];

      // Wire module events → SSE broadcasts
      const SSE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
      // delta 감지용 이전 상태 추적
      const prevSessionHashes = new Map<string, string>();
      const prevSessionIds = new Set<string>();

      activeSessions.setUpdateCallback((sessions) => {
        // SSE는 7일 내 + active 세션만 전송 (bandwidth 절감)
        // REST /api/sessions는 전체 반환 유지
        const cutoff = Date.now() - SSE_SESSION_TTL_MS;
        const sseSessions = sessions.filter(s =>
          s.lastActivityTime >= cutoff
          || s.apiStatus === 'busy' || s.apiStatus === 'retry'
          || s.waitingForInput
        );

        const currentIds = new Set<string>();
        const updated: DashboardSession[] = [];

        for (const s of sseSessions) {
          currentIds.add(s.sessionId);
          // processMetrics 제외 — CPU/RSS가 매초 변하므로 실제 상태 변경만 감지
          const hash = `${s.lastActivityTime}|${s.apiStatus}|${s.currentTool}|${s.waitingForInput}|${s.status}|${s.title}|${s.lastPrompt}|${s.machineConnected}|${s.recentlyRenamed}`;
          const prev = prevSessionHashes.get(s.sessionId);
          if (prev !== hash) {
            updated.push(s);
            prevSessionHashes.set(s.sessionId, hash);
          }
        }

        // 제거된 세션 감지
        const removed: string[] = [];
        for (const id of prevSessionIds) {
          if (!currentIds.has(id)) {
            removed.push(id);
            prevSessionHashes.delete(id);
          }
        }

        // prevSessionIds 갱신
        prevSessionIds.clear();
        for (const id of currentIds) prevSessionIds.add(id);

        // delta가 있을 때만 전송
        if (updated.length > 0 || removed.length > 0) {
          sseManager.broadcast("session.delta", { updated, removed });
        }
      });
      recentPrompts.setNewQueryCallback((query) => {
        sseManager.broadcast("query.new", query);
      });
      recentPrompts.setActiveSessionIdsCallback(() => {
        const sessions = activeSessions.getCachedSessions();
        return new Set(sessions.map(s => s.sessionId));
      });
      // NOTE: removed duplicate query.new broadcast — RecentPromptsModule handles this
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

      // Hook SSE: Agent의 실시간 hook 이벤트 구독 (B')
      machineManager.setHookUpdateCallback(() => {
        // hook 이벤트 수신 → 즉시 poll 트리거 (cachedDetails가 이미 갱신됨)
        activeSessions.triggerPoll();
      });
      machineManager.startHookSseSubscriptions();

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
        machineManager.stopHookSseSubscriptions();
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
