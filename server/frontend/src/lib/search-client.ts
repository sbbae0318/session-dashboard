import { fetchJSON } from "./api";

export interface SearchResult {
  type: "session" | "prompt";
  sessionId: string;
  title: string | null;
  directory: string | null;
  timeCreated: number;
  timeUpdated: number;
  matchField: "title" | "query" | "directory" | "content";
  matchSnippet: string;
  machineId?: string;
  machineAlias?: string;
}

export interface SearchMeta {
  totalCount: number;
  searchTimeMs: number;
  machinesSearched: number;
  machinesFailed: string[];
  timeRange: { from: number; to: number };
  hasMore: boolean;
  cached: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: SearchMeta;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d";

let activeController: AbortController | null = null;

export async function searchSessions(
  query: string,
  timeRange: TimeRange,
  options?: { limit?: number; offset?: number },
): Promise<SearchResponse> {
  if (query.trim().length < 2) {
    throw new Error("Query must be at least 2 characters");
  }

  if (activeController) {
    activeController.abort();
  }
  activeController = new AbortController();
  const signal = activeController.signal;

  const { limit = 20, offset = 0 } = options ?? {};

  return fetchJSON<SearchResponse>("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, timeRange, limit, offset }),
    signal,
  });
}
