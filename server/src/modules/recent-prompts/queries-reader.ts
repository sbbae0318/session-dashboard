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
}

/** QueryEntry — normalized internal type with machine fields added */
export interface QueryEntry {
  sessionId: string;       // NOTE: lowercase d (unlike cards.jsonl which uses sessionID)
  sessionTitle: string | null;
  timestamp: number;       // Unix ms
  query: string;           // User prompt text
  isBackground: boolean;   // true for background/subagent tasks
  source: "opencode" | "claude-code";

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

/**
 * Normalize raw JSONL query: inject default machine fields (populated later by MachineManager).
 */
function normalizeQuery(raw: RawQueryEntry): QueryEntry {
  return {
    ...raw,
    source: raw.source === 'claude-code' ? 'claude-code' as const : 'opencode' as const,
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
