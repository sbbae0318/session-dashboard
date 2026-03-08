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
    time?: { created: number };
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
  source: 'opencode';
}

// SessionCache에서 보완 세션의 데이터 다양한 형식 지원 (SessionDetail 하위호환)
// oc-query-collector.ts가 session-cache.ts에 의존하지 않도록 간단한 인터페이스로 정의
export interface SupplementData {
  lastPrompt: string | null;
  lastPromptTime: number;
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

  /**
   * oc-serve에서 최근 세션들의 user 프롬프트를 수집하여 QueryEntry 배열로 반환.
   * oc-serve 다운 시 빈 배열 + console.warn.
   */
  async collectQueries(limit: number = 50): Promise<QueryEntry[]> {
    // oc-serve session list를 가져오되, 실패/타임아웃 시에도 SessionCache 콜백으로 계속 진행
    let sessions: OcServeSession[] = [];
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session?limit=${INTERNAL_SESSION_FETCH_LIMIT}`;
      const data = await fetchJson(url, {}, SESSION_LIST_TIMEOUT_MS);
      if (Array.isArray(data)) {
        sessions = data as OcServeSession[];
      }
    } catch {
      console.warn('[oc-query-collector] session list fetch failed, falling back to SessionCache only');
      // return하지 않음 — SessionCache 콜백으로 계속 진행
    }

    // SessionCache 보완: oc-serve 목록에 없는 활성 세션의 lastPrompt를 직접 사용
    // oc-serve message 엔드포인트를 호출하지 않아선 응답 속도와 안정성이 크게 상승
    const supplementEntries: QueryEntry[] = [];
    if (this.getSupplementData) {
      const supplementData = this.getSupplementData();
      const existingIds = new Set(sessions.map((s) => s.id));
      for (const [sessionId, data] of Object.entries(supplementData)) {
        if (existingIds.has(sessionId)) continue;   // oc-serve에도 있는 세션은 스킵
        if (!data.lastPrompt) continue;             // 프롬프트 없는 세션 스킵
        const extracted = extractUserPrompt(data.lastPrompt);
        if (extracted === null) continue;            // 시스템 프롬프트 필터
        supplementEntries.push({
          sessionId,
          sessionTitle: null,
          timestamp: data.lastPromptTime || Date.now(),
          query: extracted.slice(0, QUERY_MAX_LENGTH),
          isBackground: false,
          source: 'opencode',
        });
      }
    }

    // parentID가 있는 세션 = 서브에이전트/툴 생성 세션 → 제외
    const mainSessions = sessions.filter((s) => !s.parentID);

    // 각 세션의 메시지를 병렬로 가져오기 (개별 실패 격리)
    const results = await Promise.allSettled(
      mainSessions.map((session) => this.collectFromSession(session)),
    );

    const ocServeEntries: QueryEntry[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        ocServeEntries.push(...result.value);
      }
    }

    // oc-serve 엔트리 + SessionCache 보완 엔트리 합치지
    const entries = [...ocServeEntries, ...supplementEntries];

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

      lastEntry = {
        sessionId: session.id,
        sessionTitle: session.title,
        timestamp,
        query: extracted.slice(0, QUERY_MAX_LENGTH),
        isBackground: background,
        source: 'opencode',
      };
      // break 제거 — 계속 순회하여 마지막 유효 메시지를 찾음
    }

    return lastEntry ? [lastEntry] : [];
  }
}
