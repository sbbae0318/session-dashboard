# Claude Code 모니터링 Feature Parity

## TL;DR

> **Quick Summary**: Claude Code 세션 모니터링을 OpenCode와 동등 수준으로 개선. 구현 가능한 7개 Gap(G3-G7, G9-G10)을 해결하여 lastPrompt 표시, 죽은 세션 즉시 정리, 쿼리 영속화, JSONL 파싱 최적화를 달성.
>
> **Deliverables**:
> - Single-pass JSONL 파싱 (5x 중복 파일 읽기 제거)
> - lastPrompt 텍스트 + 시스템 프롬프트 필터링
> - PID 생존 체크 + Ghost 세션 즉시 정리
> - completedAt 필드 + Claude 쿼리 SQLite 영속화
> - Server-side 매핑 수정 (lastPrompt, lastPromptTime 전달)
>
> **Estimated Effort**: Medium (1-2d)
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: T1 → T2 → T5

---

## Context

### Original Request
OpenCode 모니터링의 핵심 스펙을 기준으로 Claude Code의 달성도를 평가하고, 미달 항목(Gap)을 해소하는 플랜 수립.

### Interview Summary
**Key Discussions**:
- OpenCode 11개 모니터링 기능 전체 분석 완료
- Claude Code 10개 Gap 식별 → 구조적 한계(G1,G2,G8) 제외, 구현 가능한 7개(G3-G7,G9-G10) 스코프 확정
- Plugin Architecture 리팩토링은 별도 플랜으로 분리

**Research Findings**:
- `readHeartbeatFile()` 내에서 동일 JSONL 파일을 5번 전체 읽기 중 (성능 병목)
- `machine-manager.ts`에서 Claude lastPrompt가 하드코딩 null, lastPromptTime에 startTime 대입 (버그)
- `ClaudeQueryEntry`와 `QueryEntry` 타입 불일치 → PromptStore 통합 시 어댑터 필요
- 시스템 프롬프트 필터링이 `prompt-extractor.ts`에 이미 존재 → 재사용 가능

### Metis Review
**Identified Gaps** (addressed):
- G10을 "tail-read"에서 "single-pass extraction"으로 재정의 — 5x 중복 읽기 제거가 핵심
- TTL 단축은 PID 체크 없이 위험 → 이중 조건 (PID dead + TTL 초과) 적용
- `ClaudeSessionInfo`에 `lastPrompt` 필드 추가 필요
- `QueryEntry.source` 타입 확장으로 PromptStore 타입 안전성 확보
- Title은 head-read 필요 → 첫 생성 시 캐싱 (불변 데이터)

---

## Work Objectives

### Core Objective
Claude Code 세션 모니터링을 OpenCode와 동등 수준으로 개선하여, 대시보드에서 lastPrompt 텍스트 표시, 죽은 세션 즉시 정리, 쿼리 영속화를 달성한다.

### Concrete Deliverables
- `agent/src/claude-heartbeat.ts` — single-pass 파싱 + lastPrompt + PID 체크 + TTL 조정
- `agent/src/claude-source.ts` — completedAt 추가 + 시스템 프롬프트 필터링
- `agent/src/server.ts` — Claude 쿼리 PromptStore 통합
- `server/src/machines/machine-manager.ts` — Claude 세션 매핑 수정
- `agent/src/types.ts` — ClaudeSessionInfo.lastPrompt 필드 추가
- 테스트: 기존 전체 통과 + 각 Gap별 최소 3개 테스트

### Definition of Done
- [x] `cd agent && npm run build` — 빌드 성공
- [x] `cd agent && bun test` — 0 failures
- [x] Claude 세션에 lastPrompt 텍스트가 표시됨 (curl 검증)
- [x] 죽은 Claude 프로세스 세션이 4시간 내 자동 정리됨
- [x] Agent 재시작 후에도 Claude 쿼리가 /api/queries에서 조회됨

### Must Have
- Single-pass JSONL 파싱 (5x → 1x 파일 읽기)
- lastPrompt 텍스트 추출 + 시스템 프롬프트 필터링
- PID 생존 체크 (process.kill(pid, 0))
- Ghost 세션 조건부 정리 (PID dead + TTL 초과)
- completedAt for Claude queries
- Claude 쿼리 PromptStore 통합
- Server-side 매핑 수정 (lastPrompt, lastPromptTime)

### Must NOT Have (Guardrails)
- ❌ `session-cache.ts`의 `isSystemPrompt()` 수정 (OpenCode 경로 = scope OUT)
- ❌ `OcQueryCollector` 내부 로직 변경
- ❌ 프론트엔드 코드 변경
- ❌ 새로운 API 엔드포인트 추가
- ❌ Plugin Architecture 리팩토링
- ❌ `ClaudeHeartbeat` 클래스 구조 자체 변경 (메서드 내부만 수정)
- ❌ `as any`, `@ts-ignore` 사용
- ❌ PID 체크 없이 TTL만 단독 줄이기
- ❌ 기존 테스트 삭제 또는 비활성화

### Known Limitations (Scope OUT — 구조적 한계)
- G1 waitingForInput: Claude Code에 실시간 이벤트 스트림 없음
- G2 currentTool: JSONL은 사후 기록이므로 "현재 실행 중" 감지 불가
- G8 retry: Claude Code에 해당 개념 없음
- EC4 PID 재할당: OS가 같은 PID를 재사용하면 false positive 가능 (발생 빈도 극히 낮음)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after, 각 태스크에 테스트 포함)
- **Framework**: bun test (agent), vitest (server)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Agent module**: Use Bash (`bun test`) — Run tests, assert pass count
- **API endpoint**: Use Bash (`curl`) — Send requests, assert response fields
- **Build**: Use Bash (`npm run build`) — Assert clean build

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — MAX PARALLEL):
├── T1: Single-pass JSONL extraction (G10) [deep]
└── T3: PID liveness + Ghost cleanup (G4+G5) [unspecified-high]

Wave 2 (Data enrichment — after T1, T3 parallel):
├── T2: lastPrompt + system prompt filtering (G3+G9) [unspecified-high]  ← depends T1
└── T4: completedAt + Query SQLite integration (G6+G7) [unspecified-high] ← depends T1

Wave 3 (Server integration — after T2):
└── T5: Server-side mapping fix [quick]  ← depends T2

Wave FINAL (Verification — after ALL tasks):
├── F1: Plan compliance audit [oracle]
├── F2: Code quality review [unspecified-high]
├── F3: Integration QA [unspecified-high]
└── F4: Scope fidelity check [deep]

Critical Path: T1 → T2 → T5
Parallel Speedup: T1 ∥ T3, T2 ∥ T4
Max Concurrent: 2 (Waves 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2, T4 | 1 |
| T3 | — | — | 1 |
| T2 | T1 | T5 | 2 |
| T4 | T1 | — | 2 |
| T5 | T2 | — | 3 |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `deep`, T3 → `unspecified-high`
- **Wave 2**: 2 tasks — T2 → `unspecified-high`, T4 → `unspecified-high`
- **Wave 3**: 1 task — T5 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

- [x] 1. **Single-pass JSONL Extraction (G10)**

  **What to do:**
  - Create `parseConversationFile(filePath): Promise<ConversationData | null>` in `claude-heartbeat.ts`
  - Return type: `{ status: 'busy'|'idle', title: string|null, lastPrompt: string|null, lastPromptTime: number|null, lastResponseTime: number|null }`
  - 1x readFile() call extracts ALL fields:
    - Forward scan: first user message → `title` (100 chars)
    - Reverse scan: last user/assistant entry → `status`, `lastPromptTime`, `lastResponseTime`
    - Last user message content → `lastPrompt` (200 chars, raw — T2 adds filtering)
  - Refactor `readHeartbeatFile()`: remove individual calls to `detectSessionStatus()`, `extractTitleFromFile()`, `extractLastPromptTimeFromFile()`, `extractLastResponseTimeFromFile()` → single `parseConversationFile()` call
  - Refactor `scanProjectsForActiveSessions()`: same — replace `detectStatusFromFile()`, `extractTitleFromFile()`, `extractLastPromptTimeFromFile()`, `extractLastResponseTimeFromFile()` → `parseConversationFile()`
  - Incomplete JSON defense: try/catch each line's JSON.parse (preserve existing pattern)
  - Empty file defense: return defaults (status=busy, everything else null)
  - Constants: `MAX_TITLE_LENGTH = 100`, `MAX_PROMPT_LENGTH = 200`
  - Tests: happy path, empty file, incomplete last line, user-only, assistant-only, tool_use assistant

  **Must NOT do:** Change ClaudeHeartbeat class public API, keep individual readFile() calls per extract function, delete existing tests

  **Agent Profile:** Category `deep` (5-function consolidation, behavior preservation required), Skills []
  **Parallelization:** Wave 1 (parallel with T3), Blocks T2+T4, Blocked by none

  **References:**
  - `agent/src/claude-heartbeat.ts:129-183` — current `readHeartbeatFile()` (5x readFile calls)
  - `agent/src/claude-heartbeat.ts:238-298` — `scanProjectsForActiveSessions()` (duplicate pattern)
  - `agent/src/claude-heartbeat.ts:190-232` — `detectSessionStatus()` (reverse parsing logic to preserve)
  - `agent/src/claude-heartbeat.ts:11-24` — `ClaudeSessionInfo` interface
  - `agent/src/__tests__/claude-heartbeat.test.ts` — existing test patterns (temp dir + JSONL writing)

  **Acceptance:**
  - `parseConversationFile()` function exists
  - readFile() called max 1x per file in `readHeartbeatFile()` and `scanProjectsForActiveSessions()`
  - `bun test agent/src/__tests__/claude-heartbeat.test.ts` → all existing tests PASS
  - 6+ new tests added

  **QA:**
  ```
  Scenario: Single-pass extracts all fields correctly (happy path)
    Tool: Bash (bun test)
    Steps: bun test agent/src/__tests__/claude-heartbeat.test.ts --reporter verbose
    Expected: status=idle, title=first user msg, lastPrompt=last user msg, all timestamps correct
    Evidence: .sisyphus/evidence/task-1-single-pass-happy.txt

  Scenario: Empty JSONL file
    Tool: Bash (bun test)
    Expected: status=busy (default), title=null, lastPrompt=null
    Evidence: .sisyphus/evidence/task-1-empty-file.txt

  Scenario: Incomplete last line (file being written)
    Tool: Bash (bun test)
    Expected: Incomplete line ignored, previous complete line determines status
    Evidence: .sisyphus/evidence/task-1-incomplete-json.txt
  ```

  **Commit:** `refactor(agent): single-pass JSONL extraction for Claude sessions` — claude-heartbeat.ts, tests

- [x] 2. **lastPrompt + System Prompt Filtering (G3+G9)**

  **What to do:**
  - Add `lastPrompt: string | null` field to `ClaudeSessionInfo` interface
  - Apply `extractUserPrompt()` from `prompt-extractor.ts` to the raw lastPrompt from `parseConversationFile()`
  - If `extractUserPrompt()` returns null → lastPrompt = null (system-prompt-only case)
  - Truncate to 200 chars
  - Wire in `readHeartbeatFile()` and `scanProjectsForActiveSessions()`
  - Also apply `extractUserPrompt()` in `ClaudeSource.getRecentQueries()` for query filtering
  - Keep `ClaudeSource.isRealQuery()` existing filtering + add `extractUserPrompt()` on top
  - Tests: normal prompt, system prompt filtering, empty prompt, 200+ char truncation

  **Must NOT do:** Modify `session-cache.ts` `isSystemPrompt()`, modify `prompt-extractor.ts` itself

  **Agent Profile:** Category `unspecified-high`, Skills []
  **Parallelization:** Wave 2 (parallel with T4), Blocks T5, Blocked by T1

  **References:**
  - `agent/src/session-cache.ts:67` — `PROMPT_MAX_LENGTH = 200`
  - `agent/src/session-cache.ts:69-88` — OpenCode system prompt filtering pattern
  - `agent/src/claude-heartbeat.ts:11-24` — ClaudeSessionInfo (add lastPrompt field here)
  - `agent/src/prompt-extractor.ts` — `extractUserPrompt(text): string | null`
  - `agent/src/claude-source.ts:16-23` — ClaudeQueryEntry interface

  **Acceptance:**
  - `ClaudeSessionInfo` has `lastPrompt: string | null`
  - `/api/claude/sessions` response includes non-null lastPrompt for real prompts
  - System prompts filtered out → lastPrompt = null
  - 200+ char prompts truncated
  - `bun test` all PASS

  **QA:**
  ```
  Scenario: lastPrompt shows real user text
    Tool: Bash (bun test)
    Expected: lastPrompt = user-typed text, not system prompt
    Evidence: .sisyphus/evidence/task-2-lastprompt.txt

  Scenario: System-prompt-only session → lastPrompt = null
    Tool: Bash (bun test)
    Expected: lastPrompt = null when last user entry starts with [SYSTEM DIRECTIVE:
    Evidence: .sisyphus/evidence/task-2-system-prompt-filter.txt
  ```

  **Commit:** `feat(agent): add lastPrompt extraction + system prompt filtering for Claude sessions` — claude-heartbeat.ts, claude-source.ts, tests

- [x] 3. **PID Liveness + Ghost Session Cleanup (G4+G5)**

  **What to do:**
  - Add `isProcessAlive(pid: number): boolean` utility to `claude-heartbeat.ts`:
    - `pid <= 0` → return false
    - `process.kill(pid, 0)` in try/catch
    - EPERM (different user) → return true (process exists)
    - ESRCH (no such process) → return false
  - Modify `evictStale()`:
    - If PID alive (via `isProcessAlive()`) → SKIP eviction regardless of TTL
    - If PID dead (or pid===0 project-scan session) + `lastHeartbeat > STALE_TTL_MS` → evict
  - Change `STALE_TTL_MS` from 7 days to 4 hours: `const STALE_TTL_MS = 4 * 60 * 60 * 1000`
  - Also consider `lastFileModified` as activity signal: if JSONL was modified recently, don't evict even if heartbeat is old
  - Eviction condition: `!isProcessAlive(pid) && (now - Math.max(lastHeartbeat, lastFileModified) > STALE_TTL_MS)`
  - Tests: PID alive → no evict, PID dead + TTL expired → evict, PID dead + TTL not expired → keep, pid=0 → skip PID check + apply TTL, EPERM handling

  **Must NOT do:** Delete sessions immediately on PID dead (only change to idle or let TTL handle), modify OpenCode session-cache.ts

  **Agent Profile:** Category `unspecified-high`, Skills []
  **Parallelization:** Wave 1 (parallel with T1), Blocks none, Blocked by none

  **References:**
  - `agent/src/claude-heartbeat.ts:487-494` — current `evictStale()` (simple TTL only)
  - `agent/src/claude-heartbeat.ts:30-31` — `STALE_TTL_MS` and `EVICTION_INTERVAL_MS` constants
  - `agent/src/claude-heartbeat.ts:289-293` — pid===0 handling in project scan
  - `agent/src/__tests__/claude-heartbeat.test.ts` — existing eviction test patterns

  **Acceptance:**
  - `isProcessAlive()` exists and handles pid<=0, EPERM, ESRCH
  - `STALE_TTL_MS` = 4 hours
  - PID alive sessions are never evicted regardless of TTL
  - PID dead + TTL expired → session evicted
  - `bun test` all PASS, 4+ new tests

  **QA:**
  ```
  Scenario: PID alive → session survives past TTL
    Tool: Bash (bun test)
    Preconditions: Session with real alive PID + lastHeartbeat > 4h ago
    Expected: Session NOT evicted
    Evidence: .sisyphus/evidence/task-3-pid-alive.txt

  Scenario: PID dead + 4h elapsed → session evicted
    Tool: Bash (bun test)
    Preconditions: Session with dead PID + lastHeartbeat > 4h ago
    Expected: Session evicted from map
    Evidence: .sisyphus/evidence/task-3-pid-dead-evict.txt

  Scenario: PID dead + 1h elapsed → session kept
    Tool: Bash (bun test)
    Preconditions: Session with dead PID + lastHeartbeat 1h ago
    Expected: Session NOT evicted (TTL not reached)
    Evidence: .sisyphus/evidence/task-3-pid-dead-keep.txt
  ```

  **Commit:** `feat(agent): add PID liveness check + ghost session cleanup for Claude sessions` — claude-heartbeat.ts, tests

- [x] 4. **completedAt + Query SQLite Integration (G6+G7)**

  **What to do:**
  - Add `completedAt: number | null` to `ClaudeQueryEntry` interface in `claude-source.ts`
  - In `ClaudeSource.getRecentQueries()`: for each query entry, find the subsequent assistant entry's timestamp → set as `completedAt`
  - Extend `QueryEntry.source` type (in `oc-query-collector.ts` or types) from `'opencode'` to `'opencode' | 'claude-code'`
  - In `server.ts`, add Claude query collection to the background collection loop (alongside OpenCode):
    - If `claudeEnabled && claudeSource`: call `claudeSource.getRecentQueries()`, convert to unified QueryEntry format, upsert into PromptStore
    - Run on same 30s interval as OpenCode collection
  - `PromptStore.upsertMany()` should accept both sources — verify `source` column exists in schema (it does: `prompt-store.ts`)
  - Tests: completedAt extraction, Claude queries in PromptStore, /api/queries returns claude-code entries

  **Must NOT do:** Modify `OcQueryCollector` internal logic, change PromptStore schema (source column already exists)

  **Agent Profile:** Category `unspecified-high`, Skills []
  **Parallelization:** Wave 2 (parallel with T2), Blocks none, Blocked by T1

  **References:**
  - `agent/src/claude-source.ts:16-23` — `ClaudeQueryEntry` interface (add completedAt)
  - `agent/src/oc-query-collector.ts:35-43` — `QueryEntry` interface (extend source type)
  - `agent/src/prompt-store.ts` — PromptStore schema with `source` column
  - `agent/src/server.ts:120-139` — background collection loop (add Claude collection here)
  - `agent/src/server.ts:189-212` — `/api/queries` endpoint (already falls back, verify unified)

  **Acceptance:**
  - `ClaudeQueryEntry` has `completedAt: number | null`
  - `QueryEntry.source` accepts `'opencode' | 'claude-code'`
  - `/api/queries` returns entries with `source: "claude-code"`
  - After agent restart, Claude queries persist in SQLite
  - `bun test` all PASS

  **QA:**
  ```
  Scenario: /api/queries returns claude-code entries
    Tool: Bash (curl)
    Steps:
      1. curl -s -H "Authorization: Bearer $KEY" http://localhost:3098/api/queries?limit=10
      2. jq '.queries[] | select(.source == "claude-code") | {sessionId, source, completedAt}'
    Expected: At least 1 entry with source="claude-code" and non-null completedAt
    Evidence: .sisyphus/evidence/task-4-claude-queries.txt

  Scenario: Claude queries with completedAt
    Tool: Bash (bun test)
    Expected: completedAt = timestamp of last assistant entry after the user query
    Evidence: .sisyphus/evidence/task-4-completed-at.txt
  ```

  **Commit:** `feat(agent): add completedAt + integrate Claude queries into PromptStore` — claude-source.ts, server.ts, oc-query-collector.ts (type only), tests

- [x] 5. **Server-side Mapping Fix**

  **What to do:**
  - In `server/src/machines/machine-manager.ts` `pollSessionDetails()` method (around line 390-420):
    - Change `lastPrompt: null` → `lastPrompt: (session.lastPrompt as string) ?? null`
    - Change `lastPromptTime: (session.startTime as number) ?? Date.now()` → `lastPromptTime: (session.lastPromptTime as number) ?? null`
  - This ensures Claude session data flows correctly to the dashboard frontend
  - No frontend changes needed — the existing `DashboardSession.lastPrompt` field will now be populated

  **Must NOT do:** Add new endpoints, change API response shape, modify frontend code, change OpenCode mapping

  **Agent Profile:** Category `quick`, Skills []
  **Parallelization:** Wave 3 (sequential), Blocks none, Blocked by T2

  **References:**
  - `server/src/machines/machine-manager.ts:390-420` — Claude session synthesis in `pollSessionDetails()`
  - `server/src/machines/machine-manager.ts:154-180` — `buildSessionMap()` Claude session mapping in active-sessions module
  - `server/src/modules/active-sessions/index.ts:162-180` — `buildSessionMap()` where Claude fields are mapped

  **Acceptance:**
  - `machine-manager.ts` maps `lastPrompt` from actual session data (not null)
  - `machine-manager.ts` maps `lastPromptTime` from actual prompt time (not startTime)
  - Server builds: `cd server && npm run build` succeeds
  - No frontend changes

  **QA:**
  ```
  Scenario: Dashboard shows Claude session lastPrompt
    Tool: Bash (curl to server)
    Steps:
      1. curl -s http://localhost:3097/api/sessions | jq '.sessions[] | select(.source=="claude-code") | {sessionId, lastPrompt, lastPromptTime}'
    Expected: lastPrompt is non-null user text, lastPromptTime is actual prompt timestamp (not session start)
    Evidence: .sisyphus/evidence/task-5-server-mapping.txt
  ```

  **Commit:** `fix(server): pass Claude lastPrompt and lastPromptTime in machine-manager mapping` — machine-manager.ts

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `cd agent && npm run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Integration QA** — `unspecified-high`
  Start agent, curl all Claude endpoints, verify lastPrompt is populated, verify Claude queries appear in /api/queries, verify PID check works for dead processes. Save evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **T1**: `refactor(agent): single-pass JSONL extraction for Claude sessions` — claude-heartbeat.ts
- **T2**: `feat(agent): add lastPrompt extraction + system prompt filtering for Claude sessions` — claude-heartbeat.ts, claude-source.ts
- **T3**: `feat(agent): add PID liveness check + ghost session cleanup for Claude sessions` — claude-heartbeat.ts
- **T4**: `feat(agent): add completedAt + integrate Claude queries into PromptStore` — claude-source.ts, server.ts, types
- **T5**: `fix(server): pass Claude lastPrompt and lastPromptTime in machine-manager mapping` — machine-manager.ts

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm run build          # Expected: clean build, 0 errors
cd agent && bun test               # Expected: all tests pass, 0 failures
curl -s -H "Authorization: Bearer $KEY" http://localhost:3098/api/claude/sessions | jq '.sessions[0].lastPrompt'
                                    # Expected: non-null string (user prompt text)
curl -s -H "Authorization: Bearer $KEY" http://localhost:3098/api/queries?limit=5 | jq '.queries[] | select(.source=="claude-code")'
                                    # Expected: claude-code entries with completedAt
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass (agent + server)
- [x] No `as any` or `@ts-ignore`
- [x] Claude lastPrompt visible on dashboard
- [x] Dead process sessions cleaned up within 4 hours
- [x] Claude queries persisted in SQLite across agent restarts
