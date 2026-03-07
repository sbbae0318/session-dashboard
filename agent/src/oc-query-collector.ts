/**
 * oc-query-collector.ts
 *
 * oc-serve REST API를 폴링하여 사용자 프롬프트를 QueryEntry 배열로 수집.
 * Promise.allSettled로 개별 세션 실패를 격리하고,
 * oc-serve 다운 시 빈 배열을 반환 (throw 금지).
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
  info: { role: string; id: string };
  parts?: Array<{ type: string; text?: string }>;
}

// ── QueryEntry shape (기존 API shape 유지) ──

export interface QueryEntry {
  sessionId: string;
  sessionTitle: string | null;
  timestamp: number;
  query: string;
  isBackground: boolean;
  source: 'opencode';
}

const QUERY_MAX_LENGTH = 2000;

// output limit과 분리된 내부 세션 fetch 한도
// oc-serve에 200+ 세션이 있을 때 활성 세션이 누락되지 않도록 충분히 크게
const INTERNAL_SESSION_FETCH_LIMIT = 500;

export class OcQueryCollector {
  private readonly ocServePort: number;



  constructor(
    ocServePort: number,
    private readonly getExtraSessionIds?: () => string[],
  ) {
    this.ocServePort = ocServePort;
  }

  /**
   * oc-serve에서 최근 세션들의 user 프롬프트를 수집하여 QueryEntry 배열로 반환.
   * oc-serve 다운 시 빈 배열 + console.warn.
   */
  async collectQueries(limit: number = 50): Promise<QueryEntry[]> {
    let sessions: OcServeSession[];
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session?limit=${INTERNAL_SESSION_FETCH_LIMIT}`;
      const data = await fetchJson(url, {}, 3000);
      if (!Array.isArray(data)) return [];
      sessions = data as OcServeSession[];
    } catch {
      console.warn('[oc-query-collector] oc-serve unreachable, returning empty');
      return [];
    }

    // 콜백으로 보완 세션 ID 가져오기 (SessionCache 등 외부 소스)
    const extraIds = this.getExtraSessionIds?.() ?? [];
    const existingIds = new Set(sessions.map((s) => s.id));
    const missingIds = extraIds.filter((id) => !existingIds.has(id));

    const supplementResults = await Promise.allSettled(
      missingIds.map((id) =>
        fetchJson(
          `http://127.0.0.1:${this.ocServePort}/session/${id}`,
          {},
          3000,
        ),
      ),
    );
    for (const result of supplementResults) {
      if (result.status === 'fulfilled' && result.value && typeof result.value === 'object') {
        sessions.push(result.value as OcServeSession);
      }
    }

    // parentID가 있는 세션 = 서브에이전트/툴 생성 세션 → 제외
    const mainSessions = sessions.filter((s) => !s.parentID);

    // 각 세션의 메시지를 병렬로 가져오기 (개별 실패 격리)
    const results = await Promise.allSettled(
      mainSessions.map((session) => this.collectFromSession(session)),
    );

    const entries: QueryEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        entries.push(...result.value);
      }
    }

    // 최신순 정렬 후 limit 적용
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  /** 단일 세션에서 user 프롬프트를 추출 */
  private async collectFromSession(session: OcServeSession): Promise<QueryEntry[]> {
    const url = `http://127.0.0.1:${this.ocServePort}/session/${session.id}/message`;
    const data = await fetchJson(url, {}, 3000);
    if (!Array.isArray(data)) return [];

    const messages = data as OcServeMessage[];
    // 모든 메시지 처리 (incremental 제거 - 서버가 전체 목록을 기대함)


    const newMessages = messages;


    const entries: QueryEntry[] = [];
    const background = isBackgroundSession(session.title);

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

      const rawTime = session.time;
      const timestamp = typeof rawTime === 'object' && rawTime !== null
        ? rawTime.created
        : (rawTime || Date.now());

      entries.push({
        sessionId: session.id,
        sessionTitle: session.title,
        timestamp,
        query: extracted.slice(0, QUERY_MAX_LENGTH),
        isBackground: background,
        source: 'opencode',
      });
    }

    return entries;
  }
}
