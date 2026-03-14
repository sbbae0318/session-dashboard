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
}

let tokenData = $state<TokensData | null>(null);
let tokenAvailable = $state(false);
let tokenLoading = $state(false);

export function getTokenData(): TokensData | null { return tokenData; }
export function isTokenAvailable(): boolean { return tokenAvailable; }
export function isTokenLoading(): boolean { return tokenLoading; }

export async function fetchTokenStats(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  tokenLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<TokensData>>(
      `/api/enrichment/${machineId}/tokens`
    );
    tokenData = res.data;
    tokenAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch token stats:', e);
    tokenAvailable = false;
  } finally {
    tokenLoading = false;
  }
}

let impactData = $state<SessionCodeImpact[] | null>(null);
let impactAvailable = $state(false);
let impactLoading = $state(false);

export function getImpactData(): SessionCodeImpact[] | null { return impactData; }
export function isImpactAvailable(): boolean { return impactAvailable; }
export function isImpactLoading(): boolean { return impactLoading; }

export async function fetchImpactData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  impactLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<SessionCodeImpact[]>>(
      `/api/enrichment/${machineId}/impact`
    );
    impactData = res.data;
    impactAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch impact data:', e);
    impactAvailable = false;
  } finally {
    impactLoading = false;
  }
}

let timelineData = $state<TimelineEntry[] | null>(null);
let timelineAvailable = $state(false);
let timelineLoading = $state(false);

export function getTimelineData(): TimelineEntry[] | null { return timelineData; }
export function isTimelineAvailable(): boolean { return timelineAvailable; }
export function isTimelineLoading(): boolean { return timelineLoading; }

export async function fetchTimelineData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  timelineLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<TimelineEntry[]>>(
      `/api/enrichment/${machineId}/timeline`
    );
    timelineData = res.data;
    timelineAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch timeline data:', e);
    timelineAvailable = false;
  } finally {
    timelineLoading = false;
  }
}

let projectsData = $state<ProjectSummary[] | null>(null);
let projectsAvailable = $state(false);
let projectsLoading = $state(false);

export function getProjectsData(): ProjectSummary[] | null { return projectsData; }
export function isProjectsAvailable(): boolean { return projectsAvailable; }
export function isProjectsLoading(): boolean { return projectsLoading; }

export async function fetchProjectsData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  projectsLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<ProjectSummary[]>>(
      `/api/enrichment/${machineId}/projects`
    );
    projectsData = res.data;
    projectsAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch projects data:', e);
    projectsAvailable = false;
  } finally {
    projectsLoading = false;
  }
}

let recoveryData = $state<RecoveryContext[] | null>(null);
let recoveryAvailable = $state(false);
let recoveryLoading = $state(false);

export function getRecoveryData(): RecoveryContext[] | null { return recoveryData; }
export function isRecoveryAvailable(): boolean { return recoveryAvailable; }
export function isRecoveryLoading(): boolean { return recoveryLoading; }

export async function fetchRecoveryData(): Promise<void> {
  const machineId = getSelectedMachineId();
  if (!machineId) return;
  recoveryLoading = true;
  try {
    const res = await fetchJSON<EnrichmentResponse<RecoveryContext[]>>(
      `/api/enrichment/${machineId}/recovery`
    );
    recoveryData = res.data;
    recoveryAvailable = res.available;
  } catch (e) {
    console.error('Failed to fetch recovery data:', e);
    recoveryAvailable = false;
  } finally {
    recoveryLoading = false;
  }
}
