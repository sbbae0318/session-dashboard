import { fetchJSON } from '../api';
import { getSelectedMachineId } from './machine.svelte';

interface EnrichmentResponse<T> {
  data: T | null;
  available: boolean;
  error?: string;
  cachedAt: number;
}

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

interface EnrichmentState {
  tokenData: TokensData | null;
  tokenAvailable: boolean;
  tokenLoading: boolean;

  impactData: SessionCodeImpact[] | null;
  impactAvailable: boolean;
  impactLoading: boolean;

  timelineData: TimelineEntry[] | null;
  timelineAvailable: boolean;
  timelineLoading: boolean;

  projectsData: ProjectSummary[] | null;
  projectsAvailable: boolean;
  projectsLoading: boolean;

  recoveryData: RecoveryContext[] | null;
  recoveryAvailable: boolean;
  recoveryLoading: boolean;

  summaryCache: Record<string, { summary: string; generatedAt: number }>;
  summaryLoadingIds: string[];
}

let state = $state<EnrichmentState>({
  tokenData: null,
  tokenAvailable: false,
  tokenLoading: false,

  impactData: null,
  impactAvailable: false,
  impactLoading: false,

  timelineData: null,
  timelineAvailable: false,
  timelineLoading: false,

  projectsData: null,
  projectsAvailable: false,
  projectsLoading: false,

  recoveryData: null,
  recoveryAvailable: false,
  recoveryLoading: false,

  summaryCache: {},
  summaryLoadingIds: [],
});

export function getEnrichmentState(): EnrichmentState {
  return state;
}

export async function fetchTokenStats(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.tokenLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<TokensData>>(
      `/api/enrichment/${machineId}/tokens`
    );
    state.tokenData = res.data;
    state.tokenAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch token stats:', e);
    state.tokenAvailable = false;
  } finally {
    state.tokenLoading = false;
  }
}

export async function fetchImpactData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.impactLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<SessionCodeImpact[]>>(
      `/api/enrichment/${machineId}/impact`
    );
    state.impactData = res.data;
    state.impactAvailable = res.available;
  } catch (e) {
    state.impactAvailable = false;
  } finally {
    state.impactLoading = false;
  }
}

export async function fetchTimelineData(from?: number, to?: number, projectId?: string): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.timelineLoading = true;
  try {
    const params = new URLSearchParams();
    if (from) params.set('from', from.toString());
    if (to) params.set('to', to.toString());
    if (projectId) params.set('projectId', projectId);
    const qs = params.toString();
    const url = `/api/enrichment/${machineId}/timeline${qs ? '?' + qs : ''}`;
    const res = await fetchJSON<EnrichmentResponse<TimelineEntry[]>>(url);
    state.timelineData = res.data;
    state.timelineAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch timeline data:', e);
    state.timelineAvailable = false;
  } finally {
    state.timelineLoading = false;
  }
}

export async function fetchProjectsData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.projectsLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<ProjectSummary[]>>(
      `/api/enrichment/${machineId}/projects`
    );
    state.projectsData = res.data;
    state.projectsAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch projects data:', e);
    state.projectsAvailable = false;
  } finally {
    state.projectsLoading = false;
  }
}

export async function fetchRecoveryData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.recoveryLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<RecoveryContext[]>>(
      `/api/enrichment/${machineId}/recovery`
    );
    state.recoveryData = res.data;
    state.recoveryAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch recovery data:', e);
    state.recoveryAvailable = false;
  } finally {
    state.recoveryLoading = false;
  }
}

export function getSummary(sessionId: string): string | null {
  return state.summaryCache[sessionId]?.summary ?? null;
}

export function isSummaryLoading(sessionId: string): boolean {
  return state.summaryLoadingIds.includes(sessionId);
}

export async function fetchSummary(sessionId: string): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  state.summaryLoadingIds = [...state.summaryLoadingIds, sessionId];
  try {
    const res = await fetchJSON<{ summary: string; generatedAt: number }>(
      `/api/enrichment/${machineId}/recovery/${sessionId}/summarize`,
      { method: 'POST' },
    );
    if (res.summary) {
      state.summaryCache = { ...state.summaryCache, [sessionId]: res };
    }
  } catch (e) {
    console.error('Failed to fetch summary:', e);
  } finally {
    state.summaryLoadingIds = state.summaryLoadingIds.filter(id => id !== sessionId);
  }
}
