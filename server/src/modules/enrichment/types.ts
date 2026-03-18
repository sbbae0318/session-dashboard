export interface EnrichmentResponse<T> {
  data: T | null;
  available: boolean;
  error?: string;
  cachedAt: number;
}

// --- Projects ---
export interface ProjectSummary {
  id: string;
  worktree: string;
  sessionCount: number;
  activeSessionCount: number;
  lastActivityAt: number;
  totalTokens: number;
  totalCost: number;
  totalAdditions: number;
  totalDeletions: number;
}

// --- Tokens ---
export interface SessionTokenStats {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  totalInput: number;
  totalOutput: number;
  totalReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  models: string[];
  agents: string[];
  msgCount: number;
  timeUpdated: number;
}

export interface TokensData {
  sessions: SessionTokenStats[];
  grandTotal: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

// --- Code Impact ---
export interface SessionCodeImpact {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  additions: number;
  deletions: number;
  files: number;
  timeUpdated: number;
}

// --- Timeline ---
export interface TimelineEntry {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  directory: string;
  startTime: number;
  endTime: number | null;
  status: 'busy' | 'idle' | 'completed';
  parentId: string | null;
}

// --- Recovery ---
export interface RecoveryContext {
  sessionId: string;
  sessionTitle: string;
  directory: string;
  lastActivityAt: number;
  lastPrompts: string[];
  lastTools: string[];
  additions: number;
  deletions: number;
  files: number;
  todos: Array<{ content: string; status: string; priority: string }>;
  summary?: string;
  summaryGeneratedAt?: number;
}

export type EnrichmentFeature = 'tokens' | 'impact' | 'timeline' | 'projects' | 'recovery';

export interface EnrichmentCache {
  tokens: EnrichmentResponse<TokensData> | null;
  impact: EnrichmentResponse<SessionCodeImpact[]> | null;
  timeline: EnrichmentResponse<TimelineEntry[]> | null;
  projects: EnrichmentResponse<ProjectSummary[]> | null;
  recovery: EnrichmentResponse<RecoveryContext[]> | null;
  lastUpdated: number;
}

export function createEmptyCache(): EnrichmentCache {
  return {
    tokens: null,
    impact: null,
    timeline: null,
    projects: null,
    recovery: null,
    lastUpdated: 0,
  };
}

// ==============================
// Server-side Merged Types
// (machineId injected at server level, agent types unchanged)
// ==============================

export interface MergedTimelineEntry extends TimelineEntry {
  machineId: string;
  machineAlias: string;
}

export interface MergedSessionCodeImpact extends SessionCodeImpact {
  machineId: string;
  machineAlias: string;
}

export interface MergedRecoveryContext extends RecoveryContext {
  machineId: string;
  machineAlias: string;
}

export interface MergedProjectSummary extends ProjectSummary {
  machineId: string;
  machineAlias: string;
}

export interface MergedTokensData {
  machines: Array<{
    machineId: string;
    machineAlias: string;
    data: TokensData;
  }>;
  grandTotal: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

export interface MergedEnrichmentResponse<T> {
  data: T;
  available: boolean;
  machineCount: number;
  cachedAt: number;
}

export interface TimeWindowQuery {
  from?: number;   // epoch ms
  to?: number;     // epoch ms
  limit?: number;  // max entries
}

export interface EnrichmentCacheRow {
  machine_id: string;
  feature: EnrichmentFeature;
  data: string;        // JSON serialized
  available: number;   // 0 or 1
  updated_at: number;
}

// --- Activity Segments ---
export interface ActivitySegment {
  startTime: number;
  endTime: number;
  type: 'working';
}

export interface SessionSegmentsResponse {
  sessionId: string;
  segments: ActivitySegment[];
}

export interface MergedSessionSegmentsResponse extends SessionSegmentsResponse {
  machineId: string;
  machineAlias: string;
}
