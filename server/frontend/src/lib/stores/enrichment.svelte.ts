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

class EnrichmentStore {
  tokenData = $state<TokensData | null>(null);
  tokenAvailable = $state(false);
  tokenLoading = $state(false);

  impactData = $state<SessionCodeImpact[] | null>(null);
  impactAvailable = $state(false);
  impactLoading = $state(false);

  timelineData = $state<TimelineEntry[] | null>(null);
  timelineAvailable = $state(false);
  timelineLoading = $state(false);

  projectsData = $state<ProjectSummary[] | null>(null);
  projectsAvailable = $state(false);
  projectsLoading = $state(false);

  recoveryData = $state<RecoveryContext[] | null>(null);
  recoveryAvailable = $state(false);
  recoveryLoading = $state(false);

  summaryCache = $state<Map<string, { summary: string; generatedAt: number }>>(new Map());
  summaryLoading = $state<Set<string>>(new Set());

  async fetchTokenStats(): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.tokenLoading = true;
    try {
      const res = await fetchJSON<EnrichmentResponse<TokensData>>(
        `/api/enrichment/${machineId}/tokens`
      );
      this.tokenData = res.data;
      this.tokenAvailable = res.available;
    } catch (e) {
      console.error('Failed to fetch token stats:', e);
      this.tokenAvailable = false;
    } finally {
      this.tokenLoading = false;
    }
  }

  async fetchImpactData(): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.impactLoading = true;
    try {
      const res = await fetchJSON<EnrichmentResponse<SessionCodeImpact[]>>(
        `/api/enrichment/${machineId}/impact`
      );
      this.impactData = res.data;
      this.impactAvailable = res.available;
    } catch (e) {
      this.impactAvailable = false;
    } finally {
      this.impactLoading = false;
    }
  }

  async fetchTimelineData(from?: number, to?: number, projectId?: string): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.timelineLoading = true;
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from.toString());
      if (to) params.set('to', to.toString());
      if (projectId) params.set('projectId', projectId);
      const qs = params.toString();
      const url = `/api/enrichment/${machineId}/timeline${qs ? '?' + qs : ''}`;
      const res = await fetchJSON<EnrichmentResponse<TimelineEntry[]>>(url);
      this.timelineData = res.data;
      this.timelineAvailable = res.available;
    } catch (e) {
      console.error('Failed to fetch timeline data:', e);
      this.timelineAvailable = false;
    } finally {
      this.timelineLoading = false;
    }
  }

  async fetchProjectsData(): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.projectsLoading = true;
    try {
      const res = await fetchJSON<EnrichmentResponse<ProjectSummary[]>>(
        `/api/enrichment/${machineId}/projects`
      );
      this.projectsData = res.data;
      this.projectsAvailable = res.available;
    } catch (e) {
      console.error('Failed to fetch projects data:', e);
      this.projectsAvailable = false;
    } finally {
      this.projectsLoading = false;
    }
  }

  async fetchRecoveryData(): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.recoveryLoading = true;
    try {
      const res = await fetchJSON<EnrichmentResponse<RecoveryContext[]>>(
        `/api/enrichment/${machineId}/recovery`
      );
      this.recoveryData = res.data;
      this.recoveryAvailable = res.available;
    } catch (e) {
      console.error('Failed to fetch recovery data:', e);
      this.recoveryAvailable = false;
    } finally {
      this.recoveryLoading = false;
    }
  }

  getSummary(sessionId: string): string | null {
    return this.summaryCache.get(sessionId)?.summary ?? null;
  }

  isSummaryLoading(sessionId: string): boolean {
    return this.summaryLoading.has(sessionId);
  }

  async fetchSummary(sessionId: string): Promise<void> {
    const machineId = getSelectedMachineId();
    if (!machineId) return;
    this.summaryLoading = new Set([...this.summaryLoading, sessionId]);
    try {
      const res = await fetchJSON<{ summary: string; generatedAt: number }>(
        `/api/enrichment/${machineId}/recovery/${sessionId}/summarize`,
        { method: 'POST' },
      );
      if (res.summary) {
        this.summaryCache = new Map([...this.summaryCache, [sessionId, res]]);
      }
    } catch (e) {
      console.error('Failed to fetch summary:', e);
    } finally {
      const next = new Set(this.summaryLoading);
      next.delete(sessionId);
      this.summaryLoading = next;
    }
  }
}

export const enrichment = new EnrichmentStore();
