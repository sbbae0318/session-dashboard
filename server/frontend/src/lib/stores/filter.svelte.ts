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
let sourceFilter = $state<"all" | "opencode" | "claude-code">("all");

export function getSourceFilter(): "all" | "opencode" | "claude-code" {
  return sourceFilter;
}

export function setSourceFilter(source: "all" | "opencode" | "claude-code"): void {
  sourceFilter = source;
}

// Time range filter
export type TimeRange = "1h" | "6h" | "1d" | "7d" | "all";
let timeRange = $state<TimeRange>("1d");

export function getTimeRange(): TimeRange {
  return timeRange;
}

export function setTimeRange(range: TimeRange): void {
  timeRange = range;
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
