import type { FastifyInstance } from 'fastify';
import type { BackendModule } from '../types.js';
import type { MachineManager } from '../../machines/machine-manager.js';
import type { MachineConfig } from '../../config/machines.js';
import type { SSEManager } from '../../sse/event-stream.js';
import type {
  EnrichmentCache,
  EnrichmentFeature,
  EnrichmentResponse,
  TokensData,
  SessionCodeImpact,
  TimelineEntry,
  ProjectSummary,
  RecoveryContext,
  MergedTokensData,
  MergedEnrichmentResponse,
} from './types.js';
import { createEmptyCache } from './types.js';
import { EnrichmentCacheDB } from './enrichment-cache-db.js';

type FeatureDataMap = {
  tokens: TokensData;
  impact: SessionCodeImpact[];
  timeline: TimelineEntry[];
  projects: ProjectSummary[];
  recovery: RecoveryContext[];
};

const POLL_INTERVALS: Record<EnrichmentFeature, number> = {
  projects: 30_000,
  tokens: 60_000,
  impact: 60_000,
  timeline: 10_000,
  recovery: 10_000,
};

const FEATURES: readonly EnrichmentFeature[] = ['projects', 'tokens', 'impact', 'timeline', 'recovery'];

export class EnrichmentModule implements BackendModule {
  readonly id = 'enrichment';
  private readonly machineManager: MachineManager;
  private readonly sseManager: SSEManager;
  private readonly db: EnrichmentCacheDB;
  private readonly cache = new Map<string, EnrichmentCache>();
  private readonly timers: NodeJS.Timeout[] = [];
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(machineManager: MachineManager, sseManager: SSEManager, dbPath: string) {
    this.machineManager = machineManager;
    this.sseManager = sseManager;
    this.db = new EnrichmentCacheDB(dbPath);
  }

  registerRoutes(app: FastifyInstance): void {
    app.get('/api/enrichment', async () => {
      return Object.fromEntries(this.cache.entries());
    });

    app.get<{ Params: { machineId: string } }>(
      '/api/enrichment/:machineId',
      async (req) => {
        const { machineId } = req.params;
        return this.cache.get(machineId) ?? createEmptyCache();
      },
    );

    app.get<{
      Params: { feature: string };
      Querystring: { from?: string; to?: string };
    }>(
      '/api/enrichment/merged/:feature',
      async (req) => {
        const { feature } = req.params;
        const validFeatures: EnrichmentFeature[] = ['timeline', 'impact', 'projects', 'recovery', 'tokens'];
        if (!validFeatures.includes(feature as EnrichmentFeature)) {
          return { error: 'Invalid feature', available: false, data: null, machineCount: 0, cachedAt: 0 };
        }

        const { from: fromStr, to: toStr } = req.query;

        if (feature === 'timeline') {
          const from = fromStr ? parseInt(fromStr, 10) : 0;
          const to = toStr ? parseInt(toStr, 10) : Date.now();
          const entries = this.db.getAllTimelineEntries(from, to);
          return {
            data: entries,
            available: entries.length > 0,
            machineCount: new Set(entries.map(e => e.machineId)).size,
            cachedAt: Date.now(),
          };
        }

        const precomputed = this.db.getMergedData(feature as EnrichmentFeature);
        if (precomputed) {
          return {
            data: precomputed.data,
            available: true,
            machineCount: precomputed.machineCount,
            cachedAt: precomputed.updatedAt,
          };
        }

        return this.getMergedData(feature as EnrichmentFeature);
      },
    );

    // Timeline: 시간 윈도우 필터링 지원 (per-machine)
    app.get<{
      Params: { machineId: string };
      Querystring: { from?: string; to?: string };
    }>(
      '/api/enrichment/:machineId/timeline',
      async (req) => {
        const { machineId } = req.params;
        const { from: fromStr, to: toStr } = req.query;

        if (fromStr || toStr) {
          const from = parseInt(fromStr || '0', 10);
          const to = parseInt(toStr || String(Date.now()), 10);
          const entries = this.db.getTimelineEntries(machineId, from, to);
          return {
            data: entries,
            available: entries.length > 0,
            cachedAt: Date.now(),
          };
        }

        // 파라미터 없으면 인메모리 캐시 반환 (기존 동작)
        const cached = this.cache.get(machineId);
        return cached?.timeline ?? null;
      },
    );

    // 나머지 feature들은 기존 루프 사용 (timeline 제외)
    const NON_TIMELINE_FEATURES = FEATURES.filter(f => f !== 'timeline');
    for (const feature of NON_TIMELINE_FEATURES) {
      app.get<{ Params: { machineId: string } }>(
        `/api/enrichment/:machineId/${feature}`,
        async (req) => {
          const { machineId } = req.params;
          const cached = this.cache.get(machineId);
          return cached?.[feature] ?? null;
        },
      );
    }

    app.post<{ Params: { machineId: string; sessionId: string } }>(
      '/api/enrichment/:machineId/recovery/:sessionId/summarize',
      async (req) => {
        const { machineId, sessionId } = req.params;
        const machine = this.machineManager.getMachines().find(m => m.id === machineId);
        if (!machine) return { error: 'Machine not found' };
        return this.machineManager.fetchFromMachine(
          machine,
          `/api/enrichment/recovery/${sessionId}/summarize`,
          { method: 'POST' },
        );
      },
    );
  }

  async start(): Promise<void> {
    try {
      const loaded = this.db.loadAllCache();
      for (const [machineId, cache] of loaded) {
        this.cache.set(machineId, cache);
      }
      console.log(`[EnrichmentModule] Loaded cache for ${loaded.size} machine(s) from DB`);
    } catch (err) {
      console.warn('[EnrichmentModule] Failed to load cache from DB:', err);
    }

    // 기존 백그라운드 엔트리 정리 (stale data defense)
    try {
      const deleted = this.db.deleteBackgroundEntries();
      if (deleted > 0) {
        console.log(`[EnrichmentModule] Cleaned up ${deleted} background timeline entries`);
      }
    } catch (err) {
      console.warn('[EnrichmentModule] Failed to clean up background entries:', err);
    }

    for (const feature of FEATURES) {
      this.timers.push(
        setInterval(() => {
          this.pollFeature(feature).catch((err: unknown) => {
            console.error(`[EnrichmentModule] Poll loop error for ${feature}:`, err);
          });
        }, POLL_INTERVALS[feature]),
      );
    }

    void this.pollAll();

    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

    const runCleanup = () => {
      const cutoff = Date.now() - NINETY_DAYS_MS;
      try {
        const deleted = this.db.deleteOldEntries(cutoff, 1000);
        if (deleted > 0) {
          console.log(`[EnrichmentModule] Cleanup: deleted ${deleted} old timeline entries`);
        }
      } catch (err) {
        console.warn('[EnrichmentModule] Cleanup failed:', err);
      }
    };

    runCleanup();
    this.cleanupTimer = setInterval(runCleanup, SIX_HOURS_MS);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      this.db.close();
    } catch (err) {
      console.warn('[EnrichmentModule] Failed to close DB:', err);
    }
  }

  private async pollAll(): Promise<void> {
    await Promise.allSettled(
      FEATURES.map(feature => this.pollFeature(feature)),
    );
  }

  async pollFeature(feature: EnrichmentFeature): Promise<void> {
    const machines = this.machineManager.getMachines();

    const results = await Promise.allSettled(
      machines.map(async (machine) => {
        const data = await this.machineManager.fetchFromMachine<EnrichmentResponse<FeatureDataMap[typeof feature]>>(
          machine,
          `/api/enrichment/${feature}`,
        );
        const cached = this.cache.get(machine.id) ?? createEmptyCache();
        this.cache.set(machine.id, {
          ...cached,
          [feature]: data,
          lastUpdated: Date.now(),
        });

        try {
          this.db.saveFeatureData(machine.id, feature, data.data, data.available);

          if (feature === 'timeline' && data.available && Array.isArray(data.data)) {
            this.db.saveTimelineEntries(
              machine.id,
              machine.alias,
              data.data as TimelineEntry[],
            );
          }
        } catch (dbErr) {
          console.warn(`[EnrichmentModule] DB write failed for ${machine.id}/${feature}:`, dbErr);
        }

        this.sseManager.broadcast('enrichment.updated', {
          machineId: machine.id,
          feature,
          cachedAt: Date.now(),
        });
      }),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const machine = machines[index];
        console.warn(`[EnrichmentModule] Failed to poll ${feature} from ${machine.id}`);
      }
    }

    try {
      const merged = this.getMergedData(feature);
      this.db.saveMergedData(feature, merged.data, merged.machineCount);
      this.sseManager.broadcast('enrichment.merged.updated', {
        feature,
        machineCount: merged.machineCount,
        cachedAt: Date.now(),
      });
    } catch (err) {
      console.warn(`[EnrichmentModule] Failed to save merged data for ${feature}:`, err);
    }
  }

  getCache(): ReadonlyMap<string, EnrichmentCache> {
    return this.cache;
  }

  getDb(): EnrichmentCacheDB {
    return this.db;
  }

  private mergeTokensData(machines: readonly MachineConfig[]): MergedEnrichmentResponse<unknown> {
    let anyAvailable = false;
    let machineCount = 0;
    let cachedAt = 0;
    const machineResults: MergedTokensData['machines'] = [];
    const grandTotal: MergedTokensData['grandTotal'] = {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    };

    for (const machine of machines) {
      const cached = this.cache.get(machine.id);
      const tokenData = cached?.tokens;
      if (tokenData?.available && tokenData.data) {
        anyAvailable = true;
        machineCount++;
        cachedAt = Math.max(cachedAt, cached!.lastUpdated);
        machineResults.push({
          machineId: machine.id,
          machineAlias: machine.alias,
          data: tokenData.data,
        });
        grandTotal.input += tokenData.data.grandTotal.input;
        grandTotal.output += tokenData.data.grandTotal.output;
        grandTotal.reasoning += tokenData.data.grandTotal.reasoning;
        grandTotal.cacheRead += tokenData.data.grandTotal.cacheRead;
        grandTotal.cacheWrite += tokenData.data.grandTotal.cacheWrite;
        grandTotal.cost += tokenData.data.grandTotal.cost;
      }
    }

    const merged: MergedTokensData = { machines: machineResults, grandTotal };
    return { data: merged, available: anyAvailable, machineCount, cachedAt };
  }

  private mergeArrayFeature(
    feature: Exclude<EnrichmentFeature, 'tokens'>,
    machines: readonly MachineConfig[],
  ): MergedEnrichmentResponse<unknown> {
    let anyAvailable = false;
    let machineCount = 0;
    let cachedAt = 0;
    const allEntries: Array<Record<string, unknown> & { machineId: string; machineAlias: string }> = [];

    for (const machine of machines) {
      const cached = this.cache.get(machine.id);
      const featureData = cached?.[feature];
      if (featureData?.available && Array.isArray(featureData.data)) {
        anyAvailable = true;
        machineCount++;
        cachedAt = Math.max(cachedAt, cached!.lastUpdated);
        for (const entry of featureData.data) {
          allEntries.push({
            ...(entry as unknown as Record<string, unknown>),
            machineId: machine.id,
            machineAlias: machine.alias,
          });
        }
      }
    }

    switch (feature) {
      case 'timeline':
        allEntries.sort((a, b) => ((a.startTime as number) ?? 0) - ((b.startTime as number) ?? 0));
        break;
      case 'impact':
        allEntries.sort((a, b) => ((b.timeUpdated as number) ?? 0) - ((a.timeUpdated as number) ?? 0));
        break;
      case 'projects':
        allEntries.sort((a, b) => ((b.sessionCount as number) ?? 0) - ((a.sessionCount as number) ?? 0));
        break;
      case 'recovery':
        allEntries.sort((a, b) => ((b.lastActivityAt as number) ?? 0) - ((a.lastActivityAt as number) ?? 0));
        break;
    }

    return { data: allEntries, available: anyAvailable, machineCount, cachedAt };
  }

  getMergedData(feature: EnrichmentFeature): MergedEnrichmentResponse<unknown> {
    const machines = this.machineManager.getMachines();
    if (feature === 'tokens') {
      return this.mergeTokensData(machines);
    }
    return this.mergeArrayFeature(feature, machines);
  }
}
