import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AuditModule, AuditDB } from '../modules/audit/index.js';
import type { TurnSummaryPayload } from '../shared/api-contract.js';

function makeTurnPayload(overrides: Partial<TurnSummaryPayload & { machineId: string }> = {}): TurnSummaryPayload & { machineId: string } {
  return {
    machineId: 'machine-1',
    sessionId: 'session-abc',
    slug: 'my-project',
    gitBranch: 'main',
    cwd: '/home/user/project',
    turn: {
      promptId: 'prompt-001',
      seq: 1,
      userText: 'Hello world',
      startedAt: 1700000000000,
      endedAt: 1700000001000,
      model: 'claude-3-5-sonnet',
      inputTokens: 100,
      outputTokens: 200,
      tools: [],
      subagents: [],
    },
    ...overrides,
  };
}

describe('AuditModule', () => {
  let app: FastifyInstance;
  let db: AuditDB;

  beforeEach(async () => {
    db = new AuditDB(':memory:');
    const mod = new AuditModule(db, null);
    app = Fastify({ logger: false });
    mod.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('POST /api/ingest/turn-summary', () => {
    it('stores data and returns { ok: true }', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('persists turn so it can be queried back', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/session-abc/turns',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.turns).toHaveLength(1);
      expect(body.turns[0].promptId).toBe('prompt-001');
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: { machineId: 'machine-1' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when machineId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: { sessionId: 'session-abc' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/sessions/:sessionId/turns', () => {
    it('returns turns for known session with slug and gitBranch', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/session-abc/turns',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBe('session-abc');
      expect(body.slug).toBe('my-project');
      expect(body.gitBranch).toBe('main');
      expect(body.turns).toHaveLength(1);

      const turn = body.turns[0];
      expect(turn.promptId).toBe('prompt-001');
      expect(turn.seq).toBe(1);
      expect(turn.userText).toBe('Hello world');
      expect(turn.toolCount).toBe(0);
      expect(turn.subagentCount).toBe(0);
      expect(turn.status).toBe('done');
    });

    it('returns multiple turns in sequence order', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload({ turn: { ...makeTurnPayload().turn, promptId: 'prompt-001', seq: 1 } }),
      });
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload({ turn: { ...makeTurnPayload().turn, promptId: 'prompt-002', seq: 2 } }),
      });

      const res = await app.inject({ method: 'GET', url: '/api/sessions/session-abc/turns' });
      const body = res.json();
      expect(body.turns).toHaveLength(2);
      expect(body.turns[0].seq).toBe(1);
      expect(body.turns[1].seq).toBe(2);
    });
  });

  describe('GET /api/sessions/unknown/turns', () => {
    it('returns empty turns for unknown session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/unknown-session/turns',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBe('unknown-session');
      expect(body.slug).toBeNull();
      expect(body.gitBranch).toBeNull();
      expect(body.turns).toEqual([]);
    });
  });

  describe('GET /api/prompts/:promptId/audit', () => {
    it('returns audit for known prompt', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload({
          turn: {
            ...makeTurnPayload().turn,
            tools: [
              {
                id: 'tool-1',
                toolName: 'Bash',
                toolSubname: null,
                startedAt: 1700000000100,
                endedAt: 1700000000900,
                inputSummary: 'ls -la',
                resultSummary: 'file list',
                error: false,
              },
            ],
          },
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/prompt-001/audit',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.turn.promptId).toBe('prompt-001');
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].toolName).toBe('Bash');
      expect(body.subagents).toEqual([]);
    });
  });

  describe('GET /api/prompts/unknown/audit', () => {
    it('returns 404 for unknown prompt', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/nonexistent-prompt/audit',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Prompt not found');
    });
  });

  describe('GET /api/audit/known-prompts', () => {
    it('returns prompt IDs for a session', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload({ turn: { ...makeTurnPayload().turn, promptId: 'p-1', seq: 1 } }),
      });
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload({ turn: { ...makeTurnPayload().turn, promptId: 'p-2', seq: 2 } }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/audit/known-prompts?sessionId=session-abc',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.promptIds).toHaveLength(2);
      expect(body.promptIds).toContain('p-1');
      expect(body.promptIds).toContain('p-2');
    });

    it('returns empty array when no sessionId query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit/known-prompts',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().promptIds).toEqual([]);
    });

    it('returns empty array for unknown session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit/known-prompts?sessionId=no-such-session',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().promptIds).toEqual([]);
    });
  });

  describe('GET /api/prompts/:promptId/transcript', () => {
    it('returns 404 when promptId is unknown', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/nonexistent/transcript',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when machineManager is null (offline)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/prompt-001/transcript',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('agent_offline');
    });
  });

  describe('GET /api/prompts/:promptId/subagent/:agentKey/transcript', () => {
    it('returns 404 when promptId is unknown', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/nonexistent/subagent/some-agent/transcript',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when machineManager is null', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/ingest/turn-summary',
        payload: makeTurnPayload(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/prompt-001/subagent/agent-key/transcript',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('agent_offline');
    });
  });
});
