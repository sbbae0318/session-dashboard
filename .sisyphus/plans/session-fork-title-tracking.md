# Fix Session Fork + Rename Title Tracking

## TL;DR

> **Quick Summary**: 세션 포크/이름변경 시 대시보드에 세션 ID만 표시되는 버그 수정. Agent의 `fetchSessionMetadata()`에 재시도 로직 추가 + 주기적 null-title 스캔으로 title이 null인 세션을 자동 보충.
> 
> **Deliverables**:
> - `SessionStore.getSessionIdsWithNullTitle()` 쿼리 추가
> - `fetchSessionMetadata()` 재시도 로직 (5초 간격, 최대 3회)
> - 주기적 null-title 스캔 타이머 (30초 간격)
> - 신규 테스트 7~8개 + 전체 regression 통과
> - Production 배포 및 검증
> 
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

---

## Context

### Original Request
세션 대시보드에서 세션 포크 + 이름 변경을 진행했는데 해당 시나리오에서 추적이 안되고 세션 아이디만 노출되는 현상. 원인 분석 및 regression에 걸리지 않는 방안으로 수정.

### Interview Summary
**Key Discussions**:
- Root cause 확인: SSE에 title 정보 없음 + fetchSessionMetadata() 1회성 + 레이스 컨디션
- 수정 전략: Option D (재시도 + 주기적 스캔) 선택
- 테스트: Tests after 방식

**Research Findings** (3개 탐색 에이전트 일치):
- SSE 6가지 이벤트 중 어떤 것도 title 미포함
- `scheduleMetadataFetch()` 존재하나 1회성, 재시도 없음
- SQLite `session_status` 테이블에 title 컬럼 존재, upsert 지원
- `fetchSessionMetadata()`: GET /session/{id}, 3s timeout, silent catch
- 포크 직후 oc-serve가 rename 미완료 시 title=null 반환 → 영구 null

### Metis Review
**Identified Gaps** (addressed):
- E5: `stop()` 호출 시 pending retry timer가 DB close 후 fire → retryTimers Map으로 추적 + stop()에서 정리
- E6: 주기적 스캔과 재시도가 동일 세션에 중복 fetch → pendingMetadataFetches Set 확인으로 방지
- G7: SessionStore에 prepared statement 패턴 따를 것 (constructor에서 prepare)
- Q4: 재시도 소진 시 warning 로그 추가
- Q1: rename 추적 (non-null → 다른 non-null): 현재 스코프 외. 별도 이슈로 분리.

---

## Work Objectives

### Core Objective
포크/이름변경된 세션의 title이 null로 남는 문제를 해결하여, 대시보드에서 정상적으로 세션 이름을 표시한다.

### Concrete Deliverables
- `agent/src/session-store.ts`: `getSessionIdsWithNullTitle()` 메서드 추가
- `agent/src/session-cache.ts`: retry 로직 + null-title 스캔 타이머 추가
- `agent/src/__tests__/session-store.test.ts`: null-title 쿼리 테스트 추가
- `agent/src/__tests__/session-cache.test.ts`: retry + 스캔 테스트 7~8개 추가

### Definition of Done
- [ ] `npx vitest run` — agent 전체 테스트 통과 (240+ tests)
- [ ] `npx tsc --noEmit` — agent type check clean
- [ ] Production 배포 후, 포크된 세션이 15초 이내에 title 표시

### Must Have
- fetchSessionMetadata() 재시도: title null 시 5초 후 재시도, 최대 3회
- 주기적 null-title 스캔: 30초 간격, batch REST fetch
- 재시도 타이머 `stop()`에서 정리
- pendingMetadataFetches와 주기적 스캔 간 중복 방지
- 기존 31개 session-cache 테스트 regression 없음

### Must NOT Have (Guardrails)
- `oc-serve-proxy.ts`의 `fetchJson()` 수정 금지
- `fetchLatestUserPrompt()`에 재시도 추가 금지
- 환경변수로 타이밍 상수 설정 금지 (하드코딩, 기존 패턴)
- SessionStore 스키마 변경 (ALTER TABLE) 금지
- server/dashboard/TUI 코드 변경 금지
- 기존 non-null title을 null로 덮어쓰기 금지
- rename 추적 (non-null → 다른 non-null) — 별도 이슈

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest, 240+ agent tests, 31 session-cache tests)
- **Automated tests**: Tests-after
- **Framework**: vitest with fake timers (`vi.useFakeTimers({ shouldAdvanceTime: true })`)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit tests**: vitest with fake timers and mockFetchJson
- **Integration**: `npx vitest run` full suite
- **Build**: `npx tsc --noEmit`

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation):
├── Task 1: SessionStore.getSessionIdsWithNullTitle() [quick]

Wave 2 (After Wave 1 — core implementation):
├── Task 2: Retry logic + periodic null-title scan + tests [deep]

Wave 3 (After Wave 2 — verification + deploy):
├── Task 3: Full regression + build verification [quick]
├── Task 4: Deploy to production + verify [quick]

Wave FINAL (After ALL tasks):
├── Task F1: Plan compliance audit [oracle]
├── Task F2: Code quality + regression [unspecified-high]
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2, F1-F2 | 1 |
| 2 | 1 | 3, 4, F1-F2 | 2 |
| 3 | 2 | 4, F1-F2 | 3 |
| 4 | 3 | F1-F2 | 3 |
| F1 | 4 | — | FINAL |
| F2 | 4 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 1 task → `quick`
- **Wave 2**: 1 task → `deep`
- **Wave 3**: 2 tasks → `quick`, `quick`
- **FINAL**: 2 tasks → `oracle`, `unspecified-high`

---

## TODOs

- [ ] 1. SessionStore에 null-title 쿼리 추가

  **What to do**:
  - `SessionStore`에 `getSessionIdsWithNullTitle(): string[]` 메서드 추가
  - Constructor에서 prepared statement 준비: `SELECT session_id FROM session_status WHERE title IS NULL OR title = ''`
  - 빈 문자열도 null로 취급 (Metis Q2 대응)
  - 테스트 추가: null title 세션만 반환되는지 검증

  **Must NOT do**:
  - 스키마 변경 (ALTER TABLE) 금지
  - 기존 메서드 시그니처 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일에 1개 메서드 + 1개 prepared statement 추가. 15분 미만 작업.
  - **Skills**: []
    - 추가 스킬 불필요 — 기존 패턴 복사

  **Parallelization**:
  - **Can Run In Parallel**: NO (Wave 1 단독)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 2
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `agent/src/session-store.ts:88-112` — 기존 prepared statement 패턴 (constructor에서 `this.db.prepare()`, 메서드에서 `this.stmtXxx.all()`)
  - `agent/src/session-store.ts:128-146` — `getAll()` 메서드 패턴 (row 변환)

  **Test References**:
  - `agent/src/__tests__/session-store.test.ts` — 기존 12개 테스트. `makeDetail()` 헬퍼 사용하여 SessionDetail 생성

  **WHY Each Reference Matters**:
  - `session-store.ts:88-112`: 새 prepared statement가 이 패턴을 정확히 따라야 함 (constructor prepare, method call)
  - `session-store.test.ts`: `makeDetail()` 헬퍼로 title 있는/없는 세션을 생성하여 쿼리 검증

  **Acceptance Criteria**:

  - [ ] `npx vitest run src/__tests__/session-store.test.ts` → PASS (기존 12 + 신규 2~3)
  - [ ] `npx tsc --noEmit` (agent/) → clean

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: null-title 세션만 반환
    Tool: Bash (vitest)
    Preconditions: SessionStore 인스턴스 생성 (:memory: SQLite)
    Steps:
      1. upsert("ses-1", { ...makeDetail(), title: null })
      2. upsert("ses-2", { ...makeDetail(), title: "Has Title" })
      3. upsert("ses-3", { ...makeDetail(), title: "" })
      4. const ids = store.getSessionIdsWithNullTitle()
    Expected Result: ids는 ["ses-1", "ses-3"]을 포함, "ses-2"는 미포함
    Evidence: .sisyphus/evidence/task-1-null-title-query.txt

  Scenario: 모든 세션에 title이 있을 때 빈 배열 반환
    Tool: Bash (vitest)
    Preconditions: SessionStore에 title 있는 세션 3개
    Steps:
      1. upsert 3개 세션 (모두 title 있음)
      2. const ids = store.getSessionIdsWithNullTitle()
    Expected Result: ids === []
    Evidence: .sisyphus/evidence/task-1-all-titled.txt
  ```

  **Commit**: YES
  - Message: `feat(agent): add getSessionIdsWithNullTitle query to SessionStore`
  - Files: `agent/src/session-store.ts`, `agent/src/__tests__/session-store.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/session-store.test.ts`

- [ ] 2. fetchSessionMetadata 재시도 + 주기적 null-title 스캔 + 테스트

  **What to do**:

  **Part A: 재시도 로직 (fetchSessionMetadata 수정)**
  - `fetchSessionMetadata()` 수정: title이 null로 반환되면 5초 후 재시도, 최대 3회
  - `private retryTimers: Map<string, NodeJS.Timeout> = new Map()` 추가 (타이머 추적)
  - 각 재시도 전 `this.store.get(sessionID)` 확인 — 삭제된 세션이면 중단 (Metis E5)
  - 재시도 시에도 기존 `data.title ?? existing.title` 패턴 유지 — non-null title 보호 (Metis G3)
  - 3회 재시도 모두 실패 시 `console.log('[SessionCache] metadata retry exhausted for', sessionID)` 경고 (Metis Q4)
  - `stop()` 메서드에서 `retryTimers` 모든 엔트리 `clearTimeout` + `Map.clear()` (Metis E5)

  **Part B: 주기적 null-title 스캔**
  - 상수 추가: `const NULL_TITLE_SCAN_INTERVAL_MS = 30_000` (30초)
  - `private nullTitleScanTimer: NodeJS.Timeout | null = null` 추가
  - `start()` 메서드에서 `setInterval(this.scanNullTitles.bind(this), NULL_TITLE_SCAN_INTERVAL_MS)` 시작
  - `stop()` 메서드에서 타이머 정리
  - `scanNullTitles()` 구현:
    1. `this.store.getSessionIdsWithNullTitle()` 호출 (Task 1에서 추가한 메서드)
    2. `pendingMetadataFetches` Set에 있는 ID 제외 (Metis E6 — 중복 방지)
    3. 남은 ID들에 대해 `fetchSessionMetadata()` 호출 (이미 재시도 로직 포함)
    4. 동시 fetch 제한: batch size 4 (bootstrap 패턴 따름)
  - 빈 배열이면 아무것도 하지 않음 (불필요한 REST 호출 방지)

  **Part C: 테스트 추가**
  - session-cache.test.ts에 새 describe 블록: `"metadata retry and null-title scan"`
  - 7~8개 테스트 (Metis AC1-AC6):
    1. 재시도 성공: fetchJson 첫 2회 title=null, 3회째 title="Fork" → title 확인
    2. 재시도 소진: fetchJson 항상 title=null → 정확히 4회 호출 (1+3) 확인
    3. 재시도 중 세션 삭제: session.deleted 이벤트 → 이후 재시도 스킵
    4. 주기적 스캔: null-title 세션만 fetch 확인
    5. 스캔+재시도 중복 방지: pendingMetadataFetches에 있는 세션 스킵
    6. stop() 타이머 정리: retryTimers + nullTitleScanTimer 정리 확인
    7. 기존 테스트 regression 없음

  **Must NOT do**:
  - `oc-serve-proxy.ts`의 `fetchJson()` 수정 금지
  - `fetchLatestUserPrompt()`에 재시도 추가 금지
  - 환경변수로 타이밍 상수 설정 금지
  - 기존 non-null title을 null로 덮어쓰기 금지
  - session-cache.ts 850줄 초과 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 기존 비동기 로직 수정 + 타이머 관리 + 엣지 케이스 처리 + 7개 테스트 작성. 복잡한 상태 관리 필요.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (단독)
  - **Blocks**: Task 3, 4
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `agent/src/session-cache.ts:129-132` — 기존 타이머 선언 패턴 (`private xxxTimer: NodeJS.Timeout | null = null`)
  - `agent/src/session-cache.ts:160-178` — `stop()` 메서드의 타이머 정리 패턴 (clearInterval/clearTimeout + null 할당)
  - `agent/src/session-cache.ts:148-158` — `start()` 메서드의 타이머 시작 패턴
  - `agent/src/session-cache.ts:611-641` — 현재 `fetchSessionMetadata()` 구현 (수정 대상)
  - `agent/src/session-cache.ts:402-413` — `scheduleMetadataFetch()` 및 `pendingMetadataFetches` Set
  - `agent/src/session-cache.ts:75-82` — 기존 상수 선언 패턴 (하드코딩)

  **Test References**:
  - `agent/src/__tests__/session-cache.test.ts:28-69` — 테스트 헬퍼 패턴 (`createMockResponse`, `simulateSseEvent`, `flushPromises`, `mockFetchJson`)
  - `agent/src/__tests__/session-cache.test.ts:1-27` — mock 설정 패턴 (`vi.mock`, `vi.hoisted`)
  - `agent/src/__tests__/session-cache.test.ts` — `vi.useFakeTimers({ shouldAdvanceTime: true })` 패턴

  **External References**:
  - vitest fake timers: `vi.advanceTimersByTime(ms)` — 재시도 타이머 트리거에 사용

  **WHY Each Reference Matters**:
  - `session-cache.ts:129-132`: 새 `retryTimers`와 `nullTitleScanTimer` 선언이 이 패턴 따라야 함
  - `session-cache.ts:160-178`: `stop()`에서 새 타이머를 정확히 같은 방식으로 정리해야 DB close 후 fire 방지
  - `session-cache.ts:611-641`: 이 함수 내부에 재시도 루프 추가. 기존 try/catch 구조 유지하면서 확장
  - `session-cache.ts:402-413`: `pendingMetadataFetches` Set과 상호작용. 재시도가 이 Set을 적절히 관리해야 함
  - 테스트 헬퍼들: `mockFetchJson.mockResolvedValueOnce()` 체이닝으로 재시도 시퀀스 시뮬레이션

  **Acceptance Criteria**:

  - [ ] `npx vitest run src/__tests__/session-cache.test.ts` → PASS (기존 31 + 신규 7~8)
  - [ ] `npx tsc --noEmit` (agent/) → clean
  - [ ] `wc -l agent/src/session-cache.ts` → 850줄 미만

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 재시도로 title 확보 성공 (happy path)
    Tool: Bash (vitest)
    Preconditions: SessionCache + mocked fetchJson
    Steps:
      1. mockFetchJson 설정: 1-2회째 { title: null, parentID: null }, 3회째 { title: "Forked Session" }
      2. SSE로 새 세션 session.status 이벤트 전송
      3. await flushPromises() — 첫 번째 fetch 실행
      4. vi.advanceTimersByTime(5000) — 첫 번째 재시도 트리거
      5. await flushPromises()
      6. vi.advanceTimersByTime(5000) — 두 번째 재시도 트리거
      7. await flushPromises()
      8. store.get(sessionID).title 확인
    Expected Result: title === "Forked Session", mockFetchJson 3회 호출
    Failure Indicators: title이 null이거나 fetchJson 호출 횟수 != 3
    Evidence: .sisyphus/evidence/task-2-retry-success.txt

  Scenario: 재시도 소진 (3회 모두 title=null)
    Tool: Bash (vitest)
    Preconditions: mockFetchJson 항상 { title: null } 반환
    Steps:
      1. SSE로 새 세션 이벤트
      2. flushPromises + advanceTimersByTime(5000) × 3회
      3. mockFetchJson.mock.calls.length 확인
    Expected Result: 정확히 4회 호출 (초기 1 + 재시도 3), 이후 추가 호출 없음
    Evidence: .sisyphus/evidence/task-2-retry-exhausted.txt

  Scenario: 재시도 중 세션 삭제
    Tool: Bash (vitest)
    Preconditions: mockFetchJson 첫 호출 { title: null }
    Steps:
      1. SSE session.status → 새 세션
      2. flushPromises → 첫 fetch (title=null)
      3. SSE session.deleted 이벤트 전송
      4. advanceTimersByTime(5000) → 재시도 트리거
      5. flushPromises
      6. mockFetchJson.mock.calls.length 확인
    Expected Result: 2회 이하 호출 (삭제 후 재시도 스킵)
    Evidence: .sisyphus/evidence/task-2-retry-deleted.txt

  Scenario: 주기적 스캔 — null-title만 fetch
    Tool: Bash (vitest)
    Preconditions: store에 3개 세션 (2개 title=null, 1개 title="OK")
    Steps:
      1. vi.advanceTimersByTime(30000) — 스캔 타이머 트리거
      2. await flushPromises()
      3. mockFetchJson 호출 확인
    Expected Result: title=null인 2개 세션에 대해서만 REST 호출
    Evidence: .sisyphus/evidence/task-2-scan-null-only.txt

  Scenario: stop()에서 모든 타이머 정리
    Tool: Bash (vitest)
    Preconditions: cache started, retry timer pending
    Steps:
      1. cache.start() → SSE 새 세션 → retry 스케줄됨
      2. cache.stop()
      3. advanceTimersByTime(30000) — 타이머 fire 시도
    Expected Result: stop() 후 추가 fetch 호출 없음, DB close 에러 없음
    Evidence: .sisyphus/evidence/task-2-stop-cleanup.txt
  ```

  **Commit**: YES
  - Message: `fix(agent): add metadata retry + periodic null-title scan for fork/rename tracking`
  - Files: `agent/src/session-cache.ts`, `agent/src/__tests__/session-cache.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/session-cache.test.ts`

- [ ] 3. Full Regression + Build Verification

  **What to do**:
  - `cd agent && npx vitest run` — 전체 agent 테스트 실행 (248+ tests)
  - `cd agent && npx tsc --noEmit` — type check
  - `cd server && npx vitest run` — 서버 테스트 (기존 코드 변경 없지만 확인)
  - `cd agent && npm run build` — production build
  - 실패 시 수정 후 재실행

  **Must NOT do**:
  - 코드 변경 없이 테스트만 실행 (실패 시에만 수정)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 빌드/테스트 실행만. 코드 변경 없음 (실패 시에만).
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 4
  - **Blocked By**: Task 2

  **References**:
  - `agent/package.json` — `npm test`, `npm run build` 스크립트
  - `server/package.json` — `npm test` 스크립트

  **Acceptance Criteria**:
  - [ ] `cd agent && npx vitest run` → ALL PASS
  - [ ] `cd agent && npx tsc --noEmit` → clean
  - [ ] `cd server && npx vitest run` → ALL PASS (166 tests)
  - [ ] `cd agent && npm run build` → success

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 전체 테스트 통과
    Tool: Bash
    Steps:
      1. cd agent && npx vitest run 2>&1
      2. cd server && npx vitest run 2>&1
      3. cd agent && npx tsc --noEmit 2>&1
      4. cd agent && npm run build 2>&1
    Expected Result: 모든 명령 exit code 0, 테스트 failures 없음
    Evidence: .sisyphus/evidence/task-3-full-regression.txt
  ```

  **Commit**: NO (테스트/빌드 확인만)

- [ ] 4. Production 배포 및 검증

  **What to do**:
  - `git push origin main`
  - `ssh sbbae@192.168.0.2 "cd ~/project/session-dashboard && git pull origin main"`
  - `ssh sbbae@192.168.0.2 "cd ~/project/session-dashboard/server && docker compose build --no-cache && docker compose up -d"`
  - MacBook agent 재시작: `lsof -ti :3098 | xargs kill -9; sleep 1; cd /Users/sbbae/project/session-dashboard && ./install/agent.sh --start`
  - 배포 후 health check 및 검증

  **Must NOT do**:
  - 코드 변경 금지 (배포만)
  - agent restart 전 `npm run build` 는 Task 3에서 이미 완료

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 커맨드 실행만. 코드 변경 없음.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (Task 3 이후)
  - **Blocks**: F1, F2
  - **Blocked By**: Task 3

  **References**:
  - Production server: `sbbae@192.168.0.2:~/project/session-dashboard`
  - Agent restart: `./install/agent.sh --start` (port 3098)
  - Docker: `docker compose build --no-cache && docker compose up -d`

  **Acceptance Criteria**:
  - [ ] `curl -s http://192.168.0.2:3097/api/sessions | python3 -c "..."` — 서버 응답 정상
  - [ ] `curl -s http://localhost:3098/health` — agent healthy

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 배포 후 서비스 정상 확인
    Tool: Bash (curl)
    Steps:
      1. curl -s http://localhost:3098/health → status: ok
      2. curl -s http://192.168.0.2:3097/api/sessions → sessions 배열 비어있지 않음
      3. 15초 대기 후 세션 목록에서 title=null인 세션 수 확인
    Expected Result: health ok, sessions.length > 0
    Evidence: .sisyphus/evidence/task-4-deploy-verify.txt

  Scenario: null-title 스캔 동작 확인
    Tool: Bash (curl)
    Preconditions: agent 재시작 후 30초 이상 경과
    Steps:
      1. curl -s http://localhost:3098/proxy/sessions-all | python3 -c "
         import json, sys
         data = json.load(sys.stdin)
         sessions = data['sessions']
         null_count = sum(1 for s in sessions.values() if not s.get('title'))
         total = len(sessions)
         print(f'Total: {total}, null-title: {null_count}')"
    Expected Result: null-title 세션 수가 이전보다 감소 (스캔이 backfill 중)
    Evidence: .sisyphus/evidence/task-4-null-title-count.txt
  ```

  **Commit**: NO (배포만)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 2 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run test). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality + Regression** — `unspecified-high`
  Run `npx tsc --noEmit` + `npx vitest run`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code. Check timer cleanup in `stop()`. Verify `session-cache.ts` stays under 800 lines. Verify new prepared statements follow constructor pattern.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Lines [N] | VERDICT`

---

## Commit Strategy

| # | Message | Files | Pre-commit |
|---|---------|-------|-----------|
| 1 | `feat(agent): add null-title query to SessionStore` | `session-store.ts`, `session-store.test.ts` | `npx vitest run src/__tests__/session-store.test.ts` |
| 2 | `fix(agent): add retry + periodic scan for null-title sessions` | `session-cache.ts`, `session-cache.test.ts` | `npx vitest run src/__tests__/session-cache.test.ts` |
| 3 | `chore: full regression + deploy` | — | `npx vitest run && npx tsc --noEmit` |

---

## Success Criteria

### Verification Commands
```bash
cd agent && npx vitest run                    # Expected: 248+ tests pass (240 existing + 8 new)
cd agent && npx tsc --noEmit                  # Expected: clean, no errors
wc -l agent/src/session-cache.ts              # Expected: <850 lines
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (agent + server)
- [ ] Production deploy complete
- [ ] Forked session title visible within 15s
