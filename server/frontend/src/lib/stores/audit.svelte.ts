import type {
  PromptTurnSummary,
  PromptAuditResponse,
  SessionTurnsResponse,
} from '../../types';
import { fetchJSON } from '../api';

// ── Session turns cache (Map: sessionId → turns[]) ──
let sessionTurnsCache = $state<Map<string, PromptTurnSummary[]>>(new Map());

export function getSessionTurns(sessionId: string): PromptTurnSummary[] {
  return sessionTurnsCache.get(sessionId) ?? [];
}

export async function fetchSessionTurns(sessionId: string): Promise<void> {
  try {
    const data = await fetchJSON<SessionTurnsResponse>(`/api/sessions/${sessionId}/turns`);
    sessionTurnsCache = new Map(sessionTurnsCache).set(sessionId, data.turns);
  } catch (e) {
    console.error('Failed to fetch session turns:', e);
  }
}

// ── Prompt audit cache (Map: promptId → audit) ──
let auditCache = $state<Map<string, PromptAuditResponse>>(new Map());

export function getPromptAudit(promptId: string): PromptAuditResponse | null {
  return auditCache.get(promptId) ?? null;
}

export async function fetchPromptAudit(promptId: string): Promise<PromptAuditResponse | null> {
  const cached = auditCache.get(promptId);
  if (cached) return cached;

  try {
    const data = await fetchJSON<PromptAuditResponse>(`/api/prompts/${promptId}/audit`);
    auditCache = new Map(auditCache).set(promptId, data);
    return data;
  } catch (e) {
    console.error('Failed to fetch prompt audit:', e);
    return null;
  }
}

// ── Transcript body (on-demand, not cached in store) ──
export async function fetchTranscriptBody(promptId: string): Promise<unknown> {
  return fetchJSON(`/api/prompts/${promptId}/transcript`);
}

export async function fetchSubagentTranscript(promptId: string, agentKey: string): Promise<unknown> {
  return fetchJSON(`/api/prompts/${promptId}/subagent/${agentKey}/transcript`);
}
