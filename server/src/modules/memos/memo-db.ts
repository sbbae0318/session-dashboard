import type Database from 'better-sqlite3';
import type { Memo, MemoRow, MemoListQuery, MemoProject, MemoWithSnippet } from './types.js';

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

    try {
      this.db.exec(`ALTER TABLE memos ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // column already exists
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memos_machine ON memos(machine_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_memos_machine_project ON memos(machine_id, project_id, date DESC);
    `);
  }

  insert(memo: Memo): void {
    const stmt = this.db.prepare(`
      INSERT INTO memos (id, project_id, project_slug, machine_id, title, date, file_path, created_at, updated_at)
      VALUES (:id, :projectId, :projectSlug, :machineId, :title, :date, :filePath, :createdAt, :updatedAt)
    `);
    stmt.run({
      id: memo.id,
      projectId: memo.projectId,
      projectSlug: memo.projectSlug,
      machineId: memo.machineId,
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
    if (query.machineId) {
      conditions.push('machine_id = :machineId');
      params.machineId = query.machineId;
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

  listProjects(machineId?: string): MemoProject[] {
    const where = machineId ? 'WHERE machine_id = :machineId' : '';
    const params = machineId ? { machineId } : {};

    const rows = this.db.prepare(`
      SELECT
        project_id,
        project_slug,
        COUNT(*) as memo_count,
        MAX(date) as latest_date
      FROM memos
      ${where}
      GROUP BY project_id
      ORDER BY latest_date DESC
    `).all(params) as Array<{
      project_id: string;
      project_slug: string;
      memo_count: number;
      latest_date: string;
    }>;

    return rows.map(row => ({
      projectId: row.project_id,
      projectSlug: row.project_slug,
      memoCount: row.memo_count,
      latestDate: row.latest_date,
    }));
  }

  listFeed(limit: number, machineId?: string): MemoWithSnippet[] {
    const where = machineId ? 'WHERE machine_id = :machineId' : '';
    const params: Record<string, string | number> = { limit: Math.min(limit, 200) };
    if (machineId) {
      params.machineId = machineId;
    }

    const rows = this.db.prepare(`
      SELECT *, '' as snippet
      FROM memos
      ${where}
      ORDER BY date DESC, updated_at DESC
      LIMIT :limit
    `).all(params) as Array<MemoRow & { snippet: string }>;

    return rows.map(row => ({
      ...rowToMemo(row),
      snippet: row.snippet,
    }));
  }

  migrateExistingMemos(defaultMachineId: string): number {
    const result = this.db.prepare(
      `UPDATE memos SET machine_id = :machineId WHERE machine_id = ''`,
    ).run({ machineId: defaultMachineId });
    return result.changes;
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
    machineId: row.machine_id,
    title: row.title,
    date: row.date,
    filePath: row.file_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
