import { writable } from 'svelte/store';
import { fetchJSON } from '../api';
import { getSelectedMachineId, getMachines } from './machine.svelte';

function resolveEnrichmentMachineId(): string | null {
  const selected = getSelectedMachineId();
  if (selected) return selected;
  const machines = getMachines();
  return machines[0]?.id ?? null;
}

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

export const tokenData = writable<TokensData | null>(null);
export const tokenAvailable = writable<boolean>(false);
export const tokenLoading = writable<boolean>(false);

export const impactData = writable<SessionCodeImpact[] | null>(null);
export const impactAvailable = writable<boolean>(false);
export const impactLoading = writable<boolean>(false);

export const timelineData = writable<TimelineEntry[] | null>(null);
export const timelineAvailable = writable<boolean>(false);
export const timelineLoading = writable<boolean>(false);

export const projectsData = writable<ProjectSummary[] | null>(null);
export const projectsAvailable = writable<boolean>(false);
export const projectsLoading = writable<boolean>(false);

export const recoveryData = writable<RecoveryContext[] | null>(null);
export const recoveryAvailable = writable<boolean>(false);
export const recoveryLoading = writable<boolean>(false);

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

interface MergedEnrichmentResponse<T> {
  data: T | null;
  available: boolean;
  machineCount: number;
  cachedAt: number;
}

export const summaryCache = writable<Record<string, { summary: string; generatedAt: number }>>({});
export const summaryLoadingIds = writable<string[]>([]);

export async function fetchTokenStats(): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  tokenLoading.set(true);
  try {
    const url = machineId
      ? `/api/enrichment/${machineId}/tokens`
      : `/api/enrichment/merged/tokens`;
    const res = await fetchJSON<EnrichmentResponse<TokensData> | MergedEnrichmentResponse<TokensData>>(url);
    tokenData.set(res.data);
    tokenAvailable.set(res.available);
  } catch (e) {
    console.error('Failed to fetch token stats:', e);
    tokenAvailable.set(false);
  } finally {
    tokenLoading.set(false);
  }
}

export async function fetchImpactData(): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  impactLoading.set(true);
  try {
    const url = machineId
      ? `/api/enrichment/${machineId}/impact`
      : `/api/enrichment/merged/impact`;
    const res = await fetchJSON<EnrichmentResponse<SessionCodeImpact[]> | MergedEnrichmentResponse<MergedSessionCodeImpact[]>>(url);
    impactData.set(res.data);
    impactAvailable.set(res.available);
  } catch (e) {
    console.error('Failed to fetch impact data:', e);
    impactAvailable.set(false);
  } finally {
    impactLoading.set(false);
  }
}

export async function fetchTimelineData(from?: number, to?: number, projectId?: string): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  timelineLoading.set(true);
  try {
    const params = new URLSearchParams();
    if (from) params.set('from', from.toString());
    if (to) params.set('to', to.toString());
    if (projectId) params.set('projectId', projectId);
    const qs = params.toString();
    const url = machineId
      ? `/api/enrichment/${machineId}/timeline${qs ? '?' + qs : ''}`
      : `/api/enrichment/merged/timeline${qs ? '?' + qs : ''}`;
    const res = await fetchJSON<EnrichmentResponse<TimelineEntry[]> | MergedEnrichmentResponse<MergedTimelineEntry[]>>(url);
    timelineData.set(res.data);
    timelineAvailable.set(res.available);
  } catch (e) {
    console.error('Failed to fetch timeline data:', e);
    timelineAvailable.set(false);
  } finally {
    timelineLoading.set(false);
  }
}

export async function fetchProjectsData(): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  projectsLoading.set(true);
  try {
    const url = machineId
      ? `/api/enrichment/${machineId}/projects`
      : `/api/enrichment/merged/projects`;
    const res = await fetchJSON<EnrichmentResponse<ProjectSummary[]> | MergedEnrichmentResponse<MergedProjectSummary[]>>(url);
    projectsData.set(res.data);
    projectsAvailable.set(res.available);
  } catch (e) {
    console.error('Failed to fetch projects data:', e);
    projectsAvailable.set(false);
  } finally {
    projectsLoading.set(false);
  }
}

export async function fetchRecoveryData(): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  recoveryLoading.set(true);
  try {
    const url = machineId
      ? `/api/enrichment/${machineId}/recovery`
      : `/api/enrichment/merged/recovery`;
    const res = await fetchJSON<EnrichmentResponse<RecoveryContext[]> | MergedEnrichmentResponse<MergedRecoveryContext[]>>(url);
    recoveryData.set(res.data);
    recoveryAvailable.set(res.available);
  } catch (e) {
    console.error('Failed to fetch recovery data:', e);
    recoveryAvailable.set(false);
  } finally {
    recoveryLoading.set(false);
  }
}

export async function fetchSummary(sessionId: string): Promise<void> {
  const machineId = resolveEnrichmentMachineId();
  if (!machineId) return;
  summaryLoadingIds.update(ids => [...ids, sessionId]);
  try {
    const res = await fetchJSON<{ summary: string; generatedAt: number }>(
      `/api/enrichment/${machineId}/recovery/${sessionId}/summarize`,
      { method: 'POST' },
    );
    if (res.summary) {
      summaryCache.update(cache => ({ ...cache, [sessionId]: res }));
    }
  } catch (e) {
    console.error('Failed to fetch summary:', e);
  } finally {
    summaryLoadingIds.update(ids => ids.filter(id => id !== sessionId));
  }
}
