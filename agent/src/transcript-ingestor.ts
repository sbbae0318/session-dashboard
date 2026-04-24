/**
 * transcript-ingestor.ts
 *
 * Claude Code JSONL 파일을 증분 읽기하며 promptId 상태 머신으로
 * 턴 경계를 감지하고 EmittedTurn을 콜백으로 방출하는 오케스트레이터.
 */

import { readFileSync, statSync } from 'node:fs';
import {
  parseJsonlLine,
  type ExtractedToolUse,
} from './transcript-jsonl-parser.js';
import {
  scanSubagents,
  matchSubagentsToToolUses,
  type ScannedSubagent,
} from './subagent-scanner.js';

// =============================================================================
// Types
// =============================================================================

export interface EmittedTurn {
  sessionId: string;
  promptId: string;
  seq: number;
  userText: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  tools: {
    id: string;
    toolName: string;
    toolSubname: string | null;
    startedAt: number;
    endedAt: number | null;
    inputSummary: string | null;
    resultSummary: string | null;
    error: boolean;
  }[];
  subagents: (ScannedSubagent & { parentToolUseId: string | null })[];
}

interface IngestorOptions {
  onTurn: (turn: EmittedTurn) => void;
}

// 내부 툴 상태 (endedAt/resultSummary 추가 전)
interface PendingTool {
  id: string;
  toolName: string;
  toolSubname: string | null;
  startedAt: number;
  endedAt: number | null;
  inputSummary: string | null;
  resultSummary: string | null;
  error: boolean;
}

// 진행 중인 턴 상태
interface PendingTurn {
  sessionId: string;
  promptId: string;
  seq: number;
  userText: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  tools: PendingTool[];
  // tool_use_id → PendingTool 빠른 조회용
  toolMap: Map<string, PendingTool>;
}

// =============================================================================
// userText 추출
// =============================================================================

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.slice(0, 120) || null;
  }
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'text'
    ) {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string' && text.length > 0) {
        return text.slice(0, 120);
      }
    }
  }
  return null;
}

// =============================================================================
// tool_result 추출 헬퍼
// =============================================================================

interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

function extractToolResults(content: unknown[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const block of content) {
    if (
      typeof block !== 'object' ||
      block === null ||
      (block as Record<string, unknown>).type !== 'tool_result'
    ) {
      continue;
    }
    const b = block as Record<string, unknown>;
    const toolUseId = b.tool_use_id as string | undefined;
    if (!toolUseId) continue;

    const isError = b.is_error === true;
    let contentStr = '';

    if (typeof b.content === 'string') {
      contentStr = b.content.slice(0, 120);
    } else if (Array.isArray(b.content)) {
      for (const inner of b.content as unknown[]) {
        if (
          typeof inner === 'object' &&
          inner !== null &&
          (inner as Record<string, unknown>).type === 'text'
        ) {
          const t = (inner as Record<string, unknown>).text;
          if (typeof t === 'string') {
            contentStr = t.slice(0, 120);
            break;
          }
        }
      }
    }

    results.push({ toolUseId, content: contentStr, isError });
  }
  return results;
}

// =============================================================================
// TranscriptIngestor
// =============================================================================

export class TranscriptIngestor {
  private readonly onTurn: (turn: EmittedTurn) => void;

  // sessionId → 마지막 읽은 바이트 오프셋
  private readonly offsets = new Map<string, number>();
  // sessionId → 다음 seq 번호
  private readonly seqCounters = new Map<string, number>();
  // sessionId → 현재 진행 중인 턴
  private readonly pendingTurns = new Map<string, PendingTurn>();

  constructor(options: IngestorOptions) {
    this.onTurn = options.onTurn;
  }

  processFile(sessionId: string, jsonlPath: string, sessionDir: string): void {
    // 1. 현재 오프셋 & 파일 크기 확인
    let offset = this.offsets.get(sessionId) ?? 0;

    let fileSize: number;
    try {
      fileSize = statSync(jsonlPath).size;
    } catch {
      return; // 파일 없으면 스킵
    }

    // 파일이 재생성된 경우 (offset > fileSize) — 처음부터 재처리
    if (offset > fileSize) {
      offset = 0;
      this.seqCounters.delete(sessionId);
      this.pendingTurns.delete(sessionId);
    }

    if (offset === fileSize) {
      return; // 새 데이터 없음
    }

    // 2. 오프셋 이후 내용 읽기
    let newContent: string;
    try {
      const buf = readFileSync(jsonlPath);
      newContent = buf.subarray(offset).toString('utf-8');
    } catch {
      return;
    }

    // 3. 라인별 파싱
    const lines = newContent.split('\n');

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      const event = parseJsonlLine(line);
      if (!event) continue;

      if (event.type === 'user') {
        const rawLine = JSON.parse(line) as Record<string, unknown>;
        const isMeta = rawLine.isMeta === true;

        // content가 배열이면 tool_result 체크
        const msgContent = (rawLine.message as Record<string, unknown> | undefined)?.content;
        if (Array.isArray(msgContent)) {
          const toolResults = extractToolResults(msgContent as unknown[]);
          if (toolResults.length > 0) {
            // tool_result 처리: 현재 pending turn의 툴에 endedAt/resultSummary 설정
            const pending = this.pendingTurns.get(sessionId);
            if (pending) {
              for (const tr of toolResults) {
                const tool = pending.toolMap.get(tr.toolUseId);
                if (tool) {
                  tool.endedAt = event.timestamp;
                  tool.resultSummary = tr.content || null;
                  tool.error = tr.isError;
                }
              }
            }
            continue; // tool_result 라인은 userText 추출 대상에서 제외
          }
        }

        if (event.promptId === null) continue; // user 라인인데 promptId 없으면 스킵

        const currentPending = this.pendingTurns.get(sessionId);
        const isNewPrompt = !currentPending || currentPending.promptId !== event.promptId;

        if (isNewPrompt) {
          // 기존 턴 플러시
          if (currentPending) {
            this.flushTurn(currentPending, sessionDir);
          }

          // 새 턴 시작
          const seq = this.seqCounters.get(sessionId) ?? 0;
          const newTurn: PendingTurn = {
            sessionId,
            promptId: event.promptId,
            seq,
            userText: isMeta ? null : extractUserText(msgContent as unknown),
            startedAt: event.timestamp,
            endedAt: null,
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            tools: [],
            toolMap: new Map(),
          };
          this.seqCounters.set(sessionId, seq + 1);
          this.pendingTurns.set(sessionId, newTurn);
        } else {
          // 같은 promptId의 후속 user 라인 — userText 아직 없으면 설정
          if (!isMeta && currentPending.userText === null) {
            currentPending.userText = extractUserText(msgContent as unknown);
          }
        }
      } else if (event.type === 'assistant') {
        const pending = this.pendingTurns.get(sessionId);
        if (!pending) continue;

        // 토큰 누적
        pending.inputTokens += event.usage.inputTokens;
        pending.outputTokens += event.usage.outputTokens;

        // 모델 추적
        if (event.model) {
          pending.model = event.model;
        }

        // 타임스탬프 업데이트
        pending.endedAt = event.timestamp;

        // tool_use 추가
        for (const tu of event.toolUses) {
          const pendingTool: PendingTool = {
            id: tu.id,
            toolName: tu.toolName,
            toolSubname: tu.toolSubname,
            startedAt: event.timestamp,
            endedAt: null,
            inputSummary: tu.inputSummary,
            resultSummary: null,
            error: false,
          };
          pending.tools.push(pendingTool);
          pending.toolMap.set(tu.id, pendingTool);
        }
      }
    }

    // 4. EOF 도달 시 pending 턴 플러시
    const pending = this.pendingTurns.get(sessionId);
    if (pending) {
      this.flushTurn(pending, sessionDir);
      this.pendingTurns.delete(sessionId);
    }

    // 5. 오프셋 업데이트
    this.offsets.set(sessionId, fileSize);
  }

  private flushTurn(pending: PendingTurn, sessionDir: string): void {
    // Agent tool_use가 있으면 subagent 스캔 & 매칭
    const allToolUses: ExtractedToolUse[] = pending.tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      toolSubname: t.toolSubname,
      inputSummary: t.inputSummary,
    }));

    const hasAgentTool = pending.tools.some((t) => t.toolName === 'Agent');
    let subagents: (ScannedSubagent & { parentToolUseId: string | null })[] = [];

    if (hasAgentTool) {
      const tolerance = 5000; // ±5초
      const turnStart = pending.startedAt - tolerance;
      const turnEnd = (pending.endedAt ?? pending.startedAt) + tolerance;

      const scanned = scanSubagents(sessionDir);
      const matched = matchSubagentsToToolUses(scanned, allToolUses);

      // 턴 시간 범위 내 서브에이전트만 필터
      subagents = matched.filter(
        (s) => s.startedAt >= turnStart && s.startedAt <= turnEnd,
      );
    }

    const turn: EmittedTurn = {
      sessionId: pending.sessionId,
      promptId: pending.promptId,
      seq: pending.seq,
      userText: pending.userText,
      startedAt: pending.startedAt,
      endedAt: pending.endedAt,
      model: pending.model,
      inputTokens: pending.inputTokens,
      outputTokens: pending.outputTokens,
      tools: pending.tools.map((t) => ({
        id: t.id,
        toolName: t.toolName,
        toolSubname: t.toolSubname,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        inputSummary: t.inputSummary,
        resultSummary: t.resultSummary,
        error: t.error,
      })),
      subagents,
    };

    this.onTurn(turn);
  }
}
