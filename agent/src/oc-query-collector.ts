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

export class OcQueryCollector {
  private readonly ocServePort: number;
  /** 세션별 마지막으로 처리한 메시지 수 캐시 (incremental 용) */
  private lastSeenMessageCount: Map<string, number> = new Map();

  constructor(ocServePort: number) {
    this.ocServePort = ocServePort;
  }

  /**
   * oc-serve에서 최근 세션들의 user 프롬프트를 수집하여 QueryEntry 배열로 반환.
   * oc-serve 다운 시 빈 배열 + console.warn.
   */
  async collectQueries(limit: number = 50): Promise<QueryEntry[]> {
    let sessions: OcServeSession[];
    try {
      const url = `http://127.0.0.1:${this.ocServePort}/session?limit=${limit}`;
      const data = await fetchJson(url, {}, 3000);
      if (!Array.isArray(data)) return [];
      sessions = data as OcServeSession[];
    } catch {
      console.warn('[oc-query-collector] oc-serve unreachable, returning empty');
      return [];
    }

    // 각 세션의 메시지를 병렬로 가져오기 (개별 실패 격리)
    const results = await Promise.allSettled(
      sessions.map((session) => this.collectFromSession(session)),
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
    const previousCount = this.lastSeenMessageCount.get(session.id) ?? 0;

    // incremental: 이전에 처리한 메시지 이후의 것만 처리
    const newMessages = messages.slice(previousCount);
    this.lastSeenMessageCount.set(session.id, messages.length);

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
