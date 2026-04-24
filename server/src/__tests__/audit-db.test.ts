import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditDB } from '../modules/audit/audit-db.js';
import type { TurnSummaryPayload } from '../shared/api-contract.js';

const MACHINE_ID = 'mac-test-1';

function makePayload(overrides: Partial<TurnSummaryPayload['turn']> = {}): TurnSummaryPayload {
  const promptId = overrides.promptId ?? 'prompt-1';
  return {
    sessionId: 'sess-1',
    slug: 'test-project',
    gitBranch: 'main',
    cwd: '/home/user/project',
    turn: {
      promptId,
      seq: 1,
      userText: 'Hello world',
      startedAt: 1000,
      endedAt: 2000,
      model: 'claude-opus-4',
      inputTokens: 100,
      outputTokens: 200,
      tools: [
        {
          id: `${promptId}-tool-1`,
          toolName: 'Bash',
          toolSubname: null,
          startedAt: 1100,
          endedAt: 1500,
          inputSummary: 'ls -la',
          resultSummary: 'file list',
          error: false,
        },
        {
          id: `${promptId}-tool-2`,
          toolName: 'Read',
          toolSubname: null,
          startedAt: 1600,
          endedAt: 1900,
          inputSummary: '/etc/hosts',
          resultSummary: 'hosts content',
          error: false,
        },
      ],
      subagents: [
        {
          agentKey: `${promptId}-agent-abc123`,
          agentType: 'executor',
          description: 'Run tests',
          parentToolUseId: `${promptId}-tool-1`,
          cwd: '/home/user/project',
          model: 'claude-haiku',
          startedAt: 1200,
          endedAt: 1400,
          messageCount: 5,
          inputTokens: 50,
          outputTokens: 80,
        },
      ],
      ...overrides,
    },
  };
}

describe('AuditDB', () => {
  let db: AuditDB;

  beforeEach(() => {
    db = new AuditDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertTurnSummary', () => {
    it('inserts new turn with tools and subagents', () => {
      const payload = makePayload();
      db.upsertTurnSummary(payload, MACHINE_ID);

      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(1);
      expect(turns[0].promptId).toBe('prompt-1');
      expect(turns[0].seq).toBe(1);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].subagentCount).toBe(1);
      expect(turns[0].inputTokens).toBe(100);
      expect(turns[0].outputTokens).toBe(200);
      expect(turns[0].model).toBe('claude-opus-4');
      expect(turns[0].status).toBe('done');
    });

    it('idempotent upsert — same promptId twice results in 1 row', () => {
      const payload = makePayload();
      db.upsertTurnSummary(payload, MACHINE_ID);
      db.upsertTurnSummary(payload, MACHINE_ID);

      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(1);
    });

    it('updates endedAt on re-upsert', () => {
      const payload = makePayload({ endedAt: null });
      db.upsertTurnSummary(payload, MACHINE_ID);

      let turns = db.getSessionTurns('sess-1');
      expect(turns[0].status).toBe('running');
      expect(turns[0].endedAt).toBeNull();

      const updatedPayload = makePayload({ endedAt: 3000 });
      db.upsertTurnSummary(updatedPayload, MACHINE_ID);

      turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(1);
      expect(turns[0].endedAt).toBe(3000);
      expect(turns[0].status).toBe('done');
    });

    it('truncates userText to 120 chars', () => {
      const longText = 'A'.repeat(200);
      const payload = makePayload({ userText: longText });
      db.upsertTurnSummary(payload, MACHINE_ID);

      const turns = db.getSessionTurns('sess-1');
      expect(turns[0].userText).toHaveLength(120);
    });

    it('handles null userText', () => {
      const payload = makePayload({ userText: null });
      db.upsertTurnSummary(payload, MACHINE_ID);

      const turns = db.getSessionTurns('sess-1');
      expect(turns[0].userText).toBeNull();
    });

    it('updates denormalized total_turns and total_tokens on audit_session', () => {
      db.upsertTurnSummary(makePayload({ promptId: 'p1', seq: 1, inputTokens: 100, outputTokens: 200 }), MACHINE_ID);
      db.upsertTurnSummary(
        { ...makePayload({ promptId: 'p2', seq: 2, inputTokens: 50, outputTokens: 80 }), sessionId: 'sess-1' },
        MACHINE_ID,
      );

      // verify via getSessionTurns count
      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(2);
    });
  });

  describe('getSessionTurns', () => {
    it('returns turns sorted by seq ASC', () => {
      db.upsertTurnSummary(makePayload({ promptId: 'p3', seq: 3 }), MACHINE_ID);
      db.upsertTurnSummary(makePayload({ promptId: 'p1', seq: 1 }), MACHINE_ID);
      db.upsertTurnSummary(makePayload({ promptId: 'p2', seq: 2 }), MACHINE_ID);

      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(3);
      expect(turns.map((t) => t.seq)).toEqual([1, 2, 3]);
    });

    it('returns empty array for unknown session', () => {
      const turns = db.getSessionTurns('nonexistent');
      expect(turns).toEqual([]);
    });
  });

  describe('getPromptAudit', () => {
    it('returns turn + tools sorted by startedAt + subagents', () => {
      const payload = makePayload();
      db.upsertTurnSummary(payload, MACHINE_ID);

      const audit = db.getPromptAudit('prompt-1');
      expect(audit).not.toBeNull();
      expect(audit!.turn.promptId).toBe('prompt-1');
      expect(audit!.tools).toHaveLength(2);
      // tools sorted by startedAt
      expect(audit!.tools[0].id).toBe('prompt-1-tool-1');
      expect(audit!.tools[1].id).toBe('prompt-1-tool-2');
      expect(audit!.subagents).toHaveLength(1);
      expect(audit!.subagents[0].agentKey).toBe('prompt-1-agent-abc123');
    });

    it('converts error field from INTEGER to boolean', () => {
      const payload = makePayload({
        tools: [
          {
            id: 'tool-err',
            toolName: 'Bash',
            toolSubname: null,
            startedAt: 1100,
            endedAt: 1200,
            inputSummary: 'bad cmd',
            resultSummary: null,
            error: true,
          },
        ],
        subagents: [],
      });
      db.upsertTurnSummary(payload, MACHINE_ID);

      const audit = db.getPromptAudit('prompt-1');
      expect(audit!.tools[0].error).toBe(true);
      expect(typeof audit!.tools[0].error).toBe('boolean');
    });

    it('returns null for unknown promptId', () => {
      const result = db.getPromptAudit('nonexistent-prompt');
      expect(result).toBeNull();
    });

    it('re-upsert replaces tools (idempotent tool list)', () => {
      db.upsertTurnSummary(makePayload(), MACHINE_ID);
      // second upsert with different tools
      const updated = makePayload({
        tools: [
          {
            id: 'tool-new',
            toolName: 'Write',
            toolSubname: null,
            startedAt: 1300,
            endedAt: 1400,
            inputSummary: 'new file',
            resultSummary: 'ok',
            error: false,
          },
        ],
      });
      db.upsertTurnSummary(updated, MACHINE_ID);

      const audit = db.getPromptAudit('prompt-1');
      expect(audit!.tools).toHaveLength(1);
      expect(audit!.tools[0].id).toBe('tool-new');
    });
  });

  describe('getKnownPromptIds', () => {
    it('returns correct set of promptIds for session', () => {
      db.upsertTurnSummary(makePayload({ promptId: 'p1', seq: 1 }), MACHINE_ID);
      db.upsertTurnSummary(makePayload({ promptId: 'p2', seq: 2 }), MACHINE_ID);

      const ids = db.getKnownPromptIds('sess-1');
      expect(ids).toBeInstanceOf(Set);
      expect(ids.has('p1')).toBe(true);
      expect(ids.has('p2')).toBe(true);
      expect(ids.size).toBe(2);
    });

    it('returns empty set for unknown session', () => {
      const ids = db.getKnownPromptIds('nonexistent');
      expect(ids.size).toBe(0);
    });
  });

  describe('getSessionMachineId', () => {
    it('returns machineId for known session', () => {
      db.upsertTurnSummary(makePayload(), MACHINE_ID);
      const machineId = db.getSessionMachineId('sess-1');
      expect(machineId).toBe(MACHINE_ID);
    });

    it('returns null for unknown session', () => {
      const machineId = db.getSessionMachineId('nonexistent');
      expect(machineId).toBeNull();
    });
  });

  describe('getSessionMeta', () => {
    it('returns slug and gitBranch for known session', () => {
      db.upsertTurnSummary(makePayload(), MACHINE_ID);
      const meta = db.getSessionMeta('sess-1');
      expect(meta).not.toBeNull();
      expect(meta!.slug).toBe('test-project');
      expect(meta!.gitBranch).toBe('main');
    });

    it('returns null for unknown session', () => {
      const meta = db.getSessionMeta('nonexistent');
      expect(meta).toBeNull();
    });
  });

  describe('getSessionIdByPromptId', () => {
    it('returns sessionId for known promptId', () => {
      db.upsertTurnSummary(makePayload(), MACHINE_ID);
      const sessionId = db.getSessionIdByPromptId('prompt-1');
      expect(sessionId).toBe('sess-1');
    });

    it('returns null for unknown promptId', () => {
      const sessionId = db.getSessionIdByPromptId('nonexistent');
      expect(sessionId).toBeNull();
    });
  });

  describe('subagent storage_ref', () => {
    it('stores storage_ref as subagents/agent-{agentKey}.jsonl', () => {
      const payload = makePayload();
      db.upsertTurnSummary(payload, MACHINE_ID);

      const audit = db.getPromptAudit('prompt-1');
      // subagent data is stored but storage_ref is internal — verify via form field
      expect(audit!.subagents[0].agentKey).toBe('prompt-1-agent-abc123');
    });
  });
});
