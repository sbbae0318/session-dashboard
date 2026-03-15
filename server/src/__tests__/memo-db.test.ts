import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoDB } from '../modules/memos/memo-db.js';
import type { Memo } from '../modules/memos/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'test-id-1',
    projectId: '/Users/test/project-a',
    projectSlug: 'project-a',
    title: 'test memo',
    date: '2026-03-15',
    filePath: 'project-a/2026-03-15.md',
    createdAt: 1710500000000,
    updatedAt: 1710500000000,
    ...overrides,
  };
}

describe('MemoDB', () => {
  let db: Database.Database;
  let memoDB: MemoDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memo-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    memoDB = new MemoDB(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('insert + getById', () => {
    it('roundtrips a memo correctly', () => {
      const memo = makeMemo();
      memoDB.insert(memo);
      const result = memoDB.getById('test-id-1');

      expect(result).toEqual(memo);
    });

    it('returns null for non-existent id', () => {
      expect(memoDB.getById('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty array on fresh DB', () => {
      expect(memoDB.list({})).toEqual([]);
    });

    it('lists all memos ordered by date DESC', () => {
      memoDB.insert(makeMemo({ id: 'm1', date: '2026-03-14' }));
      memoDB.insert(makeMemo({ id: 'm2', date: '2026-03-15' }));
      memoDB.insert(makeMemo({ id: 'm3', date: '2026-03-13' }));

      const result = memoDB.list({});
      expect(result.map(m => m.id)).toEqual(['m2', 'm1', 'm3']);
    });

    it('filters by projectId', () => {
      memoDB.insert(makeMemo({ id: 'm1', projectId: '/a' }));
      memoDB.insert(makeMemo({ id: 'm2', projectId: '/b' }));

      const result = memoDB.list({ projectId: '/a' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m1');
    });

    it('filters by date', () => {
      memoDB.insert(makeMemo({ id: 'm1', date: '2026-03-14' }));
      memoDB.insert(makeMemo({ id: 'm2', date: '2026-03-15' }));

      const result = memoDB.list({ date: '2026-03-15' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m2');
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        memoDB.insert(makeMemo({
          id: `m${i}`,
          date: `2026-03-${String(15 - i).padStart(2, '0')}`,
        }));
      }

      const page1 = memoDB.list({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe('m0');

      const page2 = memoDB.list({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBe('m2');
    });

    it('clamps limit to max 200', () => {
      memoDB.insert(makeMemo());
      const result = memoDB.list({ limit: 999 });
      expect(result).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('updates title and updatedAt', () => {
      memoDB.insert(makeMemo());
      const updated = memoDB.update('test-id-1', {
        title: 'new title',
        updatedAt: 9999999999999,
      });

      expect(updated).toBe(true);
      const result = memoDB.getById('test-id-1');
      expect(result!.title).toBe('new title');
      expect(result!.updatedAt).toBe(9999999999999);
    });

    it('returns false for non-existent id', () => {
      expect(memoDB.update('nonexistent', { updatedAt: Date.now() })).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes an existing memo', () => {
      memoDB.insert(makeMemo());
      expect(memoDB.delete('test-id-1')).toBe(true);
      expect(memoDB.getById('test-id-1')).toBeNull();
    });

    it('returns false for non-existent id', () => {
      expect(memoDB.delete('nonexistent')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns 0 on fresh DB', () => {
      expect(memoDB.count()).toBe(0);
    });

    it('counts all memos', () => {
      memoDB.insert(makeMemo({ id: 'm1' }));
      memoDB.insert(makeMemo({ id: 'm2' }));
      expect(memoDB.count()).toBe(2);
    });

    it('counts per project', () => {
      memoDB.insert(makeMemo({ id: 'm1', projectId: '/a' }));
      memoDB.insert(makeMemo({ id: 'm2', projectId: '/a' }));
      memoDB.insert(makeMemo({ id: 'm3', projectId: '/b' }));

      expect(memoDB.count('/a')).toBe(2);
      expect(memoDB.count('/b')).toBe(1);
      expect(memoDB.count('/c')).toBe(0);
    });
  });
});
