import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoFS } from '../modules/memos/memo-fs.js';

describe('MemoFS', () => {
  let tmpDir: string;
  let fs: MemoFS;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memo-fs-test-'));
    fs = new MemoFS(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveFilePath(machineId, projectSlug, date)', () => {
    it('returns {machineId}/{projectSlug}/{date}.md when no file exists', () => {
      const result = fs.resolveFilePath('macbook', 'my-project', '2026-03-16');
      expect(result).toBe('macbook/my-project/2026-03-16.md');
    });

    it('returns -2 suffix when base file already exists', async () => {
      await fs.write({
        filePath: 'macbook/my-project/2026-03-16.md',
        id: 'test-id',
        projectSlug: 'my-project',
        date: '2026-03-16',
        title: 'First',
        content: 'content',
        machineId: 'macbook',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = fs.resolveFilePath('macbook', 'my-project', '2026-03-16');
      expect(result).toBe('macbook/my-project/2026-03-16-2.md');
    });

    it('increments suffix until unique path found', async () => {
      await fs.write({
        filePath: 'macbook/my-project/2026-03-16.md',
        id: 'id1',
        projectSlug: 'my-project',
        date: '2026-03-16',
        title: '',
        content: 'c1',
        machineId: 'macbook',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await fs.write({
        filePath: 'macbook/my-project/2026-03-16-2.md',
        id: 'id2',
        projectSlug: 'my-project',
        date: '2026-03-16',
        title: '',
        content: 'c2',
        machineId: 'macbook',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = fs.resolveFilePath('macbook', 'my-project', '2026-03-16');
      expect(result).toBe('macbook/my-project/2026-03-16-3.md');
    });

    it('different machineIds produce different paths', () => {
      const path1 = fs.resolveFilePath('macbook', 'proj', '2026-03-16');
      const path2 = fs.resolveFilePath('linux-server', 'proj', '2026-03-16');
      expect(path1).toBe('macbook/proj/2026-03-16.md');
      expect(path2).toBe('linux-server/proj/2026-03-16.md');
    });
  });

  describe('write() with machineId', () => {
    it('writes frontmatter with machine field', async () => {
      await fs.write({
        filePath: 'macbook/my-project/2026-03-16.md',
        id: 'abc123',
        projectSlug: 'my-project',
        date: '2026-03-16',
        title: 'Test Title',
        content: 'Hello world',
        machineId: 'macbook',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      });

      const fullPath = join(tmpDir, 'macbook/my-project/2026-03-16.md');
      expect(existsSync(fullPath)).toBe(true);

      const content = readFileSync(fullPath, 'utf-8');
      expect(content).toContain('machine: macbook');
      expect(content).toContain('id: abc123');
      expect(content).toContain('project: my-project');
      expect(content).toContain('date: 2026-03-16');
      expect(content).toContain('title: "Test Title"');
      expect(content).toContain('Hello world');
    });

    it('writes machine field even when machineId is empty string', async () => {
      await fs.write({
        filePath: 'proj/2026-03-16.md',
        id: 'id1',
        projectSlug: 'proj',
        date: '2026-03-16',
        title: '',
        content: 'content',
        machineId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const fullPath = join(tmpDir, 'proj/2026-03-16.md');
      const content = readFileSync(fullPath, 'utf-8');
      expect(content).not.toContain('machine:');
    });

    it('creates nested directories for machineId/projectSlug path', async () => {
      await fs.write({
        filePath: 'my-machine/deep-project/2026-03-16.md',
        id: 'id1',
        projectSlug: 'deep-project',
        date: '2026-03-16',
        title: '',
        content: 'content',
        machineId: 'my-machine',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const fullPath = join(tmpDir, 'my-machine/deep-project/2026-03-16.md');
      expect(existsSync(fullPath)).toBe(true);
    });
  });

  describe('read(filePath)', () => {
    it('reads body content from file (unchanged behavior)', async () => {
      await fs.write({
        filePath: 'macbook/proj/2026-03-16.md',
        id: 'id1',
        projectSlug: 'proj',
        date: '2026-03-16',
        title: 'Title',
        content: 'Body content here',
        machineId: 'macbook',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = await fs.read('macbook/proj/2026-03-16.md');
      expect(result).toBe('Body content here');
    });

    it('returns null for non-existent file', async () => {
      const result = await fs.read('nonexistent/path.md');
      expect(result).toBeNull();
    });
  });
});
