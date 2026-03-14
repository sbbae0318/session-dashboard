# Fix: 중간 대화 응답이 대시보드 쿼리로 표시되는 버그

## TL;DR

> **Quick Summary**: 세션 내 모든 user 메시지가 개별 쿼리로 수집되어 "핵심 질문 다시해주세요" 같은 중간 응답이 대시보드에 표시되는 버그를 수정. 첫 번째 유효 user 메시지만 수집하고, 타임스탬프 안정성을 확보하여 중복 삽입을 방지.
> 
> **Deliverables**:
> - `oc-query-collector.ts` — 세션당 첫 번째 유효 user 메시지만 수집
> - `session-cache.ts` — 첫 번째 user 메시지 + 안정적 타임스탬프 사용
> - 관련 테스트 업데이트 + 새 테스트 케이스 추가
> 
> **Estimated Effort**: Short (2-3 tasks, ~30min execution)
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 + Task 2 (parallel) → Task 3 (integration)

---

## Context

### Original Request
"치명적인 버그가 있는 것 같습니다. Dashboard 설치 스크립트에서 핵심 질문 다시해주세요 프롬프트가 계속 대시보드에 뜨는데 원인을 분석해주세요."

### Interview Summary
**Key Discussions**:
- 전체 데이터 파이프라인 추적 완료 (oc-serve → SessionCache/OcQueryCollector → PromptStore → Server → Frontend)
- 2개의 독립 데이터 경로 확인:
  - Path 1: `oc-query-collector.ts` → `prompt-store.ts` → `/api/queries` → `RecentPrompts.svelte` (프롬프트 히스토리)
  - Path 2: `session-cache.ts` → `session-store.ts` → `/proxy/session/details` (실시간 세션 상태)

**Research Findings**:
- `oc-query-collector.ts:156-187`: 모든 user 메시지를 개별 QueryEntry로 수집 (초기 프롬프트만이 아님)
- `session-cache.ts:367`: `.filter().pop()` → 마지막 user 메시지 사용 (첫 번째가 아님)
- `session-cache.ts:377`: `lastPromptTime: Date.now()` → 메시지 원래 타임스탬프 대신 현재 시간 사용
- `session-cache.ts:45-48`의 `OcServeMessage` 타입에 `time` 필드 누락
- `prompt-extractor.ts`: 시스템 prefix만 필터, 대화형 응답 필터 없음

### Metis Review
**Identified Gaps** (addressed):
- 2개의 독립 데이터 경로를 명확히 분리하여 각각 수정
- `OcServeMessage` 타입 불일치 → Task 2에서 `time` 필드 추가
- `fetchLastUserPrompt` 멱등성 → early return 최적화 추가
- 기존 테스트 expected count 변경 → 명시적으로 식별

---

## Work Objectives

### Core Objective
세션의 첫 번째 유효 user 메시지만 쿼리로 수집하고, 타임스탬프 안정성을 확보하여 중간 대화 응답이 대시보드에 표시되지 않도록 수정.

### Concrete Deliverables
- `agent/src/oc-query-collector.ts` — `collectFromSession()`에서 first-only 수집
- `agent/src/session-cache.ts` — `fetchLastUserPrompt()` → first message + stable timestamp + idempotency
- `agent/src/__tests__/oc-query-collector.test.ts` — 테스트 업데이트 + 새 케이스
- `agent/src/__tests__/session-cache.test.ts` — 테스트 업데이트 + 새 케이스

### Definition of Done
- [ ] `cd agent && npm run build` — TypeScript 컴파일 에러 없음
- [ ] `cd agent && npm test` — 전체 테스트 스위트 통과 (0 failures)
- [ ] 멀티 user message 세션에서 첫 번째 유효 메시지만 QueryEntry로 반환됨

### Must Have
- 세션당 첫 번째 `extractUserPrompt()` 통과 user 메시지만 수집
- `session-cache.ts`에서 메시지 원래 타임스탬프 사용 (Date.now() 대신)
- 이미 `lastPrompt`가 저장된 세션은 REST 재호출 skip
- 기존 테스트 중 의도적으로 변경되는 것만 수정

### Must NOT Have (Guardrails)
- ❌ `prompt-store.ts` 스키마 또는 dedup key 형식 변경
- ❌ 서버/프론트엔드 코드 변경 (이 버그는 agent 데이터 수집단 문제)
- ❌ `claude-source.ts` 또는 Claude Code 경로 수정 (별개 이슈)
- ❌ `prompt-extractor.ts`의 기존 필터 목록 변경 (추가만 OK)
- ❌ `QueryEntry` 인터페이스의 기존 필드 제거/이름 변경
- ❌ "대화형 응답" 패턴 필터링 (주관적, false positive 위험)
- ❌ `isSystemPrompt()` ↔ `extractUserPrompt()` 필터 목록 통일 (별개 이슈)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: YES (Tests-after — 기존 테스트 수정 + 새 케이스 추가)
- **Framework**: vitest (already configured in `agent/vitest.config.ts`)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit Tests**: Use Bash (`npx vitest run`) — Run specific test files, assert pass/fail
- **Build**: Use Bash (`npm run build`) — Verify TypeScript compilation

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — 2 independent fixes):
├── Task 1: oc-query-collector first-only 수집 + 테스트 [quick]
└── Task 2: session-cache fetchFirstUserPrompt + stable timestamp + 테스트 [quick]

Wave 2 (After Wave 1 — integration verification):
└── Task 3: 통합 빌드 + 전체 테스트 검증 [quick]

Wave FINAL (After ALL tasks — independent review):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
└── Task F3: Scope fidelity check (deep)

Critical Path: max(Task 1, Task 2) → Task 3 → Final
Parallel Speedup: ~40% (Wave 1 tasks in parallel)
Max Concurrent: 2 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 3 | 1 |
| 2 | — | 3 | 1 |
| 3 | 1, 2 | F1-F3 | 2 |
| F1-F3 | 3 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `quick`, T2 → `quick`
- **Wave 2**: **1** — T3 → `quick`
- **FINAL**: **3** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `deep`

---

## TODOs

- [ ] 1. oc-query-collector — 세션당 첫 번째 유효 user 메시지만 수집

  **What to do**:
  - `agent/src/oc-query-collector.ts`의 `collectFromSession()` (line 156-187) 수정:
    - 현재: for loop이 모든 user 메시지를 `entries`에 push
    - 변경: `extractUserPrompt()`를 통과하는 첫 번째 user 메시지만 push 후 `break`
    - 핵심 변경: for loop 내부에서 `entries.push(...)` 직후에 `break;` 추가
    - `textParts.length === 0`인 경우 기존처럼 `continue` (빈 parts는 skip하고 다음 user message 시도)
    - `extracted === null`인 경우 기존처럼 `continue` (시스템 프롬프트는 skip하고 다음 user message 시도)
  - `agent/src/__tests__/oc-query-collector.test.ts` 수정:
    - `기본 수집: user 메시지만 QueryEntry로 변환` 테스트 (약 line 39-52):
      - `expect(entries).toHaveLength(2)` → `expect(entries).toHaveLength(1)` 변경
      - `entries[0].query`가 첫 번째 user 메시지의 내용인지 확인하는 assertion 추가
    - `incremental 제거` 관련 테스트가 있으면 first-only 동작에 맞게 업데이트
    - 새 테스트 추가: `세 번째 user message가 대화 응답이어도 첫 번째만 수집됨`
      ```typescript
      it('세션당 첫 번째 유효 user 메시지만 수집 (중간 응답 제외)', async () => {
        // 3개 user message 중 첫 번째만 수집됨
        mockFetchJson.mockImplementation((url: string) => {
          if (url.includes('/session?')) return Promise.resolve([makeSession('s1')]);
          return Promise.resolve([
            makeMessage('user', '프로젝트 설정해주세요'),    // ← 이것만 수집
            makeMessage('assistant', '...'),
            makeMessage('user', '핵심 질문 다시해주세요'),  // ← 건너뜀
            makeMessage('assistant', '...'),
            makeMessage('user', '네 좋아요'),              // ← 건너뜀
          ]);
        });
        const entries = await collector.collectQueries();
        expect(entries).toHaveLength(1);
        expect(entries[0].query).toBe('프로젝트 설정해주세요');
      });
      ```
    - 새 테스트 추가: `첫 번째 user 메시지가 시스템 프롬프트면 다음 유효 메시지 수집`
      ```typescript
      it('첫 번째 user msg가 system이면 skip, 두 번째 유효 msg 수집', async () => {
        mockFetchJson.mockImplementation((url: string) => {
          if (url.includes('/session?')) return Promise.resolve([makeSession('s1')]);
          return Promise.resolve([
            makeMessage('user', '[SYSTEM DIRECTIVE: ...] 시스템'),  // ← null 반환
            makeMessage('user', '실제 프롬프트'),                    // ← 이것 수집
          ]);
        });
        const entries = await collector.collectQueries();
        expect(entries).toHaveLength(1);
        expect(entries[0].query).toBe('실제 프롬프트');
      });
      ```

  **Must NOT do**:
  - `prompt-store.ts` 스키마 변경
  - `QueryEntry` 인터페이스 필드 변경
  - `prompt-extractor.ts` 기존 필터 수정
  - `collectQueries()` 메서드의 시그니처/반환 타입 변경

  **Recommended Agent Profile**:
  > Select category + skills based on task domain.
  - **Category**: `quick`
    - Reason: 단일 파일 로직 변경 (break 추가) + 테스트 업데이트. 구조적 변경 아님.
  - **Skills**: [`cleanup-after-test`]
    - `cleanup-after-test`: 테스트 실행 후 placeholder 파일 정리
  - **Skills Evaluated but Omitted**:
    - `bug-hunting`: root cause 이미 식별됨, 추가 탐색 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 3 (통합 검증)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL - Be Exhaustive):

  **Pattern References** (existing code to follow):
  - `agent/src/oc-query-collector.ts:156-187` — 현재 `collectFromSession()` for loop. 이 loop에 `break` 추가가 핵심 변경.
  - `agent/src/oc-query-collector.ts:162-165` — `textParts` 추출 로직. 변경 불필요, 그대로 유지.
  - `agent/src/oc-query-collector.ts:168-169` — `extractUserPrompt()` 호출. null이면 continue하는 기존 로직 유지.

  **API/Type References** (contracts to implement against):
  - `agent/src/oc-query-collector.ts:35-42` — `QueryEntry` 인터페이스. 필드 변경 금지.
  - `agent/src/prompt-extractor.ts:29-61` — `extractUserPrompt()` 함수. 호출 방식 변경 불필요.

  **Test References** (testing patterns to follow):
  - `agent/src/__tests__/oc-query-collector.test.ts` — 기존 테스트 구조. `makeSession()`, `makeMessage()` 헬퍼 함수 패턴 따르기.
  - `agent/src/__tests__/prompt-extractor.test.ts` — `extractUserPrompt()` 테스트 패턴 참고 (하지만 이 파일은 수정 불필요).

  **WHY Each Reference Matters**:
  - `oc-query-collector.ts:156-187`: 정확히 어디에 `break`를 넣어야 하는지 보여줌 (line 186의 `entries.push()` 직후)
  - `QueryEntry` 인터페이스: 반환 타입 호환성 확인 — 서버가 이 타입을 그대로 소비함
  - 기존 테스트: `makeSession()`/`makeMessage()` 헬퍼 패턴을 따라야 일관성 유지

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 멀티 user message 세션에서 첫 번째만 수집
    Tool: Bash
    Preconditions: agent/ 디렉토리에서 실행
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npx vitest run src/__tests__/oc-query-collector.test.ts 2>&1
      3. 출력에서 'Tests' 라인 확인
    Expected Result: 모든 테스트 통과 (0 failed), 새 테스트 케이스 포함
    Failure Indicators: 'FAIL', 'failed', 또는 exit code != 0
    Evidence: .sisyphus/evidence/task-1-oc-query-tests.txt
  ```

  ```
  Scenario: TypeScript 빌드 에러 없음
    Tool: Bash
    Preconditions: agent/ 디렉토리에서 실행
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npx tsc --noEmit 2>&1
    Expected Result: exit code 0, 에러 출력 없음
    Failure Indicators: 'error TS', exit code != 0
    Evidence: .sisyphus/evidence/task-1-tsc-check.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-oc-query-tests.txt — vitest 실행 결과
  - [ ] task-1-tsc-check.txt — TypeScript 컴파일 검증

  **Commit**: YES (groups with Task 2)
  - Message: `fix(agent): collect only first user prompt per session`
  - Files: `agent/src/oc-query-collector.ts`, `agent/src/__tests__/oc-query-collector.test.ts`
  - Pre-commit: `cd agent && npm run build && npx vitest run src/__tests__/oc-query-collector.test.ts`

- [ ] 2. session-cache — fetchFirstUserPrompt + stable timestamp + idempotency

  **What to do**:
  - `agent/src/session-cache.ts` 수정:
    - **타입 수정** (line 45-48): `OcServeMessage` 인터페이스의 `info` 필드에 `time?: { created: number }` 추가
      ```typescript
      // 변경 전
      interface OcServeMessage {
        info: { role: string; sessionID: string };
        parts?: Array<{ type: string; text?: string }>;
      }
      // 변경 후
      interface OcServeMessage {
        info: { role: string; sessionID: string; time?: { created: number } };
        parts?: Array<{ type: string; text?: string }>;
      }
      ```
    - **fetchLastUserPrompt → fetchFirstUserPrompt 변경** (line 361-384):
      - 함수명: `fetchLastUserPrompt` → `fetchFirstUserPrompt`
      - Line 367: `.filter((m) => m.info?.role === 'user').pop()` → `.find((m) => m.info?.role === 'user')`
      - Line 376: `lastPrompt: text.slice(0, PROMPT_MAX_LENGTH)` — 변경 없음
      - Line 377: `lastPromptTime: Date.now()` → `lastPromptTime: firstUserMsg.info?.time?.created ?? Date.now()`
    - **멱등성 최적화** — `fetchFirstUserPrompt()` 시작 부분에 early return 추가:
      ```typescript
      const existing = this.store.get(sessionID);
      if (existing?.lastPrompt) return;  // 이미 첫 프롬프트 저장됨 → REST 호출 skip
      ```
    - **호출부 업데이트** (line 323):
      `void this.fetchLastUserPrompt(...)` → `void this.fetchFirstUserPrompt(...)`
  - `agent/src/__tests__/session-cache.test.ts` 수정:
    - 기존 `message.updated(role=user) → REST fallback → lastPrompt` 테스트 (약 test #6):
      - 여러 user message가 있을 때 **첫 번째**가 선택됨을 확인하는 mock 데이터로 업데이트
      - `fetchJson` mock이 `[userMsg1, assistantMsg, userMsg2]` 반환하도록 설정
      - assertion: `entry.lastPrompt`가 첫 번째 user message 내용과 일치
    - 새 테스트: `이미 lastPrompt가 있는 세션은 fetchFirstUserPrompt가 REST 호출 skip`
      ```typescript
      it('이미 lastPrompt가 저장된 세션은 REST 호출 skip', async () => {
        // SessionStore에 lastPrompt가 이미 있는 세션으로 사전 설정
        // message.updated SSE 이벤트 발생
        // fetchJson이 호출되지 않음을 확인
      });
      ```
    - 새 테스트: `message timestamp가 있으면 Date.now() 대신 사용`
      ```typescript
      it('message timestamp를 lastPromptTime으로 사용', async () => {
        // mock 데이터에 info.time.created 포함
        // lastPromptTime이 Date.now()가 아닌 message timestamp와 일치
      });
      ```

  **Must NOT do**:
  - `session-store.ts` 스키마 변경
  - `SessionDetail` 인터페이스 필드명 변경 (lastPrompt, lastPromptTime 유지)
  - `isSystemPrompt()` 필터 목록 변경
  - SSE 이벤트 핸들러 (`handleMessageUpdated`) 로직 변경 (호출부만 함수명 업데이트)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일 로직 변경 + 타입 수정 + 테스트 업데이트. 구조적 변경 아님.
  - **Skills**: [`cleanup-after-test`]
    - `cleanup-after-test`: 테스트 실행 후 placeholder 파일 정리
  - **Skills Evaluated but Omitted**:
    - `bug-hunting`: root cause 이미 식별됨

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3 (통합 검증)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL - Be Exhaustive):

  **Pattern References**:
  - `agent/src/session-cache.ts:45-48` — 현재 `OcServeMessage` 타입. `time` 필드 추가 필요.
  - `agent/src/session-cache.ts:361-384` — 현재 `fetchLastUserPrompt()`. pop → find, Date.now() → message timestamp.
  - `agent/src/session-cache.ts:318-324` — `handleMessageUpdated()`. 호출부에서 함수명만 변경.
  - `agent/src/session-cache.ts:62-72` — `SYSTEM_PROMPT_PREFIXES`. 참고만 (변경 불필요).

  **API/Type References**:
  - `agent/src/oc-query-collector.ts:24-31` — oc-query-collector의 `OcServeMessage` 타입. `time` 필드가 이미 있음. session-cache도 이와 동일하게 맞추기.
  - `agent/src/session-cache.ts:18-25` — `SessionDetail` 인터페이스. `lastPrompt`, `lastPromptTime` 필드 유지.

  **Test References**:
  - `agent/src/__tests__/session-cache.test.ts` — 기존 테스트 구조. SSE 이벤트 시뮬레이션 패턴 따르기.
  - `agent/src/__tests__/session-cache.test.ts:191-223` — 기존 `lastPrompt` 테스트. 이 패턴을 따라 새 테스트 작성.

  **WHY Each Reference Matters**:
  - `session-cache.ts:45-48`: `OcServeMessage` 타입에 time 필드 누락 — 이것을 추가해야 message timestamp 사용 가능
  - `oc-query-collector.ts:24-31`: 동일 API의 다른 타입 정의 — time 필드 형식 참고 (`time?: { created: number }`)
  - `session-cache.ts:361-384`: 변경 대상 함수 — pop→find, Date.now()→msg timestamp, early return 세 가지 변경

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: session-cache 테스트 전체 통과
    Tool: Bash
    Preconditions: agent/ 디렉토리에서 실행
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npx vitest run src/__tests__/session-cache.test.ts 2>&1
      3. 출력에서 'Tests' 라인 확인
    Expected Result: 모든 테스트 통과 (0 failed), 새 테스트 케이스 포함
    Failure Indicators: 'FAIL', 'failed', 또는 exit code != 0
    Evidence: .sisyphus/evidence/task-2-session-cache-tests.txt
  ```

  ```
  Scenario: fetchFirstUserPrompt 함수명 변경 후 참조 무결성
    Tool: Bash
    Preconditions: agent/ 디렉토리에서 실행
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npx tsc --noEmit 2>&1
      3. grep -r 'fetchLastUserPrompt' src/ (0건이어야 함)
    Expected Result: tsc 에러 없음 + 'fetchLastUserPrompt' 참조 0건
    Failure Indicators: 'error TS', 'fetchLastUserPrompt' 참조 존재
    Evidence: .sisyphus/evidence/task-2-tsc-and-rename.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-session-cache-tests.txt — vitest 실행 결과
  - [ ] task-2-tsc-and-rename.txt — TypeScript 컴파일 + 참조 확인

  **Commit**: YES (groups with Task 1)
  - Message: `fix(agent): use first user message and stable timestamp in session cache`
  - Files: `agent/src/session-cache.ts`, `agent/src/__tests__/session-cache.test.ts`
  - Pre-commit: `cd agent && npm run build && npx vitest run src/__tests__/session-cache.test.ts`

- [ ] 3. 통합 빌드 + 전체 테스트 검증

  **What to do**:
  - Task 1, 2 완료 후 전체 agent 빌드 및 테스트 실행:
    - `cd agent && npm run build` — TypeScript 컴파일 에러 없음
    - `cd agent && npm test` — 전체 테스트 스위트 통과
  - `prompt-store.ts` 관련 테스트가 변경되지 않았음을 확인 (기존 dedup 동작 유지)
  - `prompt-extractor.ts` 관련 테스트가 변경되지 않았음을 확인

  **Must NOT do**:
  - 추가 코드 변경 (검증만 수행)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 빌드/테스트 실행만. 코드 변경 없음.
  - **Skills**: [`cleanup-after-test`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Final Verification Wave
  - **Blocked By**: Task 1, Task 2

  **References**:
  - `agent/package.json` — `build`, `test` 스크립트 정의
  - `agent/vitest.config.ts` — 테스트 설정

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 전체 빌드 성공
    Tool: Bash
    Preconditions: Task 1, 2 완료 상태
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npm run build 2>&1
    Expected Result: exit code 0, 'error' 없음
    Failure Indicators: 'error TS', exit code != 0
    Evidence: .sisyphus/evidence/task-3-build.txt
  ```

  ```
  Scenario: 전체 테스트 스위트 통과
    Tool: Bash
    Preconditions: Task 1, 2 완료 상태
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. npm test 2>&1
      3. 출력에서 'Tests' 및 'Test Suites' 라인 확인
    Expected Result: 0 failed tests, 0 failed test suites
    Failure Indicators: 'FAIL', 'failed', exit code != 0
    Evidence: .sisyphus/evidence/task-3-full-tests.txt
  ```

  ```
  Scenario: prompt-store 테스트 미변경 확인
    Tool: Bash
    Preconditions: Task 1, 2 완료 상태
    Steps:
      1. cd /Users/sbbae/project/session-dashboard/agent
      2. git diff src/__tests__/prompt-store.test.ts (변경사항 없어야 함)
      3. git diff src/prompt-store.ts (변경사항 없어야 함)
    Expected Result: 두 파일 모두 변경사항 없음
    Failure Indicators: diff 출력이 존재함
    Evidence: .sisyphus/evidence/task-3-no-prompt-store-change.txt
  ```

  **Evidence to Capture:**
  - [ ] task-3-build.txt — 전체 빌드 결과
  - [ ] task-3-full-tests.txt — 전체 테스트 결과
  - [ ] task-3-no-prompt-store-change.txt — prompt-store 미변경 확인

  **Commit**: NO (Task 1, 2에서 이미 커밋)

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 3 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run build` + `npm test` in agent/. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

**Git Workflow**: 별도 워크트리에서 작업 후 나중에 메인에 머지.

```bash
# 워크트리 생성 (실행 전)
git worktree add ../session-dashboard-fix-query fix/query-collection-bug
```

- **Wave 1 완료 후**: `fix(agent): collect only first user prompt per session to prevent intermediate responses from appearing on dashboard`
  - Files: `agent/src/oc-query-collector.ts`, `agent/src/session-cache.ts`, `agent/src/__tests__/oc-query-collector.test.ts`, `agent/src/__tests__/session-cache.test.ts`
  - Pre-commit: `cd agent && npm run build && npm test`

---

## Success Criteria

### Verification Commands
```bash
cd /Users/sbbae/project/session-dashboard/agent && npm run build  # Expected: exit code 0, no errors
cd /Users/sbbae/project/session-dashboard/agent && npm test        # Expected: all tests pass, 0 failures
```

### Final Checklist
- [ ] 세션당 첫 번째 유효 user 메시지만 QueryEntry로 수집
- [ ] session-cache에서 첫 번째 user 메시지 사용 + 안정적 타임스탬프
- [ ] 이미 lastPrompt 저장된 세션은 REST 재호출 skip
- [ ] 모든 기존 테스트 통과 (변경된 테스트 포함)
- [ ] 새 테스트 케이스 통과
- [ ] TypeScript 빌드 에러 없음
- [ ] prompt-store.ts 변경 없음
- [ ] 서버/프론트엔드 코드 변경 없음
- [ ] claude-source.ts 변경 없음
