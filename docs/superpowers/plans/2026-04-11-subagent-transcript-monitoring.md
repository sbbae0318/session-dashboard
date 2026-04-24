# Subagent Transcript Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code transcript에서 subagent(Agent tool) 및 skill 사용을 prompt turn 단위로 사후 감사(post-hoc audit)할 수 있게 한다.

**Architecture:** Thin index(서버 SQLite) + on-demand body fetch(agent 로컬 JSONL). Agent가 hook trigger + file read로 turn 요약을 서버에 push. 프론트엔드는 공용 `PromptAuditView` 컴포넌트를 drawer(A), 독립 페이지(B), 세션 타임라인(C) 세 곳에서 재사용.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Svelte 5 (runes), vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-04-11-subagent-transcript-monitoring-design.md`

---

## File Structure

### New Files (Agent)

| File | Responsibility |
|---|---|
| `agent/src/transcript-ingestor.ts` | Hook trigger → JSONL tail → promptId FSM → TurnSummary → push to server |
| `agent/src/transcript-jsonl-parser.ts` | Single JSONL line 파싱 + 타입 변환 |
| `agent/src/subagent-scanner.ts` | `subagents/*.jsonl` + `meta.json` 읽기, description 매칭 |
| `agent/src/__tests__/transcript-jsonl-parser.test.ts` | Parser unit tests |
| `agent/src/__tests__/subagent-scanner.test.ts` | Scanner unit tests |
| `agent/src/__tests__/transcript-ingestor.test.ts` | Ingestor integration tests |

### New Files (Server)

| File | Responsibility |
|---|---|
| `server/src/modules/audit/audit-db.ts` | SQLite 스키마 + UPSERT/query 메서드 |
| `server/src/modules/audit/index.ts` | BackendModule: ingest route + read routes + transcript proxy |
| `server/src/__tests__/audit-db.test.ts` | DB unit tests |
| `server/src/__tests__/audit-module.test.ts` | Route handler tests |

### New Files (Frontend)

| File | Responsibility |
|---|---|
| `server/frontend/src/lib/stores/audit.svelte.ts` | Audit API fetch + 캐시 |
| `server/frontend/src/components/audit/PromptAuditHeader.svelte` | 접힌 헤더 (뱃지 + 요약) |
| `server/frontend/src/components/audit/PromptAuditBody.svelte` | 펼침 본체 (timeline + subagent tree) |
| `server/frontend/src/components/audit/PromptAuditView.svelte` | Header + Body 통합 (공용) |
| `server/frontend/src/components/audit/PromptAuditDrawer.svelte` | 드로워 래퍼 (UX A) |
| `server/frontend/src/components/pages/PromptDetailPage.svelte` | `/prompts/:pid` 페이지 (UX B) |
| `server/frontend/src/components/pages/SessionTimelinePage.svelte` | `/sessions/:sid` 페이지 (UX C) |

### Modified Files

| File | Change |
|---|---|
| `server/src/shared/api-contract.ts` | Audit 관련 타입 추가 |
| `server/frontend/src/types.ts` | Re-export audit 타입 |
| `server/src/cli.ts` | AuditModule 등록 + AuditDB 초기화 |
| `agent/src/server.ts` | Transcript body 엔드포인트 추가 |
| `agent/src/claude-heartbeat.ts` | TranscriptIngestor 연결 |
| `server/frontend/src/lib/stores/navigation.svelte.ts` | `prompt-audit`, `session-timeline` ViewType 추가 |
| `server/frontend/src/App.svelte` | 새 view 분기 + SSE `turn.new` 핸들러 |
| `server/frontend/src/components/RecentPrompts.svelte` | Subagent/tool 뱃지 추가 |

---

## Task 1: API Contract 타입 추가

**Files:**
- Modify: `server/src/shared/api-contract.ts`
- Modify: `server/frontend/src/types.ts`

- [ ] **Step 1: api-contract.ts에 Audit 타입 추가**

`server/src/shared/api-contract.ts` 끝에 추가:

```typescript
// =============================================================================
// Audit Types (Subagent/Transcript Monitoring)
// =============================================================================

// ── POST /api/ingest/turn-summary (Agent → Server) ──

export interface TurnSummaryPayload {
  sessionId: string;
  slug: string | null;
  gitBranch: string | null;
  cwd: string | null;
  turn: {
    promptId: string;
    seq: number;
    userText: string | null;
    startedAt: number;
    endedAt: number | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    tools: ToolInvocationEntry[];
    subagents: SubagentRunEntry[];
  };
}

// ── GET /api/sessions/:sid/turns ──

export interface SessionTurnsResponse {
  sessionId: string;
  slug: string | null;
  gitBranch: string | null;
  turns: PromptTurnSummary[];
}

export interface PromptTurnSummary {
  promptId: string;
  seq: number;
  userText: string | null;
  startedAt: number;
  endedAt: number | null;
  toolCount: number;
  subagentCount: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  status: 'running' | 'done' | 'error';
}

// ── GET /api/prompts/:pid/audit ──

export interface PromptAuditResponse {
  turn: PromptTurnSummary;
  tools: ToolInvocationEntry[];
  subagents: SubagentRunEntry[];
}

export interface ToolInvocationEntry {
  id: string;
  toolName: string;
  toolSubname: string | null;
  startedAt: number;
  endedAt: number | null;
  inputSummary: string | null;
  resultSummary: string | null;
  error: boolean;
}

export interface SubagentRunEntry {
  agentKey: string;
  agentType: string | null;
  description: string | null;
  parentToolUseId: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  bodyAvailable?: boolean;
}

// ── GET /claude/transcript/:sid/:pid (Agent body response) ──

export interface TranscriptBodyResponse {
  promptId: string;
  sessionId: string;
  events: TranscriptEvent[];
}

export interface TranscriptEvent {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'system';
  timestamp: number;
  role: string;
  model: string | null;
  toolUses: { id: string; name: string; inputPreview: string }[];
  toolResults: { toolUseId: string; contentPreview: string }[];
  textPreview: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

// ── SSE ──

// Add to SSEEventMap:
// 'turn.new': PromptTurnSummary & { sessionId: string; machineId: string };
```

- [ ] **Step 2: SSEEventMap에 turn.new 추가**

`server/src/shared/api-contract.ts`의 `SSEEventMap` interface에 추가:

```typescript
'turn.new': PromptTurnSummary & { sessionId: string; machineId: string };
```

- [ ] **Step 3: Frontend types.ts에 re-export 추가**

`server/frontend/src/types.ts`에 audit 타입 re-export 추가:

```typescript
export type {
  TurnSummaryPayload,
  SessionTurnsResponse,
  PromptTurnSummary,
  PromptAuditResponse,
  ToolInvocationEntry,
  SubagentRunEntry,
  TranscriptBodyResponse,
  TranscriptEvent,
} from '../../src/shared/api-contract.js';
```

- [ ] **Step 4: 빌드 확인**

```bash
cd server && npm run build && cd frontend && npm run build
```

Expected: 빌드 성공. 타입만 추가했으므로 런타임 영향 없음.

- [ ] **Step 5: 커밋**

```bash
git add server/src/shared/api-contract.ts server/frontend/src/types.ts
git commit -m "feat(api): add audit types for subagent transcript monitoring"
```

---

## Task 2: AuditDB (SQLite 스키마 + UPSERT)

**Files:**
- Create: `server/src/modules/audit/audit-db.ts`
- Create: `server/src/__tests__/audit-db.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`server/src/__tests__/audit-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuditDB } from '../modules/audit/audit-db.js';

function createTestDB(): AuditDB {
  return new AuditDB(':memory:');
}

describe('AuditDB', () => {
  let db: AuditDB;

  beforeEach(() => {
    db = createTestDB();
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertTurnSummary', () => {
    const payload = {
      sessionId: 'sess-1',
      slug: 'test-slug',
      gitBranch: 'main',
      cwd: '/home/user/project',
      turn: {
        promptId: 'prompt-1',
        seq: 0,
        userText: 'Hello world',
        startedAt: 1000,
        endedAt: 2000,
        model: 'claude-opus-4-6',
        inputTokens: 100,
        outputTokens: 200,
        tools: [
          {
            id: 'tool-1',
            toolName: 'Read',
            toolSubname: null,
            startedAt: 1100,
            endedAt: 1200,
            inputSummary: 'server.ts',
            resultSummary: 'file content...',
            error: false,
          },
        ],
        subagents: [
          {
            agentKey: 'a123',
            agentType: 'executor',
            description: 'Implement feature',
            parentToolUseId: 'tool-2',
            cwd: '/tmp/worktree',
            model: 'claude-sonnet-4-6',
            startedAt: 1300,
            endedAt: 1800,
            messageCount: 10,
            inputTokens: 50,
            outputTokens: 80,
          },
        ],
      },
    };

    it('inserts a new turn with tools and subagents', () => {
      db.upsertTurnSummary(payload, 'machine-1');

      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(1);
      expect(turns[0].promptId).toBe('prompt-1');
      expect(turns[0].toolCount).toBe(1);
      expect(turns[0].subagentCount).toBe(1);
    });

    it('is idempotent — same promptId upserts without duplication', () => {
      db.upsertTurnSummary(payload, 'machine-1');
      db.upsertTurnSummary(payload, 'machine-1');

      const turns = db.getSessionTurns('sess-1');
      expect(turns).toHaveLength(1);
    });

    it('updates existing turn when endedAt changes', () => {
      db.upsertTurnSummary(payload, 'machine-1');

      const updated = {
        ...payload,
        turn: { ...payload.turn, endedAt: 3000, status: 'done' as const },
      };
      db.upsertTurnSummary(updated, 'machine-1');

      const turns = db.getSessionTurns('sess-1');
      expect(turns[0].endedAt).toBe(3000);
    });
  });

  describe('getSessionTurns', () => {
    it('returns turns sorted by seq ASC', () => {
      const base = {
        sessionId: 'sess-1',
        slug: null,
        gitBranch: null,
        cwd: null,
      };
      db.upsertTurnSummary({
        ...base,
        turn: { promptId: 'p2', seq: 1, userText: 'second', startedAt: 2000, endedAt: 3000, model: null, inputTokens: 0, outputTokens: 0, tools: [], subagents: [] },
      }, 'machine-1');
      db.upsertTurnSummary({
        ...base,
        turn: { promptId: 'p1', seq: 0, userText: 'first', startedAt: 1000, endedAt: 2000, model: null, inputTokens: 0, outputTokens: 0, tools: [], subagents: [] },
      }, 'machine-1');

      const turns = db.getSessionTurns('sess-1');
      expect(turns[0].promptId).toBe('p1');
      expect(turns[1].promptId).toBe('p2');
    });
  });

  describe('getPromptAudit', () => {
    it('returns turn with tools and subagents', () => {
      const payload = {
        sessionId: 'sess-1', slug: null, gitBranch: null, cwd: null,
        turn: {
          promptId: 'p1', seq: 0, userText: 'test', startedAt: 1000, endedAt: 2000,
          model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 200,
          tools: [
            { id: 't1', toolName: 'Agent', toolSubname: 'executor', startedAt: 1100, endedAt: 1500, inputSummary: 'task', resultSummary: 'done', error: false },
            { id: 't2', toolName: 'Read', toolSubname: null, startedAt: 1050, endedAt: 1060, inputSummary: 'file.ts', resultSummary: 'content', error: false },
          ],
          subagents: [
            { agentKey: 'a1', agentType: 'executor', description: 'task', parentToolUseId: 't1', cwd: null, model: null, startedAt: 1100, endedAt: 1500, messageCount: 5, inputTokens: 30, outputTokens: 40 },
          ],
        },
      };
      db.upsertTurnSummary(payload, 'machine-1');

      const audit = db.getPromptAudit('p1');
      expect(audit).not.toBeNull();
      expect(audit!.turn.promptId).toBe('p1');
      expect(audit!.tools).toHaveLength(2);
      expect(audit!.subagents).toHaveLength(1);
      expect(audit!.tools[0].toolName).toBe('Read'); // sorted by startedAt
    });

    it('returns null for unknown promptId', () => {
      expect(db.getPromptAudit('nonexistent')).toBeNull();
    });
  });

  describe('getKnownPromptIds', () => {
    it('returns prompt IDs for a session', () => {
      const base = { sessionId: 'sess-1', slug: null, gitBranch: null, cwd: null };
      db.upsertTurnSummary({
        ...base,
        turn: { promptId: 'p1', seq: 0, userText: null, startedAt: 1000, endedAt: 2000, model: null, inputTokens: 0, outputTokens: 0, tools: [], subagents: [] },
      }, 'machine-1');
      db.upsertTurnSummary({
        ...base,
        turn: { promptId: 'p2', seq: 1, userText: null, startedAt: 2000, endedAt: 3000, model: null, inputTokens: 0, outputTokens: 0, tools: [], subagents: [] },
      }, 'machine-1');

      const ids = db.getKnownPromptIds('sess-1');
      expect(ids).toEqual(new Set(['p1', 'p2']));
    });
  });

  describe('getSessionMachineId', () => {
    it('returns machineId for known session', () => {
      db.upsertTurnSummary({
        sessionId: 'sess-1', slug: null, gitBranch: null, cwd: null,
        turn: { promptId: 'p1', seq: 0, userText: null, startedAt: 1000, endedAt: 2000, model: null, inputTokens: 0, outputTokens: 0, tools: [], subagents: [] },
      }, 'machine-1');

      expect(db.getSessionMachineId('sess-1')).toBe('machine-1');
    });

    it('returns null for unknown session', () => {
      expect(db.getSessionMachineId('nonexistent')).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd server && npx vitest run src/__tests__/audit-db.test.ts
```

Expected: FAIL — `../modules/audit/audit-db.js` 모듈 없음.

- [ ] **Step 3: AuditDB 구현**

`server/src/modules/audit/audit-db.ts`:

```typescript
import Database from 'better-sqlite3';
import type {
  TurnSummaryPayload,
  PromptTurnSummary,
  PromptAuditResponse,
  ToolInvocationEntry,
  SubagentRunEntry,
} from '../../shared/api-contract.js';

export class AuditDB {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_session (
        session_id     TEXT PRIMARY KEY,
        machine_id     TEXT NOT NULL,
        source         TEXT NOT NULL DEFAULT 'claude-code',
        cwd            TEXT,
        slug           TEXT,
        git_branch     TEXT,
        first_seen_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        title          TEXT,
        total_turns    INTEGER DEFAULT 0,
        total_tokens   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session_machine ON audit_session(machine_id);

      CREATE TABLE IF NOT EXISTS prompt_turn (
        prompt_id      TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES audit_session(session_id),
        seq            INTEGER NOT NULL,
        user_text      TEXT,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        tool_count     INTEGER DEFAULT 0,
        subagent_count INTEGER DEFAULT 0,
        input_tokens   INTEGER DEFAULT 0,
        output_tokens  INTEGER DEFAULT 0,
        model          TEXT,
        status         TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_turn_session ON prompt_turn(session_id, seq);

      CREATE TABLE IF NOT EXISTS tool_invocation (
        id             TEXT PRIMARY KEY,
        prompt_id      TEXT NOT NULL REFERENCES prompt_turn(prompt_id),
        session_id     TEXT NOT NULL,
        tool_name      TEXT NOT NULL,
        tool_subname   TEXT,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        input_summary  TEXT,
        result_summary TEXT,
        error          INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_inv_prompt ON tool_invocation(prompt_id, started_at);

      CREATE TABLE IF NOT EXISTS subagent_run (
        agent_key          TEXT NOT NULL,
        session_id         TEXT NOT NULL,
        prompt_id          TEXT NOT NULL REFERENCES prompt_turn(prompt_id),
        parent_tool_use_id TEXT,
        agent_type         TEXT,
        description        TEXT,
        form               TEXT NOT NULL DEFAULT 'file',
        storage_ref        TEXT,
        cwd                TEXT,
        model              TEXT,
        started_at         INTEGER NOT NULL,
        ended_at           INTEGER,
        message_count      INTEGER DEFAULT 0,
        input_tokens       INTEGER DEFAULT 0,
        output_tokens      INTEGER DEFAULT 0,
        PRIMARY KEY (session_id, agent_key)
      );
      CREATE INDEX IF NOT EXISTS idx_subagent_prompt ON subagent_run(prompt_id);
    `);
  }

  upsertTurnSummary(payload: TurnSummaryPayload, machineId: string): void {
    const { sessionId, slug, gitBranch, cwd, turn } = payload;
    const now = turn.startedAt;

    const upsertAll = this.db.transaction(() => {
      // 1. Upsert audit_session
      this.db.prepare(`
        INSERT INTO audit_session (session_id, machine_id, cwd, slug, git_branch, first_seen_at, last_seen_at)
        VALUES (:sessionId, :machineId, :cwd, :slug, :gitBranch, :now, :now)
        ON CONFLICT (session_id) DO UPDATE SET
          last_seen_at = MAX(last_seen_at, :now),
          slug = COALESCE(:slug, slug),
          git_branch = COALESCE(:gitBranch, git_branch),
          cwd = COALESCE(:cwd, cwd)
      `).run({ sessionId, machineId, cwd, slug, gitBranch, now });

      // 2. Upsert prompt_turn
      const status = turn.endedAt ? 'done' : 'running';
      this.db.prepare(`
        INSERT INTO prompt_turn (prompt_id, session_id, seq, user_text, started_at, ended_at, tool_count, subagent_count, input_tokens, output_tokens, model, status)
        VALUES (:promptId, :sessionId, :seq, :userText, :startedAt, :endedAt, :toolCount, :subagentCount, :inputTokens, :outputTokens, :model, :status)
        ON CONFLICT (prompt_id) DO UPDATE SET
          ended_at = COALESCE(:endedAt, ended_at),
          tool_count = :toolCount,
          subagent_count = :subagentCount,
          input_tokens = :inputTokens,
          output_tokens = :outputTokens,
          model = COALESCE(:model, model),
          status = :status
      `).run({
        promptId: turn.promptId,
        sessionId,
        seq: turn.seq,
        userText: turn.userText?.slice(0, 120) ?? null,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        toolCount: turn.tools.length,
        subagentCount: turn.subagents.length,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        model: turn.model,
        status,
      });

      // 3. Upsert tool_invocations (delete + re-insert for simplicity)
      this.db.prepare('DELETE FROM tool_invocation WHERE prompt_id = ?').run(turn.promptId);
      const insertTool = this.db.prepare(`
        INSERT INTO tool_invocation (id, prompt_id, session_id, tool_name, tool_subname, started_at, ended_at, input_summary, result_summary, error)
        VALUES (:id, :promptId, :sessionId, :toolName, :toolSubname, :startedAt, :endedAt, :inputSummary, :resultSummary, :error)
      `);
      for (const tool of turn.tools) {
        insertTool.run({
          id: tool.id,
          promptId: turn.promptId,
          sessionId,
          toolName: tool.toolName,
          toolSubname: tool.toolSubname,
          startedAt: tool.startedAt,
          endedAt: tool.endedAt,
          inputSummary: tool.inputSummary?.slice(0, 120) ?? null,
          resultSummary: tool.resultSummary?.slice(0, 120) ?? null,
          error: tool.error ? 1 : 0,
        });
      }

      // 4. Upsert subagent_runs (delete + re-insert)
      this.db.prepare('DELETE FROM subagent_run WHERE prompt_id = ?').run(turn.promptId);
      const insertSub = this.db.prepare(`
        INSERT INTO subagent_run (agent_key, session_id, prompt_id, parent_tool_use_id, agent_type, description, form, storage_ref, cwd, model, started_at, ended_at, message_count, input_tokens, output_tokens)
        VALUES (:agentKey, :sessionId, :promptId, :parentToolUseId, :agentType, :description, 'file', :storageRef, :cwd, :model, :startedAt, :endedAt, :messageCount, :inputTokens, :outputTokens)
      `);
      for (const sub of turn.subagents) {
        insertSub.run({
          agentKey: sub.agentKey,
          sessionId,
          promptId: turn.promptId,
          parentToolUseId: sub.parentToolUseId,
          agentType: sub.agentType,
          description: sub.description,
          storageRef: `subagents/agent-${sub.agentKey}.jsonl`,
          cwd: sub.cwd,
          model: sub.model,
          startedAt: sub.startedAt,
          endedAt: sub.endedAt,
          messageCount: sub.messageCount,
          inputTokens: sub.inputTokens,
          outputTokens: sub.outputTokens,
        });
      }

      // 5. Update denormalized counters on audit_session
      const stats = this.db.prepare(`
        SELECT COUNT(*) as turnCount, COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens
        FROM prompt_turn WHERE session_id = ?
      `).get(sessionId) as { turnCount: number; totalTokens: number };
      this.db.prepare(`
        UPDATE audit_session SET total_turns = ?, total_tokens = ? WHERE session_id = ?
      `).run(stats.turnCount, stats.totalTokens, sessionId);
    });

    upsertAll();
  }

  getSessionTurns(sessionId: string): PromptTurnSummary[] {
    return this.db.prepare(`
      SELECT prompt_id as promptId, seq, user_text as userText, started_at as startedAt,
             ended_at as endedAt, tool_count as toolCount, subagent_count as subagentCount,
             input_tokens as inputTokens, output_tokens as outputTokens, model, status
      FROM prompt_turn WHERE session_id = ? ORDER BY seq ASC
    `).all(sessionId) as PromptTurnSummary[];
  }

  getPromptAudit(promptId: string): PromptAuditResponse | null {
    const turn = this.db.prepare(`
      SELECT prompt_id as promptId, seq, user_text as userText, started_at as startedAt,
             ended_at as endedAt, tool_count as toolCount, subagent_count as subagentCount,
             input_tokens as inputTokens, output_tokens as outputTokens, model, status
      FROM prompt_turn WHERE prompt_id = ?
    `).get(promptId) as PromptTurnSummary | undefined;

    if (!turn) return null;

    const tools = this.db.prepare(`
      SELECT id, tool_name as toolName, tool_subname as toolSubname,
             started_at as startedAt, ended_at as endedAt,
             input_summary as inputSummary, result_summary as resultSummary,
             error
      FROM tool_invocation WHERE prompt_id = ? ORDER BY started_at ASC
    `).all(promptId) as (ToolInvocationEntry & { error: number })[];

    const subagents = this.db.prepare(`
      SELECT agent_key as agentKey, agent_type as agentType, description,
             parent_tool_use_id as parentToolUseId, cwd, model,
             started_at as startedAt, ended_at as endedAt,
             message_count as messageCount, input_tokens as inputTokens,
             output_tokens as outputTokens
      FROM subagent_run WHERE prompt_id = ? ORDER BY started_at ASC
    `).all(promptId) as SubagentRunEntry[];

    return {
      turn,
      tools: tools.map(t => ({ ...t, error: t.error === 1 })),
      subagents,
    };
  }

  getKnownPromptIds(sessionId: string): Set<string> {
    const rows = this.db.prepare(
      'SELECT prompt_id FROM prompt_turn WHERE session_id = ?'
    ).all(sessionId) as { prompt_id: string }[];
    return new Set(rows.map(r => r.prompt_id));
  }

  getSessionMachineId(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT machine_id FROM audit_session WHERE session_id = ?'
    ).get(sessionId) as { machine_id: string } | undefined;
    return row?.machine_id ?? null;
  }

  getSessionMeta(sessionId: string): { slug: string | null; gitBranch: string | null } | null {
    const row = this.db.prepare(
      'SELECT slug, git_branch as gitBranch FROM audit_session WHERE session_id = ?'
    ).get(sessionId) as { slug: string | null; gitBranch: string | null } | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd server && npx vitest run src/__tests__/audit-db.test.ts
```

Expected: 모든 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add server/src/modules/audit/audit-db.ts server/src/__tests__/audit-db.test.ts
git commit -m "feat(server): add AuditDB with SQLite schema for transcript monitoring"
```

---

## Task 3: Agent TranscriptJsonlParser

**Files:**
- Create: `agent/src/transcript-jsonl-parser.ts`
- Create: `agent/src/__tests__/transcript-jsonl-parser.test.ts`

JSONL 라인을 파싱하고 promptId FSM에 필요한 구조화된 이벤트로 변환하는 순수 함수 모듈.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/src/__tests__/transcript-jsonl-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseJsonlLine,
  extractToolUses,
  extractUsage,
  type ParsedEvent,
} from '../transcript-jsonl-parser.js';

describe('parseJsonlLine', () => {
  it('parses user line with promptId', () => {
    const line = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: 'prompt-1',
      type: 'user',
      message: { role: 'user', content: 'Hello world' },
      uuid: 'uuid-1',
      timestamp: '2026-04-10T08:00:00.000Z',
      sessionId: 'sess-1',
    });
    const event = parseJsonlLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('user');
    expect(event!.promptId).toBe('prompt-1');
    expect(event!.isSidechain).toBe(false);
  });

  it('parses assistant line with null promptId', () => {
    const line = JSON.stringify({
      parentUuid: 'uuid-1',
      isSidechain: false,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'Hello!' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      uuid: 'uuid-2',
      timestamp: '2026-04-10T08:00:01.000Z',
      sessionId: 'sess-1',
    });
    const event = parseJsonlLine(line);
    expect(event!.type).toBe('assistant');
    expect(event!.promptId).toBeNull();
    expect(event!.model).toBe('claude-opus-4-6');
  });

  it('skips file-history-snapshot lines', () => {
    const line = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} });
    expect(parseJsonlLine(line)).toBeNull();
  });

  it('skips sidechain lines', () => {
    const line = JSON.stringify({
      isSidechain: true,
      type: 'user',
      promptId: 'p1',
      message: { role: 'user', content: 'sub' },
      uuid: 'u1',
      timestamp: '2026-04-10T08:00:00.000Z',
      sessionId: 'sess-1',
    });
    expect(parseJsonlLine(line)).toBeNull();
  });
});

describe('extractToolUses', () => {
  it('extracts Agent and Skill tool_uses from assistant content', () => {
    const content = [
      { type: 'text', text: 'Let me help' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Agent',
        input: { subagent_type: 'executor', description: 'Build feature', prompt: '...' },
      },
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Read',
        input: { file_path: '/tmp/file.ts' },
      },
      {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Skill',
        input: { skill: 'superpowers:brainstorming' },
      },
    ];
    const tools = extractToolUses(content);
    expect(tools).toHaveLength(3);
    expect(tools[0]).toEqual({
      id: 'toolu_1',
      toolName: 'Agent',
      toolSubname: 'executor',
      inputSummary: 'Build feature',
    });
    expect(tools[1]).toEqual({
      id: 'toolu_2',
      toolName: 'Read',
      toolSubname: null,
      inputSummary: '/tmp/file.ts',
    });
    expect(tools[2]).toEqual({
      id: 'toolu_3',
      toolName: 'Skill',
      toolSubname: 'superpowers:brainstorming',
      inputSummary: 'superpowers:brainstorming',
    });
  });
});

describe('extractUsage', () => {
  it('extracts input/output tokens from usage', () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    expect(extractUsage(usage)).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('returns zeros for missing usage', () => {
    expect(extractUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd agent && npx vitest run src/__tests__/transcript-jsonl-parser.test.ts
```

Expected: FAIL — 모듈 없음.

- [ ] **Step 3: Parser 구현**

`agent/src/transcript-jsonl-parser.ts`:

```typescript
export interface ParsedEvent {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'system';
  promptId: string | null;
  isSidechain: boolean;
  timestamp: number;
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

const SKIP_TYPES = new Set([
  'file-history-snapshot',
  'attachment',
  'queue-operation',
  'agent-name',
  'custom-title',
]);

export function parseJsonlLine(line: string): ParsedEvent | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const type = obj.type as string;
  if (SKIP_TYPES.has(type)) return null;
  if (obj.isSidechain === true) return null;
  if (!['user', 'assistant', 'system'].includes(type)) return null;

  const message = obj.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? []) as unknown[];
  const rawUsage = message?.usage as Record<string, number> | undefined;

  return {
    uuid: obj.uuid as string,
    parentUuid: (obj.parentUuid as string) ?? null,
    type: type as 'user' | 'assistant' | 'system',
    promptId: (obj.promptId as string) ?? null,
    isSidechain: false,
    timestamp: new Date(obj.timestamp as string).getTime(),
    sessionId: obj.sessionId as string,
    model: (message?.model as string) ?? null,
    content,
    usage: extractUsage(rawUsage),
    toolUses: type === 'assistant' ? extractToolUses(content) : [],
  };
}

export function extractToolUses(content: unknown[]): ExtractedToolUse[] {
  const results: ExtractedToolUse[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;

    const name = b.name as string;
    const input = (b.input ?? {}) as Record<string, unknown>;
    let subname: string | null = null;
    let summary: string | null = null;

    if (name === 'Agent') {
      subname = (input.subagent_type as string) ?? null;
      summary = (input.description as string)?.slice(0, 120) ?? null;
    } else if (name === 'Skill') {
      subname = (input.skill as string) ?? null;
      summary = subname;
    } else {
      const firstVal = Object.values(input)[0];
      summary = typeof firstVal === 'string' ? firstVal.slice(0, 120) : null;
    }

    results.push({ id: b.id as string, toolName: name, toolSubname: subname, inputSummary: summary });
  }
  return results;
}

export function extractUsage(usage: Record<string, number> | undefined): { inputTokens: number; outputTokens: number } {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd agent && npx vitest run src/__tests__/transcript-jsonl-parser.test.ts
```

Expected: 모든 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/transcript-jsonl-parser.ts agent/src/__tests__/transcript-jsonl-parser.test.ts
git commit -m "feat(agent): add JSONL line parser for transcript monitoring"
```

---

## Task 4: Agent SubagentScanner

**Files:**
- Create: `agent/src/subagent-scanner.ts`
- Create: `agent/src/__tests__/subagent-scanner.test.ts`

`<sessionId>/subagents/` 디렉토리를 읽고, `meta.json` + JSONL 첫/마지막 줄에서 메타데이터를 추출하고, parent Agent tool_use와 description 매칭.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/src/__tests__/subagent-scanner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { scanSubagents, matchSubagentsToToolUses, type ScannedSubagent } from '../subagent-scanner.js';
import type { ExtractedToolUse } from '../transcript-jsonl-parser.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `subagent-scan-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tempDir: string;

beforeEach(() => { tempDir = createTempDir(); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('scanSubagents', () => {
  it('scans subagent directory and reads meta.json + first/last JSONL lines', () => {
    const subDir = join(tempDir, 'subagents');
    mkdirSync(subDir, { recursive: true });

    // meta.json
    writeFileSync(join(subDir, 'agent-abc123.meta.json'), JSON.stringify({
      agentType: 'executor',
      description: 'Implement feature X',
      worktreePath: '/tmp/worktree',
    }));

    // JSONL — first and last line
    const firstLine = JSON.stringify({
      parentUuid: null, isSidechain: true, promptId: 'sub-prompt-1', agentId: 'abc123',
      type: 'user', message: { role: 'user', content: 'task...' },
      uuid: 'u1', timestamp: '2026-04-10T08:00:00.000Z', sessionId: 'sess-1',
    });
    const lastLine = JSON.stringify({
      parentUuid: 'u2', isSidechain: true, agentId: 'abc123',
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 50 } },
      uuid: 'u3', timestamp: '2026-04-10T08:05:00.000Z', sessionId: 'sess-1',
    });
    writeFileSync(join(subDir, 'agent-abc123.jsonl'), `${firstLine}\n${lastLine}\n`);

    const results = scanSubagents(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].agentKey).toBe('abc123');
    expect(results[0].agentType).toBe('executor');
    expect(results[0].description).toBe('Implement feature X');
    expect(results[0].cwd).toBe('/tmp/worktree');
    expect(results[0].startedAt).toBe(new Date('2026-04-10T08:00:00.000Z').getTime());
    expect(results[0].endedAt).toBe(new Date('2026-04-10T08:05:00.000Z').getTime());
  });

  it('returns empty array when no subagents directory exists', () => {
    expect(scanSubagents(tempDir)).toEqual([]);
  });
});

describe('matchSubagentsToToolUses', () => {
  it('matches by description', () => {
    const subagents: ScannedSubagent[] = [{
      agentKey: 'abc123', agentType: 'executor', description: 'Implement feature X',
      cwd: null, model: null, startedAt: 1000, endedAt: 2000, messageCount: 5,
      inputTokens: 100, outputTokens: 50,
    }];
    const toolUses: ExtractedToolUse[] = [
      { id: 'toolu_1', toolName: 'Agent', toolSubname: 'executor', inputSummary: 'Implement feature X' },
      { id: 'toolu_2', toolName: 'Read', toolSubname: null, inputSummary: 'file.ts' },
    ];
    const matched = matchSubagentsToToolUses(subagents, toolUses);
    expect(matched[0].parentToolUseId).toBe('toolu_1');
  });

  it('leaves parentToolUseId null when no match', () => {
    const subagents: ScannedSubagent[] = [{
      agentKey: 'abc123', agentType: 'executor', description: 'Unique description',
      cwd: null, model: null, startedAt: 1000, endedAt: 2000, messageCount: 5,
      inputTokens: 100, outputTokens: 50,
    }];
    const toolUses: ExtractedToolUse[] = [
      { id: 'toolu_1', toolName: 'Agent', toolSubname: 'executor', inputSummary: 'Different task' },
    ];
    const matched = matchSubagentsToToolUses(subagents, toolUses);
    expect(matched[0].parentToolUseId).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd agent && npx vitest run src/__tests__/subagent-scanner.test.ts
```

Expected: FAIL.

- [ ] **Step 3: SubagentScanner 구현**

`agent/src/subagent-scanner.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedToolUse } from './transcript-jsonl-parser.js';
import type { SubagentRunEntry } from '../types.js';

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

export function scanSubagents(sessionDir: string): ScannedSubagent[] {
  const subDir = join(sessionDir, 'subagents');
  if (!existsSync(subDir)) return [];

  const results: ScannedSubagent[] = [];
  const files = readdirSync(subDir).filter(f => f.endsWith('.jsonl'));

  for (const jsonlFile of files) {
    const agentKey = jsonlFile.replace('agent-', '').replace('.jsonl', '');
    const metaPath = join(subDir, jsonlFile.replace('.jsonl', '.meta.json'));
    const jsonlPath = join(subDir, jsonlFile);

    // Read meta.json
    let meta: MetaJson = {};
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch { /* meta.json optional */ }

    // Read first and last JSONL lines
    let content: string;
    try {
      content = readFileSync(jsonlPath, 'utf-8');
    } catch { continue; }

    const lines = content.trim().split('\n').filter(l => l.length > 0);
    if (lines.length === 0) continue;

    let startedAt = 0;
    let endedAt: number | null = null;
    let model: string | null = null;
    let totalInput = 0;
    let totalOutput = 0;
    let msgCount = 0;

    // First line → startedAt
    try {
      const first = JSON.parse(lines[0]);
      startedAt = new Date(first.timestamp).getTime();
    } catch { continue; }

    // Last line → endedAt, model
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      endedAt = new Date(last.timestamp).getTime();
      model = last.message?.model ?? null;
    } catch { /* use startedAt as fallback */ }

    // Count messages and sum tokens (scan all assistant lines)
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' || obj.type === 'user') msgCount++;
        const usage = obj.message?.usage;
        if (usage) {
          totalInput += usage.input_tokens ?? 0;
          totalOutput += usage.output_tokens ?? 0;
        }
      } catch { /* skip malformed */ }
    }

    results.push({
      agentKey,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      cwd: meta.worktreePath ?? null,
      model,
      startedAt,
      endedAt,
      messageCount: msgCount,
      inputTokens: totalInput,
      outputTokens: totalOutput,
    });
  }

  return results;
}

export function matchSubagentsToToolUses(
  subagents: ScannedSubagent[],
  toolUses: ExtractedToolUse[],
): (ScannedSubagent & { parentToolUseId: string | null })[] {
  const agentToolUses = toolUses.filter(t => t.toolName === 'Agent');

  return subagents.map(sub => {
    // Primary: description match
    const match = agentToolUses.find(t => t.inputSummary === sub.description);
    return { ...sub, parentToolUseId: match?.id ?? null };
  });
}
```

Note: `SubagentRunEntry` 타입을 agent에서 쓰려면 agent/src/types.ts에서 정의하거나 api-contract.ts에서 import해야 합니다. 실제 push 시 이 scanner 결과를 `TurnSummaryPayload.turn.subagents` 형태로 변환합니다.

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd agent && npx vitest run src/__tests__/subagent-scanner.test.ts
```

Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/subagent-scanner.ts agent/src/__tests__/subagent-scanner.test.ts
git commit -m "feat(agent): add subagent scanner with description-based matching"
```

---

## Task 5: Agent TranscriptIngestor

**Files:**
- Create: `agent/src/transcript-ingestor.ts`
- Create: `agent/src/__tests__/transcript-ingestor.test.ts`

Hook trigger 수신 → JSONL tail → promptId FSM → subagent 스캔 → TurnSummary 생성 → 서버 push. 이 모듈이 전체 수집 파이프라인의 orchestrator.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/src/__tests__/transcript-ingestor.test.ts` — promptId FSM 경계 + turn 생성 로직을 테스트:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TranscriptIngestor, type EmittedTurn } from '../transcript-ingestor.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `ingestor-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeUserLine(promptId: string, text: string, ts: string, uuid?: string): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, promptId, type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid ?? randomUUID(), timestamp: ts, sessionId: 'sess-1',
  });
}

function makeAssistantLine(parentUuid: string, ts: string, toolUses?: unknown[]): string {
  return JSON.stringify({
    parentUuid, isSidechain: false, type: 'assistant',
    message: {
      role: 'assistant', model: 'claude-opus-4-6',
      content: toolUses ?? [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    uuid: randomUUID(), timestamp: ts, sessionId: 'sess-1',
  });
}

let tempDir: string;
beforeEach(() => { tempDir = createTempDir(); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('TranscriptIngestor', () => {
  it('emits a TurnSummary when promptId changes', () => {
    // Two prompt turns in one file
    const jsonlPath = join(tempDir, 'sess-1.jsonl');
    const lines = [
      makeUserLine('p1', 'first prompt', '2026-04-10T08:00:00.000Z', 'u1'),
      makeAssistantLine('u1', '2026-04-10T08:00:01.000Z'),
      makeUserLine('p2', 'second prompt', '2026-04-10T08:01:00.000Z', 'u2'),
      makeAssistantLine('u2', '2026-04-10T08:01:01.000Z'),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({
      onTurn: (turn) => { emitted.push(turn); },
    });

    ingestor.processFile('sess-1', jsonlPath, tempDir);

    // p1 is flushed when p2 starts; p2 is flushed at EOF
    expect(emitted).toHaveLength(2);
    expect(emitted[0].promptId).toBe('p1');
    expect(emitted[0].userText).toBe('first prompt');
    expect(emitted[0].seq).toBe(0);
    expect(emitted[1].promptId).toBe('p2');
    expect(emitted[1].seq).toBe(1);
  });

  it('extracts tool_uses from assistant lines', () => {
    const jsonlPath = join(tempDir, 'sess-1.jsonl');
    const lines = [
      makeUserLine('p1', 'do something', '2026-04-10T08:00:00.000Z', 'u1'),
      makeAssistantLine('u1', '2026-04-10T08:00:01.000Z', [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x.ts' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Skill', input: { skill: 'plan' } },
      ]),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (turn) => { emitted.push(turn); } });
    ingestor.processFile('sess-1', jsonlPath, tempDir);

    expect(emitted[0].tools).toHaveLength(2);
    expect(emitted[0].tools[0].toolName).toBe('Read');
    expect(emitted[0].tools[1].toolName).toBe('Skill');
    expect(emitted[0].tools[1].toolSubname).toBe('plan');
  });

  it('resumes from last offset (incremental)', () => {
    const jsonlPath = join(tempDir, 'sess-1.jsonl');

    // First write — one turn
    const firstBatch = [
      makeUserLine('p1', 'first', '2026-04-10T08:00:00.000Z', 'u1'),
      makeAssistantLine('u1', '2026-04-10T08:00:01.000Z'),
    ].join('\n') + '\n';
    writeFileSync(jsonlPath, firstBatch);

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (turn) => { emitted.push(turn); } });
    ingestor.processFile('sess-1', jsonlPath, tempDir);
    expect(emitted).toHaveLength(1);

    // Second write — append another turn
    const secondBatch = [
      makeUserLine('p2', 'second', '2026-04-10T08:01:00.000Z', 'u2'),
      makeAssistantLine('u2', '2026-04-10T08:01:01.000Z'),
    ].join('\n') + '\n';
    writeFileSync(jsonlPath, firstBatch + secondBatch);

    ingestor.processFile('sess-1', jsonlPath, tempDir);
    expect(emitted).toHaveLength(2); // only p2 emitted in second pass
    expect(emitted[1].promptId).toBe('p2');
  });

  it('aggregates input/output tokens across assistant lines', () => {
    const jsonlPath = join(tempDir, 'sess-1.jsonl');
    const lines = [
      makeUserLine('p1', 'test', '2026-04-10T08:00:00.000Z', 'u1'),
      makeAssistantLine('u1', '2026-04-10T08:00:01.000Z'), // 100in, 50out
      makeAssistantLine('u1', '2026-04-10T08:00:02.000Z'), // 100in, 50out (agentic loop)
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const emitted: EmittedTurn[] = [];
    const ingestor = new TranscriptIngestor({ onTurn: (turn) => { emitted.push(turn); } });
    ingestor.processFile('sess-1', jsonlPath, tempDir);

    expect(emitted[0].inputTokens).toBe(200);
    expect(emitted[0].outputTokens).toBe(100);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd agent && npx vitest run src/__tests__/transcript-ingestor.test.ts
```

- [ ] **Step 3: TranscriptIngestor 구현**

`agent/src/transcript-ingestor.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { parseJsonlLine, type ParsedEvent, type ExtractedToolUse } from './transcript-jsonl-parser.js';
import { scanSubagents, matchSubagentsToToolUses, type ScannedSubagent } from './subagent-scanner.js';

export interface EmittedTurn {
  promptId: string;
  seq: number;
  userText: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  tools: ExtractedToolUse[];
  subagents: (ScannedSubagent & { parentToolUseId: string | null })[];
}

interface TurnAccumulator {
  promptId: string;
  userText: string | null;
  startedAt: number;
  lastTimestamp: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  toolUses: ExtractedToolUse[];
}

interface IngestorOptions {
  onTurn: (turn: EmittedTurn) => void;
}

export class TranscriptIngestor {
  private readonly onTurn: (turn: EmittedTurn) => void;
  // session별 offset + seq + 진행 중 turn 추적
  private readonly offsets = new Map<string, number>();
  private readonly seqCounters = new Map<string, number>();
  private readonly pendingTurns = new Map<string, TurnAccumulator>();

  constructor(options: IngestorOptions) {
    this.onTurn = options.onTurn;
  }

  processFile(sessionId: string, jsonlPath: string, sessionDir: string): void {
    const lastOffset = this.offsets.get(sessionId) ?? 0;

    let fileSize: number;
    try {
      fileSize = statSync(jsonlPath).size;
    } catch { return; }

    // offset이 파일보다 크면 리셋 (파일이 재생성됐을 수 있음)
    const offset = lastOffset > fileSize ? 0 : lastOffset;

    let content: string;
    try {
      const buf = readFileSync(jsonlPath);
      content = buf.subarray(offset).toString('utf-8');
    } catch { return; }

    const lines = content.split('\n').filter(l => l.length > 0);
    let bytesRead = offset;

    for (const line of lines) {
      bytesRead += Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n
      const event = parseJsonlLine(line);
      if (!event) continue;

      this.processEvent(sessionId, event, sessionDir);
    }

    // EOF에서 pending turn flush
    this.flushPending(sessionId, sessionDir);
    this.offsets.set(sessionId, bytesRead);
  }

  private processEvent(sessionId: string, event: ParsedEvent, sessionDir: string): void {
    if (event.type === 'user' && event.promptId) {
      const pending = this.pendingTurns.get(sessionId);
      // 새 promptId면 이전 turn flush
      if (pending && pending.promptId !== event.promptId) {
        this.flushTurn(sessionId, pending, sessionDir);
      }

      if (!pending || pending.promptId !== event.promptId) {
        // user message의 content에서 텍스트 추출
        let userText: string | null = null;
        const content = event.content;
        if (typeof content === 'string') {
          userText = content.slice(0, 120);
        } else if (Array.isArray(content)) {
          // skip — content might be complex
        } else {
          userText = String(content).slice(0, 120);
        }
        // 단순 string content 처리
        if (!userText && typeof (event as unknown as Record<string, unknown>).message === 'object') {
          const msg = (event as unknown as { message: Record<string, unknown> }).message;
          const c = msg.content;
          if (typeof c === 'string') userText = c.slice(0, 120);
        }

        this.pendingTurns.set(sessionId, {
          promptId: event.promptId,
          userText,
          startedAt: event.timestamp,
          lastTimestamp: event.timestamp,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          toolUses: [],
        });
      }
    }

    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;

    pending.lastTimestamp = Math.max(pending.lastTimestamp, event.timestamp);

    if (event.type === 'assistant') {
      pending.model = pending.model ?? event.model;
      pending.inputTokens += event.usage.inputTokens;
      pending.outputTokens += event.usage.outputTokens;
      pending.toolUses.push(...event.toolUses);
    }
  }

  private flushPending(sessionId: string, sessionDir: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (pending) {
      this.flushTurn(sessionId, pending, sessionDir);
    }
  }

  private flushTurn(sessionId: string, acc: TurnAccumulator, sessionDir: string): void {
    const seq = this.seqCounters.get(sessionId) ?? 0;
    this.seqCounters.set(sessionId, seq + 1);

    // Subagent 스캔 — turn에 Agent tool_use가 있으면
    const agentToolUses = acc.toolUses.filter(t => t.toolName === 'Agent');
    let matchedSubagents: (ScannedSubagent & { parentToolUseId: string | null })[] = [];

    if (agentToolUses.length > 0) {
      const scanned = scanSubagents(sessionDir);
      // 이 turn의 시간 범위 안의 subagent만 필터
      const turnSubagents = scanned.filter(s =>
        s.startedAt >= acc.startedAt - 2000 && s.startedAt <= acc.lastTimestamp + 2000
      );
      matchedSubagents = matchSubagentsToToolUses(turnSubagents, agentToolUses);
    }

    const turn: EmittedTurn = {
      promptId: acc.promptId,
      seq,
      userText: acc.userText,
      startedAt: acc.startedAt,
      endedAt: acc.lastTimestamp > acc.startedAt ? acc.lastTimestamp : null,
      model: acc.model,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      tools: acc.toolUses,
      subagents: matchedSubagents,
    };

    this.onTurn(turn);
    this.pendingTurns.delete(this.findKeyForAcc(acc));
  }

  private findKeyForAcc(acc: TurnAccumulator): string {
    for (const [key, val] of this.pendingTurns) {
      if (val === acc) return key;
    }
    return '';
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd agent && npx vitest run src/__tests__/transcript-ingestor.test.ts
```

Expected: PASS.

- [ ] **Step 5: 빌드 확인**

```bash
cd agent && npm run build
```

- [ ] **Step 6: 커밋**

```bash
git add agent/src/transcript-ingestor.ts agent/src/__tests__/transcript-ingestor.test.ts
git commit -m "feat(agent): add TranscriptIngestor with promptId FSM"
```

---

## Task 6: Server AuditModule (BackendModule)

**Files:**
- Create: `server/src/modules/audit/index.ts`
- Modify: `server/src/cli.ts`
- Create: `server/src/__tests__/audit-module.test.ts`

BackendModule 패턴으로 ingest route + read routes + transcript proxy 등록.

- [ ] **Step 1: 실패하는 테스트 작성**

`server/src/__tests__/audit-module.test.ts` — 핵심 route 동작 테스트:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { AuditModule } from '../modules/audit/index.js';
import { AuditDB } from '../modules/audit/audit-db.js';

let app: ReturnType<typeof Fastify>;
let db: AuditDB;

beforeAll(async () => {
  db = new AuditDB(':memory:');
  app = Fastify({ logger: false });
  const mod = new AuditModule(db, null as never); // machineManager null for unit test
  mod.registerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe('POST /api/ingest/turn-summary', () => {
  it('accepts and stores a turn summary', async () => {
    const payload = {
      sessionId: 'sess-test',
      slug: 'test-slug',
      gitBranch: 'main',
      cwd: '/project',
      machineId: 'mac-1',
      turn: {
        promptId: 'p-test',
        seq: 0,
        userText: 'hello',
        startedAt: 1000,
        endedAt: 2000,
        model: 'claude-opus-4-6',
        inputTokens: 100,
        outputTokens: 50,
        tools: [],
        subagents: [],
      },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingest/turn-summary',
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('GET /api/sessions/:sessionId/turns', () => {
  it('returns turns for a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-test/turns',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].promptId).toBe('p-test');
  });

  it('returns empty turns for unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/unknown/turns',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).turns).toEqual([]);
  });
});

describe('GET /api/prompts/:promptId/audit', () => {
  it('returns audit data for known prompt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/prompts/p-test/audit',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turn.promptId).toBe('p-test');
    expect(body.tools).toEqual([]);
    expect(body.subagents).toEqual([]);
  });

  it('returns 404 for unknown prompt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/prompts/unknown/audit',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/audit/known-prompts', () => {
  it('returns known prompt IDs for session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/known-prompts?sessionId=sess-test',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.promptIds).toContain('p-test');
  });
});
```

- [ ] **Step 2: AuditModule 구현**

`server/src/modules/audit/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { BackendModule } from '../types.js';
import type { AuditDB } from './audit-db.js';
import type { MachineManager } from '../../machines/machine-manager.js';
import type { TurnSummaryPayload } from '../../shared/api-contract.js';

export class AuditModule implements BackendModule {
  readonly id = 'audit';

  constructor(
    private readonly db: AuditDB,
    private readonly machineManager: MachineManager,
  ) {}

  registerRoutes(app: FastifyInstance): void {
    // ── Ingest (Agent → Server) ──
    app.post<{ Body: TurnSummaryPayload & { machineId: string } }>(
      '/api/ingest/turn-summary',
      async (request) => {
        const { machineId, ...payload } = request.body;
        this.db.upsertTurnSummary(payload, machineId);
        return { ok: true };
      },
    );

    // ── Read: session turns (light) ──
    app.get<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/turns',
      async (request) => {
        const { sessionId } = request.params;
        const turns = this.db.getSessionTurns(sessionId);
        const meta = this.db.getSessionMeta(sessionId);
        return {
          sessionId,
          slug: meta?.slug ?? null,
          gitBranch: meta?.gitBranch ?? null,
          turns,
        };
      },
    );

    // ── Read: prompt audit (heavy) ──
    app.get<{ Params: { promptId: string } }>(
      '/api/prompts/:promptId/audit',
      async (request, reply) => {
        const audit = this.db.getPromptAudit(request.params.promptId);
        if (!audit) return reply.code(404).send({ error: 'Prompt not found' });
        return audit;
      },
    );

    // ── Read: known prompt IDs (for agent initial scan) ──
    app.get<{ Querystring: { sessionId?: string } }>(
      '/api/audit/known-prompts',
      async (request) => {
        const { sessionId } = request.query;
        if (!sessionId) return { promptIds: [] };
        const ids = this.db.getKnownPromptIds(sessionId);
        return { promptIds: [...ids] };
      },
    );

    // ── Transcript proxy (Server → Agent on-demand pull) ──
    app.get<{ Params: { promptId: string } }>(
      '/api/prompts/:promptId/transcript',
      async (request, reply) => {
        const { promptId } = request.params;
        const audit = this.db.getPromptAudit(promptId);
        if (!audit) return reply.code(404).send({ error: 'Prompt not found' });

        const machineId = this.db.getSessionMachineId(audit.turn.promptId);
        if (!machineId) return reply.code(404).send({ error: 'Session not found' });

        // Derive sessionId from prompt_turn
        const sessionId = this.db.getSessionIdByPromptId(promptId);
        if (!sessionId) return reply.code(404).send({ error: 'Session not found' });

        try {
          const data = await this.machineManager.fetchFromMachine(
            this.machineManager.getMachineById(machineId)!,
            `/claude/transcript/${sessionId}/${promptId}`,
          );
          return data;
        } catch {
          return reply.code(503).send({ error: 'agent_offline', machineId });
        }
      },
    );
  }
}
```

Note: `getSessionIdByPromptId`와 `getMachineById`를 AuditDB와 MachineManager에 각각 추가해야 합니다. 구현 시 해당 메서드를 간단히 추가:

```typescript
// audit-db.ts에 추가
getSessionIdByPromptId(promptId: string): string | null {
  const row = this.db.prepare(
    'SELECT session_id FROM prompt_turn WHERE prompt_id = ?'
  ).get(promptId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}
```

- [ ] **Step 3: cli.ts에 AuditModule 등록**

`server/src/cli.ts`에서 AuditDB + AuditModule 초기화:

```typescript
// 기존 import 근처에 추가
import { AuditDB } from './modules/audit/audit-db.js';
import { AuditModule } from './modules/audit/index.js';

// 기존 DB 초기화 근처에 추가 (memoDb 초기화 후)
const auditDbPath = join(dataDir, 'audit.db');
const auditDb = new AuditDB(auditDbPath);

// modules 배열에 추가
const auditModule = new AuditModule(auditDb, machineManager);
// modules 배열에 auditModule 포함
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd server && npx vitest run src/__tests__/audit-module.test.ts
```

- [ ] **Step 5: 전체 빌드 확인**

```bash
cd server && npm run build
```

- [ ] **Step 6: 커밋**

```bash
git add server/src/modules/audit/index.ts server/src/cli.ts server/src/__tests__/audit-module.test.ts
git commit -m "feat(server): add AuditModule with ingest and read routes"
```

---

## Task 7: Agent Transcript Body Endpoints

**Files:**
- Modify: `agent/src/server.ts`

Agent에 transcript body 서빙 엔드포인트 추가 — 서버가 on-demand로 호출.

- [ ] **Step 1: server.ts에 transcript 엔드포인트 추가**

`agent/src/server.ts` — route 등록 영역에 추가:

```typescript
// GET /claude/transcript/:sessionId/:promptId
app.get<{ Params: { sessionId: string; promptId: string } }>(
  '/claude/transcript/:sessionId/:promptId',
  async (request, reply) => {
    const { sessionId, promptId } = request.params;
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');

    // Find session JSONL — encoded cwd 패턴으로 검색
    const sessionJsonlPath = findSessionJsonl(claudeProjectsDir, sessionId);
    if (!sessionJsonlPath) {
      return reply.code(404).send({ error: 'Session JSONL not found' });
    }

    const events = readPromptEvents(sessionJsonlPath, promptId);
    return { promptId, sessionId, events };
  },
);

// GET /claude/transcript/:sessionId/subagent/:agentKey
app.get<{ Params: { sessionId: string; agentKey: string } }>(
  '/claude/transcript/:sessionId/subagent/:agentKey',
  async (request, reply) => {
    const { sessionId, agentKey } = request.params;
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');

    const sessionDir = findSessionDir(claudeProjectsDir, sessionId);
    if (!sessionDir) {
      return reply.code(404).send({ error: 'Session directory not found' });
    }

    const subagentPath = join(sessionDir, 'subagents', `agent-${agentKey}.jsonl`);
    const events = readAllEvents(subagentPath);
    return { agentKey, sessionId, events };
  },
);
```

헬퍼 함수 (`findSessionJsonl`, `readPromptEvents`, `readAllEvents`)는 별도 유틸리티 파일이나 server.ts 내 로컬 함수로 구현. 핵심 로직:

```typescript
function findSessionJsonl(projectsDir: string, sessionId: string): string | null {
  // 모든 프로젝트 디렉토리를 순회해서 <sessionId>.jsonl 탐색
  for (const projDir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, projDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readPromptEvents(jsonlPath: string, promptId: string): TranscriptEvent[] {
  const content = readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.length > 0);
  const events: TranscriptEvent[] = [];
  let inScope = false;

  for (const line of lines) {
    const event = parseJsonlLine(line);
    if (!event) continue;

    // user 라인이면 scope 판정
    if (event.type === 'user' && event.promptId) {
      inScope = event.promptId === promptId;
    }

    if (inScope) {
      events.push(toTranscriptEvent(event));
    }
  }
  return events;
}
```

- [ ] **Step 2: 빌드 확인**

```bash
cd agent && npm run build
```

- [ ] **Step 3: 커밋**

```bash
git add agent/src/server.ts
git commit -m "feat(agent): add transcript body endpoints for on-demand pull"
```

---

## Task 8: Agent → Server 연결 (Hook Wiring)

**Files:**
- Modify: `agent/src/claude-heartbeat.ts`
- Modify: `agent/src/server.ts`

Claude hook 이벤트(`Stop`, `UserPromptSubmit`)를 TranscriptIngestor에 연결하고, turn 완결 시 서버에 push.

- [ ] **Step 1: claude-heartbeat.ts에 ingestor 연결**

```typescript
// TranscriptIngestor 인스턴스를 ClaudeHeartbeat에 주입
// hook 이벤트 수신 시 ingestor.processFile() 호출
```

구체적으로 `handleHookEvent()` 메서드(또는 동등한 hook 처리 함수) 내부에서:

```typescript
if (event.type === 'Stop' || event.type === 'UserPromptSubmit') {
  const sessionId = event.sessionId;
  if (sessionId && this.transcriptIngestor) {
    const jsonlPath = this.findSessionJsonl(sessionId);
    const sessionDir = this.findSessionDir(sessionId);
    if (jsonlPath && sessionDir) {
      this.transcriptIngestor.processFile(sessionId, jsonlPath, sessionDir);
    }
  }
}
```

- [ ] **Step 2: server.ts에서 ingestor 초기화 + push 콜백 설정**

```typescript
const serverUrl = config.dashboardUrl ?? 'http://192.168.0.2:3097';
const machineId = config.machineId;

const ingestor = new TranscriptIngestor({
  onTurn: async (turn) => {
    try {
      await fetch(`${serverUrl}/api/ingest/turn-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: turn.sessionId,
          machineId,
          slug: null, // 추후 enrichment
          gitBranch: null,
          cwd: null,
          turn,
        }),
      });
    } catch (err) {
      console.error('Failed to push turn summary:', err);
    }
  },
});
```

- [ ] **Step 3: 빌드 확인**

```bash
cd agent && npm run build
```

- [ ] **Step 4: 커밋**

```bash
git add agent/src/claude-heartbeat.ts agent/src/server.ts
git commit -m "feat(agent): wire TranscriptIngestor to Claude hooks and server push"
```

---

## Task 9: Frontend Audit Store

**Files:**
- Create: `server/frontend/src/lib/stores/audit.svelte.ts`

- [ ] **Step 1: audit store 구현**

```typescript
import type {
  PromptTurnSummary,
  PromptAuditResponse,
  SessionTurnsResponse,
} from '../../types';
import { fetchJSON } from '../api';

// ── Session turns cache ──
let sessionTurnsCache = $state<Map<string, PromptTurnSummary[]>>(new Map());

export function getSessionTurns(sessionId: string): PromptTurnSummary[] {
  return sessionTurnsCache.get(sessionId) ?? [];
}

export async function fetchSessionTurns(sessionId: string): Promise<void> {
  try {
    const data = await fetchJSON<SessionTurnsResponse>(`/api/sessions/${sessionId}/turns`);
    sessionTurnsCache = new Map(sessionTurnsCache).set(sessionId, data.turns);
  } catch (e) {
    console.error('Failed to fetch session turns:', e);
  }
}

// ── Prompt audit cache ──
let auditCache = $state<Map<string, PromptAuditResponse>>(new Map());

export function getPromptAudit(promptId: string): PromptAuditResponse | null {
  return auditCache.get(promptId) ?? null;
}

export async function fetchPromptAudit(promptId: string): Promise<PromptAuditResponse | null> {
  const cached = auditCache.get(promptId);
  if (cached) return cached;

  try {
    const data = await fetchJSON<PromptAuditResponse>(`/api/prompts/${promptId}/audit`);
    auditCache = new Map(auditCache).set(promptId, data);
    return data;
  } catch (e) {
    console.error('Failed to fetch prompt audit:', e);
    return null;
  }
}

// ── Transcript body (on-demand, not cached in store) ──
export async function fetchTranscriptBody(promptId: string): Promise<unknown> {
  return fetchJSON(`/api/prompts/${promptId}/transcript`);
}

export async function fetchSubagentTranscript(promptId: string, agentKey: string): Promise<unknown> {
  return fetchJSON(`/api/prompts/${promptId}/subagent/${agentKey}/transcript`);
}
```

- [ ] **Step 2: 빌드 확인**

```bash
cd server/frontend && npm run build
```

- [ ] **Step 3: 커밋**

```bash
git add server/frontend/src/lib/stores/audit.svelte.ts
git commit -m "feat(frontend): add audit store with session turns and prompt audit cache"
```

---

## Task 10: Frontend PromptAuditView 컴포넌트

**Files:**
- Create: `server/frontend/src/components/audit/PromptAuditHeader.svelte`
- Create: `server/frontend/src/components/audit/PromptAuditBody.svelte`
- Create: `server/frontend/src/components/audit/PromptAuditView.svelte`
- Create: `server/frontend/src/components/audit/PromptAuditDrawer.svelte`

공용 컴포넌트 4개 구현. 기존 SessionCards/RecentPrompts의 CSS 패턴을 따름.

- [ ] **Step 1: PromptAuditHeader 구현**

`server/frontend/src/components/audit/PromptAuditHeader.svelte`:

```svelte
<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import { truncate } from '../../lib/utils';

  let {
    turn,
    expanded = false,
    onclick,
  }: {
    turn: PromptTurnSummary;
    expanded?: boolean;
    onclick?: () => void;
  } = $props();

  let timeStr = $derived(new Date(turn.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  let tokenStr = $derived(`${((turn.inputTokens + turn.outputTokens) / 1000).toFixed(1)}k`);
</script>

<button class="audit-header" class:expanded onclick={onclick}>
  <span class="time">{timeStr}</span>
  <span class="text">{truncate(turn.userText ?? '(no text)', 60)}</span>
  <span class="badges">
    {#if turn.subagentCount > 0}
      <span class="badge badge-subagent" title="Subagents">{turn.subagentCount}</span>
    {/if}
    {#if turn.toolCount > 0}
      <span class="badge badge-tool" title="Tools">{turn.toolCount}</span>
    {/if}
    <span class="badge badge-token">{tokenStr}</span>
  </span>
  <span class="chevron">{expanded ? '▾' : '▸'}</span>
</button>

<style>
  .audit-header {
    display: flex; align-items: center; gap: 0.5rem;
    width: 100%; padding: 0.5rem 0.75rem;
    border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
    background: rgba(255,255,255,0.03); cursor: pointer;
    font: inherit; color: inherit; text-align: left;
  }
  .audit-header:hover { background: rgba(255,255,255,0.06); }
  .audit-header.expanded { border-color: rgba(88,166,255,0.3); }
  .time { color: #8b949e; font-size: 0.8rem; flex-shrink: 0; }
  .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; gap: 0.25rem; flex-shrink: 0; }
  .badge { padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; }
  .badge-subagent { background: rgba(136,98,234,0.2); color: #a78bfa; }
  .badge-tool { background: rgba(88,166,255,0.15); color: #58a6ff; }
  .badge-token { background: rgba(255,255,255,0.06); color: #8b949e; }
  .chevron { color: #8b949e; font-size: 0.7rem; }
</style>
```

- [ ] **Step 2: PromptAuditBody 구현**

`server/frontend/src/components/audit/PromptAuditBody.svelte`:

```svelte
<script lang="ts">
  import type { PromptAuditResponse, ToolInvocationEntry, SubagentRunEntry } from '../../types';
  import { fetchPromptAudit } from '../../lib/stores/audit.svelte';
  import { onMount } from 'svelte';

  let { promptId }: { promptId: string } = $props();

  let audit = $state<PromptAuditResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      audit = await fetchPromptAudit(promptId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load';
    } finally {
      loading = false;
    }
  });

  function toolIcon(name: string): string {
    if (name === 'Agent') return '\u{1F916}';
    if (name === 'Skill') return '\u{1F9EA}';
    return '\u{1F527}';
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
</script>

{#if loading}
  <div class="audit-body loading">Loading...</div>
{:else if error}
  <div class="audit-body error">{error}</div>
{:else if audit}
  <div class="audit-body">
    {#each audit.tools as tool (tool.id)}
      <div class="tool-row">
        <span class="tool-time">{formatTime(tool.startedAt)}</span>
        <span class="tool-icon">{toolIcon(tool.toolName)}</span>
        <span class="tool-name">{tool.toolName}{tool.toolSubname ? `(${tool.toolSubname})` : ''}</span>
        {#if tool.inputSummary}
          <span class="tool-summary">{tool.inputSummary}</span>
        {/if}
      </div>
    {/each}

    {#if audit.subagents.length > 0}
      <div class="subagent-section">
        <h4>Subagents ({audit.subagents.length})</h4>
        {#each audit.subagents as sub (sub.agentKey)}
          <div class="subagent-card">
            <span class="sub-type">{sub.agentType ?? 'unknown'}</span>
            <span class="sub-desc">{sub.description ?? ''}</span>
            <span class="sub-stats">{sub.messageCount} msgs, {((sub.inputTokens + sub.outputTokens) / 1000).toFixed(1)}k tok</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .audit-body { padding: 0.5rem 0.75rem; font-size: 0.85rem; }
  .audit-body.loading, .audit-body.error { color: #8b949e; padding: 1rem; }
  .tool-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0; }
  .tool-time { color: #8b949e; font-size: 0.75rem; flex-shrink: 0; }
  .tool-icon { font-size: 0.8rem; }
  .tool-name { font-weight: 500; }
  .tool-summary { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subagent-section { margin-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.5rem; }
  .subagent-section h4 { margin: 0 0 0.3rem; font-size: 0.8rem; color: #a78bfa; }
  .subagent-card { display: flex; gap: 0.5rem; padding: 0.3rem 0; }
  .sub-type { background: rgba(136,98,234,0.2); color: #a78bfa; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.7rem; }
  .sub-desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub-stats { color: #8b949e; font-size: 0.75rem; flex-shrink: 0; }
</style>
```

- [ ] **Step 3: PromptAuditView (통합) 구현**

`server/frontend/src/components/audit/PromptAuditView.svelte`:

```svelte
<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import PromptAuditHeader from './PromptAuditHeader.svelte';
  import PromptAuditBody from './PromptAuditBody.svelte';

  let {
    turn,
    autoExpand = false,
  }: {
    turn: PromptTurnSummary;
    autoExpand?: boolean;
  } = $props();

  let expanded = $state(autoExpand);

  function toggle() {
    expanded = !expanded;
  }
</script>

<div class="prompt-audit-view">
  <PromptAuditHeader {turn} {expanded} onclick={toggle} />
  {#if expanded}
    <PromptAuditBody promptId={turn.promptId} />
  {/if}
</div>

<style>
  .prompt-audit-view {
    margin-bottom: 0.25rem;
  }
</style>
```

- [ ] **Step 4: PromptAuditDrawer 구현**

`server/frontend/src/components/audit/PromptAuditDrawer.svelte`:

```svelte
<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import PromptAuditView from './PromptAuditView.svelte';

  let {
    turn = null,
    onclose,
  }: {
    turn: PromptTurnSummary | null;
    onclose?: () => void;
  } = $props();
</script>

{#if turn}
  <div class="drawer-overlay" onclick={onclose} role="presentation"></div>
  <aside class="audit-drawer">
    <div class="drawer-header">
      <h3>Prompt Audit</h3>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>
    <PromptAuditView {turn} autoExpand={true} />
  </aside>
{/if}

<style>
  .drawer-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 90;
  }
  .audit-drawer {
    position: fixed; right: 0; top: 0; bottom: 0; width: 480px;
    background: #161b22; border-left: 1px solid rgba(255,255,255,0.1);
    z-index: 100; overflow-y: auto; padding: 1rem;
  }
  .drawer-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 1rem;
  }
  .drawer-header h3 { margin: 0; font-size: 1rem; }
  .close-btn {
    background: none; border: none; color: #8b949e; font-size: 1.5rem; cursor: pointer;
  }
</style>
```

- [ ] **Step 5: 빌드 확인**

```bash
cd server/frontend && npm run build
```

- [ ] **Step 6: 커밋**

```bash
git add server/frontend/src/components/audit/
git commit -m "feat(frontend): add PromptAudit component family (Header, Body, View, Drawer)"
```

---

## Task 11: Frontend Navigation + Pages

**Files:**
- Modify: `server/frontend/src/lib/stores/navigation.svelte.ts`
- Create: `server/frontend/src/components/pages/PromptDetailPage.svelte`
- Create: `server/frontend/src/components/pages/SessionTimelinePage.svelte`
- Modify: `server/frontend/src/App.svelte`

- [ ] **Step 1: navigation.svelte.ts에 ViewType 추가**

`ViewType` union에 `'prompt-audit'` | `'session-timeline'` 추가. `getInitialState()`에 `view=prompt-audit&promptId=X` 와 `view=session-timeline&session=X` 파싱 추가.

```typescript
// ViewType에 추가
| 'prompt-audit'
| 'session-timeline'

// NavigationState에 추가
promptId?: string | null;

// getInitialState()에 추가
if (view === 'prompt-audit') {
  const promptId = params.get('promptId');
  return { currentView: 'prompt-audit', sessionId: null, promptId, previousScrollPosition: 0 };
}
if (view === 'session-timeline' && sessionId) {
  return { currentView: 'session-timeline', sessionId, previousScrollPosition: 0 };
}
```

Navigation 함수 추가:

```typescript
export function pushPromptAudit(promptId: string): void {
  state.previousScrollPosition = window.scrollY;
  state = { ...state, currentView: 'prompt-audit', promptId };
  updateUrl({ view: 'prompt-audit', promptId });
}

export function pushSessionTimeline(sessionId: string): void {
  state.previousScrollPosition = window.scrollY;
  state = { ...state, currentView: 'session-timeline', sessionId };
  updateUrl({ view: 'session-timeline', session: sessionId });
}
```

- [ ] **Step 2: PromptDetailPage 구현**

`server/frontend/src/components/pages/PromptDetailPage.svelte`:

```svelte
<script lang="ts">
  import { fetchPromptAudit, getPromptAudit } from '../../lib/stores/audit.svelte';
  import PromptAuditView from '../audit/PromptAuditView.svelte';
  import { onMount } from 'svelte';

  let { promptId }: { promptId: string } = $props();

  let loading = $state(true);

  onMount(async () => {
    await fetchPromptAudit(promptId);
    loading = false;
  });

  let audit = $derived(getPromptAudit(promptId));
</script>

<div class="prompt-detail-page">
  <h2>Prompt Audit</h2>
  <p class="prompt-id">{promptId}</p>
  {#if loading}
    <p>Loading...</p>
  {:else if audit}
    <PromptAuditView turn={audit.turn} autoExpand={true} />
  {:else}
    <p>Prompt not found.</p>
  {/if}
</div>
```

- [ ] **Step 3: SessionTimelinePage 구현**

`server/frontend/src/components/pages/SessionTimelinePage.svelte`:

```svelte
<script lang="ts">
  import { fetchSessionTurns, getSessionTurns } from '../../lib/stores/audit.svelte';
  import PromptAuditView from '../audit/PromptAuditView.svelte';
  import { onMount } from 'svelte';

  let { sessionId }: { sessionId: string } = $props();

  let loading = $state(true);

  onMount(async () => {
    await fetchSessionTurns(sessionId);
    loading = false;
  });

  let turns = $derived(getSessionTurns(sessionId));
</script>

<div class="session-timeline-page">
  <h2>Session Timeline</h2>
  <p class="session-id">{sessionId}</p>
  {#if loading}
    <p>Loading...</p>
  {:else if turns.length > 0}
    {#each turns as turn (turn.promptId)}
      <PromptAuditView {turn} autoExpand={false} />
    {/each}
  {:else}
    <p>No turns found.</p>
  {/if}
</div>
```

- [ ] **Step 4: App.svelte에 view 분기 추가**

`App.svelte`의 view 분기에 추가:

```svelte
{:else if currentView === 'prompt-audit'}
  <PromptDetailPage promptId={state.promptId ?? ''} />
{:else if currentView === 'session-timeline'}
  <SessionTimelinePage sessionId={state.sessionId ?? ''} />
```

- [ ] **Step 5: 빌드 확인**

```bash
cd server/frontend && npm run build
```

- [ ] **Step 6: 커밋**

```bash
git add server/frontend/src/lib/stores/navigation.svelte.ts \
       server/frontend/src/components/pages/PromptDetailPage.svelte \
       server/frontend/src/components/pages/SessionTimelinePage.svelte \
       server/frontend/src/App.svelte
git commit -m "feat(frontend): add PromptDetailPage, SessionTimelinePage, and navigation"
```

---

## Task 12: RecentPrompts 뱃지 + Drawer 연결

**Files:**
- Modify: `server/frontend/src/components/RecentPrompts.svelte`

기존 RecentPrompts 행에 subagent/tool 뱃지 추가. 클릭 시 PromptAuditDrawer 열기.

- [ ] **Step 1: RecentPrompts.svelte 수정**

1. `PromptAuditDrawer` import
2. 각 행에 조건부 뱃지 렌더 (해당 prompt에 audit 데이터가 있으면)
3. 행 클릭 시 drawer 열기

참고: RecentPrompts의 현재 데이터는 `QueryEntry` (timestamp + sessionId + query 기반). Audit 데이터는 별도 API에서 옴. 초기 접근: 뱃지는 `turn.new` SSE 이벤트로 수신한 데이터 기반, 또는 행 클릭 시 lazy fetch.

뱃지 간단 구현 (행 우측에):

```svelte
<!-- 기존 행 렌더링 내부에 추가 -->
{#if entry.subagentCount}
  <span class="badge badge-subagent">{entry.subagentCount}</span>
{/if}
{#if entry.toolCount}
  <span class="badge badge-tool">{entry.toolCount}</span>
{/if}
```

Drawer 연결:

```svelte
<script>
  import PromptAuditDrawer from './audit/PromptAuditDrawer.svelte';
  let drawerTurn = $state<PromptTurnSummary | null>(null);
</script>

<PromptAuditDrawer turn={drawerTurn} onclose={() => drawerTurn = null} />
```

Note: `QueryEntry`와 `PromptTurnSummary`의 매칭은 `timestamp + sessionId` 조합으로 수행. 정확한 `promptId` 해석은 서버 API 추가가 필요할 수 있음 — 초기에는 행 클릭 시 `/api/sessions/:sid/turns`를 fetch해서 timestamp 가장 가까운 turn을 찾는 방식.

- [ ] **Step 2: 빌드 확인**

```bash
cd server/frontend && npm run build
```

- [ ] **Step 3: 커밋**

```bash
git add server/frontend/src/components/RecentPrompts.svelte
git commit -m "feat(frontend): add subagent/tool badges to RecentPrompts with drawer"
```

---

## Task 13: SSE turn.new 연결

**Files:**
- Modify: `server/src/modules/audit/index.ts`
- Modify: `server/frontend/src/App.svelte`

- [ ] **Step 1: AuditModule에서 SSE broadcast 연결**

`AuditModule` constructor에 `SSEManager`를 주입하고, ingest 성공 시 `turn.new` broadcast:

```typescript
// POST /api/ingest/turn-summary 핸들러 끝에 추가
this.sseManager?.broadcast('turn.new', {
  ...turn (PromptTurnSummary fields),
  sessionId: payload.sessionId,
  machineId,
});
```

- [ ] **Step 2: App.svelte에서 turn.new SSE 핸들러 추가**

```typescript
.on("turn.new", (data) => {
  // audit store에 추가 (선택적: 현재 보고 있는 세션이면 자동 반영)
  console.log('New turn:', data);
})
```

- [ ] **Step 3: 커밋**

```bash
git add server/src/modules/audit/index.ts server/frontend/src/App.svelte
git commit -m "feat: wire SSE turn.new event from server to frontend"
```

---

## Task 14: 전체 빌드 + 수동 확인

**Files:** None (검증만)

- [ ] **Step 1: Agent 빌드**

```bash
cd agent && npm run build
```

- [ ] **Step 2: Server 빌드**

```bash
cd server && npm run build
```

- [ ] **Step 3: Frontend 빌드**

```bash
cd server/frontend && npm run build
```

- [ ] **Step 4: Server 테스트**

```bash
cd server && npx vitest run
```

- [ ] **Step 5: Agent 테스트**

```bash
cd agent && npx vitest run
```

Expected: 모든 테스트 PASS, 빌드 성공.

- [ ] **Step 6: 커밋 (필요 시 fix)**

빌드 에러가 있으면 수정 후 커밋.

---

## Self-Review Notes

### Spec Coverage Gaps

1. **§ 5.4 초기 스캔 (boot-time backfill)** — 현재 plan에 포함 안 됨. Agent 부팅 시 `GET /api/audit/known-prompts`로 누락분 체크 → 전체 스캔은 **v1.1 follow-up task**로 분리. 기본 파이프라인(hook trigger + file read)이 먼저 안정화되어야 함.

2. **§ 5.1 Fallback watcher** (5분 timeout active session tail) — plan에 미포함. 초기 스캔과 함께 v1.1로.

### Type Consistency Notes

- `EmittedTurn.tools`는 `ExtractedToolUse[]`이고 `TurnSummaryPayload.turn.tools`는 `ToolInvocationEntry[]`. `ExtractedToolUse`에는 `startedAt/endedAt/resultSummary/error`가 없음.
- **해결**: Task 5 TranscriptIngestor에서 tool_use 이벤트의 timestamp를 `startedAt`으로, 매칭되는 tool_result의 timestamp를 `endedAt`으로, tool_result content 첫 120자를 `resultSummary`로 추출해야 함. 구현 시 `EmittedTurn.tools` 타입을 `ToolInvocationEntry[]`로 변경하고 ingestor에서 tool_result 매칭 로직 추가.

### Known Limitations

- RecentPrompts 행의 `QueryEntry` → `PromptTurnSummary` 매칭이 timestamp 기반 휴리스틱. 정확도 100%는 아님. v2에서 `promptId`를 QueryEntry에 추가하는 방안 검토.
