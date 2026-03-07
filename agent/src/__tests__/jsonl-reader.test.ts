import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JsonlReader } from '../jsonl-reader.js';

interface TestItem {
  id: number;
  name: string;
}

function tempFile(): string {
  const dir = join(tmpdir(), 'agent-jsonl-reader-test');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.jsonl`);
}

const cleanupFiles: string[] = [];

afterEach(() => {
  for (const f of cleanupFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  cleanupFiles.length = 0;
});

describe('JsonlReader (dashboard-agent)', () => {
  describe('tailLines()', () => {
    it('should read valid JSONL file and return parsed items', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '{"id":1,"name":"alpha"}',
        '{"id":2,"name":"beta"}',
        '{"id":3,"name":"gamma"}',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({ id: 1, name: 'alpha' });
      expect(items[2]).toEqual({ id: 3, name: 'gamma' });
    });

    it('should parse lines with #XX| prefix format', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '#AB|{"id":1,"name":"prefixed"}',
        '#CD|{"id":2,"name":"also-prefixed"}',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 1, name: 'prefixed' });
      expect(items[1]).toEqual({ id: 2, name: 'also-prefixed' });
    });

    it('should return last N items when n < total', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '{"id":1,"name":"first"}',
        '{"id":2,"name":"second"}',
        '{"id":3,"name":"third"}',
        '{"id":4,"name":"fourth"}',
        '{"id":5,"name":"fifth"}',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(2);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 4, name: 'fourth' });
      expect(items[1]).toEqual({ id: 5, name: 'fifth' });
    });

    it('should return empty array for non-existent file', async () => {
      const reader = new JsonlReader<TestItem>('/tmp/nonexistent-' + randomUUID() + '.jsonl');
      const items = await reader.tailLines(10);
      expect(items).toEqual([]);
    });

    it('should return empty array for empty file', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, '');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);
      expect(items).toEqual([]);
    });

    it('should skip malformed JSON lines and return valid ones', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '{"id":1,"name":"valid"}',
        'not json at all',
        '{"id":3,"name":"also-valid"}',
        '{broken json',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 1, name: 'valid' });
      expect(items[1]).toEqual({ id: 3, name: 'also-valid' });
    });

    it('should skip empty and whitespace-only lines', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '{"id":1,"name":"one"}',
        '',
        '   ',
        '{"id":2,"name":"two"}',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
    });

    it('should handle mixed prefixed and non-prefixed lines', async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, [
        '#AB|{"id":1,"name":"prefixed"}',
        '{"id":2,"name":"bare"}',
        '#XY|{"id":3,"name":"prefixed-again"}',
      ].join('\n') + '\n');

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(3);
      expect(items[1]).toEqual({ id: 2, name: 'bare' });
    });
  });
});
