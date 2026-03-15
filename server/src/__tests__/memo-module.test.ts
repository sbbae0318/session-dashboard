import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MemoModule } from '../modules/memos/index.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MemoModule', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let tmpDir: string;
  let memoDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memo-module-test-'));
    memoDir = join(tmpDir, 'memos');
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');

    const mod = new MemoModule(db, memoDir);
    app = Fastify({ logger: false });
    mod.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
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
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.projectId).toBe('/Users/test/my-project');
      expect(body.projectSlug).toBe('my-project');
      expect(body.title).toBe('Test Memo');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const mdPath = join(memoDir, body.filePath);
      expect(existsSync(mdPath)).toBe(true);

      const mdContent = readFileSync(mdPath, 'utf-8');
      expect(mdContent).toContain('Hello world');
      expect(mdContent).toContain('project: my-project');
    });

    it('returns 400 when projectId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { content: 'no project' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when content is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates unique file paths for same date', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'first', date: '2026-03-15' },
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'second', date: '2026-03-15' },
      });

      const path1 = res1.json().filePath;
      const path2 = res2.json().filePath;
      expect(path1).not.toBe(path2);
      expect(path1).toBe('test/2026-03-15.md');
      expect(path2).toBe('test/2026-03-15-2.md');
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
        payload: { projectId: '/a', content: 'memo a' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/b', content: 'memo b' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/memos?projectId=/a',
      });
      expect(res.json().memos).toHaveLength(1);
      expect(res.json().memos[0].projectId).toBe('/a');
    });
  });

  describe('GET /api/memos/:id', () => {
    it('returns memo with content', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'Hello content', title: 'Title' },
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
  });

  describe('PUT /api/memos/:id', () => {
    it('updates memo content and MD file', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'original' },
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
  });

  describe('DELETE /api/memos/:id', () => {
    it('deletes memo and removes MD file', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/memos',
        payload: { projectId: '/test', content: 'to delete' },
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
