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
    machineId: 'macbook-pro',
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

    it('roundtrips machineId correctly', () => {
      const memo = makeMemo({ machineId: 'linux-server' });
      memoDB.insert(memo);
      const result = memoDB.getById('test-id-1');
      expect(result!.machineId).toBe('linux-server');
    });
  });

  describe('migration', () => {
    it('adds machine_id column to existing table without it', () => {
      const oldDir = mkdtempSync(join(tmpdir(), 'memo-migrate-'));
      const oldDb = new Database(join(oldDir, 'test.db'));
      oldDb.pragma('journal_mode = WAL');

      oldDb.exec(`
        CREATE TABLE IF NOT EXISTS memos (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          project_slug TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          date TEXT NOT NULL,
          file_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      oldDb.prepare(`
        INSERT INTO memos (id, project_id, project_slug, title, date, file_path, created_at, updated_at)
        VALUES ('old-1', '/old/project', 'old-project', 'old memo', '2026-01-01', 'old.md', 1000, 1000)
      `).run();

      const migratedDB = new MemoDB(oldDb);
      const result = migratedDB.getById('old-1');

      expect(result).not.toBeNull();
      expect(result!.machineId).toBe('');
      expect(result!.projectId).toBe('/old/project');

      oldDb.close();
      rmSync(oldDir, { recursive: true, force: true });
    });

    it('does not fail when machine_id column already exists', () => {
      expect(() => new MemoDB(db)).not.toThrow();
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

    it('filters by machineId', () => {
      memoDB.insert(makeMemo({ id: 'm1', machineId: 'machine-a' }));
      memoDB.insert(makeMemo({ id: 'm2', machineId: 'machine-b' }));
      memoDB.insert(makeMemo({ id: 'm3', machineId: 'machine-a' }));

      const result = memoDB.list({ machineId: 'machine-a' });
      expect(result).toHaveLength(2);
      expect(result.map(m => m.id).sort()).toEqual(['m1', 'm3']);
    });

    it('filters by date', () => {
      memoDB.insert(makeMemo({ id: 'm1', date: '2026-03-14' }));
      memoDB.insert(makeMemo({ id: 'm2', date: '2026-03-15' }));

      const result = memoDB.list({ date: '2026-03-15' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m2');
    });

    it('filters by machineId and projectId together', () => {
      memoDB.insert(makeMemo({ id: 'm1', projectId: '/a', machineId: 'mac' }));
      memoDB.insert(makeMemo({ id: 'm2', projectId: '/a', machineId: 'linux' }));
      memoDB.insert(makeMemo({ id: 'm3', projectId: '/b', machineId: 'mac' }));

      const result = memoDB.list({ projectId: '/a', machineId: 'mac' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m1');
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

  describe('listProjects', () => {
    it('returns empty array when no memos exist', () => {
      expect(memoDB.listProjects()).toEqual([]);
    });

    it('returns aggregated project info', () => {
      memoDB.insert(makeMemo({ id: 'm1', projectId: '/a', projectSlug: 'proj-a', date: '2026-03-14' }));
      memoDB.insert(makeMemo({ id: 'm2', projectId: '/a', projectSlug: 'proj-a', date: '2026-03-15' }));
      memoDB.insert(makeMemo({ id: 'm3', projectId: '/b', projectSlug: 'proj-b', date: '2026-03-13' }));

      const projects = memoDB.listProjects();
      expect(projects).toHaveLength(2);

      expect(projects[0].projectId).toBe('/a');
      expect(projects[0].projectSlug).toBe('proj-a');
      expect(projects[0].memoCount).toBe(2);
      expect(projects[0].latestDate).toBe('2026-03-15');

      expect(projects[1].projectId).toBe('/b');
      expect(projects[1].memoCount).toBe(1);
    });

    it('filters by machineId', () => {
      memoDB.insert(makeMemo({ id: 'm1', projectId: '/a', machineId: 'mac' }));
      memoDB.insert(makeMemo({ id: 'm2', projectId: '/a', machineId: 'linux' }));
      memoDB.insert(makeMemo({ id: 'm3', projectId: '/b', machineId: 'mac' }));

      const projects = memoDB.listProjects('mac');
      expect(projects).toHaveLength(2);
      expect(projects.every(p => p.memoCount >= 1)).toBe(true);

      const linuxProjects = memoDB.listProjects('linux');
      expect(linuxProjects).toHaveLength(1);
      expect(linuxProjects[0].projectId).toBe('/a');
    });
  });

  describe('listFeed', () => {
    it('returns empty array when no memos exist', () => {
      expect(memoDB.listFeed(10)).toEqual([]);
    });

    it('returns memos ordered by date DESC with snippet', () => {
      memoDB.insert(makeMemo({ id: 'm1', date: '2026-03-14', title: 'older' }));
      memoDB.insert(makeMemo({ id: 'm2', date: '2026-03-15', title: 'newer' }));

      const feed = memoDB.listFeed(10);
      expect(feed).toHaveLength(2);
      expect(feed[0].id).toBe('m2');
      expect(feed[1].id).toBe('m1');
      expect(feed[0]).toHaveProperty('snippet');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        memoDB.insert(makeMemo({
          id: `m${i}`,
          date: `2026-03-${String(15 - i).padStart(2, '0')}`,
        }));
      }

      const feed = memoDB.listFeed(3);
      expect(feed).toHaveLength(3);
    });

    it('filters by machineId', () => {
      memoDB.insert(makeMemo({ id: 'm1', machineId: 'mac', date: '2026-03-15' }));
      memoDB.insert(makeMemo({ id: 'm2', machineId: 'linux', date: '2026-03-14' }));

      const feed = memoDB.listFeed(10, 'mac');
      expect(feed).toHaveLength(1);
      expect(feed[0].id).toBe('m1');
    });
  });

  describe('migrateExistingMemos', () => {
    it('updates memos with empty machineId to the given default', () => {
      memoDB.insert(makeMemo({ id: 'm1', machineId: '' }));
      memoDB.insert(makeMemo({ id: 'm2', machineId: '' }));
      memoDB.insert(makeMemo({ id: 'm3', machineId: 'already-set' }));

      const count = memoDB.migrateExistingMemos('default-machine');

      expect(count).toBe(2);
      expect(memoDB.getById('m1')!.machineId).toBe('default-machine');
      expect(memoDB.getById('m2')!.machineId).toBe('default-machine');
      expect(memoDB.getById('m3')!.machineId).toBe('already-set');
    });

    it('returns 0 when no memos need migration', () => {
      memoDB.insert(makeMemo({ id: 'm1', machineId: 'set' }));
      expect(memoDB.migrateExistingMemos('default')).toBe(0);
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
