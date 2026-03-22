# Session Time Range Filter

## TL;DR

> **Quick Summary**: Dashboard 사이드바의 Sessions 목록에 `1d | 7d | 30d` 시간 범위 필터를 추가합니다. Agent의 캐시 TTL을 30일로 확장하고, 프론트엔드에서 client-side 필터링 + localStorage 영속화를 구현합니다.
> 
> **Deliverables**:
> - Agent 캐시 상수 변경 (TTL 30d, MAX_CACHE_SIZE 2000, bootstrap limit 2000)
> - 프론트엔드 time range 스토어 (localStorage 영속화)
> - Sessions 사이드바에 세그먼트 버튼 UI (`1d | 7d | 30d`)
> - `$derived` 필터 체인에 time range 필터 추가
> 
> **Estimated Effort**: Short (3-4시간)
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 0 (Worktree) → Task 1 (Agent 상수) → Task 3 (UI) → Task 4 (통합)
> **Worktree**: `feat/session-timerange-filter` branch → `/Users/sbbae/project/session-dashboard-timerange`

---

## Context

### Original Request
Dashboard 메뉴에서 표시되는 세션 갯수가 적다. 검색 기능처럼 1일/7일/30일로 시간 범위를 선택할 수 있는 기능을 추가하되, 일자 선택이 프론트 또는 백엔드에 저장되도록 해달라.

### Interview Summary
**Key Discussions**:
- 현재 Agent의 SSE 캐시 TTL이 24시간이라 그 이상의 세션은 보이지 않음
- Ghost 필터 (title=null & apiStatus=null)도 idle 세션을 제거
- 프로젝트에 localStorage 사용 전례 없음 — 새 패턴 도입 필요
- TimelinePage의 preset 버튼 UI가 가장 가까운 참고 패턴

**Research Findings**:
- Agent `session-cache.ts`의 `TTL_MS=86_400_000` (24h)와 `MAX_CACHE_SIZE=500`이 근본 원인
- `checkDeletedSessions()`과 `bootstrapProject()`에 하드코딩된 `limit=500`이 있어, MAX_CACHE_SIZE 증가 시 함께 변경 필요
- SSE는 매 2초마다 전체 sessions 배열을 broadcast — 5000개 시 ~2.5MB/push로 과다
- 서버의 `/api/sessions` 엔드포인트에 `?timeRange=` 추가는 불필요 (SSE가 2초마다 REST 데이터를 대체)

### Metis Review
**Identified Gaps** (addressed):
- SSE payload 크기 제한: MAX_CACHE_SIZE를 5000 대신 2000으로 축소 → ~1MB/push 허용 범위
- `limit=500` 하드코딩 2곳: `checkDeletedSessions()` (line 582)와 `bootstrapProject()` (line 765)도 함께 업데이트
- Active 세션 bypass: busy/retry 상태 세션은 시간 범위 무관하게 항상 표시
- `lastActivityTime=0` 가드: 메타데이터 미수신 신규 세션은 항상 표시
- 서버사이드 `?timeRange=` 파라미터: scope creep으로 판단, 제거

---

## Work Objectives

### Core Objective
Dashboard Sessions 사이드바에 시간 범위 필터(1d/7d/30d)를 추가하여 사용자가 원하는 기간의 세션을 볼 수 있게 하고, 선택 값을 localStorage에 영속화한다.

### Concrete Deliverables
- `agent/src/session-cache.ts`: TTL/MAX_CACHE_SIZE/limit 상수 변경
- `server/frontend/src/lib/stores/filter.svelte.ts`: timeRange 스토어 + localStorage
- `server/frontend/src/components/ActiveSessions.svelte`: 세그먼트 버튼 UI + $derived 필터

### Definition of Done
- [ ] 1d/7d/30d 버튼이 Sessions 패널 헤더에 표시됨
- [ ] 버튼 클릭 시 세션 목록이 해당 기간으로 필터됨
- [ ] 페이지 새로고침 후에도 선택한 time range가 유지됨
- [ ] busy/retry 상태 세션은 시간 범위 무관하게 항상 표시됨
- [ ] `npm test` (agent) 통과
- [ ] `npm test` (server/frontend) 통과
- [ ] Playwright 스모크 테스트 통과

### Must Have
- 1d/7d/30d 세그먼트 버튼 (기존 source-filter 디자인과 일관된 스타일)
- localStorage 영속화 (키: `session-dashboard:timeRange`)
- 기본값 `1d` (현재 24h 동작과 동일)
- busy/retry 세션 bypass (활성 작업은 숨기지 않음)
- `lastActivityTime <= 0` 가드 (신규 세션 보호)

### Must NOT Have (Guardrails)
- 서버사이드 `/api/sessions` 에 `?timeRange=` 파라미터 추가 금지 (SSE가 2초마다 대체하므로 불필요)
- SSE broadcast 메커니즘 변경 금지 (client-side 필터링으로 충분)
- `timeline-utils.ts`의 `TimeRangePreset` 타입 수정 금지 (다른 용도)
- `getTimeRange()` 함수 재사용 금지 (다른 preset 세트)
- virtual scrolling 추가 금지 (필터 후 <100개 세션)
- 서버사이드 time range 상태 관리 금지 (순수 프론트엔드 필터)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest for both agent and server/frontend, Playwright for e2e)
- **Automated tests**: YES (TDD — tests first for agent constants, tests-after for UI)
- **Framework**: vitest (unit), Playwright (e2e)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot
- **Agent/Backend**: Use Bash (npm test) — Run test suites, compare output
- **Library/Module**: Use Bash (vitest) — Import, call functions, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Pre-requisite — worktree setup):
└── Task 0: Git worktree 생성 + 초기 설정 [quick]

Wave 1 (After Wave 0 — agent + frontend store, PARALLEL):
├── Task 1: Agent 캐시 상수 변경 (TTL, MAX_CACHE_SIZE, bootstrap limits) [quick]
├── Task 2: Frontend timeRange 스토어 + localStorage 영속화 [quick]
└── (No dependencies between Task 1 and Task 2)

Wave 2 (After Wave 1 — UI + integration):
├── Task 3: ActiveSessions.svelte 세그먼트 버튼 + $derived 필터 (depends: Task 2) [visual-engineering]
└── Task 4: 통합 테스트 + Playwright 스모크 테스트 (depends: Task 1, 2, 3) [quick]

Wave FINAL (After ALL tasks — verification):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 0 → Task 1 → Task 3 → Task 4 → F1-F4
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 2 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 0 | — | 1, 2, 3, 4, F1-F4 |
| 1 | 0 | 4, F1-F4 |
| 2 | 0 | 3, 4, F1-F4 |
| 3 | 2 | 4, F1-F4 |
| 4 | 1, 2, 3 | F1-F4 |
| F1-F4 | 1, 2, 3, 4 | — |

### Agent Dispatch Summary

- **Wave 0**: 1 task — T0 → `quick`
- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `quick`
- **Wave 2**: 2 tasks — T3 → `visual-engineering`, T4 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 0. Git Worktree 생성 및 초기 설정

  **What to do**:
  - 메인 브랜치(`main`)에서 새 feature 브랜치와 worktree 생성:
    ```bash
    cd /Users/sbbae/project/session-dashboard
    git worktree add -b feat/session-timerange-filter /Users/sbbae/project/session-dashboard-timerange main
    ```
  - worktree 경로로 이동 후 npm install 실행:
    ```bash
    cd /Users/sbbae/project/session-dashboard-timerange
    npm install --prefix agent
    npm install --prefix server
    npm install --prefix server/frontend
    ```
  - 빌드 검증:
    ```bash
    cd /Users/sbbae/project/session-dashboard-timerange/agent && npm run build
    cd /Users/sbbae/project/session-dashboard-timerange/server && npm run build
    ```
  - **이후 모든 Task (1~4, F1~F4)는 worktree 경로에서 작업**:
    - 작업 디렉토리: `/Users/sbbae/project/session-dashboard-timerange`
    - 원본 디렉토리: `/Users/sbbae/project/session-dashboard` (건드리지 말 것)

  **Must NOT do**:
  - 원본 `/Users/sbbae/project/session-dashboard` 디렉토리의 파일 수정 금지
  - main 브랜치에 직접 커밋 금지
  - 기존 worktree가 있다면 삭제하지 말 것

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: git 명령어 + npm install 실행. 간단한 환경 설정.
  - **Skills**: [`git-master`]
    - `git-master`: git worktree 생성, 브랜치 관리

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0 (prerequisite for all)
  - **Blocks**: Task 1, 2, 3, 4, F1-F4
  - **Blocked By**: None (first task)

  **References**:

  **Pattern References** (existing worktree convention):
  - 기존 worktree 패턴: `/Users/sbbae/project/session-dashboard-<short-name>` + `feat/<feature-name>` 브랜치
  - 현재 main commit: `9ec9703`

  **WHY Each Reference Matters**:
  - worktree 경로 패턴을 기존 컨벤션에 맞춰야 함
  - main에서 분기해야 최신 코드 기반으로 작업 가능

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Worktree 생성 및 브랜치 확인
    Tool: Bash
    Preconditions: /Users/sbbae/project/session-dashboard가 git repo
    Steps:
      1. ls -la /Users/sbbae/project/session-dashboard-timerange/
      2. Assert 디렉토리 존재 + agent/, server/ 디렉토리 포함
      3. cd /Users/sbbae/project/session-dashboard-timerange && git branch --show-current
      4. Assert 출력이 "feat/session-timerange-filter"
      5. git log -1 --format='%h' main
      6. Assert worktree의 HEAD가 main의 최신 커밋과 일치
    Expected Result: worktree가 올바른 브랜치와 경로에 생성됨
    Failure Indicators: 디렉토리 미존재, 브랜치명 불일치
    Evidence: .sisyphus/evidence/task-0-worktree-created.txt

  Scenario: 빌드 성공 확인
    Tool: Bash
    Preconditions: worktree에서 npm install 완료
    Steps:
      1. cd /Users/sbbae/project/session-dashboard-timerange/agent && npm run build
      2. Assert exit code 0
      3. cd /Users/sbbae/project/session-dashboard-timerange/server && npm run build
      4. Assert exit code 0
    Expected Result: agent, server 빌드 성공
    Failure Indicators: exit code != 0, 컴파일 에러
    Evidence: .sisyphus/evidence/task-0-build-success.txt
  ```

  **Commit**: NO (환경 설정 — 코드 변경 없음)

- [ ] 1. Agent 캐시 상수 변경 (TTL 30d, MAX_CACHE_SIZE 2000, bootstrap limit 2000)

  **What to do**:
  > ⚠️ **작업 경로**: `/Users/sbbae/project/session-dashboard-timerange` (worktree)
  - `agent/src/session-cache.ts`의 상수 3개 변경:
    - `TTL_MS`: `86_400_000` (24h) → `2_592_000_000` (30d)
    - `MAX_CACHE_SIZE`: `500` → `2000`
  - 같은 파일 내 하드코딩된 `limit=500` 2곳 변경:
    - `checkDeletedSessions()` 내 `${baseUrl}/session?directory=${dir}&limit=500` → `limit=2000` (약 line 582)
    - `bootstrapProject()` 내 `${baseUrl}/session?directory=${encodedDir}&limit=500` → `limit=2000` (약 line 765)
  - 기존 eviction 테스트가 통과하는지 확인
  - 새 테스트 추가: 25일 전 updatedAt을 가진 세션이 eviction에서 살아남는지 검증

  **Must NOT do**:
  - `EVICTION_INTERVAL_MS` (60초) 변경 금지
  - `HEARTBEAT_TIMEOUT_MS` 변경 금지
  - `PROMPT_MAX_LENGTH` 변경 금지
  - evict() 함수의 로직 자체를 변경하지 말 것 — 상수만 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 상수 값 4개 변경 + 테스트 1개 추가. 단순 수정 작업.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `cleanup-after-test`: 테스트 정리가 아닌 테스트 추가 작업

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 4
  - **Blocked By**: Task 0 (worktree 생성 필요)

  **References**:

  **Pattern References** (existing code to follow):
  - `agent/src/session-cache.ts:76-78` — 현재 `TTL_MS`, `MAX_CACHE_SIZE` 상수 정의 위치
  - `agent/src/session-cache.ts:864-878` — `evict()` 함수: TTL 기반 삭제 + MAX_CACHE_SIZE 초과 시 오래된 것부터 삭제
  - `agent/src/session-cache.ts:568-600` — `checkDeletedSessions()`의 `fetchAllOcServeSessionIds()`: limit=500 하드코딩 위치
  - `agent/src/session-cache.ts:759-858` — `bootstrapProject()`: limit=500 하드코딩 위치

  **Test References** (testing patterns to follow):
  - `agent/src/__tests__/session-store.test.ts` — SessionStore evict() 테스트 패턴 (있다면)

  **WHY Each Reference Matters**:
  - `session-cache.ts:76-78`: 변경할 상수의 정확한 위치
  - `session-cache.ts:864-878`: evict() 로직이 TTL_MS와 MAX_CACHE_SIZE를 어떻게 사용하는지 파악
  - `session-cache.ts:568-600`: `limit=500`을 변경하지 않으면 `checkDeletedSessions()`가 500개 넘는 유효 세션을 삭제하는 버그 발생
  - `session-cache.ts:759-858`: `limit=500`을 변경하지 않으면 부트스트랩 시 500개까지만 로드되어 30일 데이터 부족

  **Acceptance Criteria**:

  **Tests:**
  - [ ] `cd agent && npm test` → PASS (기존 테스트 + 새 eviction 테스트)
  - [ ] 새 테스트: updatedAt이 25일 전인 세션이 evict() 후에도 존재
  - [ ] 새 테스트: 2001개 세션 삽입 후 evict() 실행 → 2000개로 감소

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: TTL 30d 상수 변경 확인
    Tool: Bash (grep)
    Preconditions: agent/src/session-cache.ts 파일 존재
    Steps:
      1. grep "TTL_MS" agent/src/session-cache.ts
      2. Assert 값이 2_592_000_000 (30일) 으로 변경됨
      3. grep "MAX_CACHE_SIZE" agent/src/session-cache.ts
      4. Assert 값이 2000으로 변경됨
    Expected Result: 두 상수 모두 새 값으로 변경됨
    Failure Indicators: 이전 값(86_400_000, 500) 이 여전히 존재
    Evidence: .sisyphus/evidence/task-1-constants-verified.txt

  Scenario: limit=500 하드코딩 제거 확인
    Tool: Bash (grep)
    Preconditions: agent/src/session-cache.ts 파일 존재
    Steps:
      1. grep -n "limit=500" agent/src/session-cache.ts
      2. Assert 결과가 비어있음 (모두 limit=2000으로 변경됨)
    Expected Result: "limit=500" 문자열이 agent/src/session-cache.ts에 없음
    Failure Indicators: "limit=500" 가 1건 이상 검색됨
    Evidence: .sisyphus/evidence/task-1-limit-500-removed.txt

  Scenario: Agent 테스트 스위트 통과
    Tool: Bash (npm test)
    Preconditions: agent/ 디렉토리에서 실행
    Steps:
      1. cd agent && npm test
      2. Assert exit code 0
      3. Assert 0 failures
    Expected Result: 모든 테스트 통과 (기존 + 새로 추가된 eviction 테스트)
    Failure Indicators: exit code != 0 또는 FAIL 키워드 출력
    Evidence: .sisyphus/evidence/task-1-agent-tests.txt
  ```

  **Commit**: YES
  - Message: `feat(agent): increase session cache TTL to 30d and size to 2000`
  - Files: `agent/src/session-cache.ts`, `agent/src/__tests__/session-cache.test.ts` (또는 session-store.test.ts)
  - Pre-commit: `cd agent && npm test`

- [ ] 2. Frontend timeRange 스토어 + localStorage 영속화

  **What to do**:
  > ⚠️ **작업 경로**: `/Users/sbbae/project/session-dashboard-timerange` (worktree)
  - `server/frontend/src/lib/stores/filter.svelte.ts`에 추가:
    - 타입: `export type SessionTimeRange = '1d' | '7d' | '30d';`
    - 상수: `const TIME_RANGE_MS: Record<SessionTimeRange, number> = { '1d': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };`
    - localStorage 키: `const STORAGE_KEY = 'session-dashboard:timeRange';`
    - 초기값 로드: localStorage에서 읽기 (try/catch), 없으면 `'1d'`
    - `$state<SessionTimeRange>` + getter/setter
    - setter에서 localStorage에 저장 (try/catch)
    - 순수 필터 헬퍼 함수 export: `filterByTimeRange(sessions, timeRange)` — 테스트 가능하게 분리
  - 필터 헬퍼 함수 로직:
    - `lastActivityTime <= 0` → 항상 표시 (신규 세션 보호)
    - `apiStatus === 'busy' || apiStatus === 'retry'` → 항상 표시 (활성 작업 bypass)
    - 나머지: `lastActivityTime >= (Date.now() - TIME_RANGE_MS[timeRange])`

  **Must NOT do**:
  - `timeline-utils.ts`의 `TimeRangePreset` 타입 수정 금지
  - `getTimeRange()` 함수 재사용 금지 (다른 preset 세트)
  - 서버사이드 API 변경 금지
  - 기존 `selectedSessionId`, `sourceFilter` 상태에 영향 주지 말 것

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일(filter.svelte.ts)에 타입, 상수, 스토어, 헬퍼 함수 추가. 간단한 작업.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: UI 작업 아님, 순수 로직

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3, Task 4
  - **Blocked By**: Task 0 (worktree 생성 필요)

  **References**:

  **Pattern References** (existing code to follow):
  - `server/frontend/src/lib/stores/filter.svelte.ts:1-24` — 전체 파일. `$state` + getter/setter 패턴. 새 timeRange 상태를 동일한 패턴으로 추가
  - `server/frontend/src/lib/stores/dismissed.svelte.ts:1-43` — 독립 필터 스토어 패턴 참고 (Map 기반이지만 구조 유사)
  - `server/frontend/src/lib/stores/machine.svelte.ts:26-31` — `selectMachine()`의 콜백 패턴 (필요 시 참고)

  **API/Type References**:
  - `server/frontend/src/types.ts:16` — `DashboardSession` 타입: `lastActivityTime: number`, `apiStatus: string | null` 필드 확인

  **External References**:
  - MDN Web Docs: `localStorage.getItem()` / `setItem()` — try/catch 패턴 (incognito 모드 대응)

  **WHY Each Reference Matters**:
  - `filter.svelte.ts`: 동일 파일에 추가하므로 기존 패턴을 정확히 따라야 함
  - `types.ts:DashboardSession`: 필터 함수가 사용할 필드 (`lastActivityTime`, `apiStatus`)의 타입 확인
  - localStorage MDN: incognito 모드에서 `setItem()`이 QuotaExceededError를 던질 수 있으므로 try/catch 필수

  **Acceptance Criteria**:

  **Tests:**
  - [ ] `filterByTimeRange()` 유닛 테스트: 7일 전 세션 + '1d' 범위 → 제외됨
  - [ ] `filterByTimeRange()` 유닛 테스트: 3일 전 세션 + '7d' 범위 → 포함됨
  - [ ] `filterByTimeRange()` 유닛 테스트: busy 세션 (40일 전) + '30d' 범위 → bypass로 포함됨
  - [ ] `filterByTimeRange()` 유닛 테스트: `lastActivityTime=0` 세션 → 항상 포함됨
  - [ ] localStorage 영속화: setter 호출 → `localStorage.getItem` 결과 일치

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: localStorage 영속화 동작 확인
    Tool: Playwright
    Preconditions: http://localhost:3097 접속 가능
    Steps:
      1. page.goto('http://localhost:3097')
      2. page.waitForSelector('[data-testid="active-sessions"]')
      3. page.click('[data-testid="time-range-7d"]')
      4. 브라우저에서 page.evaluate(() => localStorage.getItem('session-dashboard:timeRange'))
      5. Assert 반환값 === '"7d"' 또는 '7d'
      6. page.reload()
      7. page.waitForSelector('[data-testid="time-range-7d"]')
      8. Assert '[data-testid="time-range-7d"]' 가 active 클래스를 가짐
    Expected Result: 7d 선택 후 새로고침해도 7d가 선택된 상태
    Failure Indicators: 새로고침 후 1d로 리셋됨
    Evidence: .sisyphus/evidence/task-2-localstorage-persistence.png

  Scenario: filterByTimeRange 순수 함수 검증
    Tool: Bash (vitest)
    Preconditions: server/ 디렉토리에서 실행
    Steps:
      1. cd server && npm test -- --reporter=verbose
      2. Assert 'filterByTimeRange' 관련 테스트 전부 PASS
    Expected Result: 모든 필터 로직 테스트 통과
    Failure Indicators: FAIL 키워드 또는 assertion error
    Evidence: .sisyphus/evidence/task-2-filter-tests.txt
  ```

  **Commit**: YES
  - Message: `feat(frontend): add time range filter store with localStorage persistence`
  - Files: `server/frontend/src/lib/stores/filter.svelte.ts`
  - Pre-commit: `cd server && npm test`

- [ ] 3. ActiveSessions.svelte 세그먼트 버튼 + $derived 필터

  **What to do**:
  > ⚠️ **작업 경로**: `/Users/sbbae/project/session-dashboard-timerange` (worktree)
  - `server/frontend/src/components/ActiveSessions.svelte` 수정:
    - import 추가: `getSessionTimeRange`, `setSessionTimeRange`, `filterByTimeRange`, `type SessionTimeRange` from filter store
    - `let timeRange = $derived(getSessionTimeRange());` 추가
    - `topLevelSessions` 의 `$derived` 체인에 time range 필터 추가:
      ```typescript
      let topLevelSessions = $derived(
        filterByTimeRange(
          sessions
            .filter(s => !machineFilter || s.machineId === machineFilter)
            .filter(s => { /* source filter */ })
            .filter(s => !s.parentSessionId),
          timeRange
        )
      );
      ```
    - Sessions 패널 내부, 세션 리스트 위에 세그먼트 버튼 추가:
      ```html
      <div class="time-range-filter" data-testid="time-range-filter">
        {#each (['1d', '7d', '30d'] as const) as range}
          <button
            class="range-btn"
            class:active={timeRange === range}
            data-testid="time-range-{range}"
            onclick={() => setSessionTimeRange(range)}
          >{range}</button>
        {/each}
      </div>
      ```
    - CSS 스타일: 기존 `source-filter-btn` 스타일과 동일한 디자인 (pill 형태, accent 색상)
    - 버튼 위치: `<h2>Sessions</h2>` 아래, 세션 리스트 위

  **Must NOT do**:
  - App.svelte의 source-filter 영역에 넣지 말 것 (Sessions 패널 내부에 배치)
  - 기존 `topLevelSessions` 필터 체인의 순서를 변경하지 말 것 (time range는 마지막에 적용)
  - 기존 CSS 변수를 변경하지 말 것 (새 클래스만 추가)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI 컴포넌트 수정, CSS 스타일링, Svelte 반응형 바인딩 작업
  - **Skills**: [`ui-ux-pro-max`]
    - `ui-ux-pro-max`: 버튼 스타일링, 세그먼트 컨트롤 디자인, Svelte + Tailwind 패턴
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: 새 페이지가 아닌 기존 컴포넌트 수정이므로 과잉

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Task 4
  - **Blocked By**: Task 2 (filter store 필요)

  **References**:

  **Pattern References** (existing code to follow):
  - `server/frontend/src/components/ActiveSessions.svelte:67-76` — 현재 `topLevelSessions` $derived 필터 체인. time range 필터를 여기에 추가
  - `server/frontend/src/components/ActiveSessions.svelte:100-105` — 세션 리스트 렌더링 시작점. 버튼을 이 위에 배치
  - `server/frontend/src/App.svelte:147-163` — `source-filter` 버튼 그룹의 HTML/CSS 패턴 (pill 버튼, `class:active`, 동일 스타일)
  - `server/frontend/src/App.svelte:251-281` — `source-filter-btn` CSS 클래스 정의 (복사하여 `range-btn`으로 재사용)
  - `server/frontend/src/components/pages/TimelinePage.svelte:64-71` — time-range-control 버튼 그룹 HTML 패턴 참고

  **WHY Each Reference Matters**:
  - `ActiveSessions.svelte:67-76`: 기존 필터 체인에 time range를 추가할 정확한 위치
  - `App.svelte:251-281`: CSS 스타일을 일관되게 유지하기 위한 참고 (pill 형태, accent 색상 등)
  - `TimelinePage.svelte:64-71`: 버튼 그룹의 HTML 구조 참고 (`#each` 루프 + `class:active`)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 시간 범위 버튼 렌더링 및 기본값 확인
    Tool: Playwright
    Preconditions: http://localhost:3097 접속 가능, Dashboard 탭 활성
    Steps:
      1. page.goto('http://localhost:3097')
      2. page.waitForSelector('[data-testid="time-range-filter"]')
      3. const buttons = await page.locator('[data-testid="time-range-filter"] button').all()
      4. Assert buttons.length === 3
      5. Assert buttons 텍스트: '1d', '7d', '30d'
      6. Assert '[data-testid="time-range-1d"]' 가 active 클래스를 가짐 (기본값)
    Expected Result: 3개 버튼 렌더링, 1d가 기본 선택
    Failure Indicators: 버튼이 0개이거나 active 클래스 없음
    Evidence: .sisyphus/evidence/task-3-buttons-rendered.png

  Scenario: 시간 범위 변경 시 세션 목록 필터링
    Tool: Playwright
    Preconditions: Dashboard에 세션이 1개 이상 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. page.waitForSelector('[data-testid="active-sessions"]')
      3. const countBefore = await page.locator('.session-item').count()
      4. page.click('[data-testid="time-range-30d"]')
      5. await page.waitForTimeout(500)
      6. const countAfter = await page.locator('.session-item').count()
      7. Assert countAfter >= countBefore (30d는 1d보다 더 많거나 같은 세션)
    Expected Result: 30d 선택 시 세션 수가 1d보다 같거나 많음
    Failure Indicators: 30d 세션 수가 1d보다 적음
    Evidence: .sisyphus/evidence/task-3-filter-change.png

  Scenario: 기존 필터(machine, source)와 함께 동작
    Tool: Playwright
    Preconditions: multi-machine 설정, 세션 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. page.click('[data-testid="time-range-30d"]')
      3. source filter에서 'OpenCode' 클릭
      4. Assert 세션 목록이 OpenCode 소스 + 30일 범위로 필터됨
      5. source filter에서 'All' 클릭
      6. Assert 세션 수 증가
    Expected Result: time range와 source filter가 독립적으로 AND 조합 동작
    Failure Indicators: 필터 조합 시 세션이 모두 사라지거나 필터 무시됨
    Evidence: .sisyphus/evidence/task-3-combined-filters.png
  ```

  **Commit**: YES
  - Message: `feat(frontend): add 1d/7d/30d time range buttons to Sessions sidebar`
  - Files: `server/frontend/src/components/ActiveSessions.svelte`
  - Pre-commit: `cd server && npm test`

- [ ] 4. 통합 테스트 + 빌드 검증

  **What to do**:
  > ⚠️ **작업 경로**: `/Users/sbbae/project/session-dashboard-timerange` (worktree)
  - Agent 빌드 확인: `cd agent && npm run build`
  - Server 빌드 확인: `cd server && npm run build`
  - Frontend 빌드 확인: `cd server/frontend && npm run build`
  - Agent 테스트: `cd agent && npm test`
  - Server 테스트: `cd server && npm test`
  - TypeScript 타입 체크: `cd agent && npx tsc --noEmit` + `cd server && npx tsc --noEmit`

  **Must NOT do**:
  - 새로운 코드 작성 금지 (검증만 수행)
  - 테스트 실패 시 이 태스크에서 수정하지 말 것 (해당 태스크로 돌아가 수정)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 빌드 + 테스트 명령 실행만 수행
  - **Skills**: [`cleanup-after-test`]
    - `cleanup-after-test`: 테스트 후 빈 placeholder 파일 정리

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Tasks 1, 2, 3)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 1, Task 2, Task 3

  **References**:

  **Pattern References**:
  - `agent/package.json` — build/test 스크립트 확인
  - `server/package.json` — build/test 스크립트 확인
  - `server/frontend/package.json` — build 스크립트 확인

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 전체 빌드 성공
    Tool: Bash
    Preconditions: 모든 이전 태스크 완료
    Steps:
      1. cd agent && npm run build
      2. Assert exit code 0
      3. cd server && npm run build
      4. Assert exit code 0
    Expected Result: 빌드 에러 없음
    Failure Indicators: exit code != 0, TypeScript 컴파일 에러
    Evidence: .sisyphus/evidence/task-4-build-success.txt

  Scenario: 전체 테스트 통과
    Tool: Bash
    Preconditions: 빌드 성공
    Steps:
      1. cd agent && npm test
      2. Assert exit code 0, 0 failures
      3. cd server && npm test
      4. Assert exit code 0, 0 failures
    Expected Result: 모든 테스트 통과
    Failure Indicators: FAIL 키워드 또는 exit code != 0
    Evidence: .sisyphus/evidence/task-4-all-tests.txt
  ```

  **Commit**: NO (검증 전용)

---

## Final Verification Wave

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, check DOM). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` in agent/ and server/. Run `npm test` in both. Review all changed files for: `as any`/`@ts-ignore`, empty catches (except localStorage try/catch), console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (time range filter works WITH machine filter, source filter, dismiss). Test edge cases: empty state, rapid toggle, localStorage disabled simulation. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

> **모든 커밋은 worktree에서 수행**: `/Users/sbbae/project/session-dashboard-timerange`
> **브랜치**: `feat/session-timerange-filter`

- **Commit 1**: `feat(agent): increase session cache TTL to 30d and size to 2000` — `agent/src/session-cache.ts`, `npm test --prefix agent`
- **Commit 2**: `feat(frontend): add time range filter store with localStorage persistence` — `server/frontend/src/lib/stores/filter.svelte.ts`, `npm test --prefix server`
- **Commit 3**: `feat(frontend): add 1d/7d/30d time range buttons to Sessions sidebar` — `server/frontend/src/components/ActiveSessions.svelte`, `npm test --prefix server`

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm test         # Expected: all tests pass
cd server && npm test        # Expected: all tests pass
# Playwright: navigate to localhost:3097, verify 1d/7d/30d buttons visible
```

### Final Checklist
- [ ] 1d/7d/30d 버튼이 Sessions 패널에 표시됨
- [ ] 버튼 클릭 시 세션 목록이 해당 기간으로 필터됨
- [ ] localStorage에 `session-dashboard:timeRange` 키로 저장됨
- [ ] 새로고침 후 선택 값 유지됨
- [ ] busy/retry 세션은 항상 표시됨
- [ ] 기존 필터 (machine, source, dismiss) 와 함께 동작
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
