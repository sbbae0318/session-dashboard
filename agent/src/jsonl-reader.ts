/**
 * Stateless JSONL file reader
 *
 * Reads JSONL files on-demand (no file watching).
 * Handles #XX| prefix format (2 random chars + pipe before JSON).
 * Adapted from session-dashboard's jsonl-reader for agent use.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export class JsonlReader<T> {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read the last N lines from the JSONL file
   *
   * @param n Number of lines to return
   * @returns Array of parsed items, or empty array if file doesn't exist
   */
  async tailLines(n: number): Promise<T[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      const items: T[] = [];
      for (const line of lines) {
        const item = this.parseLine(line);
        if (item !== null) {
          items.push(item);
        }
      }

      // Return last N items
      return items.slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * Parse a single JSONL line, handling the #XX| prefix
   *
   * Format: #XX|{json} where XX is 2 random characters
   * Returns null if line is empty or JSON parse fails
   */
  private parseLine(line: string): T | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    // Handle #XX| prefix (2 random chars + pipe)
    let json = trimmed;
    const pipeIndex = trimmed.indexOf('|');

    // Check if line starts with # and has pipe within first 4 chars
    if (pipeIndex !== -1 && pipeIndex <= 4 && trimmed.startsWith('#')) {
      json = trimmed.slice(pipeIndex + 1);
    }

    try {
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  }
}
