# Session Dashboard UI Bugfix — Title 노출 + Waiting 뱃지

## TL;DR

> **Quick Summary**: 세션 ID가 이름 대신 노출되는 문제와 Waiting 뱃지가 비정상 표시되는 문제를 수정
> 
> **Deliverables**:
> - Orphan 세션의 title을 previousSessionMap에서 복원하여 ID 대신 이름 표시
> - `handleSessionIdle`에서 `waitingForInput` 리셋하여 idle 상태에서 Waiting 뱃지 제거
> - `.status-waiting` CSS 스타일 추가하여 Waiting 뱃지 정상 렌더링
> 
> **Estimated Effort**: Quick (각 fix가 코드 1-3줄 + 테스트 추가)
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 (agent) + Task 2 (server) 병렬 → Task 3 (CSS) → Final

---

## Context

### Original Request
대시보드 UI에서 간혹 세션 ID가 이름 대신 노출되는 문제 + Waiting 뱃지가 Human 입력 대기 상태가 아닌데도 표시되는 문제 분석 및 수정

### Interview Summary
**Key Discussions**:
- 코드 분석 결과 3개의 독립적인 버그 확인
- Bug 1: Server의 orphan 세션 합성 시 title이 항상 null (이전 cycle 데이터로 복원 가능)
- Bug 2-A: Agent의 handleSessionIdle에서 waitingForInput 리셋 누락
- Bug 2-B: Svelte 컴포넌트에 .status-waiting CSS 규칙 미정의

**Research Findings**:
- `previousSessionMap`에 DashboardSession 전체 (title 포함) 저장됨 → orphan title 복원 가능
- TUI는 waiting 상태에 magenta 색상 사용 → 웹 UI도 magenta 계열로 일관성 유지
- 기존 테스트 패턴 (session-cache.test.ts test 21-24, active-sessions.test.ts test Q-S) 활용 가능

### Metis Review
**Identified Gaps** (addressed):
- First-time orphan (REST에 한 번도 안 나온 세션)은 previousSessionMap으로도 title 복원 불가 → known limitation으로 문서화
- `.status-waiting` 색상은 인라인 hex로 충분 (app.css 변수 추가 불필요)
- SSE 이벤트 순서 보장 안 됨 (idle→pending race) → handleSessionIdle 리셋이 여전히 올바른 접근

---

## Work Objectives

### Core Objective
세션 대시보드의 3개 UI 버그를 정확히 수정하고, 각각에 대한 단위 테스트를 추가하여 regression 방지

### Concrete Deliverables
- `server/src/modules/active-sessions/index.ts` — orphan title 복원 로직
- `agent/src/session-cache.ts` — handleSessionIdle에 waitingForInput 리셋
- `server/frontend/src/components/ActiveSessions.svelte` — .status-waiting CSS

### Definition of Done
- [x] `cd agent && npm run test` → ALL PASS
- [x] `cd server && npm run test` → ALL PASS
- [x] `cd server && npm run typecheck` → exit 0
- [x] `cd agent && npm run build` → exit 0

### Must Have
- Orphan 세션이 이전 poll cycle에서 title을 가졌으면 해당 title 보존
- `session.idle` 이벤트 후 `waitingForInput === false`
- `.status-waiting` CSS가 magenta/purple 계열로 렌더링
- 각 버그에 대한 단위 테스트

### Must NOT Have (Guardrails)
- `CachedSessionDetail` 인터페이스에 title 필드 추가 금지
- oc-serve API call 추가 금지 (orphan title fetch 등)
- `handleSessionStatus`, `handleMessagePartUpdated` 등 다른 핸들러 수정 금지
- `getDisplayStatus()` 함수 로직 변경 금지
- `CommandPalette.svelte` 또는 다른 컴포넌트 CSS 수정 금지
- `app.css` 테마 변수 추가 금지 (인라인 hex로 충분)
- Line 100 필터 로직 (`s.apiStatus !== null`) 변경 금지
- E2E/Playwright 테스트 추가 불필요

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after — 각 fix 후 테스트 추가)
- **Framework**: Vitest (agent/, server/)
- **빌드 검증**: `npm run build` (agent), `npm run typecheck` (server)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Backend/Agent**: Use Bash — Run tests, assert pass counts
- **Frontend CSS**: Use Bash — grep for CSS rule existence + typecheck

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — independent fixes):
├── Task 1: Bug 2-A — waitingForInput 리셋 (agent) [quick]
├── Task 2: Bug 1 — orphan title 보존 (server) [quick]
└── Task 3: Bug 2-B — .status-waiting CSS (server frontend) [quick]

Wave FINAL (After ALL tasks — verification):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 + Task 2 + Task 3 (parallel) → Final (parallel)
Parallel Speedup: ~66% (3 tasks → 1 wave)
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | Final |
| 2 | — | Final |
| 3 | — | Final |
| F1-F4 | 1, 2, 3 | — |

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `quick`, T2 → `quick`, T3 → `quick`
- **Wave FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs


- [x] 1. Bug 2-A: `handleSessionIdle`에서 `waitingForInput` 리셋 추가

  **What to do**:
  - `agent/src/session-cache.ts`의 `handleSessionIdle` 메서드 (lines 341-356)에서 `waitingForInput: false` 추가
  - 기존 코드:
    ```typescript
    this.store.upsert(sessionID, {
      ...existing,
      status: 'idle',
      currentTool: null,
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
    });
    ```
  - 수정 후:
    ```typescript
    this.store.upsert(sessionID, {
      ...existing,
      status: 'idle',
      currentTool: null,
      waitingForInput: false,  // idle = turn 완료 → 대기 상태 해제
      directory: directory ?? existing.directory,
      updatedAt: Date.now(),
    });
    ```
  - `agent/src/__tests__/session-cache.test.ts`에 테스트 2개 추가:
    - Test: `pending tool → session.idle → waitingForInput === false`
    - Test: `permission.updated → session.idle → waitingForInput === false`
  - 기존 Test 21-24 패턴 (line 659-799) 따라 `simulateSseEvent()` + `flushPromises()` 사용

  **Must NOT do**:
  - `handleSessionStatus`, `handleMessagePartUpdated`, `handlePermissionUpdated` 등 다른 핸들러 수정 금지
  - `SessionDetail` 인터페이스 변경 금지
  - `defaultSessionDetail` 함수 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 코드 1줄 추가 + 테스트 2개 추가의 단순한 fix
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `cleanup-after-test`: 테스트 파일 정리는 이 작업과 무관

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Final Verification Wave
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `agent/src/session-cache.ts:341-356` — handleSessionIdle 메서드 전체 (수정 대상)
  - `agent/src/session-cache.ts:324-339` — handleSessionStatus에서 `waitingForInput: statusType === 'busy' ? false : existing.waitingForInput` 패턴 참고 (busy일 때만 리셋하는 기존 패턴)
  - `agent/src/session-cache.ts:380-404` — handleMessagePartUpdated에서 tool state별 waitingForInput 설정 패턴 참고

  **Test References** (testing patterns to follow):
  - `agent/src/__tests__/session-cache.test.ts:659-683` — Test 21: pending tool → waitingForInput=true 패턴 (SSE 이벤트 시뮬레이션 방법)
  - `agent/src/__tests__/session-cache.test.ts:689-729` — Test 22: pending→running 전환 시 waitingForInput 리셋 패턴
  - `agent/src/__tests__/session-cache.test.ts:735-767` — Test 23: session.status busy가 waitingForInput 리셋하는 패턴
  - `agent/src/__tests__/session-cache.test.ts:772-799` — Test 24: permission.updated → waitingForInput=true 패턴

  **WHY Each Reference Matters**:
  - handleSessionIdle (341-356): 이 메서드에 `waitingForInput: false` 한 줄을 추가해야 함
  - handleSessionStatus (324-339): 다른 핸들러가 waitingForInput을 다루는 기존 패턴 확인용
  - Test 21-24: 새 테스트의 구조, mock 방법, assertion 패턴을 그대로 복제해야 함

  **Acceptance Criteria**:

  - [x] `agent/src/session-cache.ts`의 `handleSessionIdle`에 `waitingForInput: false` 추가됨
  - [x] `cd agent && npm run test` → ALL PASS (기존 + 새 테스트 포함)
  - [x] `cd agent && npm run build` → exit 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: pending tool → session.idle → waitingForInput resets to false
    Tool: Bash
    Preconditions: agent 테스트 환경 (npm install 완료)
    Steps:
      1. cd agent && npm run test -- --grep "idle.*waitingForInput\|waitingForInput.*idle"
      2. 새로 추가된 테스트가 포함되어 PASS 확인
      3. 전체 테스트: cd agent && npm run test
    Expected Result: ALL tests PASS, 0 failures
    Failure Indicators: 테스트 실패 또는 새 테스트가 grep에 매칭되지 않음
    Evidence: .sisyphus/evidence/task-1-idle-reset-tests.txt

  Scenario: 기존 테스트 regression 없음
    Tool: Bash
    Preconditions: Task 1 코드 변경 완료
    Steps:
      1. cd agent && npm run test 2>&1 | tee .sisyphus/evidence/task-1-full-test-run.txt
      2. 출력에서 "Tests" 라인의 pass/fail 카운트 확인
    Expected Result: 0 failures, 기존 테스트 수 이상 pass
    Failure Indicators: 1개 이상 failure
    Evidence: .sisyphus/evidence/task-1-full-test-run.txt
  ```

  **Commit**: YES
  - Message: `fix(agent): reset waitingForInput on session.idle event`
  - Files: `agent/src/session-cache.ts`, `agent/src/__tests__/session-cache.test.ts`
  - Pre-commit: `cd agent && npm run test`

---

- [x] 2. Bug 1: Orphan 세션 title을 previousSessionMap에서 복원

  **What to do**:
  - `server/src/modules/active-sessions/index.ts`의 orphan 세션 합성 로직 (lines 194-214)에서 `title: null`을 `title: this.previousSessionMap.get(id)?.title ?? null`로 변경
  - 기존 코드 (line 198):
    ```typescript
    title: null,
    ```
  - 수정 후:
    ```typescript
    title: this.previousSessionMap.get(id)?.title ?? null,
    ```
  - `server/src/__tests__/active-sessions.test.ts`에 테스트 2개 추가:
    - Test: orphan 세션이 previousSessionMap에 title이 있으면 해당 title 복원
    - Test: first-time orphan (이전 cycle에 없던 세션)은 title=null 유지 (known limitation)
  - 기존 Test S (line 882) 패턴 따라 mock 구성 — `pollAllSessions`에 빈 sessions + `pollSessionDetails`에 orphan 데이터

  **Must NOT do**:
  - Line 100 필터 로직 (`s.apiStatus !== null`) 변경 금지
  - Orphan synthesis 로직 전체 리팩토링 금지
  - `CachedSessionDetail` 인터페이스에 title 필드 추가 금지
  - oc-serve API call 추가 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 코드 1줄 변경 + 테스트 2개 추가의 단순한 fix
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Final Verification Wave
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `server/src/modules/active-sessions/index.ts:194-214` — orphan 세션 합성 루프 전체 (수정 대상, line 198의 `title: null`을 변경)
  - `server/src/modules/active-sessions/index.ts:38` — `previousSessionMap: Map<string, DashboardSession>` 선언 (title 포함 확인)
  - `server/src/modules/active-sessions/index.ts:118` — `this.previousSessionMap = sessionMap` 할당 (매 poll cycle마다 갱신)
  - `server/src/modules/active-sessions/index.ts:154-180` — 정상 세션 구성 패턴 (title이 `(s.title as string) ?? null`로 설정되는 기존 로직)

  **Test References** (testing patterns to follow):
  - `server/src/__tests__/active-sessions.test.ts:882-913` — Test S: orphan 세션 waitingForInput 전달 테스트 (동일한 mock 구조 사용)
  - `server/src/__tests__/active-sessions.test.ts:785-830` — Test Q: cachedDetails에서 필드 전달 패턴 (mock 설정 방법)

  **WHY Each Reference Matters**:
  - orphan loop (194-214): `title: null` 하드코딩을 `previousSessionMap` lookup으로 교체해야 함
  - previousSessionMap (38, 118): 이전 cycle의 세션 데이터가 title 포함하여 저장됨을 확인
  - Test S: orphan 세션 테스트 mock 구조를 그대로 재사용하되, title 검증만 추가

  **Acceptance Criteria**:

  - [x] `server/src/modules/active-sessions/index.ts` orphan 루프에서 `previousSessionMap.get(id)?.title ?? null` 사용
  - [x] `cd server && npm run test` → ALL PASS (기존 + 새 테스트 포함)
  - [x] `cd server && npm run typecheck` → exit 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: orphan 세션이 previousSessionMap에서 title 복원
    Tool: Bash
    Preconditions: server 테스트 환경 (npm install 완료)
    Steps:
      1. cd server && npm run test -- --grep "orphan.*title\|title.*orphan" 2>&1 | tee .sisyphus/evidence/task-2-orphan-title-tests.txt
      2. 새로 추가된 orphan title 복원 테스트가 PASS 확인
      3. 전체 테스트: cd server && npm run test 2>&1 | tee .sisyphus/evidence/task-2-full-test-run.txt
    Expected Result: ALL tests PASS, 0 failures
    Failure Indicators: orphan title 테스트 실패 또는 기존 테스트 regression
    Evidence: .sisyphus/evidence/task-2-orphan-title-tests.txt, .sisyphus/evidence/task-2-full-test-run.txt

  Scenario: first-time orphan은 title=null 유지 (known limitation)
    Tool: Bash
    Preconditions: Task 2 코드 변경 완료
    Steps:
      1. cd server && npm run test -- --grep "first.time\|first-time" 2>&1
      2. first-time orphan 테스트가 title=null을 확인
    Expected Result: first-time orphan 테스트 PASS, title === null
    Failure Indicators: title이 null이 아닌 값으로 설정됨
    Evidence: .sisyphus/evidence/task-2-first-time-orphan.txt
  ```

  **Commit**: YES
  - Message: `fix(server): preserve orphan session title from previous poll cycle`
  - Files: `server/src/modules/active-sessions/index.ts`, `server/src/__tests__/active-sessions.test.ts`
  - Pre-commit: `cd server && npm run test`

---

- [x] 3. Bug 2-B: `.status-waiting` CSS 스타일 추가

  **What to do**:
  - `server/frontend/src/components/ActiveSessions.svelte`의 `<style>` 섹션에 `.status-waiting` CSS 규칙 추가
  - `.status-working` (line 351-355)과 `.status-idle` (line 357-361) 사이에 배치
  - 추가할 CSS:
    ```css
    .status-waiting {
      background: rgba(209, 105, 239, 0.15);
      color: #d169ef;
      border: 1px solid rgba(209, 105, 239, 0.3);
    }
    ```
  - magenta/purple 계열 색상으로 TUI의 `magenta` 뱅지 색상과 시각적 일관성 유지
  - 기존 `.status-working`, `.status-idle`과 동일한 구조 (`background`, `color`, `border`) 사용

  **Must NOT do**:
  - `app.css`에 CSS 변수 추가 금지 (인라인 hex로 충분)
  - `getDisplayStatus()` 함수 로직 변경 금지
  - `CommandPalette.svelte` 또는 다른 컴포넌트 CSS 수정 금지
  - 모바일 반응형 CSS에서 `.status-waiting` 별도 스타일 추가 금지 (기본 스타일로 충분)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: CSS 규칙 4줄 추가만 필요
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Final Verification Wave
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `server/frontend/src/components/ActiveSessions.svelte:351-355` — `.status-working` CSS 규칙 (동일한 구조로 복제)
  - `server/frontend/src/components/ActiveSessions.svelte:357-361` — `.status-idle` CSS 규칙 (동일한 구조)
  - `server/frontend/src/components/ActiveSessions.svelte:87-100` — `getDisplayStatus()` 함수 (cssClass 할당 확인용, 수정 금지)
  - `tui/src/components/SessionList.tsx:43` — TUI에서 waiting에 `magenta` 사용 (색상 일관성 참고)

  **WHY Each Reference Matters**:
  - .status-working/idle: 동일한 CSS 구조(background, color, border)를 그대로 복제해야 함
  - getDisplayStatus(): `cssClass: 'status-waiting'`이 이미 올바르게 할당되고 있음을 확인용
  - TUI magenta: 웹 UI도 동일한 magenta 계열을 사용해야 하는 근거

  **Acceptance Criteria**:

  - [x] `.status-waiting` CSS 규칙이 `ActiveSessions.svelte`의 `<style>` 섹션에 존재
  - [x] `background`, `color`, `border` 3개 속성 모두 정의됨
  - [x] magenta/purple 계열 색상 사용

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: .status-waiting CSS 규칙 존재 확인
    Tool: Bash (grep)
    Preconditions: Task 3 코드 변경 완료
    Steps:
      1. grep -A4 'status-waiting' server/frontend/src/components/ActiveSessions.svelte
      2. 출력에 background, color, border 속성이 모두 존재하는지 확인
    Expected Result: .status-waiting 규칙에 background, color, border 3개 속성 존재
    Failure Indicators: .status-waiting 규칙 미존재 또는 속성 누락
    Evidence: .sisyphus/evidence/task-3-css-check.txt

  Scenario: .status-working 및 .status-idle와 동일한 구조 확인
    Tool: Bash (grep)
    Preconditions: Task 3 코드 변경 완료
    Steps:
      1. grep -B1 -A5 'status-working\|status-idle\|status-waiting' server/frontend/src/components/ActiveSessions.svelte | grep -E 'background|color|border'
      2. 세 규칙 모두 동일한 구조(background, color, border) 사용 확인
    Expected Result: 3개 status CSS 규칙이 모두 background + color + border 구조
    Failure Indicators: 구조 불일치
    Evidence: .sisyphus/evidence/task-3-css-structure.txt
  ```

  **Commit**: YES
  - Message: `fix(frontend): add missing .status-waiting CSS for Waiting badge`
  - Files: `server/frontend/src/components/ActiveSessions.svelte`
  - Pre-commit: N/A (CSS only, no tests to run)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — APPROVED by Orchestrator (Atlas)
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — agent: 239 pass (1 pre-existing fail), server: 162 pass, typecheck: exit 0, build: exit 0
  Run `npm run typecheck` (server) + `npm run test` (agent, server). Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — All 3 code diffs read line-by-line, logic verified, no stubs/TODOs/as any
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [x] F4. **Scope Fidelity Check** — T1: session-cache.ts+test only, T2: active-sessions/index.ts+test only, T3: ActiveSessions.svelte CSS only. No scope creep.
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Commit 1** (Task 1): `fix(agent): reset waitingForInput on session.idle event` — agent/src/session-cache.ts, agent/src/__tests__/session-cache.test.ts
- **Commit 2** (Task 2): `fix(server): preserve orphan session title from previous poll cycle` — server/src/modules/active-sessions/index.ts, server/src/__tests__/active-sessions.test.ts
- **Commit 3** (Task 3): `fix(frontend): add missing .status-waiting CSS for Waiting badge` — server/frontend/src/components/ActiveSessions.svelte

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm run test           # Expected: ALL PASS
cd server && npm run test          # Expected: ALL PASS
cd server && npm run typecheck     # Expected: exit 0
cd agent && npm run build          # Expected: exit 0
```

### Final Checklist
- [x] Orphan 세션이 이전 cycle title 보존
- [x] session.idle 후 waitingForInput === false
- [x] .status-waiting CSS 존재 및 magenta 색상
- [x] 모든 기존 테스트 regression 없음
- [x] Must NOT Have 항목 전부 준수
