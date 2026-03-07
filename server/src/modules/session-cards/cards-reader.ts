/**
 * Cards-specific JSONL reader
 *
 * Reads session history cards from ~/.opencode/history/cards.jsonl
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonlReader } from '../../readers/jsonl-reader.js';

/**
 * RawHistoryCard — matches cards.jsonl schema exactly (do NOT change field names)
 *
 * V1 fields: version, sessionID, startTime, endTime, endedAt, duration, summary, tools, source
 * V2 extends with: project, parentSessionID, endReason, tokenUsage
 */
interface RawHistoryCard {
  version: 1 | 2;
  sessionID: string; // NOTE: capital D in JSONL format — normalized to sessionId internally
  sessionTitle?: string;
  startTime: number;
  endTime: number;
  endedAt: string;
  duration: string;
  summary: string;
  tools: string[];
  source?: string;

  // V2 fields (optional)
  project?: {
    cwd: string;
    root: string;
  };
  parentSessionID?: string;
  endReason?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/**
 * HistoryCard — normalized internal type (sessionID → sessionId, machine fields added)
 *
 * This is the type used throughout internal code. Raw JSONL uses sessionID (capital D),
 * but after normalization we use sessionId (lowercase d) for consistency.
 */
export interface HistoryCard {
  version: 1 | 2;
  sessionId: string; // normalized from JSONL's sessionID (capital D)
  sessionTitle?: string;
  startTime: number;
  endTime: number;
  endedAt: string;
  duration: string;
  summary: string;
  tools: string[];
  source?: string;

  // V2 fields (optional)
  project?: {
    cwd: string;
    root: string;
  };
  parentSessionID?: string;
  endReason?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

/**
 * Normalize raw JSONL card: maps sessionID (capital D) → sessionId (lowercase d)
 * and injects default machine fields (populated later by MachineManager).
 */
function normalizeCard(raw: RawHistoryCard): HistoryCard {
  const { sessionID, ...rest } = raw;
  return {
    ...rest,
    sessionId: sessionID,
    machineId: '',
    machineHost: '',
    machineAlias: '',
  };
}

const CARDS_PATH = join(homedir(), '.opencode', 'history', 'cards.jsonl');

/**
 * Cards reader — wrapper around JsonlReader for session history cards
 */
export class CardsReader {
  private reader: JsonlReader<RawHistoryCard>;

  constructor(filePath?: string) {
    this.reader = new JsonlReader<RawHistoryCard>(filePath ?? CARDS_PATH);
  }

  /**
   * Get recent cards from the history
   *
   * @param limit Number of cards to return (default: 20)
   * @returns Array of history cards
   */
  async getRecentCards(limit: number = 20): Promise<HistoryCard[]> {
    const raw = await this.reader.tailLines(limit);
    return raw.map(normalizeCard);
  }

  /**
   * Watch for new cards
   *
   * @param onNew Callback for each new card
   * @returns Function to stop watching
   */
  watchCards(onNew: (card: HistoryCard) => void): () => void {
    return this.reader.watchFile((raw) => onNew(normalizeCard(raw)));
  }
}
