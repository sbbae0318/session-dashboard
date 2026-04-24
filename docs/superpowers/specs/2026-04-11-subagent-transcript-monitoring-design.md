# Subagent / Superpowers Transcript Monitoring — Design Spec

**Date**: 2026-04-11
**Status**: Draft
**Scope**: Claude Code 전체 transcript의 사후 감사(post-hoc audit) 기능

## 1. 목적 및 범위

### 1차 목적
Claude Code 세션에서 발생하는 subagent(Agent tool)와 skill(Skill tool) 사용을 **사후 분석/감사** 할 수 있게 한다. 실시간 모니터링이 아닌, 완료된 세션의 프롬프트 단위 검수가 핵심.

### 캡처 범위
- 전체 Claude Code transcript (user/assistant/tool_use/tool_result)
- Subagent 분리 파일 (`<sid>/subagents/agent-*.jsonl` + `.meta.json`)
- Skill tool 호출 (`Skill` tool_use의 `input.skill`)

### 감사 결합 단위
**Prompt turn** (`sessionId` + `promptId`) — subagent와 tool은 세션이 아닌 **프롬프트에 귀속**된다. 각 프롬프트마다 사용되는 subagent가 다르므로, 특정 프롬프트 검수 시 해당 시점의 subagent transcript를 볼 수 있어야 한다.

## 2. Architecture

```
┌──────────────────────────────┐
│  Claude CLI (user's machine) │
│  ~/.claude/projects/**/*.jsonl│ ← sole source of truth
│  + hooks → /hooks/event       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  agent (:3098)                               │
│  ┌─ claude-heartbeat.ts (hook receiver) ──┐  │
│  │   UserPromptSubmit / Stop / SubagentStop│  │
│  │   → TranscriptIngestor.notifyTurnEnd()  │  │
│  └──────────┬──────────────────────────────┘  │
│             ▼                                 │
│  ┌─ TranscriptIngestor ──────────────────┐    │
│  │  • resolveSessionJsonl(sessionId)     │    │
│  │  • tail from last offset              │    │
│  │  • promptId FSM (state machine)       │    │
│  │  • detect subagent runs (file form)   │    │
│  │  • emit TurnSummary                   │    │
│  └──────────┬────────────────────────────┘    │
│             │                                 │
│  ┌─ TranscriptStore (local cache) ───────┐    │
│  │  last-offset map, promptId seen set   │    │
│  └───────────────────────────────────────┘    │
│             │                                 │
│  ┌─ HTTP endpoints ──────────────────────┐    │
│  │  → POST server/api/ingest/turn-summary│    │
│  │  GET  /claude/transcript/:sid/:pid    │    │
│  │  GET  /claude/transcript/:sid/        │    │
│  │         subagent/:agentKey            │    │
│  └──────────────────────┬────────────────┘    │
└───────────────────────────┼───────────────────┘
                            │ push (light)
                            ▼
┌───────────────────────────────────────────────┐
│  server (:3097)                               │
│  ┌─ IngestRoutes ─────────────────────────┐   │
│  │  POST /api/ingest/turn-summary         │   │
│  │   → UPSERT prompt_turn, tool_invocation│   │
│  │   → UPSERT subagent_run                │   │
│  │   → emit SSE `turn.new`                │   │
│  └────────────────────────────────────────┘   │
│  ┌─ Read API ─────────────────────────────┐   │
│  │  GET /api/sessions/:sid/turns (light)  │   │
│  │  GET /api/prompts/:pid/audit           │   │
│  │  GET /api/prompts/:pid/transcript      │   │
│  │       (proxy → agent)                  │   │
│  │  GET /api/prompts/:pid/subagent/       │   │
│  │       :agentKey/transcript (proxy)     │   │
│  └────────────────────────────────────────┘   │
│  ┌─ SQLite (new tables) ──────────────────┐   │
│  │  audit_session / prompt_turn           │   │
│  │  tool_invocation / subagent_run        │   │
│  └────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
                  │
                  ▼
┌───────────────────────────────────────────────┐
│  frontend (Svelte 5 SPA)                      │
│  PromptAuditView  ← 공용 컴포넌트             │
│  ├─ Drawer (RecentPrompts row click)    (A)   │
│  ├─ Page #/prompts/:pid                 (B)   │
│  └─ Page #/sessions/:sid  (N × View)   (C)   │
└───────────────────────────────────────────────┘
```

### 핵심 원칙
- 원본 JSONL은 **복제하지 않음** (agent 로컬에 남음)
- 서버는 light index(SQLite) + orchestration만
- Body(transcript 상세)는 agent에서 **on-demand pull**
- `promptId`가 idempotent key — 중복 ingest 방지

## 3. Data Model (SQLite)

### 3.1 Gap Analysis 결과 반영

실제 JSONL 파싱으로 확인된 사실:

| 항목 | 실제 | 영향 |
|---|---|---|
| Subagent tool name | `"Agent"` (not `"Task"`) | 모든 참조 교정 |
| `promptId` 분포 | user 라인에만 존재, assistant는 null | 상태 머신으로 상속 |
| Inline sidechain | 현재 CLI에서 관찰 안 됨 | file form만 1차 구현 |
| meta.json 필드 | `{agentType, description, worktreePath?}` | parent_tool_use_id 파생 필요 |
| Parent↔Subagent 링크 | 직접 연결 없음 | description 매칭 (16/16 성공) |

### 3.2 Schema

```sql
CREATE TABLE audit_session (
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
CREATE INDEX idx_audit_session_machine ON audit_session(machine_id);
CREATE INDEX idx_audit_session_last_seen ON audit_session(last_seen_at DESC);

CREATE TABLE prompt_turn (
  prompt_id      TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES audit_session(session_id),
  seq            INTEGER NOT NULL,     -- 세션 내 0-based, started_at 기준 정렬 후 할당
  user_text      TEXT,                -- 첫 120자 raw truncation (마크다운 미처리)
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  tool_count     INTEGER DEFAULT 0,
  subagent_count INTEGER DEFAULT 0,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  model          TEXT,                -- 첫 assistant 응답의 message.model
  status         TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX idx_prompt_turn_session ON prompt_turn(session_id, seq);
CREATE INDEX idx_prompt_turn_started ON prompt_turn(started_at DESC);

CREATE TABLE tool_invocation (
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
CREATE INDEX idx_tool_inv_prompt ON tool_invocation(prompt_id, started_at);
CREATE INDEX idx_tool_inv_name ON tool_invocation(tool_name, started_at DESC);

CREATE TABLE subagent_run (
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
CREATE INDEX idx_subagent_prompt ON subagent_run(prompt_id);
```

### 3.3 Sizing

- 세션당 평균 20 turn, turn당 평균 10 tool / 1 subagent
- 행당 ~200B → 세션당 ~40KB → 1000 세션 × 5 머신 = ~200MB

## 4. API 계약

### 4.1 Agent 엔드포인트 (`:3098`, 신규)

#### POST /internal/turn-summary

Agent가 turn 완결 시 서버에 push. 서버는 UPSERT.

```typescript
interface TurnSummaryPayload {
  sessionId: string;
  slug: string | null;
  gitBranch: string | null;
  cwd: string | null;
  turn: {
    promptId: string;
    seq: number;
    userText: string | null;       // 첫 120자
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
    subagents: {
      agentKey: string;
      agentType: string | null;
      description: string | null;
      parentToolUseId: string | null;
      form: 'file';
      storageRef: string;
      cwd: string | null;
      model: string | null;
      startedAt: number;
      endedAt: number | null;
      messageCount: number;
      inputTokens: number;
      outputTokens: number;
    }[];
  };
}
```

#### GET /claude/transcript/:sessionId/:promptId

On-demand body fetch. 해당 promptId 범위의 JSONL 라인을 파싱해서 반환.

```typescript
interface TranscriptBodyResponse {
  promptId: string;
  sessionId: string;
  events: TranscriptEvent[];
}

interface TranscriptEvent {
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
```

#### GET /claude/transcript/:sessionId/subagent/:agentKey

Subagent JSONL 파일을 동일한 `TranscriptEvent[]` 형식으로 반환.

### 4.2 Server 엔드포인트 (`:3097`, 신규)

#### POST /api/ingest/turn-summary

Agent로부터 `TurnSummaryPayload`를 받아 SQLite에 UPSERT. SSE `turn.new` 이벤트 방출.

#### GET /api/sessions/:sessionId/turns

세션의 모든 prompt turn 목록 (light, 헤더용).

```typescript
interface SessionTurnsResponse {
  sessionId: string;
  slug: string | null;
  gitBranch: string | null;
  turns: PromptTurnSummary[];
}

interface PromptTurnSummary {
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
```

#### GET /api/prompts/:promptId/audit

단일 prompt turn의 full audit.

```typescript
interface PromptAuditResponse {
  turn: PromptTurnSummary;
  tools: ToolInvocationEntry[];
  subagents: SubagentRunEntry[];
}

interface ToolInvocationEntry {
  id: string;
  toolName: string;
  toolSubname: string | null;
  startedAt: number;
  endedAt: number | null;
  inputSummary: string | null;
  resultSummary: string | null;
  error: boolean;
}

interface SubagentRunEntry {
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
  bodyAvailable: boolean;
}
```

#### GET /api/prompts/:promptId/transcript

On-demand proxy → agent `/claude/transcript/:sid/:pid`. 서버가 `prompt_turn.session_id → audit_session.machine_id` DB lookup으로 대상 agent를 결정. Agent 오프라인 시 503 + `{ error: 'agent_offline', machineId }`.

#### GET /api/prompts/:promptId/subagent/:agentKey/transcript

On-demand proxy → agent `/claude/transcript/:sid/subagent/:agentKey`. 동일한 machine 해석 경로.

#### GET /api/audit/known-prompts

초기 스캔에서 agent가 이미 인덱싱된 promptId를 조회하기 위한 엔드포인트.

- Query: `?sessionId=X` (선택적, 세션별 필터)
- Response: `{ promptIds: string[] }`

### 4.3 SSE 이벤트 추가

```typescript
// SSEEventMap 확장
'turn.new': PromptTurnSummary & { sessionId: string; machineId: string };
```

## 5. 수집 파이프라인 (TranscriptIngestor)

### 5.1 트리거 메커니즘

**혼합 방식**: Hook trigger + file read + 초기 스캔 보정.

1. **Hook trigger**: `UserPromptSubmit` / `Stop` / `SubagentStop` 이벤트 → "이 session에서 turn이 변경됐을 가능성"
2. **File read**: hook 수신 시 해당 session JSONL을 tail (마지막 offset 이후)
3. **초기 스캔**: 부팅 시 서버에 인덱싱된 promptId 조회 → 누락분 보정
4. **Fallback watcher**: 5분 이상 hook 없는 active session → 주기적 tail

### 5.2 promptId 상태 머신

JSONL에서 `promptId`는 **user 타입 라인에만 존재**. assistant 라인은 `promptId: null`. 따라서:

```
state: { currentPromptId, currentTurnLines[], offset }

on user line (promptId = X):
  if X !== currentPromptId:
    → flush currentTurn → emit TurnSummary
    → currentPromptId = X, reset
  push line

on assistant line (promptId = null):
  → inherit currentPromptId
  → push line, extract tool_uses from message.content

on EOF / new hook:
  → flush if currentTurn has ended signal
```

### 5.3 Subagent↔Parent 매칭

`meta.json`에 `parentToolUseId`가 없으므로 파생 매칭:

1. **Primary**: `meta.json.description` === Agent tool_use `input.description` (실측 16/16 성공)
2. **Fallback**: `meta.json.agentType` + timestamp ±2s 윈도우
3. **Unresolved**: 매칭 실패 시 `parent_tool_use_id = null`, UI에 "unlinked" 표시

### 5.4 초기 스캔 흐름

```
1. GET /api/audit/known-prompts → 이미 인덱싱된 promptId set
2. ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 전체 파싱
3. knownSet에 없는 promptId → TurnSummary 생성 → POST /internal/turn-summary
4. offset 기록 → 이후 incremental tail
```

## 6. UX 설계

### 6.1 공용 컴포넌트: PromptAuditView

`PromptAuditView`는 **재사용 가능한 Svelte 컴포넌트**로 설계. 세 곳에서 동일하게 사용:

| 용도 | 컨테이너 | Props |
|---|---|---|
| A. Drawer | `PromptAuditDrawer` | `promptId, autoExpand=true` |
| B. Route | `PromptDetailPage` | `promptId, autoExpand=true` |
| C. Session timeline | `SessionTimelinePage` | `promptId, autoExpand=false` |

### 6.2 컴포넌트 2단 분리

```
PromptAuditView
├── PromptAuditHeader (항상 렌더)
│   └ user_text 1줄 + 🤖N 🛠M 뱃지 + tokens + status
└── PromptAuditBody (클릭 시 lazy mount)
    ├ ToolTimeline (시간순 tool_use 목록)
    ├ SubagentTree (subagent 카드 목록)
    └ TranscriptViewer (on-demand, agent pull)
```

**이유**: C에서 30+ turn이 동시 렌더될 때 Body를 lazy mount해야 DOM 폭발 방지.

### 6.3 파일 구조

```
server/frontend/src/
├── components/
│   ├── audit/
│   │   ├── PromptAuditHeader.svelte
│   │   ├── PromptAuditBody.svelte
│   │   ├── PromptAuditView.svelte
│   │   ├── PromptAuditDrawer.svelte
│   │   ├── SubagentTree.svelte
│   │   ├── TranscriptViewer.svelte
│   │   └── ToolTimeline.svelte
│   ├── pages/
│   │   ├── PromptDetailPage.svelte
│   │   └── SessionTimelinePage.svelte
│   └── RecentPrompts.svelte  ← 기존 확장
├── lib/
│   └── stores/
│       └── audit.svelte.ts
```

### 6.4 라우팅

Hash 기반 경량 라우터:
- `#/` → 기존 대시보드
- `#/prompts/:pid` → PromptDetailPage (B)
- `#/sessions/:sid` → SessionTimelinePage (C)

### 6.5 데이터 fetch 전략

| 화면 | 초기 fetch | 상세 fetch |
|---|---|---|
| A (Drawer) | `GET /api/prompts/:pid/audit` | transcript → on-demand |
| B (Route) | `GET /api/prompts/:pid/audit` | transcript → on-demand |
| C (Session) | `GET /api/sessions/:sid/turns` (light) | 펼친 turn만 `/api/prompts/:pid/audit` |

→ C에서 N+1 방지: 초기 로드는 `/turns` 한 번, 펼칠 때만 개별 audit.

### 6.6 상태 격리

C에서 여러 `PromptAuditView`가 동시 존재. 각 인스턴스의 "펼침 상태, 선택된 subagent, tool 필터" 등은 **컴포넌트 로컬 `$state`**에만 두고 전역 store에 올리지 않는다.

### 6.7 네비게이션

- A의 "↗" 버튼 → `#/prompts/:pid` (B)
- B의 "in session" 링크 → `#/sessions/:sid#turn-:pid` (C)
- C의 각 turn "↗" 버튼 → `#/prompts/:pid` (B)

## 7. 에러 처리 & 엣지 케이스

| 시나리오 | 처리 |
|---|---|
| Agent 오프라인 시 transcript 요청 | 서버 503 → UI "머신 오프라인 — 인덱스는 보이지만 본문은 머신이 돌아올 때 조회 가능" |
| Hook 손실 (turn 미감지) | 부팅 시 초기 스캔 + 5분 fallback watcher |
| Description 매칭 실패 | `parent_tool_use_id = null`, UI에 "unlinked subagent" 표시 |
| 중복 ingest | UPSERT on `prompt_id` PK — idempotent |
| JSONL 삭제/rotation | offset > 파일 크기 → offset 리셋 + 전체 재스캔 |
| 세션 진행 중 | `status: 'running'`, 다음 hook에서 업데이트 |

## 8. 테스트 전략

| 레이어 | 테스트 종류 | 핵심 케이스 |
|---|---|---|
| `TranscriptIngestor` | Unit (vitest) | promptId FSM 경계, subagent description 매칭, offset 복구 |
| Agent 엔드포인트 | Unit (vitest) | transcript 응답 스키마, 존재하지 않는 session 404 |
| Server ingest | Unit (vitest) | UPSERT idempotency, denormalized counter 정합성 |
| Server read API | Unit (vitest) | `/sessions/:sid/turns` 정렬, `/prompts/:pid/audit` 조인 |
| Frontend `PromptAuditView` | E2E (Playwright) | 헤더 뱃지 렌더링, 펼침/접힘, transcript lazy load |
| 통합 | E2E (Playwright) | RecentPrompts → drawer → "↗" → 라우트 전환 |

## 9. 미래 확장 (Out of Scope)

- **실시간 subagent 상태**: 현재 turn이 진행 중일 때 subagent working 상태를 SSE로 push (v2)
- **토큰/비용 집계 대시보드**: 모델별·tool별·skill별 일/주/월 집계 (v2)
- **Retention / GC**: `last_seen_at < now - 90d` 기준 cascade 삭제 job (v2)
- **Pin/Export**: 중요 세션의 transcript를 서버에 영구 저장 (agent 꺼져도 보존) (v2)
- **OpenCode 통합**: 동일한 prompt_turn 모델로 OpenCode background session도 감사 (v2)
- **Inline sidechain**: 구 버전 CLI 호환, 관찰 시 추가 (v2)
