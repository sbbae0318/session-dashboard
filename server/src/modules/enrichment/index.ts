import type { FastifyInstance } from 'fastify';
import type { BackendModule } from '../types.js';
import type { MachineManager } from '../../machines/machine-manager.js';
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
  private readonly cache = new Map<string, EnrichmentCache>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(machineManager: MachineManager, sseManager: SSEManager) {
    this.machineManager = machineManager;
    this.sseManager = sseManager;
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

    // Merged: all machines combined for a given feature
    app.get<{ Params: { feature: string } }>(
      '/api/enrichment/merged/:feature',
      async (req) => {
        const { feature } = req.params;
        const validFeatures: EnrichmentFeature[] = ['timeline', 'impact', 'projects', 'recovery', 'tokens'];
        if (!validFeatures.includes(feature as EnrichmentFeature)) {
          return { error: 'Invalid feature', available: false, data: null, machineCount: 0, cachedAt: 0 };
        }
        return this.getMergedData(feature as EnrichmentFeature);
      },
    );

    for (const feature of FEATURES) {
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
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
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
        this.sseManager.broadcast('enrichment.update', {
          machineId: machine.id,
          feature,
        });
      }),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const machine = machines[index];
        console.warn(`[EnrichmentModule] Failed to poll ${feature} from ${machine.id}`);
      }
    }
  }

  getCache(): ReadonlyMap<string, EnrichmentCache> {
    return this.cache;
  }

  getMergedData(feature: EnrichmentFeature): MergedEnrichmentResponse<unknown> {
    const machines = this.machineManager.getMachines();
    let anyAvailable = false;
    let machineCount = 0;
    let cachedAt = 0;

    if (feature === 'tokens') {
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
}
