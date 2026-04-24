import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TranscriptIngestor, type EmittedTurn } from '../transcript-ingestor.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeUserLine(
  promptId: string,
  text: string,
  ts: string,
  opts?: { uuid?: string; isMeta?: boolean },
): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: opts?.uuid ?? randomUUID(),
    timestamp: ts,
    sessionId: 'sess-1',
    ...(opts?.isMeta ? { isMeta: true } : {}),
  });
}

function makeAssistantLine(
  parentUuid: string,
  ts: string,
  content?: unknown[],
  usage?: Record<string, number>,
): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: content ?? [{ type: 'text', text: 'response' }],
      usage: usage ?? { input_tokens: 100, output_tokens: 50 },
    },
    uuid: randomUUID(),
    timestamp: ts,
    sessionId: 'sess-1',
  });
}

function makeToolResultLine(
  toolUseId: string,
  content: string,
  ts: string,
  promptId: string,
): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
    uuid: randomUUID(),
    timestamp: ts,
    sessionId: 'sess-1',
  });
}

// ── setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `transcript-ingestor-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('TranscriptIngestor', () => {
  it('emits TurnSummary when promptId changes', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid1 = randomUUID();
    const userUuid2 = randomUUID();

    const lines = [
      // Turn 1: promptId p1
      makeUserLine('p1', 'first prompt', '2026-04-10T08:00:00.000Z', { uuid: userUuid1 }),
      makeAssistantLine(userUuid1, '2026-04-10T08:00:05.000Z'),
      // Turn 2: promptId p2
      makeUserLine('p2', 'second prompt', '2026-04-10T08:01:00.000Z', { uuid: userUuid2 }),
      makeAssistantLine(userUuid2, '2026-04-10T08:01:05.000Z'),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(2);

    expect(emitted[0].promptId).toBe('p1');
    expect(emitted[0].seq).toBe(0);
    expect(emitted[0].userText).toBe('first prompt');

    expect(emitted[1].promptId).toBe('p2');
    expect(emitted[1].seq).toBe(1);
    expect(emitted[1].userText).toBe('second prompt');
  });

  it('extracts tool_uses from assistant lines', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid = randomUUID();

    const toolUseContent = [
      {
        type: 'tool_use',
        id: 'toolu_read_01',
        name: 'Read',
        input: { file_path: '/some/file.ts' },
      },
      {
        type: 'tool_use',
        id: 'toolu_skill_01',
        name: 'Skill',
        input: { skill: 'tdd' },
      },
    ];

    const lines = [
      makeUserLine('p1', 'do things', '2026-04-10T08:00:00.000Z', { uuid: userUuid }),
      makeAssistantLine(userUuid, '2026-04-10T08:00:05.000Z', toolUseContent),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    const turn = emitted[0];

    expect(turn.tools).toHaveLength(2);
    expect(turn.tools[0].toolName).toBe('Read');
    expect(turn.tools[0].id).toBe('toolu_read_01');
    expect(turn.tools[0].inputSummary).toBe('/some/file.ts');
    expect(turn.tools[1].toolName).toBe('Skill');
    expect(turn.tools[1].toolSubname).toBe('tdd');
  });

  it('resumes from last offset (incremental)', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid1 = randomUUID();

    const turn1Lines = [
      makeUserLine('p1', 'first prompt', '2026-04-10T08:00:00.000Z', { uuid: userUuid1 }),
      makeAssistantLine(userUuid1, '2026-04-10T08:00:05.000Z'),
    ];
    writeFileSync(jsonlPath, turn1Lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });

    // First process — should emit turn 1
    ingestor.processFile('sess-1', jsonlPath, tmpDir);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].promptId).toBe('p1');

    // Append turn 2
    const userUuid2 = randomUUID();
    const turn2Lines = [
      makeUserLine('p2', 'second prompt', '2026-04-10T08:01:00.000Z', { uuid: userUuid2 }),
      makeAssistantLine(userUuid2, '2026-04-10T08:01:05.000Z'),
    ];
    const existingContent = turn1Lines.join('\n');
    writeFileSync(jsonlPath, existingContent + '\n' + turn2Lines.join('\n'));

    // Second process — should emit only turn 2
    ingestor.processFile('sess-1', jsonlPath, tmpDir);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].promptId).toBe('p2');
  });

  it('aggregates tokens across multiple assistant lines', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid = randomUUID();
    const assistantUuid1 = randomUUID();

    const lines = [
      makeUserLine('p1', 'complex task', '2026-04-10T08:00:00.000Z', { uuid: userUuid }),
      // First assistant message in agentic loop
      makeAssistantLine(userUuid, '2026-04-10T08:00:05.000Z', undefined, {
        input_tokens: 200,
        output_tokens: 100,
      }),
      // Second assistant message (continuation)
      makeAssistantLine(assistantUuid1, '2026-04-10T08:00:10.000Z', undefined, {
        input_tokens: 300,
        output_tokens: 150,
      }),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].inputTokens).toBe(500);  // 200 + 300
    expect(emitted[0].outputTokens).toBe(250); // 100 + 150
  });

  it('extracts userText from first non-meta user line', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const metaUuid = randomUUID();
    const realUuid = randomUUID();

    const lines = [
      // isMeta=true line first — should be skipped for userText
      makeUserLine('p1', 'system injection', '2026-04-10T08:00:00.000Z', {
        uuid: metaUuid,
        isMeta: true,
      }),
      // Real user prompt
      makeUserLine('p1', 'actual user prompt', '2026-04-10T08:00:01.000Z', {
        uuid: realUuid,
      }),
      makeAssistantLine(realUuid, '2026-04-10T08:00:05.000Z'),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].userText).toBe('actual user prompt');
  });

  it('matches tool_result to tool_use and sets endedAt + resultSummary', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid = randomUUID();

    const toolUseContent = [
      {
        type: 'tool_use',
        id: 'toolu_read_01',
        name: 'Read',
        input: { file_path: '/some/file.ts' },
      },
    ];

    const lines = [
      makeUserLine('p1', 'read a file', '2026-04-10T08:00:00.000Z', { uuid: userUuid }),
      makeAssistantLine(userUuid, '2026-04-10T08:00:05.000Z', toolUseContent),
      // tool_result comes back as a user message
      makeToolResultLine('toolu_read_01', 'file content here', '2026-04-10T08:00:10.000Z', 'p1'),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    const tool = emitted[0].tools[0];
    expect(tool.id).toBe('toolu_read_01');
    expect(tool.resultSummary).toBe('file content here');
    expect(tool.endedAt).not.toBeNull();
    expect(tool.endedAt).toBe(new Date('2026-04-10T08:00:10.000Z').getTime());
    expect(tool.error).toBe(false);
  });

  it('handles userText truncation to 120 chars', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid = randomUUID();
    const longText = 'a'.repeat(200);

    const lines = [
      makeUserLine('p1', longText, '2026-04-10T08:00:00.000Z', { uuid: userUuid }),
      makeAssistantLine(userUuid, '2026-04-10T08:00:05.000Z'),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].userText).toHaveLength(120);
  });

  it('extracts userText from array content (finds first text block)', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid = randomUUID();

    const arrayContent = [
      { type: 'image', source: { type: 'base64', data: 'abc' } },
      { type: 'text', text: 'describe this image' },
    ];

    const lines = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        promptId: 'p1',
        type: 'user',
        message: { role: 'user', content: arrayContent },
        uuid: userUuid,
        timestamp: '2026-04-10T08:00:00.000Z',
        sessionId: 'sess-1',
      }),
      makeAssistantLine(userUuid, '2026-04-10T08:00:05.000Z'),
    ];
    writeFileSync(jsonlPath, lines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });
    ingestor.processFile('sess-1', jsonlPath, tmpDir);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].userText).toBe('describe this image');
  });

  it('resets offset if file was recreated (offset > fileSize)', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    const userUuid1 = randomUUID();

    // 첫 번째 파일: 많은 줄로 큰 파일 생성
    const bigLines: string[] = [
      makeUserLine('p1', 'a'.repeat(100), '2026-04-10T08:00:00.000Z', { uuid: userUuid1 }),
    ];
    for (let i = 0; i < 20; i++) {
      bigLines.push(makeAssistantLine(userUuid1, `2026-04-10T08:00:0${i % 9}.000Z`));
    }
    writeFileSync(jsonlPath, bigLines.join('\n'));

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (t) => emitted.push(t) });

    ingestor.processFile('sess-1', jsonlPath, tmpDir);
    expect(emitted).toHaveLength(1);
    const firstOffset = (ingestor as unknown as { offsets: Map<string, number> }).offsets.get('sess-1') ?? 0;
    expect(firstOffset).toBeGreaterThan(0);

    // 파일 재생성 — 원래보다 훨씬 작은 파일 (offset > fileSize 조건 충족)
    const userUuid2 = randomUUID();
    const newLines = [
      makeUserLine('p2', 'new', '2026-04-10T09:00:00.000Z', { uuid: userUuid2 }),
      makeAssistantLine(userUuid2, '2026-04-10T09:00:05.000Z'),
    ];
    writeFileSync(jsonlPath, newLines.join('\n'));

    const newFileSize = statSync(jsonlPath).size;
    expect(newFileSize).toBeLessThan(firstOffset); // 조건 충족 확인

    ingestor.processFile('sess-1', jsonlPath, tmpDir);
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted[emitted.length - 1].promptId).toBe('p2');
  });
});
