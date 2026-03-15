import type Database from 'better-sqlite3';
import type { Memo, MemoRow, MemoListQuery } from './types.js';

export class MemoDB {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_memos_project ON memos(project_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_memos_date ON memos(date DESC);
      CREATE INDEX IF NOT EXISTS idx_memos_slug_date ON memos(project_slug, date DESC);
    `);
  }

  insert(memo: Memo): void {
    const stmt = this.db.prepare(`
      INSERT INTO memos (id, project_id, project_slug, title, date, file_path, created_at, updated_at)
      VALUES (:id, :projectId, :projectSlug, :title, :date, :filePath, :createdAt, :updatedAt)
    `);
    stmt.run({
      id: memo.id,
      projectId: memo.projectId,
      projectSlug: memo.projectSlug,
      title: memo.title,
      date: memo.date,
      filePath: memo.filePath,
      createdAt: memo.createdAt,
      updatedAt: memo.updatedAt,
    });
  }

  getById(id: string): Memo | null {
    const row = this.db.prepare(
      'SELECT * FROM memos WHERE id = ?',
    ).get(id) as MemoRow | undefined;
    return row ? rowToMemo(row) : null;
  }

  list(query: MemoListQuery): Memo[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (query.projectId) {
      conditions.push('project_id = :projectId');
      params.projectId = query.projectId;
    }
    if (query.date) {
      conditions.push('date = :date');
      params.date = query.date;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM memos ${where} ORDER BY date DESC, updated_at DESC LIMIT :limit OFFSET :offset`,
    ).all({ ...params, limit, offset }) as MemoRow[];

    return rows.map(rowToMemo);
  }

  update(id: string, fields: { title?: string; updatedAt: number }): boolean {
    const sets: string[] = ['updated_at = :updatedAt'];
    const params: Record<string, string | number> = { id, updatedAt: fields.updatedAt };

    if (fields.title !== undefined) {
      sets.push('title = :title');
      params.title = fields.title;
    }

    const result = this.db.prepare(
      `UPDATE memos SET ${sets.join(', ')} WHERE id = :id`,
    ).run(params);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memos WHERE id = ?').run(id);
    return result.changes > 0;
  }

  count(projectId?: string): number {
    if (projectId) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM memos WHERE project_id = ?',
      ).get(projectId) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memos').get() as { cnt: number };
    return row.cnt;
  }
}

function rowToMemo(row: MemoRow): Memo {
  return {
    id: row.id,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    title: row.title,
    date: row.date,
    filePath: row.file_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
