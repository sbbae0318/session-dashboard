import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanSubagents,
  matchSubagentsToToolUses,
  type ScannedSubagent,
} from '../subagent-scanner.js';
import type { ExtractedToolUse } from '../transcript-jsonl-parser.js';

// ── test helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

function setupTmpDir(): string {
  tmpDir = join(tmpdir(), `subagent-scanner-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeSubagentDir(sessionDir: string): string {
  const subagentsDir = join(sessionDir, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  return subagentsDir;
}

const USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: true,
  promptId: 'p1',
  agentId: 'abc123',
  type: 'user',
  message: { role: 'user', content: 'task content' },
  uuid: 'u1',
  timestamp: '2026-04-10T08:00:00.000Z',
  sessionId: 'sess-1',
});

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: 'u2',
  isSidechain: true,
  agentId: 'abc123',
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  uuid: 'u3',
  timestamp: '2026-04-10T08:05:00.000Z',
  sessionId: 'sess-1',
});

// ── scanSubagents ─────────────────────────────────────────────────────────────

describe('scanSubagents', () => {
  it('reads meta.json + JSONL and extracts all fields correctly', () => {
    const sessionDir = setupTmpDir();
    const subagentsDir = makeSubagentDir(sessionDir);

    const meta = {
      agentType: 'executor',
      description: 'Implement feature X',
      worktreePath: '/tmp/worktree',
    };
    writeFileSync(
      join(subagentsDir, 'agent-abc123.meta.json'),
      JSON.stringify(meta),
    );
    writeFileSync(
      join(subagentsDir, 'agent-abc123.jsonl'),
      [USER_LINE, ASSISTANT_LINE].join('\n'),
    );

    const results = scanSubagents(sessionDir);

    expect(results).toHaveLength(1);
    const sub = results[0];
    expect(sub.agentKey).toBe('abc123');
    expect(sub.agentType).toBe('executor');
    expect(sub.description).toBe('Implement feature X');
    expect(sub.cwd).toBe('/tmp/worktree');
    expect(sub.model).toBe('claude-sonnet-4-6');
    expect(sub.startedAt).toBe(new Date('2026-04-10T08:00:00.000Z').getTime());
    expect(sub.endedAt).toBe(new Date('2026-04-10T08:05:00.000Z').getTime());
    expect(sub.messageCount).toBe(2);
    expect(sub.inputTokens).toBe(100);
    expect(sub.outputTokens).toBe(50);
  });

  it('returns [] when no subagents directory exists', () => {
    const sessionDir = setupTmpDir();
    // subagents/ 디렉토리 생성하지 않음
    const results = scanSubagents(sessionDir);
    expect(results).toEqual([]);
  });

  it('handles missing meta.json gracefully (null fields)', () => {
    const sessionDir = setupTmpDir();
    const subagentsDir = makeSubagentDir(sessionDir);

    // meta.json 없이 JSONL만 존재
    writeFileSync(
      join(subagentsDir, 'agent-xyz789.jsonl'),
      [USER_LINE, ASSISTANT_LINE].join('\n'),
    );

    const results = scanSubagents(sessionDir);

    expect(results).toHaveLength(1);
    const sub = results[0];
    expect(sub.agentKey).toBe('xyz789');
    expect(sub.agentType).toBeNull();
    expect(sub.description).toBeNull();
    expect(sub.cwd).toBeNull();
  });

  it('counts messages and sums tokens from multiple lines', () => {
    const sessionDir = setupTmpDir();
    const subagentsDir = makeSubagentDir(sessionDir);

    const middleAssistant = JSON.stringify({
      parentUuid: 'u1',
      isSidechain: true,
      agentId: 'abc123',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'mid response' }],
        usage: { input_tokens: 200, output_tokens: 75 },
      },
      uuid: 'u2',
      timestamp: '2026-04-10T08:02:00.000Z',
      sessionId: 'sess-1',
    });

    const finalAssistant = JSON.stringify({
      parentUuid: 'u1',
      isSidechain: true,
      agentId: 'abc123',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 300, output_tokens: 100 },
      },
      uuid: 'u3',
      timestamp: '2026-04-10T08:05:00.000Z',
      sessionId: 'sess-1',
    });

    writeFileSync(
      join(subagentsDir, 'agent-abc123.jsonl'),
      [USER_LINE, middleAssistant, finalAssistant].join('\n'),
    );

    const results = scanSubagents(sessionDir);
    expect(results).toHaveLength(1);
    const sub = results[0];
    expect(sub.messageCount).toBe(3);
    // 200+300 = 500 input, 75+100 = 175 output
    expect(sub.inputTokens).toBe(500);
    expect(sub.outputTokens).toBe(175);
    expect(sub.startedAt).toBe(new Date('2026-04-10T08:00:00.000Z').getTime());
    expect(sub.endedAt).toBe(new Date('2026-04-10T08:05:00.000Z').getTime());
  });
});

// ── matchSubagentsToToolUses ──────────────────────────────────────────────────

describe('matchSubagentsToToolUses', () => {
  it('matches subagent to Agent tool_use by description', () => {
    const subagents: ScannedSubagent[] = [
      {
        agentKey: 'abc123',
        agentType: 'executor',
        description: 'Implement feature X',
        cwd: '/tmp/worktree',
        model: 'claude-sonnet-4-6',
        startedAt: 1000,
        endedAt: 2000,
        messageCount: 2,
        inputTokens: 100,
        outputTokens: 50,
      },
    ];

    const toolUses: ExtractedToolUse[] = [
      {
        id: 'toolu_01',
        toolName: 'Agent',
        toolSubname: 'executor',
        inputSummary: 'Implement feature X',
      },
      {
        id: 'toolu_02',
        toolName: 'Read',
        toolSubname: null,
        inputSummary: '/some/file.ts',
      },
    ];

    const results = matchSubagentsToToolUses(subagents, toolUses);

    expect(results).toHaveLength(1);
    expect(results[0].agentKey).toBe('abc123');
    expect(results[0].parentToolUseId).toBe('toolu_01');
  });

  it('returns null parentToolUseId when no matching Agent tool_use', () => {
    const subagents: ScannedSubagent[] = [
      {
        agentKey: 'abc123',
        agentType: 'executor',
        description: 'Some unique description',
        cwd: null,
        model: null,
        startedAt: 1000,
        endedAt: null,
        messageCount: 1,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];

    const toolUses: ExtractedToolUse[] = [
      {
        id: 'toolu_01',
        toolName: 'Agent',
        toolSubname: 'executor',
        inputSummary: 'Completely different description',
      },
    ];

    const results = matchSubagentsToToolUses(subagents, toolUses);

    expect(results).toHaveLength(1);
    expect(results[0].parentToolUseId).toBeNull();
  });
});
