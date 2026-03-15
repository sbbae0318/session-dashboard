import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

export class MemoFS {
  constructor(private readonly memoDir: string) {}

  async write(opts: {
    filePath: string;
    id: string;
    projectSlug: string;
    date: string;
    title: string;
    content: string;
    machineId: string;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    const fullPath = join(this.memoDir, opts.filePath);
    await mkdir(dirname(fullPath), { recursive: true });

    const frontmatter = [
      '---',
      `id: ${opts.id}`,
      `project: ${opts.projectSlug}`,
      `date: ${opts.date}`,
      ...(opts.machineId ? [`machine: ${opts.machineId}`] : []),
      ...(opts.title ? [`title: "${opts.title.replace(/"/g, '\\"')}"`] : []),
      `created: ${new Date(opts.createdAt).toISOString()}`,
      `updated: ${new Date(opts.updatedAt).toISOString()}`,
      '---',
    ].join('\n');

    const fileContent = `${frontmatter}\n\n${opts.content}\n`;
    await writeFile(fullPath, fileContent, 'utf-8');
  }

  async read(filePath: string): Promise<string | null> {
    const fullPath = join(this.memoDir, filePath);
    if (!existsSync(fullPath)) return null;

    const raw = await readFile(fullPath, 'utf-8');
    return extractBody(raw);
  }

  async readSnippet(filePath: string, maxChars = 100): Promise<string> {
    const fullPath = join(this.memoDir, filePath);
    if (!existsSync(fullPath)) return '';

    const raw = await readFile(fullPath, 'utf-8');
    const body = extractBody(raw);
    if (body.length <= maxChars) return body;
    return body.slice(0, maxChars) + '…';
  }

  async delete(filePath: string): Promise<boolean> {
    const fullPath = join(this.memoDir, filePath);
    if (!existsSync(fullPath)) return false;

    await unlink(fullPath);
    return true;
  }

  resolveFilePath(machineId: string, projectSlug: string, date: string): string {
    const base = machineId
      ? `${machineId}/${projectSlug}/${date}`
      : `${projectSlug}/${date}`;
    if (!existsSync(join(this.memoDir, `${base}.md`))) {
      return `${base}.md`;
    }
    let n = 2;
    while (existsSync(join(this.memoDir, `${base}-${n}.md`))) {
      n++;
    }
    return `${base}-${n}.md`;
  }

  getMemoDir(): string {
    return this.memoDir;
  }
}

function extractBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) return trimmed;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return trimmed;

  return trimmed.slice(endIdx + 3).trim();
}
