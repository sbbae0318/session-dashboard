import type { FastifyInstance } from 'fastify';
import type { BackendModule } from '../types.js';
import type { MachineManager } from '../../machines/machine-manager.js';
import type { MachineConfig } from '../../config/machines.js';

interface AgentSearchResult {
  type: 'session' | 'prompt';
  sessionId: string;
  title: string | null;
  directory: string | null;
  timeCreated: number;
  timeUpdated: number;
  matchField: 'title' | 'query' | 'directory' | 'content';
  matchSnippet: string;
}

interface AgentSearchResponse {
  data: {
    results: AgentSearchResult[];
    total: number;
    hasMore: boolean;
  } | null;
  available: boolean;
  error?: string;
}

interface SearchResultWithMachine extends AgentSearchResult {
  machineId: string;
  machineAlias: string;
}

interface SearchMeta {
  totalCount: number;
  searchTimeMs: number;
  machinesSearched: number;
  machinesFailed: string[];
  timeRange: { from: number; to: number };
  hasMore: boolean;
  cached: boolean;
}

interface CacheEntry {
  results: SearchResultWithMachine[];
  meta: SearchMeta;
  timestamp: number;
}

const TIME_RANGE_MAP: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 100;
const AGENT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Search timeout')), ms),
    ),
  ]);
}

export class SearchModule implements BackendModule {
  readonly id = 'search';
  private readonly machineManager: MachineManager;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(machineManager: MachineManager) {
    this.machineManager = machineManager;
  }

  registerRoutes(app: FastifyInstance): void {
    app.post<{
      Body: {
        query: string;
        timeRange: '1h' | '24h' | '7d' | '30d' | '90d';
        limit?: number;
        offset?: number;
      };
    }>('/api/search', async (request, reply) => {
      const { query, timeRange, limit: rawLimit, offset: rawOffset } = request.body ?? {};

      if (!query || typeof query !== 'string' || query.length < 2) {
        return reply.code(400).send({ error: 'Query must be at least 2 characters' });
      }

      if (!timeRange || !(timeRange in TIME_RANGE_MAP)) {
        return reply.code(400).send({ error: 'Invalid timeRange. Must be one of: 1h, 24h, 7d, 30d, 90d' });
      }

      const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);
      const offset = Math.max(rawOffset ?? 0, 0);

      const now = Date.now();
      const from = now - TIME_RANGE_MAP[timeRange];
      const to = now;

      const cacheKey = `${query}:${timeRange}`;
      const cached = this.cache.get(cacheKey);
      if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        const paged = cached.results.slice(offset, offset + limit);
        return {
          results: paged,
          meta: {
            ...cached.meta,
            hasMore: offset + limit < cached.results.length,
            cached: true,
          },
        };
      }

      const startMs = Date.now();
      const machines = this.machineManager.getMachines();
      const machinesFailed: string[] = [];
      const allResults: SearchResultWithMachine[] = [];

      const agentResults = await Promise.allSettled(
        machines.map(machine =>
          withTimeout(
            this.fetchSearchFromAgent(machine, query, from, to, limit + offset),
            AGENT_TIMEOUT_MS,
          ).then(data => ({ machine, data })),
        ),
      );

      for (const result of agentResults) {
        if (result.status === 'fulfilled') {
          const { machine, data } = result.value;
          if (data?.data?.results) {
            for (const r of data.data.results) {
              allResults.push({
                ...r,
                machineId: machine.id,
                machineAlias: machine.alias,
              });
            }
          }
        } else {
          const machineIndex = agentResults.indexOf(result);
          const failedMachine = machines[machineIndex];
          if (failedMachine) {
            machinesFailed.push(failedMachine.id);
          }
        }
      }

      allResults.sort((a, b) => b.timeUpdated - a.timeUpdated);

      const searchTimeMs = Date.now() - startMs;
      const meta: SearchMeta = {
        totalCount: allResults.length,
        searchTimeMs,
        machinesSearched: machines.length,
        machinesFailed,
        timeRange: { from, to },
        hasMore: offset + limit < allResults.length,
        cached: false,
      };

      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, { results: allResults, meta, timestamp: Date.now() });

      if (this.cache.size > MAX_CACHE_SIZE) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }

      const paged = allResults.slice(offset, offset + limit);
      return { results: paged, meta };
    });
  }

  private async fetchSearchFromAgent(
    machine: MachineConfig,
    query: string,
    from: number,
    to: number,
    limit: number,
  ): Promise<AgentSearchResponse> {
    const params = new URLSearchParams({
      q: query,
      from: String(from),
      to: String(to),
      limit: String(limit),
      offset: '0',
    });
    const path = `/api/search?${params.toString()}`;
    return this.machineManager.fetchFromMachine<AgentSearchResponse>(machine, path);
  }
}
