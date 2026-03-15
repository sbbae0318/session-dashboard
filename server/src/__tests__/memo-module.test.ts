import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MemoModule } from '../modules/memos/index.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MemoModule', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let tmpDir: string;
  let memoDir: string;

  const DEFAULT_MACHINE_ID = 'test-machine';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memo-module-test-'));
    memoDir = join(tmpDir, 'memos');
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');

    const mod = new MemoModule(db, memoDir, DEFAULT_MACHINE_ID);
    app = Fastify({ logger: false });
    mod.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('migrates existing memos with defaultMachineId', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'memo-migrate-test-'));
      const tempMemoDir = join(tempDir, 'memos');
      const tempDb = new Database(join(tempDir, 'test.db'));
      tempDb.pragma('journal_mode = WAL');

      new MemoModule(tempDb, tempMemoDir, '');
      tempDb.prepare(`
        INSERT INTO memos (id, project_id, project_slug, machine_id, title, date, file_path, created_at, updated_at)
        VALUES ('old-memo', '/test', 'test', '', '', '2026-03-15', 'test/2026-03-15.md', 1, 1)
      `).run();

      new MemoModule(tempDb, tempMemoDir, 'migrated-machine');

      const row = tempDb.prepare('SELECT machine_id FROM memos WHERE id = ?').get('old-memo') as { machine_id: string };
      expect(row.machine_id).toBe('migrated-machine');

      tempDb.close();
      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('POST /api/memos', () => {
    it('creates a memo and writes MD file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: {
          projectId: '/Users/test/my-project',
          content: 'Hello world',
          title: 'Test Memo',
          machineId: 'my-machine',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.projectId).toBe('/Users/test/my-project');
      expect(body.projectSlug).toBe('my-project');
      expect(body.machineId).toBe('my-machine');
      expect(body.title).toBe('Test Memo');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const mdPath = join(memoDir, body.filePath);
      expect(existsSync(mdPath)).toBe(true);

      const mdContent = readFileSync(mdPath, 'utf-8');
      expect(mdContent).toContain('Hello world');
      expect(mdContent).toContain('project: my-project');
      expect(mdContent).toContain('machine: my-machine');
    });

    it('returns 400 when projectId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { content: 'no project', machineId: 'mac' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when content is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', machineId: 'mac' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when machineId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'hello' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('machineId');
    });

    it('creates unique file paths for same date', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'first', date: '2026-03-15', machineId: 'mac' },
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'second', date: '2026-03-15', machineId: 'mac' },
      });

      const path1 = res1.json().filePath;
      const path2 = res2.json().filePath;
      expect(path1).not.toBe(path2);
      expect(path1).toBe('mac/test/2026-03-15.md');
      expect(path2).toBe('mac/test/2026-03-15-2.md');
    });
  });

  describe('GET /api/memos', () => {
    it('returns empty list on fresh DB', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memos' });
      expect(res.statusCode).toBe(200);
      expect(res.json().memos).toEqual([]);
    });

    it('lists memos filtered by projectId', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/a', content: 'memo a', machineId: 'mac' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/b', content: 'memo b', machineId: 'mac' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/memos?projectId=/a',
      });
      expect(res.json().memos).toHaveLength(1);
      expect(res.json().memos[0].projectId).toBe('/a');
    });

    it('lists memos filtered by machineId', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'from mac1', machineId: 'mac1' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'from mac2', machineId: 'mac2' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/memos?machineId=mac1',
      });
      const memos = res.json().memos;
      expect(memos).toHaveLength(1);
      expect(memos[0].machineId).toBe('mac1');
    });

    it('returns snippet for each memo', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: {
          projectId: '/test',
          content: 'Short content for snippet test',
          machineId: 'mac',
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/memos' });
      const memos = res.json().memos;
      expect(memos).toHaveLength(1);
      expect(memos[0].snippet).toBeDefined();
      expect(memos[0].snippet).toBe('Short content for snippet test');
    });

    it('truncates snippet to 100 chars with ellipsis', async () => {
      const longContent = 'A'.repeat(150);
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: {
          projectId: '/test',
          content: longContent,
          machineId: 'mac',
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/memos' });
      const memos = res.json().memos;
      expect(memos[0].snippet).toBe('A'.repeat(100) + '…');
    });
  });

  describe('GET /api/memos/:id', () => {
    it('returns memo with content', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'Hello content', title: 'Title', machineId: 'mac' },
      });
      const id = createRes.json().id;

      const res = await app.inject({ method: 'GET', url: `/api/memos/${id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.content).toBe('Hello content');
      expect(body.title).toBe('Title');
    });

    it('returns 404 for non-existent id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memos/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('includes machineId in response', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'test', machineId: 'my-mac' },
      });
      const id = createRes.json().id;

      const res = await app.inject({ method: 'GET', url: `/api/memos/${id}` });
      expect(res.json().machineId).toBe('my-mac');
    });
  });

  describe('PUT /api/memos/:id', () => {
    it('updates memo content and MD file', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'original', machineId: 'mac' },
      });
      const id = createRes.json().id;
      const filePath = createRes.json().filePath;

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memos/${id}`,
        payload: { content: 'updated', title: 'New Title' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe('New Title');

      const mdContent = readFileSync(join(memoDir, filePath), 'utf-8');
      expect(mdContent).toContain('updated');
      expect(mdContent).toContain('title: "New Title"');
    });

    it('returns 404 for non-existent id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/memos/nonexistent',
        payload: { content: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('does not change machineId even if provided in body', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'test', machineId: 'original-mac' },
      });
      const id = createRes.json().id;

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memos/${id}`,
        payload: { content: 'updated', machineId: 'hacked-mac' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().machineId).toBe('original-mac');
    });
  });

  describe('DELETE /api/memos/:id', () => {
    it('deletes memo and removes MD file', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'to delete', machineId: 'mac' },
      });
      const { id, filePath } = createRes.json();

      expect(existsSync(join(memoDir, filePath))).toBe(true);

      const res = await app.inject({ method: 'DELETE', url: `/api/memos/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBe(true);
      expect(existsSync(join(memoDir, filePath))).toBe(false);

      const getRes = await app.inject({ method: 'GET', url: `/api/memos/${id}` });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 404 for non-existent id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/memos/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });
});
