import { JsonlReader } from './jsonl-reader.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractUserPrompt } from './prompt-extractor.js';

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
  completedAt: number | null;
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
    return entries
      .filter((entry) => this.isRealQuery(entry.display))
      .map((entry) => {
        const filtered = extractUserPrompt(entry.display);
        if (filtered === null) return null;
        return {
          sessionId: entry.sessionId,
          sessionTitle: null,
          timestamp: entry.timestamp,
          query: filtered,
          isBackground: false,
          source: 'claude-code' as const,
          completedAt: null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  /** 슬래시 커맨드, 빈 문자열, XML 태그로 시작하는 항목 제외 */
  private isRealQuery(display: string): boolean {
    if (!display || display.trim().length === 0) return false;
    if (display.startsWith('/')) return false;  // /exit, /help, /clear 등
    if (display.startsWith('<')) return false;  // XML 시스템 메시지
    return true;
  }
}
