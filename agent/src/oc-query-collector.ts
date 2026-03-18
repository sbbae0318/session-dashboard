/**
 * oc-query-collector.ts
 *
 * oc-serve REST API를 폴링하여 사용자 프롬프트를 QueryEntry 배열로 수집.
 * Promise.allSettled로 개별 세션 실패를 격리하고,
 * oc-serve 다운 시 SessionCache 데이터로 폴백 (수집 계속).
 *
 * 개선된 아키텍첲:
 * - oc-serve 세션 목록: 실패/타임아웃 시 SessionCache로 폴백
 * - SessionCache 보완 세션: lastPrompt 데이터 직접 사용 (oc-serve message fetch 불필요)
 */

import { fetchJson } from './oc-serve-proxy.js';
import { extractUserPrompt, isBackgroundSession } from './prompt-extractor.js';
// ── oc-serve API 응답 타입 ──

interface OcServeSession {
  id: string;
  title: string | null;
  time: { created: number; updated: number } | number;
  parentID?: string;  // 있으면 서브에이전트/툴 생성 세션
}

interface OcServeMessage {
  info: {
    role: string;
    id: string;
    time?: { created: number; completed?: number };
  };
  parts?: Array<{ type: string; text?: string }>;
}

// ── QueryEntry shape (기존 API shape 유지) ──

export interface QueryEntry {
  sessionId: string;
  sessionTitle: string | null;
  timestamp: number;
  query: string;
  isBackground: boolean;
  source: 'opencode' | 'claude-code';
  completedAt: number | null;
}

// SessionCache에서 보완 세션의 데이터 다양한 형식 지원 (SessionDetail 하위호환)
// oc-query-collector.ts가 session-cache.ts에 의존하지 않도록 간단한 인터페이스로 정의
export interface SupplementData {
  lastPrompt: string | null;
  lastPromptTime: number;
  status?: 'busy' | 'idle' | 'retry';
  title?: string | null;
}

const QUERY_MAX_LENGTH = 2000;

// output limit과 분리된 내부 세션 fetch 한도
// oc-serve에 200+ 세션이 있을 때 활성 세션이 누락되지 않도록 충분히 크게
const INTERNAL_SESSION_FETCH_LIMIT = 100;

// oc-serve가 부하 상태일 때 충분히 기다리기 위한 타임아웃
// /session?limit=500 실측: ~5초, /session/{id}/message 실측: ~8초
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MESSAGE_FETCH_TIMEOUT_MS = 10_000;

export class OcQueryCollector {
  private readonly ocServePort: number;

  constructor(
    ocServePort: number,
    /**
     * SessionCache에서 활성 세션 데이터를 제공하는 콜백.
     * 반환된 데이터는 oc-serve 세션 목록에 없는 세션에 대해
     * lastPrompt를 직접 QueryEntry로 변환함 (속도 + 신뢰성 향상).
     */
    private readonly getSupplementData?: () => Record<string, SupplementData>,
  ) {
    this.ocServePort = ocServePort;
  }

  /** 모든 프로젝트 worktree 경로를 가져옴 */
  private async fetchProjectWorktrees(): Promise<string[]> {
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/project`;
      const data = await fetchJson(url, {}, SESSION_LIST_TIMEOUT_MS);
      if (!Array.isArray(data)) return [];
      return (data as Array<{ worktree?: string }>)
        .map(p => p.worktree)
        .filter((w): w is string => typeof w === 'string' && w !== '/');
    } catch {
      return [];
    }
  }

  /** 모든 프로젝트에서 세션 병렬 수집 후 deduplicate */
  private async fetchSessionsFromAllProjects(worktrees: string[]): Promise<OcServeSession[]> {
    const PER_PROJECT_LIMIT = 20;
    const results = await Promise.allSettled(
      worktrees.map(async (worktree) => {
        const url = `http://127.0.0.1:${this.ocServePort}/session?directory=${encodeURIComponent(worktree)}&limit=${PER_PROJECT_LIMIT}`;
        const data = await fetchJson(url, {}, SESSION_LIST_TIMEOUT_MS);
        return Array.isArray(data) ? (data as OcServeSession[]) : [];
      }),
    );
    // Deduplicate by session ID
    const seen = new Set<string>();
    const sessions: OcServeSession[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const session of result.value) {
        if (!seen.has(session.id)) {
          seen.add(session.id);
          sessions.push(session);
        }
      }
    }
    return sessions;
  }

  /**
   * oc-serve에서 최근 세션들의 user 프롬프트를 수집하여 QueryEntry 배열로 반환.
   * oc-serve 다운 시 빈 배열 + console.warn.
   */
   async collectQueries(limit: number = 50): Promise<QueryEntry[]> {
    const cacheEntries: QueryEntry[] = [];
    const cacheSessionIds = new Set<string>();
    if (this.getSupplementData) {
      const supplementData = this.getSupplementData();
      for (const [sessionId, data] of Object.entries(supplementData)) {
        if (!data.lastPrompt) continue;
        const extracted = extractUserPrompt(data.lastPrompt);
        if (extracted === null) continue;
        cacheSessionIds.add(sessionId);
        cacheEntries.push({
          sessionId,
          sessionTitle: data.title ?? null,
          timestamp: data.lastPromptTime || Date.now(),
          query: extracted.slice(0, QUERY_MAX_LENGTH),
          isBackground: false,
          source: 'opencode',
          completedAt: data.status === 'idle' ? (data.lastPromptTime || Date.now()) : null,
        });
      }
    }

    let sessions: OcServeSession[] = [];
    const worktrees = await this.fetchProjectWorktrees();
    if (worktrees.length > 0) {
      sessions = await this.fetchSessionsFromAllProjects(worktrees);
    }

    // 전역 세션 보완 — 등록 안 된 프로젝트의 세션도 수집
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session?limit=${INTERNAL_SESSION_FETCH_LIMIT}`;
      const data = await fetchJson(url, {}, SESSION_LIST_TIMEOUT_MS);
      if (Array.isArray(data)) {
        const existingIds = new Set(sessions.map(s => s.id));
        for (const session of data as OcServeSession[]) {
          if (!existingIds.has(session.id)) {
            sessions.push(session);
          }
        }
      }
    } catch {
      if (sessions.length === 0 && cacheEntries.length === 0) {
        console.warn('[oc-query-collector] session list fetch failed, no cache data available');
      }
    }

    const uncachedSessions = sessions.filter(s => !cacheSessionIds.has(s.id));

    const getUpdatedTime = (s: OcServeSession): number => {
      const t = s.time;
      return typeof t === 'object' && t !== null ? t.updated ?? t.created : (t || 0);
    };
    const byUpdatedDesc = (a: OcServeSession, b: OcServeSession) =>
      getUpdatedTime(b) - getUpdatedTime(a);

    const UNCACHED_FETCH_LIMIT = 20;
    const mainUncached = uncachedSessions
      .filter((s) => !s.parentID)
      .sort(byUpdatedDesc)
      .slice(0, UNCACHED_FETCH_LIMIT);

    const BG_SESSION_LIMIT = 10;
    const bgUncached = uncachedSessions
      .filter((s) => !!s.parentID)
      .sort(byUpdatedDesc)
      .slice(0, BG_SESSION_LIMIT);

    const [mainResults, bgResults] = await Promise.all([
      Promise.allSettled(mainUncached.map((s) => this.collectFromSession(s))),
      Promise.allSettled(bgUncached.map((s) => this.collectFromSession(s))),
    ]);

    const ocServeEntries: QueryEntry[] = [];
    for (const result of mainResults) {
      if (result.status === 'fulfilled') {
        ocServeEntries.push(...result.value);
      }
    }
    for (const result of bgResults) {
      if (result.status === 'fulfilled') {
        for (const entry of result.value) {
          entry.isBackground = true;
        }
        ocServeEntries.push(...result.value);
      }
    }

    const entries = [...cacheEntries, ...ocServeEntries];

    // 최신순 정렬 후 limit 적용
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  /** 단일 세션에서 user 프롬프트를 추출 */
  private async collectFromSession(session: OcServeSession): Promise<QueryEntry[]> {
    const url = `http://127.0.0.1:${this.ocServePort}/session/${session.id}/message`;
    const data = await fetchJson(url, {}, MESSAGE_FETCH_TIMEOUT_MS);
    if (!Array.isArray(data)) return [];

    const messages = data as OcServeMessage[];
    // 모든 메시지 처리 (incremental 제거 - 서버가 전체 목록을 기대함)


    const newMessages = messages;


    let lastEntry: QueryEntry | null = null;
    const background = isBackgroundSession(session.title);
    let lastUserMsgIndex = -1;

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      if (msg.info?.role !== 'user') continue;

      // text parts를 합쳐서 하나의 text로
      const textParts = (msg.parts ?? [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string);

      if (textParts.length === 0) continue;

      const rawText = textParts.join('\n');
      const extracted = extractUserPrompt(rawText);
      if (extracted === null) continue;

      // per-message 타임스탬프 사용 (info.time.created), 없으면 session 타임스탬프 폴백
      const msgTime = msg.info?.time?.created;
      const rawTime = session.time;
      const sessionTs = typeof rawTime === 'object' && rawTime !== null
        ? rawTime.created
        : (rawTime || Date.now());
      const timestamp = msgTime ?? sessionTs;

      lastUserMsgIndex = i;
      lastEntry = {
        sessionId: session.id,
        sessionTitle: session.title,
        timestamp,
        query: extracted.slice(0, QUERY_MAX_LENGTH),
        isBackground: background,
        source: 'opencode',
        completedAt: null,
      };
      // break 제거 — 계속 순회하여 마지막 유효 메시지를 찾음
    }

    // 마지막 user 메시지 이후의 assistant 메시지에서 completedAt 추출
    if (lastEntry && lastUserMsgIndex >= 0) {
      for (let i = newMessages.length - 1; i > lastUserMsgIndex; i--) {
        const msg = newMessages[i];
        if (msg.info?.role === 'assistant' && msg.info?.time?.completed) {
          lastEntry.completedAt = msg.info.time.completed;
          break;
        }
      }
    }

    return lastEntry ? [lastEntry] : [];
  }
}
