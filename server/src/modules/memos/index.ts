import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { BackendModule } from '../types.js';
import { MemoDB } from './memo-db.js';
import { MemoFS } from './memo-fs.js';
import type {
  CreateMemoRequest,
  UpdateMemoRequest,
  MemoWithContent,
} from './types.js';

export class MemoModule implements BackendModule {
  readonly id = 'memos';
  private readonly memoDB: MemoDB;
  private readonly memoFS: MemoFS;

  constructor(db: Database.Database, memoDir: string) {
    this.memoDB = new MemoDB(db);
    this.memoFS = new MemoFS(memoDir);
  }

  registerRoutes(app: FastifyInstance): void {
    app.get('/api/memos', async (request) => {
      const query = request.query as {
        projectId?: string;
        date?: string;
        limit?: string;
        offset?: string;
      };
      const memos = this.memoDB.list({
        projectId: query.projectId,
        date: query.date,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
      return { memos };
    });

    app.get('/api/memos/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const memo = this.memoDB.getById(id);
      if (!memo) {
        return reply.code(404).send({ error: 'Memo not found' });
      }

      const content = await this.memoFS.read(memo.filePath);
      const result: MemoWithContent = { ...memo, content: content ?? '' };
      return result;
    });

    app.post('/api/memos', async (request, reply) => {
      const body = request.body as CreateMemoRequest | null;
      if (!body?.projectId || !body?.content) {
        return reply.code(400).send({ error: 'projectId and content are required' });
      }

      const now = Date.now();
      const date = body.date ?? toDateString(now);
      const projectSlug = slugFromPath(body.projectId);
      const machineId = body.machineId ?? '';
      const filePath = this.memoFS.resolveFilePath(machineId, projectSlug, date);
      const id = randomUUID();
      const title = body.title ?? '';

      const memo = {
        id,
        projectId: body.projectId,
        projectSlug,
        machineId,
        title,
        date,
        filePath,
        createdAt: now,
        updatedAt: now,
      };

      await this.memoFS.write({
        filePath,
        id,
        projectSlug,
        date,
        title,
        content: body.content,
        machineId,
        createdAt: now,
        updatedAt: now,
      });

      this.memoDB.insert(memo);

      return reply.code(201).send(memo);
    });

    app.put('/api/memos/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateMemoRequest | null;

      const existing = this.memoDB.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'Memo not found' });
      }

      const now = Date.now();
      const updatedTitle = body?.title ?? existing.title;

      if (body?.content !== undefined) {
        await this.memoFS.write({
          filePath: existing.filePath,
          id: existing.id,
          projectSlug: existing.projectSlug,
          date: existing.date,
          title: updatedTitle,
          content: body.content,
          machineId: existing.machineId,
          createdAt: existing.createdAt,
          updatedAt: now,
        });
      }

      this.memoDB.update(id, { title: updatedTitle, updatedAt: now });

      const updated = this.memoDB.getById(id);
      return updated;
    });

    app.delete('/api/memos/:id', async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = this.memoDB.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'Memo not found' });
      }

      await this.memoFS.delete(existing.filePath);
      this.memoDB.delete(id);

      return { deleted: true };
    });
  }
}

function slugFromPath(worktreePath: string): string {
  const normalized = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

function toDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
