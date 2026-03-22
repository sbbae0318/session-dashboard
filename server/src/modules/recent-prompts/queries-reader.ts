import { homedir } from "node:os";
import { join } from "node:path";
import { JsonlReader } from "../../readers/jsonl-reader.js";

/** RawQueryEntry — matches queries.jsonl schema exactly (do NOT change field names) */
interface RawQueryEntry {
  sessionId: string;       // NOTE: lowercase d (unlike cards.jsonl which uses sessionID)
  sessionTitle: string | null;
  timestamp: number;       // Unix ms
  query: string;           // User prompt text
  isBackground: boolean;   // true for background/subagent tasks
  source?: string;          // "opencode" | "claude-code"
  completedAt?: number | null;  // Unix ms, completion timestamp
}

// QueryEntry — shared/api-contract.ts에서 정의된 공유 타입 re-export
export type { QueryEntry } from '../../shared/api-contract.js';
import type { QueryEntry } from '../../shared/api-contract.js';

/**
 * Normalize raw JSONL query: inject default machine fields (populated later by MachineManager).
 */
function normalizeQuery(raw: RawQueryEntry): QueryEntry {
  return {
    ...raw,
    source: raw.source === 'claude-code' ? 'claude-code' as const : 'opencode' as const,
    completedAt: raw.completedAt ?? null,
    machineId: '',
    machineHost: '',
    machineAlias: '',
  };
}

const QUERIES_PATH = join(homedir(), ".opencode", "history", "queries.jsonl");

export class QueriesReader {
  private reader: JsonlReader<RawQueryEntry>;

  constructor(filePath?: string) {
    this.reader = new JsonlReader<RawQueryEntry>(filePath ?? QUERIES_PATH);
  }

  async getRecentQueries(limit: number = 10): Promise<QueryEntry[]> {
    const raw = await this.reader.tailLines(limit);
    return raw.map(normalizeQuery);
  }

  watchQueries(onNew: (query: QueryEntry) => void): () => void {
    return this.reader.watchFile((raw) => onNew(normalizeQuery(raw)));
  }
}
