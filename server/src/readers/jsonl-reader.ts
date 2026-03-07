/**
 * Generic JSONL file reader with tail and watch capabilities
 *
 * Handles files with #XX| prefix format (2 random chars + pipe before JSON)
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { watch, type FSWatcher } from 'chokidar';

/**
 * Generic JSONL file reader with tail and watch capabilities
 */
export class JsonlReader<T> {
  private filePath: string;
  private watcher: FSWatcher | null = null;
  private filePosition = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 100;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read the last N lines from the JSONL file
   * Handles #XX| prefix format (2 random chars + pipe before JSON)
   *
   * @param n Number of lines to return
   * @returns Array of parsed items, or empty array if file doesn't exist
   */
  async tailLines(n: number): Promise<T[]> {
    // If file doesn't exist, return empty array
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
   * Watch the file for new lines
   * Returns cleanup function to stop watching
   *
   * @param onNewLine Callback for each new line parsed
   * @returns Function to stop watching
   */
  watchFile(onNewLine: (item: T) => void): () => void {
    // Initialize file position
    if (existsSync(this.filePath)) {
      const stats = statSync(this.filePath);
      this.filePosition = stats.size;
    }

    // Start watching with chokidar
    this.watcher = watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', () => {
      this.handleFileChange(onNewLine);
    });

    this.watcher.on('error', (error) => {
      console.error('[JsonlReader] Watch error:', error);
    });

    // Return cleanup function
    return () => {
      this.stopWatching();
    };
  }

  /**
   * Handle file change with debouncing
   */
  private handleFileChange(onNewLine: (item: T) => void): void {
    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new debounce timer
    this.debounceTimer = setTimeout(() => {
      this.processNewLines(onNewLine).catch((err) => {
        console.error('[JsonlReader] Error processing new lines:', err);
      });
    }, this.debounceMs);
  }

  /**
   * Process new lines added to the file (tail)
   */
  private async processNewLines(onNewLine: (item: T) => void): Promise<void> {
    if (!existsSync(this.filePath)) {
      return;
    }

    const stats = statSync(this.filePath);

    // If file was truncated, reset position
    if (stats.size < this.filePosition) {
      this.filePosition = 0;
    }

    // If no new data, return
    if (stats.size <= this.filePosition) {
      return;
    }

    // Read new content from last position
    const stream = createReadStream(this.filePath, {
      start: this.filePosition,
      encoding: 'utf-8',
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const item = this.parseLine(line);
      if (item !== null) {
        onNewLine(item);
      }
    }

    // Update file position
    this.filePosition = stats.size;
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

  /**
   * Stop watching the file
   */
  private stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close().catch((err) => {
        console.error('[JsonlReader] Error closing watcher:', err);
      });
      this.watcher = null;
    }
  }
}
