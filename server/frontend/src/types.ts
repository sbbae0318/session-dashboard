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
  source?: "opencode" | "claude-code";
  project?: { cwd: string; root: string };
  parentSessionID?: string;
  endReason?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  invocations?: {
    total: number;
    errorTotal: number;
    byTool: Record<string, { count: number; errors: number }>;
  };

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

export interface QueryEntry {
  sessionId: string;
  sessionTitle: string | null;
  timestamp: number;
  query: string;
  isBackground: boolean;
  source?: "opencode" | "claude-code";

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

export interface DashboardSession {
  sessionId: string;
  parentSessionId: string | null;
  childSessionIds: string[];
  title: string | null;
  projectCwd: string | null;
  status: "active" | "completed" | "orphaned";
  startTime: number;
  lastActivityTime: number;
  currentTool: string | null;
  duration: string | null;
  summary: string | null;
  apiStatus: "idle" | "busy" | "retry" | null;
  lastPrompt: string | null;

  source?: "opencode" | "claude-code";

  // Machine fields — runtime-injected by MachineManager (not in JSONL)
  machineId: string;
  machineHost: string;
  machineAlias: string;
}

export interface MachineInfo {
  id: string;
  alias: string;
  host: string;
  status: 'connected' | 'disconnected';
  lastSeen: number | null;
  error: string | null;
  source?: "opencode" | "claude-code" | "both";
}
