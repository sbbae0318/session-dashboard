let selectedSessionId = $state<string | null>(null);

export function getSelectedSessionId(): string | null {
  return selectedSessionId;
}

export function selectSession(sessionId: string): void {
  selectedSessionId = selectedSessionId === sessionId ? null : sessionId;
}

export function clearFilter(): void {
  selectedSessionId = null;
}

// Source filter
let sourceFilter = $state<"all" | "opencode" | "claude-code">("all");

export function getSourceFilter(): "all" | "opencode" | "claude-code" {
  return sourceFilter;
}

export function setSourceFilter(source: "all" | "opencode" | "claude-code"): void {
  sourceFilter = source;
}
