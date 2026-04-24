/**
 * subagent-scanner.ts
 *
 * Claude Code 세션의 subagents/ 디렉토리를 스캔하여 서브에이전트 메타데이터를 추출.
 * meta.json + JSONL 파일을 읽어 ScannedSubagent 배열 반환.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedToolUse } from './transcript-jsonl-parser.js';

export interface ScannedSubagent {
  agentKey: string;
  agentType: string | null;
  description: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

interface MetaJson {
  agentType?: string;
  description?: string;
  worktreePath?: string;
}

interface JsonlLine {
  type?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/**
 * sessionDir/subagents/ 디렉토리를 스캔하여 서브에이전트 정보를 반환.
 * subagents/ 디렉토리가 없으면 빈 배열 반환.
 */
export function scanSubagents(sessionDir: string): ScannedSubagent[] {
  const subagentsDir = join(sessionDir, 'subagents');
  if (!existsSync(subagentsDir)) return [];

  const jsonlFiles = readdirSync(subagentsDir).filter(
    (f) => f.startsWith('agent-') && f.endsWith('.jsonl'),
  );

  return jsonlFiles.map((filename) => {
    const agentKey = filename.slice('agent-'.length, -'.jsonl'.length);
    return readSubagent(subagentsDir, agentKey);
  });
}

function readSubagent(subagentsDir: string, agentKey: string): ScannedSubagent {
  // meta.json 읽기
  const metaPath = join(subagentsDir, `agent-${agentKey}.meta.json`);
  let agentType: string | null = null;
  let description: string | null = null;
  let cwd: string | null = null;

  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as MetaJson;
      agentType = meta.agentType ?? null;
      description = meta.description ?? null;
      cwd = meta.worktreePath ?? null;
    } catch {
      // meta.json 파싱 실패 시 null 유지
    }
  }

  // JSONL 읽기
  const jsonlPath = join(subagentsDir, `agent-${agentKey}.jsonl`);
  const lines = readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  let startedAt = 0;
  let endedAt: number | null = null;
  let model: string | null = null;
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < lines.length; i++) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(lines[i]) as JsonlLine;
    } catch {
      continue;
    }

    const type = parsed.type;
    if (type !== 'user' && type !== 'assistant') continue;

    messageCount++;

    // 첫 번째 유효 라인 → startedAt
    if (messageCount === 1 && parsed.timestamp) {
      startedAt = new Date(parsed.timestamp).getTime();
    }

    // 마지막 유효 라인 → endedAt, model
    if (parsed.timestamp) {
      endedAt = new Date(parsed.timestamp).getTime();
    }
    if (parsed.message?.model) {
      model = parsed.message.model;
    }

    // 토큰 집계
    const usage = parsed.message?.usage;
    if (usage) {
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
    }
  }

  return {
    agentKey,
    agentType,
    description,
    cwd,
    model,
    startedAt,
    endedAt,
    messageCount,
    inputTokens,
    outputTokens,
  };
}

/**
 * 서브에이전트 배열을 Agent tool_use들과 매칭하여 parentToolUseId를 추가.
 * description === inputSummary 기준으로 매칭.
 */
export function matchSubagentsToToolUses(
  subagents: ScannedSubagent[],
  toolUses: ExtractedToolUse[],
): (ScannedSubagent & { parentToolUseId: string | null })[] {
  const agentToolUses = toolUses.filter((tu) => tu.toolName === 'Agent');

  return subagents.map((sub) => {
    const matched = agentToolUses.find(
      (tu) => tu.inputSummary !== null && tu.inputSummary === sub.description,
    );
    return {
      ...sub,
      parentToolUseId: matched?.id ?? null,
    };
  });
}
