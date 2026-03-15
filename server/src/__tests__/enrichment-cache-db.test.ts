import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnrichmentCacheDB } from '../modules/enrichment/enrichment-cache-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('EnrichmentCacheDB', () => {
  let db: EnrichmentCacheDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'enrichment-test-'));
    db = new EnrichmentCacheDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadAllCache returns empty Map on fresh DB', () => {
    const cache = db.loadAllCache();
    expect(cache).toBeInstanceOf(Map);
    expect(cache.size).toBe(0);
  });

  it('saveFeatureData + loadAllCache roundtrip preserves data', () => {
    const tokensData = {
      sessions: [],
      grandTotal: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 5, cost: 0.05 },
    };
    db.saveFeatureData('mac-1', 'tokens', tokensData, true);

    const cache = db.loadAllCache();
    expect(cache.size).toBe(1);

    const machineCache = cache.get('mac-1');
    expect(machineCache).toBeDefined();
    expect(machineCache!.tokens).toBeDefined();
    expect(machineCache!.tokens!.available).toBe(true);
    expect(machineCache!.tokens!.data).toEqual(tokensData);
    expect(machineCache!.lastUpdated).toBeGreaterThan(0);
  });

  it('saveFeatureData with same key updates via ON CONFLICT', () => {
    db.saveFeatureData('mac-1', 'tokens', { version: 1 }, true);
    db.saveFeatureData('mac-1', 'tokens', { version: 2 }, false);

    const cache = db.loadAllCache();
    expect(cache.size).toBe(1);

    const machineCache = cache.get('mac-1');
    expect(machineCache!.tokens!.data).toEqual({ version: 2 });
    expect(machineCache!.tokens!.available).toBe(false);
  });

  it('saveFeatureData stores multiple features for same machine', () => {
    db.saveFeatureData('mac-1', 'tokens', { t: 1 }, true);
    db.saveFeatureData('mac-1', 'impact', [{ i: 1 }], true);
    db.saveFeatureData('mac-1', 'projects', [{ p: 1 }], false);

    const cache = db.loadAllCache();
    expect(cache.size).toBe(1);

    const machineCache = cache.get('mac-1');
    expect(machineCache!.tokens).toBeDefined();
    expect(machineCache!.impact).toBeDefined();
    expect(machineCache!.projects).toBeDefined();
    expect(machineCache!.timeline).toBeNull();
    expect(machineCache!.recovery).toBeNull();
  });

  describe('timeline entries', () => {
    const makeEntry = (sessionId: string, startTime: number, endTime: number | null = null) => ({
      sessionId,
      sessionTitle: `Session ${sessionId}`,
      projectId: 'p1',
      directory: '/test',
      startTime,
      endTime,
      status: 'completed' as const,
      parentId: null,
    });

    it('saveTimelineEntries + getTimelineEntries filters by time window', () => {
      const entries = [
        makeEntry('s1', 1000, 2000),
        makeEntry('s2', 3000, 4000),
        makeEntry('s3', 5000, 6000),
        makeEntry('s4', 7000, 8000),
      ];
      db.saveTimelineEntries('mac-1', 'MacBook', entries);

      const result = db.getTimelineEntries('mac-1', 3000, 5000);
      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe('s2');
      expect(result[1].sessionId).toBe('s3');
    });

    it('getTimelineEntries returns empty array for non-matching window', () => {
      const entries = [makeEntry('s1', 1000, 2000)];
      db.saveTimelineEntries('mac-1', 'MacBook', entries);

      const result = db.getTimelineEntries('mac-1', 5000, 9000);
      expect(result).toHaveLength(0);
    });

    it('getAllTimelineEntries returns entries from all machines with metadata', () => {
      db.saveTimelineEntries('mac-1', 'MacBook A', [makeEntry('s1', 2000, 3000)]);
      db.saveTimelineEntries('mac-2', 'MacBook B', [makeEntry('s2', 1000, 2000)]);

      const result = db.getAllTimelineEntries(0, 10000);
      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe('s2');
      expect(result[0].machineId).toBe('mac-2');
      expect(result[0].machineAlias).toBe('MacBook B');
      expect(result[1].sessionId).toBe('s1');
      expect(result[1].machineId).toBe('mac-1');
      expect(result[1].machineAlias).toBe('MacBook A');
    });

    it('saveTimelineEntries skips empty array without error', () => {
      db.saveTimelineEntries('mac-1', 'MacBook', []);
      const result = db.getTimelineEntries('mac-1', 0, 99999);
      expect(result).toHaveLength(0);
    });

    it('saveTimelineEntries updates on conflict (same session_id + machine_id)', () => {
      const entry1 = makeEntry('s1', 1000, 2000);
      db.saveTimelineEntries('mac-1', 'MacBook', [entry1]);

      const updatedEntry = { ...entry1, endTime: 5000, status: 'idle' as const };
      db.saveTimelineEntries('mac-1', 'MacBook', [updatedEntry]);

      const result = db.getTimelineEntries('mac-1', 0, 99999);
      expect(result).toHaveLength(1);
      expect(result[0].endTime).toBe(5000);
      expect(result[0].status).toBe('idle');
    });
  });

  describe('deleteOldEntries', () => {
    const makeEntry = (sessionId: string, startTime: number) => ({
      sessionId,
      sessionTitle: `Session ${sessionId}`,
      projectId: 'p1',
      directory: '/test',
      startTime,
      endTime: startTime + 1000,
      status: 'completed' as const,
      parentId: null,
    });

    it('deletes entries before cutoff and preserves newer ones', () => {
      const entries = [
        makeEntry('old1', 1000),
        makeEntry('old2', 2000),
        makeEntry('new1', 5000),
        makeEntry('new2', 8000),
      ];
      db.saveTimelineEntries('mac-1', 'MacBook', entries);

      const deleted = db.deleteOldEntries(3000);
      expect(deleted).toBe(2);

      const remaining = db.getTimelineEntries('mac-1', 0, 99999);
      expect(remaining).toHaveLength(2);
      expect(remaining[0].sessionId).toBe('new1');
      expect(remaining[1].sessionId).toBe('new2');
    });

    it('returns 0 when no entries match cutoff', () => {
      db.saveTimelineEntries('mac-1', 'MacBook', [makeEntry('s1', 5000)]);
      const deleted = db.deleteOldEntries(1000);
      expect(deleted).toBe(0);
    });
  });

  describe('merged data', () => {
    it('saveMergedData + getMergedData roundtrip', () => {
      const mergedTimeline = [
        { sessionId: 's1', machineId: 'mac-1', machineAlias: 'MacBook', startTime: 1000 },
      ];
      db.saveMergedData('timeline', mergedTimeline, 2);

      const result = db.getMergedData('timeline');
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(mergedTimeline);
      expect(result!.machineCount).toBe(2);
      expect(result!.updatedAt).toBeGreaterThan(0);
    });

    it('getMergedData returns null for missing feature', () => {
      const result = db.getMergedData('tokens');
      expect(result).toBeNull();
    });

    it('saveMergedData updates on conflict (same feature)', () => {
      db.saveMergedData('tokens', { v: 1 }, 1);
      db.saveMergedData('tokens', { v: 2 }, 3);

      const result = db.getMergedData('tokens');
      expect(result!.data).toEqual({ v: 2 });
      expect(result!.machineCount).toBe(3);
    });
  });
});
