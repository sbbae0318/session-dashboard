import Database from 'better-sqlite3';
import type {
  EnrichmentCache,
  EnrichmentFeature,
  EnrichmentResponse,
  TimelineEntry,
  MergedTimelineEntry,
} from './types.js';
import { createEmptyCache } from './types.js';

const FEATURE_KEYS: readonly EnrichmentFeature[] = [
  'tokens',
  'impact',
  'timeline',
  'projects',
  'recovery',
] as const;

export class EnrichmentCacheDB {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrichment_cache (
        machine_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        data TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (machine_id, feature)
      );

      CREATE TABLE IF NOT EXISTS enrichment_merged (
        feature TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        machine_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timeline_entries (
        session_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        machine_alias TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, machine_id)
      );

      CREATE INDEX IF NOT EXISTS idx_timeline_start ON timeline_entries(start_time);
      CREATE INDEX IF NOT EXISTS idx_timeline_machine ON timeline_entries(machine_id, start_time);
    `);
  }

  saveFeatureData(
    machineId: string,
    feature: EnrichmentFeature,
    data: unknown,
    available: boolean,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO enrichment_cache (machine_id, feature, data, available, updated_at)
      VALUES (:machineId, :feature, :data, :available, :updatedAt)
      ON CONFLICT (machine_id, feature) DO UPDATE SET
        data = excluded.data,
        available = excluded.available,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      machineId,
      feature,
      data: JSON.stringify(data),
      available: available ? 1 : 0,
      updatedAt: Date.now(),
    });
  }

  loadAllCache(): Map<string, EnrichmentCache> {
    const rows = this.db.prepare(
      'SELECT machine_id, feature, data, available, updated_at FROM enrichment_cache',
    ).all() as Array<{
      machine_id: string;
      feature: string;
      data: string;
      available: number;
      updated_at: number;
    }>;

    const result = new Map<string, EnrichmentCache>();

    for (const row of rows) {
      if (!result.has(row.machine_id)) {
        result.set(row.machine_id, createEmptyCache());
      }
      const cache = result.get(row.machine_id)!;
      const feature = row.feature as EnrichmentFeature;

      if (!FEATURE_KEYS.includes(feature)) continue;

      const parsed: unknown = JSON.parse(row.data);
      const response: EnrichmentResponse<typeof parsed> = {
        data: parsed,
        available: row.available === 1,
        cachedAt: row.updated_at,
      };

      switch (feature) {
        case 'tokens':
          cache.tokens = response as EnrichmentCache['tokens'];
          break;
        case 'impact':
          cache.impact = response as EnrichmentCache['impact'];
          break;
        case 'timeline':
          cache.timeline = response as EnrichmentCache['timeline'];
          break;
        case 'projects':
          cache.projects = response as EnrichmentCache['projects'];
          break;
        case 'recovery':
          cache.recovery = response as EnrichmentCache['recovery'];
          break;
      }
      cache.lastUpdated = Math.max(cache.lastUpdated, row.updated_at);
    }

    return result;
  }

  saveTimelineEntries(
    machineId: string,
    machineAlias: string,
    entries: readonly TimelineEntry[],
  ): void {
    if (entries.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO timeline_entries (session_id, machine_id, machine_alias, start_time, end_time, data, updated_at)
      VALUES (:sessionId, :machineId, :machineAlias, :startTime, :endTime, :data, :updatedAt)
      ON CONFLICT (session_id, machine_id) DO UPDATE SET
        machine_alias = excluded.machine_alias,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        data = excluded.data,
        updated_at = excluded.updated_at
    `);

    const now = Date.now();
    const insertMany = this.db.transaction((items: readonly TimelineEntry[]) => {
      for (const entry of items) {
        stmt.run({
          sessionId: entry.sessionId,
          machineId,
          machineAlias,
          startTime: entry.startTime,
          endTime: entry.endTime ?? null,
          data: JSON.stringify(entry),
          updatedAt: now,
        });
      }
    });

    insertMany(entries);
  }

  getTimelineEntries(
    machineId: string,
    from: number,
    to: number,
  ): TimelineEntry[] {
    const rows = this.db.prepare(
      'SELECT data FROM timeline_entries WHERE machine_id = ? AND start_time >= ? AND start_time <= ?',
    ).all(machineId, from, to) as Array<{ data: string }>;

    return rows.map((row) => JSON.parse(row.data) as TimelineEntry);
  }

  getAllTimelineEntries(from: number, to: number): MergedTimelineEntry[] {
    const rows = this.db.prepare(
      `SELECT machine_id, machine_alias, data
       FROM timeline_entries
       WHERE start_time >= ? AND start_time <= ?
       ORDER BY start_time ASC`,
    ).all(from, to) as Array<{
      machine_id: string;
      machine_alias: string;
      data: string;
    }>;

    return rows.map((row) => ({
      ...(JSON.parse(row.data) as TimelineEntry),
      machineId: row.machine_id,
      machineAlias: row.machine_alias,
    }));
  }

  saveMergedData(
    feature: EnrichmentFeature,
    data: unknown,
    machineCount: number,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO enrichment_merged (feature, data, machine_count, updated_at)
      VALUES (:feature, :data, :machineCount, :updatedAt)
      ON CONFLICT (feature) DO UPDATE SET
        data = excluded.data,
        machine_count = excluded.machine_count,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      feature,
      data: JSON.stringify(data),
      machineCount,
      updatedAt: Date.now(),
    });
  }

  getMergedData(
    feature: EnrichmentFeature,
  ): { data: unknown; machineCount: number; updatedAt: number } | null {
    const row = this.db.prepare(
      'SELECT data, machine_count, updated_at FROM enrichment_merged WHERE feature = ?',
    ).get(feature) as {
      data: string;
      machine_count: number;
      updated_at: number;
    } | undefined;

    if (!row) return null;

    return {
      data: JSON.parse(row.data) as unknown,
      machineCount: row.machine_count,
      updatedAt: row.updated_at,
    };
  }

  deleteOldEntries(cutoffTimestamp: number, batchSize: number = 1000): number {
    const stmt = this.db.prepare(
      'DELETE FROM timeline_entries WHERE start_time < :cutoff LIMIT :batchSize',
    );

    let totalDeleted = 0;
    for (;;) {
      const result = stmt.run({ cutoff: cutoffTimestamp, batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  close(): void {
    this.db.close();
  }
}
