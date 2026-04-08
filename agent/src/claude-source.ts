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

  async getRecentQueries(limit: number = 50, sessionId?: string): Promise<ClaudeQueryEntry[]> {
    // sessionId 필터 시 전체 스캔 (history.jsonl 전체 읽음 — tailLines은 이미 전체 로드)
    const scanLimit = sessionId ? 10000 : limit;
    const entries = await this.reader.tailLines(scanLimit);
    return entries
      .filter((entry) => this.isRealQuery(entry.display))
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
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
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .slice(-limit);
  }

  /** 슬래시 커맨드, 빈 문자열, XML 태그로 시작하는 항목 제외 */
  private isRealQuery(display: string): boolean {
    if (!display || display.trim().length === 0) return false;
    if (display.startsWith('/')) return false;  // /exit, /help, /clear 등
    if (display.startsWith('<')) return false;  // XML 시스템 메시지
    return true;
  }
}
