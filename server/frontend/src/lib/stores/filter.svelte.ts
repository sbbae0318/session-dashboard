const STORAGE_KEY = 'session-dashboard:filters';

interface PersistedFilters {
  timeRange: TimeRange;
  sourceFilter: "all" | "opencode" | "claude-code";
}

function loadFilters(): PersistedFilters {
  if (typeof window === 'undefined') return { timeRange: "7d", sourceFilter: "all" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { timeRange: "7d", sourceFilter: "all" };
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    return {
      timeRange: isValidTimeRange(parsed.timeRange) ? parsed.timeRange : "7d",
      sourceFilter: isValidSource(parsed.sourceFilter) ? parsed.sourceFilter : "all",
    };
  } catch {
    return { timeRange: "7d", sourceFilter: "all" };
  }
}

function saveFilters(): void {
  if (typeof window === 'undefined') return;
  try {
    const data: PersistedFilters = { timeRange, sourceFilter };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable
  }
}

function isValidTimeRange(v: unknown): v is TimeRange {
  return v === "1h" || v === "6h" || v === "1d" || v === "7d" || v === "all";
}

function isValidSource(v: unknown): v is "all" | "opencode" | "claude-code" {
  return v === "all" || v === "opencode" || v === "claude-code";
}

const saved = loadFilters();

let selectedSessionId = $state<string | null>(null);

export function getSelectedSessionId(): string | null {
  return selectedSessionId;
}

export function selectSession(sessionId: string): void {
  selectedSessionId = selectedSessionId === sessionId ? null : sessionId;
}

export function clearFilter(): void {
  selectedSessionId = null;
  projectFilter = null;
}

// Project filter
let projectFilter = $state<string | null>(null);

export function getProjectFilter(): string | null {
  return projectFilter;
}

export function setProjectFilter(cwd: string | null): void {
  projectFilter = cwd;
}

// Source filter
let sourceFilter = $state<"all" | "opencode" | "claude-code">(saved.sourceFilter);

export function getSourceFilter(): "all" | "opencode" | "claude-code" {
  return sourceFilter;
}

export function setSourceFilter(source: "all" | "opencode" | "claude-code"): void {
  sourceFilter = source;
  saveFilters();
}

// Time range filter
export type TimeRange = "1h" | "6h" | "1d" | "7d" | "all";
let timeRange = $state<TimeRange>(saved.timeRange);

export function getTimeRange(): TimeRange {
  return timeRange;
}

export function setTimeRange(range: TimeRange): void {
  timeRange = range;
  saveFilters();
}

/** Returns cutoff timestamp (ms) for the current time range, or 0 for "all" */
export function getTimeRangeCutoff(): number {
  if (timeRange === "all") return 0;
  const ms: Record<TimeRange, number> = {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "1d": 86_400_000,
    "7d": 604_800_000,
    "all": 0,
  };
  return Date.now() - ms[timeRange];
}
