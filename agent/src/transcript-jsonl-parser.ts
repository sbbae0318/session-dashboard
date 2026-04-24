/**
 * transcript-jsonl-parser.ts
 *
 * Claude Code transcript JSONL 파일의 단일 라인을 파싱하는 순수 함수 모듈.
 * 부작용 없음, I/O 없음 — 파싱만 담당.
 */

export interface ParsedEvent {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'system';
  promptId: string | null;
  isSidechain: boolean;
  timestamp: number; // ms epoch
  sessionId: string;
  model: string | null;
  content: unknown[];
  usage: { inputTokens: number; outputTokens: number };
  toolUses: ExtractedToolUse[];
}

export interface ExtractedToolUse {
  id: string;
  toolName: string;
  toolSubname: string | null;
  inputSummary: string | null;
}

// 스킵할 type 값들
const SKIP_TYPES = new Set([
  'file-history-snapshot',
  'attachment',
  'queue-operation',
  'agent-name',
  'custom-title',
]);

/**
 * JSONL 한 줄을 파싱하여 ParsedEvent를 반환.
 * 스킵 대상이거나 파싱 실패 시 null 반환.
 */
export function parseJsonlLine(line: string): ParsedEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = raw.type as string | undefined;

  // 스킵 대상 type
  if (!type || SKIP_TYPES.has(type)) return null;

  // sidechain 스킵
  if (raw.isSidechain === true) return null;

  // 허용된 type만 처리
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null;

  const message = (raw.message ?? {}) as Record<string, unknown>;
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  const usage = extractUsage(message.usage as Record<string, number> | undefined);

  const toolUses = type === 'assistant' ? extractToolUses(content) : [];

  return {
    uuid: raw.uuid as string,
    parentUuid: (raw.parentUuid as string | null) ?? null,
    type: type as 'user' | 'assistant' | 'system',
    promptId: (raw.promptId as string | null | undefined) ?? null,
    isSidechain: Boolean(raw.isSidechain),
    timestamp: new Date(raw.timestamp as string).getTime(),
    sessionId: raw.sessionId as string,
    model: (message.model as string | null | undefined) ?? null,
    content,
    usage,
    toolUses,
  };
}

/**
 * assistant content 배열에서 tool_use 블록을 추출.
 */
export function extractToolUses(content: unknown[]): ExtractedToolUse[] {
  const results: ExtractedToolUse[] = [];

  for (const block of content) {
    if (
      typeof block !== 'object' ||
      block === null ||
      (block as Record<string, unknown>).type !== 'tool_use'
    ) {
      continue;
    }

    const b = block as Record<string, unknown>;
    const id = b.id as string;
    const toolName = b.name as string;
    const input = (b.input ?? {}) as Record<string, unknown>;

    let toolSubname: string | null = null;
    let inputSummary: string | null = null;

    if (toolName === 'Agent') {
      toolSubname = (input.subagent_type as string | undefined) ?? null;
      const desc = input.description as string | undefined;
      inputSummary = desc ? desc.slice(0, 120) : null;
    } else if (toolName === 'Skill') {
      toolSubname = (input.skill as string | undefined) ?? null;
      inputSummary = toolSubname;
    } else {
      // 첫 번째 string 값
      for (const val of Object.values(input)) {
        if (typeof val === 'string') {
          inputSummary = val.slice(0, 120);
          break;
        }
      }
    }

    results.push({ id, toolName, toolSubname, inputSummary });
  }

  return results;
}

/**
 * usage 레코드에서 inputTokens/outputTokens 추출. 없으면 0.
 */
export function extractUsage(
  usage: Record<string, number> | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}
