import { JsonlReader } from './jsonl-reader.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryEntry {
  display: string;
  timestamp: number;
  sessionId: string;
  project?: string;
}

export interface ClaudeQueryEntry {
  sessionId: string;
  sessionTitle: string | null;
  timestamp: number;
  query: string;
  isBackground: boolean;
  source: 'claude-code';
}

// ---------------------------------------------------------------------------
// ClaudeSource
// ---------------------------------------------------------------------------

export class ClaudeSource {
  private readonly historyPath: string;
  private reader: JsonlReader<HistoryEntry>;

  constructor(claudeHistoryDir?: string) {
    const baseDir = claudeHistoryDir ?? join(homedir(), '.claude');
    this.historyPath = join(baseDir, 'history.jsonl');
    this.reader = new JsonlReader<HistoryEntry>(this.historyPath);
  }

  start(): void {
    // Stateless reader — no initialization needed
  }

  stop(): void {
    // Stateless reader — no cleanup needed
  }

  async getRecentQueries(limit: number = 50): Promise<ClaudeQueryEntry[]> {
    const entries = await this.reader.tailLines(limit);
    return entries.map((entry) => ({
      sessionId: entry.sessionId,
      sessionTitle: null,
      timestamp: entry.timestamp,
      query: entry.display,
      isBackground: false,
      source: 'claude-code' as const,
    }));
  }
}
