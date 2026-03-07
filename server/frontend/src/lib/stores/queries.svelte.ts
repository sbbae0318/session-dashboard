import type { QueryEntry } from "../../types";
import { fetchJSON } from "../api";

interface QueriesResponse {
  queries: QueryEntry[];
}

let queries = $state<QueryEntry[]>([]);

export function getQueries(): QueryEntry[] {
  return queries;
}

export function addQuery(query: QueryEntry): void {
  // Deduplicate by sessionId+timestamp composite key
  const key = `${query.sessionId}-${query.timestamp}`;
  const exists = queries.some(q => `${q.sessionId}-${q.timestamp}` === key);
  if (!exists) {
    queries = [query, ...queries].slice(0, 30);
  }
}

export async function fetchQueries(limit: number = 30): Promise<void> {
  try {
    const data = await fetchJSON<QueriesResponse>(`/api/queries?limit=${limit}`);
    queries = data.queries ?? [];
  } catch (e) {
    console.error("Failed to fetch queries:", e);
  }
}
