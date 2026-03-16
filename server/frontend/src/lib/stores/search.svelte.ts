import type { SearchResult, SearchMeta, TimeRange, SearchResponse } from "../search-client";
import { searchSessions } from "../search-client";

let searchQuery = $state("");
let timeRange = $state<TimeRange>("7d");
let serverResults = $state<SearchResult[]>([]);
let isSearching = $state(false);
let searchMeta = $state<SearchMeta | null>(null);
let searchError = $state<string | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function getSearchQuery(): string {
  return searchQuery;
}

export function setSearchQuery(value: string): void {
  searchQuery = value;
}

export function getTimeRange(): TimeRange {
  return timeRange;
}

export function setTimeRange(value: TimeRange): void {
  timeRange = value;
}

export function getServerResults(): SearchResult[] {
  return serverResults;
}

export function getIsSearching(): boolean {
  return isSearching;
}

export function getSearchMeta(): SearchMeta | null {
  return searchMeta;
}

export function getSearchError(): string | null {
  return searchError;
}

export async function performSearch(query: string, range: TimeRange): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  searchQuery = query;
  timeRange = range;

  if (query.trim().length < 2) {
    serverResults = [];
    isSearching = false;
    searchMeta = null;
    searchError = null;
    return;
  }

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    isSearching = true;
    searchError = null;
    try {
      const response: SearchResponse = await searchSessions(query, range);
      serverResults = response.results;
      searchMeta = response.meta;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return;
      }
      searchError = "서버 검색 실패";
      serverResults = [];
      searchMeta = null;
    } finally {
      isSearching = false;
    }
  }, 300);
}

export function clearSearch(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  searchQuery = "";
  timeRange = "7d";
  serverResults = [];
  isSearching = false;
  searchMeta = null;
  searchError = null;
}
