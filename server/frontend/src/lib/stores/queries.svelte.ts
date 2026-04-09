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
    queries = [query, ...queries].slice(0, 5000);
  }
}

export async function fetchQueries(limit: number = 500): Promise<void> {
  try {
    const data = await fetchJSON<QueriesResponse>(`/api/queries?limit=${limit}`);
    queries = data.queries ?? [];
  } catch (e) {
    console.error("Failed to fetch queries:", e);
  }
}

/** 특정 세션의 쿼리를 fetch하여 기존 store에 병합 (dedup) */
export async function fetchSessionQueries(sessionId: string, limit: number = 500): Promise<void> {
  try {
    const data = await fetchJSON<QueriesResponse>(`/api/queries?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`);
    const newQueries = data.queries ?? [];
    if (newQueries.length === 0) return;

    const existingKeys = new Set(queries.map(q => `${q.sessionId}-${q.timestamp}`));
    const toAdd = newQueries.filter(q => !existingKeys.has(`${q.sessionId}-${q.timestamp}`));
    if (toAdd.length > 0) {
      queries = [...queries, ...toAdd];
    }
  } catch (e) {
    console.error("Failed to fetch session queries:", e);
  }
}
