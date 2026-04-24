import { describe, it, expect } from 'vitest';
import {
  parseJsonlLine,
  extractToolUses,
  extractUsage,
} from '../transcript-jsonl-parser.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  promptId: '6d2ef105-0000-0000-0000-000000000000',
  type: 'user',
  message: { role: 'user', content: 'Hello' },
  uuid: 'ebb33f33-0000-0000-0000-000000000000',
  timestamp: '2026-04-08T15:14:31.934Z',
  sessionId: '55427d54-0000-0000-0000-000000000000',
});

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: 'uuid-1',
  isSidechain: false,
  type: 'assistant',
  message: {
    model: 'claude-opus-4-6',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Agent',
        input: {
          subagent_type: 'executor',
          description: 'Build feature',
          prompt: '...',
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  uuid: 'uuid-2',
  timestamp: '2026-04-08T15:54:36.843Z',
  sessionId: '55427d54-0000-0000-0000-000000000000',
});

const SKIP_LINE = JSON.stringify({
  type: 'file-history-snapshot',
  snapshot: {},
});

const SIDECHAIN_LINE = JSON.stringify({
  parentUuid: 'uuid-parent',
  isSidechain: true,
  type: 'user',
  message: { role: 'user', content: 'side msg' },
  uuid: 'uuid-side',
  timestamp: '2026-04-08T16:00:00.000Z',
  sessionId: '55427d54-0000-0000-0000-000000000000',
});

// ── parseJsonlLine ────────────────────────────────────────────────────────────

describe('parseJsonlLine', () => {
  it('parses user line with promptId', () => {
    const result = parseJsonlLine(USER_LINE);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('user');
    expect(result!.uuid).toBe('ebb33f33-0000-0000-0000-000000000000');
    expect(result!.parentUuid).toBeNull();
    expect(result!.promptId).toBe('6d2ef105-0000-0000-0000-000000000000');
    expect(result!.sessionId).toBe('55427d54-0000-0000-0000-000000000000');
    expect(result!.isSidechain).toBe(false);
    expect(result!.timestamp).toBe(new Date('2026-04-08T15:14:31.934Z').getTime());
    expect(result!.model).toBeNull();
    expect(result!.toolUses).toEqual([]);
    expect(result!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('parses assistant line with null promptId and extracts model', () => {
    const result = parseJsonlLine(ASSISTANT_LINE);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.uuid).toBe('uuid-2');
    expect(result!.parentUuid).toBe('uuid-1');
    expect(result!.promptId).toBeNull();
    expect(result!.model).toBe('claude-opus-4-6');
    expect(result!.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result!.toolUses).toHaveLength(1);
    expect(result!.toolUses[0].toolName).toBe('Agent');
  });

  it('skips file-history-snapshot lines (returns null)', () => {
    expect(parseJsonlLine(SKIP_LINE)).toBeNull();
  });

  it('skips sidechain lines (returns null)', () => {
    expect(parseJsonlLine(SIDECHAIN_LINE)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonlLine('not json {')).toBeNull();
  });
});

// ── extractToolUses ───────────────────────────────────────────────────────────

describe('extractToolUses', () => {
  it('extracts Agent, Read, and Skill tool_uses correctly', () => {
    const content: unknown[] = [
      { type: 'text', text: 'thinking...' },
      {
        type: 'tool_use',
        id: 'toolu_agent',
        name: 'Agent',
        input: {
          subagent_type: 'executor',
          description: 'Run build pipeline step for CI',
          prompt: '...',
        },
      },
      {
        type: 'tool_use',
        id: 'toolu_read',
        name: 'Read',
        input: { file_path: '/some/file.ts' },
      },
      {
        type: 'tool_use',
        id: 'toolu_skill',
        name: 'Skill',
        input: { skill: 'tdd', extra: 'ignored' },
      },
    ];

    const result = extractToolUses(content);
    expect(result).toHaveLength(3);

    // Agent
    expect(result[0]).toEqual({
      id: 'toolu_agent',
      toolName: 'Agent',
      toolSubname: 'executor',
      inputSummary: 'Run build pipeline step for CI',
    });

    // Read — first string value from input
    expect(result[1]).toEqual({
      id: 'toolu_read',
      toolName: 'Read',
      toolSubname: null,
      inputSummary: '/some/file.ts',
    });

    // Skill
    expect(result[2]).toEqual({
      id: 'toolu_skill',
      toolName: 'Skill',
      toolSubname: 'tdd',
      inputSummary: 'tdd',
    });
  });

  it('returns empty array for text-only content', () => {
    const content: unknown[] = [
      { type: 'text', text: 'just some text' },
    ];
    expect(extractToolUses(content)).toEqual([]);
  });
});

// ── extractUsage ──────────────────────────────────────────────────────────────

describe('extractUsage', () => {
  it('extracts tokens from a usage record', () => {
    expect(extractUsage({ input_tokens: 42, output_tokens: 17 })).toEqual({
      inputTokens: 42,
      outputTokens: 17,
    });
  });

  it('returns zeros for undefined', () => {
    expect(extractUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
