# OpenCode DB Enrichment — Session Dashboard 기능 확장

## TL;DR

> **Quick Summary**: OpenCode 정식 SQLite DB(`~/.local/share/opencode/opencode.db`)에서 토큰/비용, 코드 변경, 에이전트 타임라인, 프로젝트 그룹핑, 컨텍스트 복구 데이터를 읽어서 session-dashboard에 5개 새 페이지를 추가한다.
> 
> **Deliverables**:
> - Agent: `opencode-db-reader.ts` 모듈 + enrichment API 엔드포인트
> - Server: `EnrichmentModule` 백엔드 모듈 (agent 폴링 + SSE 전달)
> - Frontend: 네비게이션 확장 (Top Tab Bar) + 5개 새 페이지 컴포넌트
>   1. Token/Cost — 세션별/프로젝트별 토큰 사용량 & 비용
>   2. Code Impact — git-style 변경 요약 (+N -N files)
>   3. Agent Timeline — Swim Lane 시간축 세션 활동 시각화
>   4. Projects — 프로젝트별 세션 그룹핑 & 통계
>   5. Context Recovery — idle 세션 복구 정보 카드
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Tasks 4-8 (parallel) → Tasks 9-13 (parallel) → Final Verification

---

## Context

### Original Request
OpenCode 정식 SQLite DB(opencode.db)의 풍부한 데이터(토큰, 비용, 모델, 에이전트, 도구 사용, 코드 변경 요약 등)를 활용하여 session-dashboard를 enrich하고, 인간이 동시 작업 세션의 기억/컨텍스트를 관리하는 데 도움이 되는 기능을 추가한다.

### Interview Summary
**Key Discussions**:
- **기능 선택**: B(Token/Cost), C(Code Impact), D(Agent Timeline), F(Project Grouping), H(Context Recovery)
- **각 기능 별도 페이지**: 현재 단일 뷰에서 멀티 페이지 탭 구조로 확장
- **데이터 아키텍처**: Agent에서 opencode.db 직접 읽기 (better-sqlite3, readonly)
- **클라이언트**: Web (Svelte 5) only — TUI 제외
- **Timeline 형태**: Swim Lane (시간축 X, 세션별 레인 Y)
- **테스트 전략**: TDD (RED-GREEN-REFACTOR) with vitest + Playwright

**Research Findings**:
- opencode.db 위치: `~/.local/share/opencode/opencode.db` (679 세션, 15,828 메시지, 67,543 파트)
- message.data JSON: `role, modelID, providerID, agent, cost, tokens{input,output,reasoning,cache{read,write}}, variant, finish`
- part.data JSON: `type(text/tool/reasoning), tool, state{status,input,output,time{start,end}}`
- session: `summary_additions, summary_deletions, summary_files, summary_diffs, parent_id`
- events JSONL: `session.started, session.completed(duration, endReason), session.activity, tool.invocation`
- Agent 패턴: Fastify + better-sqlite3 + SSE (session-cache.ts → session-store.ts)
- Frontend 패턴: Svelte 5 runes, custom navigation store, CSS variables, SSE client

### Metis Review
**Identified Gaps** (addressed):
- **DB Concurrent Access**: opencode.db를 `readonly: true`로 열고, SQLITE_BUSY 시 retry + graceful degradation
- **Navigation Scaling**: ViewType 확장 (union type 추가), URL param `?view=xxx` 스킴, 기존 overview/detail 유지
- **Polling Storm 방지**: 단일 batch endpoint `GET /api/enrichment` + 개별 endpoint 병행
- **Claude Code 세션**: 새 페이지에서 OpenCode 데이터만 표시 (opencode.db에 Claude 데이터 없음)
- **Schema 변경 대응**: 모든 JSON 파싱에 try/catch, graceful degradation
- **Empty State**: 각 페이지별 opencode.db 없음 / 데이터 없음 상태 디자인

---

## Work Objectives

### Core Objective
OpenCode DB의 미활용 데이터를 session-dashboard의 5개 새 페이지로 시각화하여, 인간이 동시 작업 중 각 세션의 비용/영향/상태/맥락을 빠르게 파악할 수 있게 한다.

### Concrete Deliverables
- `agent/src/opencode-db-reader.ts` — OpenCode DB 읽기 모듈
- `agent/src/server.ts` — 5개 enrichment API 엔드포인트 추가
- `server/src/modules/enrichment/` — BackendModule (agent 폴링 + 캐시 + SSE)
- `server/frontend/src/components/pages/` — 5개 페이지 컴포넌트
- `server/frontend/src/lib/stores/enrichment.svelte.ts` — enrichment 데이터 스토어
- `server/frontend/src/lib/stores/navigation.svelte.ts` — ViewType 확장
- `server/frontend/src/components/TopNav.svelte` — 탭 네비게이션 컴포넌트

### Definition of Done
- [ ] Agent: `GET /api/enrichment` 엔드포인트가 5개 feature 데이터를 반환
- [ ] Server: EnrichmentModule이 agent를 폴링하고 SSE로 frontend에 전달
- [ ] Frontend: 6개 뷰(기존 Dashboard + 5 new) 간 탭 네비게이션 작동
- [ ] 각 페이지: 데이터 로드, empty state, error state 처리
- [ ] TDD: 모든 새 모듈 80%+ 커버리지
- [ ] E2E: Playwright로 각 페이지 네비게이션 + 데이터 표시 검증
- [ ] `npm test` (agent) + `npm test` (server) + `npm run build` (server/frontend) 전부 통과

### Must Have
- opencode.db를 `readonly: true`로만 접근 (절대 쓰기 금지)
- 기존 overview/session-detail 뷰 100% 하위 호환
- `OPENCODE_DB_PATH` 환경변수로 DB 경로 설정 가능
- opencode.db 없거나 잠겨 있을 때 graceful degradation (빈 데이터 반환, 500 에러 아님)
- 모든 새 엔드포인트에 기존 Bearer auth 적용
- CSS는 기존 CSS 변수 사용 (Tailwind 금지, 새 색상값 금지)
- 모든 JSON 파싱에 try/catch (스키마 버전 차이 대응)

### Must NOT Have (Guardrails)
- opencode.db에 쓰기 금지
- 라우터 라이브러리 설치 금지 (기존 navigation store 확장)
- 차트 라이브러리 설치 금지 (SVG 직접 사용)
- Session Tree 시각화 (Feature A — 별도 계획)
- Tool Usage 분석 (Feature E — 별도 계획)
- Cognitive Load 지표 (Feature G — 별도 계획)
- Claude Code 세션 데이터를 새 페이지에서 표시 (opencode.db에 없는 데이터)
- SSE 실시간 push for Token/Cost (폴링 충분, 히스토리 데이터)
- 모바일 반응형 Timeline (데스크탑 우선, 모바일은 간단 fallback)
- 머신 간 데이터 합산/통합 (머신별 표시, 머신 indicator 포함)
- 데이터 export/CSV 다운로드
- 기존 sidebar 레이아웃 변경 (Top Tab만 추가)
- agent/frontend 변경을 같은 커밋에 섞기

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest + Playwright)
- **Automated tests**: TDD (RED-GREEN-REFACTOR)
- **Framework**: vitest (agent, server), Playwright (e2e)
- **Each task follows**: RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Agent API**: Use Bash (curl) — Send requests, assert status + response fields
- **Frontend/UI**: Use Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot
- **Module/Unit**: Use Bash (vitest) — Run tests, verify pass/coverage

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — must complete first):
├── Task 1: OpenCode DB Reader 모듈 (agent) [deep]
├── Task 2: Navigation 확장 + TopNav 컴포넌트 (frontend) [visual-engineering]
└── Task 3: Enrichment Backend Module 스캐폴딩 (server) [unspecified-high]

Wave 2 (Feature Pages — MAX PARALLEL, 5개 동시):
├── Task 4: Token/Cost 페이지 — 풀스택 (depends: 1, 2, 3) [visual-engineering]
├── Task 5: Code Impact 페이지 — 풀스택 (depends: 1, 2, 3) [visual-engineering]
├── Task 6: Agent Timeline 페이지 — 풀스택 (depends: 1, 2, 3) [deep]
├── Task 7: Projects 페이지 — 풀스택 (depends: 1, 2, 3) [visual-engineering]
└── Task 8: Context Recovery 페이지 — 풀스택 (depends: 1, 2, 3) [visual-engineering]

Wave 3 (Integration & Polish):
├── Task 9: E2E 통합 테스트 (depends: 4-8) [unspecified-high]
└── Task 10: 빌드 검증 + 기존 기능 회귀 테스트 (depends: 4-8) [unspecified-high]

Wave FINAL (After ALL — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA — Playwright (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 6 (Timeline, most complex) → Task 9 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 5 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 4,5,6,7,8 | 1 |
| 2 | — | 4,5,6,7,8 | 1 |
| 3 | — | 4,5,6,7,8 | 1 |
| 4 | 1,2,3 | 9,10 | 2 |
| 5 | 1,2,3 | 9,10 | 2 |
| 6 | 1,2,3 | 9,10 | 2 |
| 7 | 1,2,3 | 9,10 | 2 |
| 8 | 1,2,3 | 9,10 | 2 |
| 9 | 4-8 | F1-F4 | 3 |
| 10 | 4-8 | F1-F4 | 3 |
| F1-F4 | 9,10 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `deep`, T2 → `visual-engineering`, T3 → `unspecified-high`
- **Wave 2**: **5** — T4,T5,T7,T8 → `visual-engineering`, T6 → `deep`
- **Wave 3**: **2** — T9,T10 → `unspecified-high`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. OpenCode DB Reader 모듈 (Agent)

  **What to do**:
  - TDD RED: `agent/src/__tests__/opencode-db-reader.test.ts` 작성 — `:memory:` DB에 opencode.db 스키마 재현, 테스트 데이터 삽입, 각 쿼리 메서드 검증
  - TDD GREEN: `agent/src/opencode-db-reader.ts` 구현:
    - `OpenCodeDBReader` 클래스 — `new Database(path, { readonly: true, fileMustExist: true })`
    - 생성자: 스키마 검증 (session, message, part 테이블 존재 확인), prepared statements 준비
    - `getSessionTokenStats(sessionId: string)` → `{ totalInput, totalOutput, totalReasoning, cacheRead, cacheWrite, totalCost, models: string[], agents: string[] }`
    - `getProjectTokenStats(projectId: string)` → 프로젝트 내 모든 세션 합산
    - `getAllProjectsTokenStats()` → 프로젝트별 토큰/비용 요약 (일별 그룹핑 포함)
    - `getSessionCodeImpact(sessionId: string)` → `{ additions, deletions, files, diffs }`
    - `getAllSessionsCodeImpact(options: { limit, offset, projectId? })` → 세션별 코드 변경 목록
    - `getSessionTimeline(options: { from, to, projectId? })` → 세션별 시작/종료/도구호출 시점 데이터
    - `getProjectSessions(projectId: string)` → 프로젝트 내 세션 목록 (메타데이터 포함)
    - `getAllProjects()` → 프로젝트 목록 + 세션 수 + 최근 활동
    - `getSessionRecoveryContext(sessionId: string)` → 마지막 5개 user 프롬프트, 마지막 도구 상태, 코드 변경 요약, todo 목록
    - `isAvailable()` → DB 파일 존재 + 읽기 가능 여부
    - `close()` → DB 연결 종료
  - TDD REFACTOR: prepared statements 최적화, 에러 핸들링 정리
  - `OPENCODE_DB_PATH` 환경변수 지원 (기본값: `~/.local/share/opencode/opencode.db`)
  - Agent server.ts에 `OpenCodeDBReader` 인스턴스 생성 + 5개 엔드포인트 등록:
    - `GET /api/enrichment/tokens?sessionId=xxx&projectId=xxx` → 토큰/비용 데이터
    - `GET /api/enrichment/impact?limit=50&projectId=xxx` → 코드 변경 영향
    - `GET /api/enrichment/timeline?from=xxx&to=xxx&projectId=xxx` → 타임라인 데이터
    - `GET /api/enrichment/projects` → 프로젝트 목록 + 통계
    - `GET /api/enrichment/recovery?sessionId=xxx` → 컨텍스트 복구 정보
    - `GET /api/enrichment` → 배치 엔드포인트 (모든 데이터 한번에)
  - 모든 엔드포인트에 기존 auth preHandler 적용
  - opencode.db 없거나 잠겨 있을 때: `{ data: null, available: false, error: 'DB not found' }` 반환

  **Must NOT do**:
  - opencode.db에 절대 쓰기 금지 (`readonly: true` 필수)
  - JSON 파싱 시 try/catch 없이 직접 접근 금지
  - WHERE 절 없이 전체 테이블 스캔 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SQLite 모듈 설계 + 복잡한 JSON 쿼리 + TDD → 깊은 사고 필요
  - **Skills**: [`mcp-context7`]
    - `mcp-context7`: better-sqlite3 API 참조 필요 시

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5, 6, 7, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `agent/src/session-store.ts:37-113` — SQLite 클래스 구조 패턴 (Database 생성, WAL, prepared statements, row-to-type helper)
  - `agent/src/session-cache.ts:56-69` — OcServeSessionMeta, OcServeMessage 인터페이스 (oc-serve 응답 구조 참고)
  - `agent/src/server.ts` — Fastify 라우트 등록 패턴, auth preHandler 적용 방식

  **API/Type References**:
  - `agent/src/types.ts` — AgentConfig (환경변수 매핑), ApiResponse wrapper
  - `agent/src/auth.ts` — Bearer auth preHandler 구현

  **Test References**:
  - `agent/src/__tests__/session-store.test.ts` — `:memory:` SQLite 테스트 패턴, `makeDetail()` 팩토리 함수

  **External References**:
  - better-sqlite3 readonly mode: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#new-daborabledatabasepath-options

  **WHY Each Reference Matters**:
  - `session-store.ts` — 동일한 SQLite 접근 패턴을 따라야 일관성 유지. 특히 생성자에서 prepared statements 준비하는 패턴
  - `types.ts` — `AgentConfig`에 `openCodeDbPath` 필드 추가 시 기존 구조 파악 필요
  - `auth.ts` — 새 엔드포인트에 동일한 인증 적용해야 함
  - `session-store.test.ts` — `:memory:` DB 테스트 패턴을 그대로 복제하되, opencode.db 스키마로

  **Acceptance Criteria**:

  - [ ] Test file created: `agent/src/__tests__/opencode-db-reader.test.ts`
  - [ ] `cd agent && npm test -- --reporter=verbose opencode-db-reader` → PASS (10+ tests, 0 failures)
  - [ ] Coverage: `cd agent && npm test -- --coverage` → opencode-db-reader.ts 80%+

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Happy path — enrichment tokens endpoint returns session stats
    Tool: Bash (curl)
    Preconditions: Agent running on port 3098 with valid API_KEY, opencode.db accessible
    Steps:
      1. curl -s -H "Authorization: Bearer $API_KEY" http://localhost:3098/api/enrichment/tokens | python3 -m json.tool
      2. Assert response has { data: { sessions: [...] }, available: true }
      3. Assert each session entry has: totalInput (number), totalOutput (number), totalCost (number), models (array)
    Expected Result: 200 OK with token stats for known sessions
    Failure Indicators: 500 error, empty data when DB has sessions, missing fields
    Evidence: .sisyphus/evidence/task-1-tokens-happy.json

  Scenario: DB missing — graceful degradation
    Tool: Bash (curl)
    Preconditions: Agent running, OPENCODE_DB_PATH set to non-existent path
    Steps:
      1. OPENCODE_DB_PATH=/tmp/nonexistent.db restart agent
      2. curl -s -H "Authorization: Bearer $API_KEY" http://localhost:3098/api/enrichment/tokens
      3. Assert response: { data: null, available: false, error: "DB not found" }
    Expected Result: 200 OK with available: false (NOT 500 error)
    Failure Indicators: 500 error, crash, unhandled exception
    Evidence: .sisyphus/evidence/task-1-db-missing.json

  Scenario: Batch endpoint returns all features
    Tool: Bash (curl)
    Preconditions: Agent running, opencode.db accessible
    Steps:
      1. curl -s -H "Authorization: Bearer $API_KEY" http://localhost:3098/api/enrichment
      2. Assert response has keys: tokens, impact, timeline, projects, recovery
    Expected Result: 200 OK with all 5 feature datasets
    Evidence: .sisyphus/evidence/task-1-batch.json
  ```

  **Commit**: YES
  - Message: `feat(agent): add opencode-db-reader module with readonly access and enrichment endpoints`
  - Files: `agent/src/opencode-db-reader.ts`, `agent/src/__tests__/opencode-db-reader.test.ts`, `agent/src/server.ts`, `agent/src/types.ts`
  - Pre-commit: `cd agent && npm test`

- [x] 2. Navigation 확장 + TopNav 컴포넌트 (Frontend)

  **What to do**:
  - TDD RED: Playwright e2e 테스트 — 탭 클릭으로 각 뷰 전환, URL 변경, 브라우저 back/forward 동작 검증
  - TDD GREEN:
    - `navigation.svelte.ts` 확장:
      - `ViewType`을 `'overview' | 'session-detail' | 'token-cost' | 'code-impact' | 'timeline' | 'projects' | 'context-recovery'`로 확장
      - `pushView(view: ViewType, params?: Record<string, string>)` 범용 함수 추가
      - URL 스킴: `?view=token-cost`, `?view=timeline`, etc. (기존 `?session=xxx`는 그대로 유지)
      - `popstate` 핸들러 확장 — `?view` 파라미터 파싱
      - `getCurrentView()`, `isPageView()` 등 헬퍼 함수
    - `TopNav.svelte` 컴포넌트 생성:
      - 탭 목록: Dashboard | Tokens | Impact | Timeline | Projects | Recovery
      - 현재 활성 탭 하이라이팅
      - 키보드 접근성 (tabindex, Enter/Space로 전환)
      - 기존 CSS 변수 사용 (컴팩트한 탭 바, 기존 헤더 아래)
    - `App.svelte` 수정:
      - TopNav 추가 (header 아래)
      - 기존 `{#if isDetail}` 로직은 완전히 유지
      - 새 `{#if}` 분기: 각 ViewType에 따라 해당 페이지 컴포넌트 렌더링
      - 각 페이지 컴포넌트는 빈 placeholder로 생성 (`<div data-testid="page-{name}">Coming soon</div>`)
    - 5개 placeholder 페이지 컴포넌트 생성:
      - `server/frontend/src/components/pages/TokenCostPage.svelte`
      - `server/frontend/src/components/pages/CodeImpactPage.svelte`
      - `server/frontend/src/components/pages/TimelinePage.svelte`
      - `server/frontend/src/components/pages/ProjectsPage.svelte`
      - `server/frontend/src/components/pages/ContextRecoveryPage.svelte`
  - TDD REFACTOR: 중복 제거, 타입 정리

  **Must NOT do**:
  - 라우터 라이브러리 설치 금지
  - 기존 overview/session-detail 동작 변경 금지
  - 기존 sidebar 레이아웃 변경 금지 (Top Tab만 추가)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 프론트엔드 네비게이션 + UI 컴포넌트 작업
  - **Skills**: [`ui-ux-pro-max`]
    - `ui-ux-pro-max`: 탭 네비게이션 UX 패턴 참조

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, with Tasks 1, 3)
  - **Blocks**: Tasks 4, 5, 6, 7, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/navigation.svelte.ts:1-89` — 현재 ViewType 정의, pushState/popstate 패턴 (이 파일을 확장)
  - `server/frontend/src/App.svelte:116-194` — 현재 뷰 분기 로직 ({#if isDetail} ... {:else} ...)
  - `server/frontend/src/components/MachineSelector.svelte` — 기존 헤더 내 컴포넌트 패턴 참조

  **API/Type References**:
  - `server/frontend/src/types.ts` — 기존 프론트엔드 타입 (새 enrichment 타입도 여기 추가)

  **Test References**:
  - `server/e2e/` — Playwright e2e 테스트 구조 및 config 참조

  **WHY Each Reference Matters**:
  - `navigation.svelte.ts` — 이 파일을 직접 확장해야 함. ViewType union 추가, pushView 함수 추가
  - `App.svelte` — 뷰 분기 로직에 새 조건부 렌더링 추가해야 함. 기존 구조를 이해하고 깨지지 않게
  - `app.css` — CSS 변수 이름과 값을 파악하여 TopNav 스타일링에 사용

  **Acceptance Criteria**:

  - [ ] `navigation.svelte.ts`에 7개 ViewType 정의
  - [ ] TopNav.svelte 렌더링, 탭 클릭으로 뷰 전환
  - [ ] URL에 `?view=token-cost` 반영, 새로고침 시 해당 뷰 복원
  - [ ] 브라우저 back/forward 정상 동작
  - [ ] 기존 `?session=xxx` 뷰 100% 동일 동작

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Tab navigation — click each tab and verify view change
    Tool: Playwright
    Preconditions: Frontend dev server running
    Steps:
      1. Navigate to http://localhost:5173 (or production port)
      2. Verify TopNav is visible with 6 tabs
      3. Click "Tokens" tab → assert URL contains ?view=token-cost
      4. Assert [data-testid="page-token-cost"] is visible
      5. Click "Dashboard" tab → assert URL has no ?view param
      6. Assert existing dashboard layout is visible
      7. Repeat for all 5 new tabs
    Expected Result: Each tab navigates to correct view, URL updates, content changes
    Failure Indicators: 404, blank page, URL not updating, existing views broken
    Evidence: .sisyphus/evidence/task-2-tab-navigation.png

  Scenario: Browser back/forward across views
    Tool: Playwright
    Preconditions: Frontend running
    Steps:
      1. Start at Dashboard (no ?view)
      2. Click "Timeline" → assert ?view=timeline
      3. Click "Projects" → assert ?view=projects
      4. Browser back → assert ?view=timeline
      5. Browser back → assert no ?view (Dashboard)
      6. Browser forward → assert ?view=timeline
    Expected Result: History navigation works correctly across all views
    Evidence: .sisyphus/evidence/task-2-back-forward.png

  Scenario: Deep link — direct URL access
    Tool: Playwright
    Preconditions: Frontend running
    Steps:
      1. Navigate directly to http://localhost:5173/?view=code-impact
      2. Assert [data-testid="page-code-impact"] is visible
      3. Assert "Impact" tab is highlighted in TopNav
    Expected Result: Direct URL access loads correct view
    Evidence: .sisyphus/evidence/task-2-deep-link.png

  Scenario: Existing session-detail view unchanged
    Tool: Playwright
    Preconditions: Frontend running, sessions available
    Steps:
      1. Navigate to Dashboard
      2. Click session detail button (›)
      3. Assert session detail view shows with "← 돌아가기"
      4. Assert URL has ?session=xxx
      5. Click back → overview restored
    Expected Result: Session detail flow identical to before
    Evidence: .sisyphus/evidence/task-2-session-detail-regression.png
  ```

  **Commit**: YES
  - Message: `feat(frontend): extend navigation to multi-page with TopNav tabs`
  - Files: `server/frontend/src/lib/stores/navigation.svelte.ts`, `server/frontend/src/components/TopNav.svelte`, `server/frontend/src/App.svelte`, `server/frontend/src/components/pages/*.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 3. Enrichment Backend Module 스캐폴딩 (Server)

  **What to do**:
  - TDD RED: `server/src/__tests__/enrichment-module.test.ts` — mock agent 응답으로 enrichment 데이터 변환/캐싱 검증
  - TDD GREEN:
    - `server/src/modules/enrichment/index.ts` — BackendModule 구현:
      - `registerRoutes(app)`: 프론트엔드용 API 엔드포인트 등록
        - `GET /api/enrichment/:machineId/tokens`
        - `GET /api/enrichment/:machineId/impact`
        - `GET /api/enrichment/:machineId/timeline`
        - `GET /api/enrichment/:machineId/projects`
        - `GET /api/enrichment/:machineId/recovery`
      - `start()`: MachineManager를 통해 agent의 enrichment 엔드포인트 폴링 시작
      - 폴링 간격: tokens/impact 60초, timeline/recovery 10초, projects 30초
      - 캐싱: 마지막 성공 응답 저장, agent 다운 시 캐시 반환
      - SSE 이벤트 발행: `enrichment.update` (프론트엔드에 새 데이터 알림)
    - `server/src/modules/enrichment/types.ts` — enrichment 데이터 타입 정의
    - Server `createServer()`에 EnrichmentModule 등록
    - SSEManager에 `enrichment.update` 이벤트 타입 추가
  - Agent가 enrichment 미지원 시 (404): graceful skip, 로그 남기고 빈 데이터 캐시

  **Must NOT do**:
  - 기존 ActiveSessionsModule, RecentPromptsModule 변경 금지
  - agent당 5개 별도 폴링 금지 (가능하면 batch endpoint 1개로)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 서버 사이드 모듈, 폴링 로직, 캐싱 전략
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5, 6, 7, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/active-sessions/index.ts` — BackendModule 구현 패턴 (registerRoutes, start, pollAll)
  - `server/src/machines/machine-manager.ts` — MachineManager API (pollAll, fetchFromMachine 등)
  - `server/src/sse/sse-manager.ts` — SSE 이벤트 발행 패턴 (broadcast)
  - `server/src/config/machines-config.ts` — machines.yml 설정 로딩 패턴

  **API/Type References**:
  - `server/src/modules/types.ts` — BackendModule 인터페이스 정의

  **Test References**:
  - `server/src/__tests__/` — 서버 테스트 패턴

  **WHY Each Reference Matters**:
  - `active-sessions/index.ts` — 정확히 같은 패턴으로 EnrichmentModule을 만들어야 함. 폴링 주기, 캐시 전략, SSE 발행 방식
  - `machine-manager.ts` — agent에서 데이터를 가져오는 방법 (fetchFromMachine 등)
  - `sse-manager.ts` — enrichment.update 이벤트를 어떻게 frontend에 push하는지

  **Acceptance Criteria**:

  - [ ] `server/src/modules/enrichment/index.ts` 생성, BackendModule 인터페이스 구현
  - [ ] `cd server && npm test` → PASS
  - [ ] EnrichmentModule이 createServer에 등록되어 서버 시작 시 폴링 시작

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Server proxies enrichment data from agent
    Tool: Bash (curl)
    Preconditions: Server running on :3097, Agent running on :3098
    Steps:
      1. curl -s http://localhost:3097/api/enrichment/macbook/projects
      2. Assert response has project list data
    Expected Result: Server returns enrichment data from agent
    Failure Indicators: 502, empty response, connection refused
    Evidence: .sisyphus/evidence/task-3-proxy.json

  Scenario: Agent unreachable — graceful degradation
    Tool: Bash (curl)
    Preconditions: Server running, agent stopped
    Steps:
      1. Stop agent
      2. curl -s http://localhost:3097/api/enrichment/macbook/tokens
      3. Assert response: cached data or { data: null, available: false }
    Expected Result: 200 with cached/empty data, NOT 502 or crash
    Evidence: .sisyphus/evidence/task-3-agent-down.json
  ```

  **Commit**: YES
  - Message: `feat(server): add enrichment backend module with agent polling and caching`
  - Files: `server/src/modules/enrichment/index.ts`, `server/src/modules/enrichment/types.ts`, `server/src/server.ts`
  - Pre-commit: `cd server && npm test`

- [x] 4. Token/Cost Analytics 페이지 — 풀스택

  **What to do**:
  - **목적**: 세션별/프로젝트별 토큰 사용량과 비용을 시각화하여 비용 감각을 제공
  - TDD RED: vitest로 enrichment store 테스트 + Playwright로 페이지 렌더링 테스트
  - TDD GREEN:
    - **Frontend Store**: `server/frontend/src/lib/stores/enrichment.svelte.ts`
      - `fetchTokenStats()` — `/api/enrichment/{machineId}/tokens` 호출
      - `getTokenStats()` → `$state` 기반 토큰 데이터
      - SSE `enrichment.update` 이벤트 수신 시 자동 갱신
    - **Frontend Page**: `TokenCostPage.svelte` placeholder를 실제 구현으로 교체
      - **요약 카드 영역**: 전체 합산 — 총 input/output/reasoning 토큰, 총 비용, 총 cache read/write
      - **프로젝트별 테이블**: 프로젝트명 | 세션 수 | Input | Output | Cache | Cost — 정렬 가능
      - **세션별 테이블**: 세션 title | Model | Agent | Input | Output | Cost — 클릭 시 세션 상세
      - **Empty state**: "OpenCode DB를 찾을 수 없습니다" 또는 "토큰 데이터 없음"
      - 모든 토큰 수: 1,234 → 1.2K → 1.2M 형식 포매팅
      - 비용: $0.0000 형식 (소수점 4자리)
      - `data-testid` 속성 필수: `page-token-cost`, `token-summary`, `project-table`, `session-table`
    - CSS: 기존 CSS 변수 사용, 테이블/카드 스타일 기존 패턴 따르기

  **Must NOT do**:
  - Chart.js 등 차트 라이브러리 설치 금지
  - Claude Code 세션 토큰 데이터 표시 금지 (opencode.db에 없음)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 데이터 테이블 + 요약 카드 UI 구현
  - **Skills**: [`ui-ux-pro-max`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with Tasks 5, 6, 7, 8)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/sessions.svelte.ts` — store 패턴 ($state, fetch 함수, getter)
  - `server/frontend/src/lib/stores/queries.svelte.ts` — 데이터 패칭 + SSE 갱신 패턴
  - `server/frontend/src/components/RecentPrompts.svelte` — 데이터 리스트 렌더링 + 필터링 패턴
  - `server/frontend/src/lib/api.ts` — API 호출 유틸리티
  - `server/frontend/src/lib/sse-client.ts` — SSE 이벤트 구독 패턴

  **API/Type References**:
  - `server/frontend/src/types.ts` — 기존 타입 정의 위치 (새 enrichment 타입도 여기 추가)

  **WHY Each Reference Matters**:
  - `sessions.svelte.ts` — enrichment store를 동일한 패턴으로 만들어야 App.svelte에서 일관되게 사용 가능
  - `RecentPrompts.svelte` — 테이블/리스트 렌더링 시 CSS 클래스와 구조 참조

  **Acceptance Criteria**:
  - [ ] TokenCostPage.svelte가 토큰 데이터를 테이블로 렌더링
  - [ ] 요약 카드에 총 토큰/비용 표시
  - [ ] Empty state 표시 (DB 없음 / 데이터 없음)
  - [ ] `cd server/frontend && npm run build` → 에러 없음

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Token page shows session token breakdown
    Tool: Playwright
    Preconditions: Full stack running, opencode.db with session data
    Steps:
      1. Navigate to http://localhost:3097/?view=token-cost
      2. Wait for [data-testid="token-summary"] to be visible (timeout: 10s)
      3. Assert summary shows total input tokens > 0
      4. Assert [data-testid="session-table"] has at least 1 row
      5. Assert each row has columns: session title, model, input, output, cost
      6. Screenshot
    Expected Result: Token data displayed with proper formatting (1.2K, $0.0012)
    Failure Indicators: Blank page, "0" for all values, loading spinner stuck
    Evidence: .sisyphus/evidence/task-4-tokens-happy.png

  Scenario: Token page — DB unavailable
    Tool: Playwright
    Preconditions: Full stack running, OPENCODE_DB_PATH set to nonexistent
    Steps:
      1. Navigate to http://localhost:3097/?view=token-cost
      2. Assert [data-testid="empty-state"] is visible
      3. Assert text contains "OpenCode DB" or "데이터 없음"
    Expected Result: Graceful empty state, no errors
    Evidence: .sisyphus/evidence/task-4-tokens-empty.png
  ```

  **Commit**: YES
  - Message: `feat: add token/cost analytics page (store + component)`
  - Files: `server/frontend/src/lib/stores/enrichment.svelte.ts`, `server/frontend/src/components/pages/TokenCostPage.svelte`, `server/frontend/src/types.ts`
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 5. Code Impact 페이지 — 풀스택

  **What to do**:
  - **목적**: 세션별 코드 변경 영향도를 git-style로 시각화 (+N -N files)
  - TDD RED → GREEN → REFACTOR:
    - **Frontend Page**: `CodeImpactPage.svelte` 구현
      - **세션별 코드 변경 리스트**: 세션 title | project | +additions -deletions | files 수 | 시간
      - **변경 바 시각화**: GitHub-style addition(초록)/deletion(빨강) bar (순수 CSS/SVG)
      - **정렬**: 시간순(기본), 변경량순, 프로젝트별
      - **필터**: 프로젝트별 필터링 (드롭다운)
      - **Empty state**: "코드 변경 기록 없음"
      - **Zero-change 세션**: additions=0, deletions=0인 세션은 회색으로 "변경 없음" 표시
      - `data-testid`: `page-code-impact`, `impact-list`, `impact-item`, `impact-bar`
    - enrichment store에 `fetchImpactData()`, `getImpactData()` 추가

  **Must NOT do**:
  - summary_diffs 내용 전체 표시 금지 (숫자 요약만)
  - 차트 라이브러리 금지

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`ui-ux-pro-max`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with Tasks 4, 6, 7, 8)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/RecentPrompts.svelte` — 리스트 아이템 렌더링 + CSS 패턴
  - `server/frontend/src/components/ActiveSessions.svelte:84-97` — status badge 스타일링 패턴

  **WHY Each Reference Matters**:
  - `RecentPrompts.svelte` — 유사한 리스트 UI 구조. CSS 클래스 네이밍, 패딩, 갭 등 동일하게
  - Badge 패턴 — additions/deletions을 색상 배지로 표시할 때 기존 스타일 활용

  **Acceptance Criteria**:
  - [ ] CodeImpactPage가 세션별 코드 변경 리스트 렌더링
  - [ ] GitHub-style addition/deletion bar 표시
  - [ ] 프로젝트별 필터 동작
  - [ ] `cd server/frontend && npm run build` → 에러 없음

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Impact page shows code changes per session
    Tool: Playwright
    Preconditions: Full stack, opencode.db with sessions having non-zero summary
    Steps:
      1. Navigate to http://localhost:3097/?view=code-impact
      2. Wait for [data-testid="impact-list"] (timeout: 10s)
      3. Assert at least 1 [data-testid="impact-item"] visible
      4. Assert item shows "+N -N" with green/red coloring
      5. Assert [data-testid="impact-bar"] has width proportional to changes
    Expected Result: Code impact data with visual bars
    Evidence: .sisyphus/evidence/task-5-impact-happy.png

  Scenario: Filter by project
    Tool: Playwright
    Preconditions: Full stack, multiple projects in DB
    Steps:
      1. Navigate to code-impact page
      2. Select a specific project from filter dropdown
      3. Assert all visible items belong to selected project
      4. Clear filter → all items shown
    Expected Result: Project filter correctly narrows results
    Evidence: .sisyphus/evidence/task-5-impact-filter.png
  ```

  **Commit**: YES
  - Message: `feat: add code impact page with git-style change visualization`
  - Files: `server/frontend/src/components/pages/CodeImpactPage.svelte`, enrichment store updates
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 6. Agent Timeline Swim Lane 페이지 — 풀스택

  **What to do**:
  - **목적**: 시간축 기반으로 모든 세션의 활동을 swim lane으로 시각화 — "지금 동시에 뭐가 돌고 있지?" 전체 그림 파악
  - TDD RED → GREEN → REFACTOR:
    - **Frontend Page**: `TimelinePage.svelte` 구현
      - **SVG 기반 Swim Lane 차트** (라이브러리 없이 순수 SVG):
        - Y축: 세션별 레인 (세션 title 레이블)
        - X축: 시간 (분 단위 눈금, 시간 레이블)
        - 각 세션 레인에 busy(파란색)/idle(회색) 구간을 색상 블록으로 표시
        - 도구 호출 시점: 작은 마커/dot (hover 시 도구 이름 tooltip)
        - 현재 시각 표시선 (빨간 점선)
      - **시간 범위 컨트롤**: Last 1h | 6h | 24h | 7d 버튼
      - **프로젝트 필터**: 드롭다운
      - **세션 레인 클릭**: 해당 세션의 상세 뷰로 이동
      - **반응형**: 수평 스크롤 for 긴 시간 범위
      - **Empty state**: "타임라인 데이터 없음"
      - `data-testid`: `page-timeline`, `timeline-svg`, `swim-lane`, `time-axis`, `time-range-control`
    - enrichment store에 `fetchTimelineData(from, to, projectId?)`, `getTimelineData()` 추가
    - SVG 렌더링 헬퍼 유틸: `server/frontend/src/lib/timeline-utils.ts`
      - `timeToX(timestamp, viewStart, viewEnd, svgWidth)` — 시간→X좌표 변환
      - `sessionToY(index, laneHeight)` — 세션 인덱스→Y좌표 변환
      - `formatTimeAxis(from, to)` — 눈금 레이블 생성

  **Must NOT do**:
  - D3, Chart.js 등 차트 라이브러리 금지 (순수 SVG)
  - 모바일 반응형 최적화 불필요 (데스크탑 우선, 단순 스크롤 fallback)
  - Tool Usage 상세 분석 금지 (Feature E — 별도)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SVG 기반 시각화 로직이 복잡. 시간-좌표 변환, 줌, 스크롤 등
  - **Skills**: [`ui-ux-pro-max`, `frontend-design`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with Tasks 4, 5, 7, 8)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/app.css` — CSS 변수 목록 (색상, 반경, 폰트)
  - `server/frontend/src/components/ActiveSessions.svelte:348-364` — 상태별 색상 패턴 (working=blue, idle=green)

  **External References**:
  - SVG in Svelte: Svelte는 네이티브 SVG 렌더링 지원 — `<svg>` 안에 `{#each}`로 rect/circle 생성

  **WHY Each Reference Matters**:
  - CSS 변수 — 타임라인 색상에 `--accent` (busy), `--success` (idle), `--error` (retry) 등 기존 값 활용
  - 상태 색상 — 세션 상태별 swim lane 색상을 기존 badge 색상과 일치시켜 시각적 일관성 유지

  **Acceptance Criteria**:
  - [ ] TimelinePage가 SVG swim lane 렌더링
  - [ ] 시간 범위 컨트롤 (1h/6h/24h/7d) 동작
  - [ ] 세션 레인에 busy/idle 구간 표시
  - [ ] 프로젝트 필터 동작
  - [ ] `cd server/frontend && npm run build` → 에러 없음

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Timeline shows session swim lanes
    Tool: Playwright
    Preconditions: Full stack, opencode.db with multiple sessions
    Steps:
      1. Navigate to http://localhost:3097/?view=timeline
      2. Wait for [data-testid="timeline-svg"] (timeout: 10s)
      3. Assert at least 1 [data-testid="swim-lane"] visible
      4. Assert [data-testid="time-axis"] has time labels
      5. Assert swim lane has colored segments (busy=blue, idle=gray)
      6. Screenshot full timeline
    Expected Result: Visual swim lane chart with time axis and session lanes
    Evidence: .sisyphus/evidence/task-6-timeline-happy.png

  Scenario: Time range control changes view
    Tool: Playwright
    Preconditions: Timeline page loaded
    Steps:
      1. Click "1h" button in [data-testid="time-range-control"]
      2. Assert timeline X axis shows last 1 hour range
      3. Click "24h" button
      4. Assert timeline X axis shows last 24 hours
    Expected Result: Time range switches correctly, swim lanes update
    Evidence: .sisyphus/evidence/task-6-timeline-range.png

  Scenario: Empty timeline
    Tool: Playwright
    Preconditions: Full stack, DB with no recent sessions
    Steps:
      1. Navigate to timeline page with filter set to empty project
      2. Assert [data-testid="empty-state"] visible
    Expected Result: "타임라인 데이터 없음" message shown
    Evidence: .sisyphus/evidence/task-6-timeline-empty.png
  ```

  **Commit**: YES
  - Message: `feat: add agent timeline swim-lane page with SVG visualization`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`, `server/frontend/src/lib/timeline-utils.ts`, enrichment store updates
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 7. Projects 그룹핑 페이지 — 풀스택

  **What to do**:
  - **목적**: 프로젝트별로 세션을 그룹핑하여 "어떤 프로젝트에서 뭘 하고 있는지" 구조적으로 파악
  - TDD RED → GREEN → REFACTOR:
    - **Frontend Page**: `ProjectsPage.svelte` 구현
      - **프로젝트 카드 그리드**: 각 프로젝트가 하나의 카드
        - 프로젝트명 (worktree의 마지막 2 경로 세그먼트)
        - 세션 수 (총 / 활성)
        - 최근 활동 시간 (relative time)
        - 총 토큰 사용량 (요약)
        - 총 코드 변경 (합산 +N -N)
      - **카드 클릭**: 해당 프로젝트의 세션 목록 accordion 펼침
        - 세션 title | status badge | 시작 시간 | 모델 | 에이전트
        - 세션 클릭 → session-detail 뷰로 이동
      - **정렬**: 최근 활동순(기본), 세션 수순, 토큰 사용량순
      - **Empty state**: "등록된 프로젝트 없음"
      - `data-testid`: `page-projects`, `project-card`, `project-sessions`, `session-row`
    - enrichment store에 `fetchProjectsData()`, `getProjectsData()` 추가

  **Must NOT do**:
  - 머신 간 프로젝트 합산 금지 (머신별 표시)
  - 프로젝트 설정/수정 UI 금지 (읽기 전용)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`ui-ux-pro-max`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with Tasks 4, 5, 6, 8)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:100-187` — 세션 카드 렌더링 패턴, CSS 스타일
  - `server/frontend/src/lib/utils.ts` — `relativeTime()` 유틸리티 함수

  **WHY Each Reference Matters**:
  - `ActiveSessions.svelte` — 프로젝트 카드 안의 세션 목록은 기존 세션 카드와 유사한 스타일이어야 시각적 일관성
  - `relativeTime()` — 최근 활동 시간 표시에 동일 함수 재사용

  **Acceptance Criteria**:
  - [ ] ProjectsPage가 프로젝트 카드 그리드 렌더링
  - [ ] 카드 클릭 시 세션 목록 accordion 펼침
  - [ ] 각 프로젝트 카드에 세션 수, 토큰, 코드 변경 요약 표시
  - [ ] `cd server/frontend && npm run build` → 에러 없음

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Projects page shows project cards
    Tool: Playwright
    Preconditions: Full stack, opencode.db with multiple projects
    Steps:
      1. Navigate to http://localhost:3097/?view=projects
      2. Wait for [data-testid="project-card"] (timeout: 10s)
      3. Assert at least 2 project cards visible
      4. Assert each card shows project name, session count, recent activity
      5. Click first project card → accordion expands
      6. Assert [data-testid="project-sessions"] shows session rows
    Expected Result: Project cards with stats and expandable session list
    Evidence: .sisyphus/evidence/task-7-projects-happy.png

  Scenario: Session click navigates to detail
    Tool: Playwright
    Preconditions: Projects page loaded, accordion expanded
    Steps:
      1. Click a session row within project accordion
      2. Assert navigation changes to session-detail view
      3. Assert URL has ?session=xxx
    Expected Result: Session detail view opens from project page
    Evidence: .sisyphus/evidence/task-7-projects-navigate.png
  ```

  **Commit**: YES
  - Message: `feat: add projects grouping page with accordion sessions`
  - Files: `server/frontend/src/components/pages/ProjectsPage.svelte`, enrichment store updates
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 8. Context Recovery 페이지 — 풀스택

  **What to do**:
  - **목적**: idle 세션을 resume할 때 "이 세션이 뭘 했었는지" 컨텍스트를 빠르게 복구하는 카드 제공
  - TDD RED → GREEN → REFACTOR:
    - **Frontend Page**: `ContextRecoveryPage.svelte` 구현
      - **Recovery 카드 리스트**: idle 세션만 표시 (busy/active 제외)
        - 세션 title
        - 프로젝트 경로 (마지막 2 세그먼트)
        - 마지막 활동 시간 (relative time)
        - **컨텍스트 요약 영역**:
          - 마지막 5개 user 프롬프트 (truncated, 최신 순)
          - 마지막 사용한 도구 목록 (최근 5개, 예: "edit → bash → read → grep → edit")
          - 코드 변경 요약 (+N -N files)
          - Todo 목록 (있으면): content + status badge
        - **Resume 버튼**: 클릭 시 `opencode attach ...` 명령어 클립보드 복사
        - **세션 상세 링크**: "전체 보기" → session-detail 뷰로 이동
      - **정렬**: 마지막 활동 시간 최신순
      - **Empty state**: "복구할 idle 세션이 없습니다"
      - `data-testid`: `page-context-recovery`, `recovery-card`, `recovery-prompts`, `recovery-tools`, `recovery-impact`, `recovery-todos`, `resume-btn`
    - enrichment store에 `fetchRecoveryData()`, `getRecoveryData()` 추가

  **Must NOT do**:
  - Active/busy 세션 표시 금지 (idle만)
  - 세션 내용 전체 로드 금지 (마지막 5개 프롬프트 + 요약만)
  - 자동 resume 기능 금지 (명령어 복사만)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`ui-ux-pro-max`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with Tasks 4, 5, 6, 7)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:36-47` — `buildSessionCommand()` 함수 (opencode attach 명령어 생성)
  - `server/frontend/src/components/ActiveSessions.svelte:49-53` — `copySessionCommand()` 클립보드 복사 패턴
  - `server/frontend/src/components/PromptDetailModal.svelte` — 상세 정보 모달 패턴

  **WHY Each Reference Matters**:
  - `buildSessionCommand()` — Resume 버튼에 동일한 명령어 생성 로직 재사용 (중복 방지)
  - `copySessionCommand()` — 클립보드 복사 + toast 알림 패턴 재사용
  - `PromptDetailModal` — 상세 정보 표시 UI 패턴 참조

  **Acceptance Criteria**:
  - [ ] ContextRecoveryPage가 idle 세션만 recovery 카드로 렌더링
  - [ ] 각 카드에 마지막 프롬프트, 도구 목록, 코드 변경 요약 표시
  - [ ] Resume 버튼 클릭 시 opencode attach 명령어 클립보드 복사
  - [ ] `cd server/frontend && npm run build` → 에러 없음

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Recovery page shows idle session cards with context
    Tool: Playwright
    Preconditions: Full stack, opencode.db with idle sessions
    Steps:
      1. Navigate to http://localhost:3097/?view=context-recovery
      2. Wait for [data-testid="recovery-card"] (timeout: 10s)
      3. Assert at least 1 recovery card visible
      4. Assert card shows [data-testid="recovery-prompts"] with text
      5. Assert card shows [data-testid="recovery-tools"] with tool names
      6. Assert card shows [data-testid="recovery-impact"] with +N -N
    Expected Result: Recovery cards with full context summary
    Evidence: .sisyphus/evidence/task-8-recovery-happy.png

  Scenario: Resume button copies command
    Tool: Playwright
    Preconditions: Recovery page with at least 1 card
    Steps:
      1. Click [data-testid="resume-btn"] on first recovery card
      2. Assert clipboard contains "opencode attach" command
      3. Assert toast message "Copied!" appears
    Expected Result: opencode attach command copied to clipboard
    Evidence: .sisyphus/evidence/task-8-recovery-resume.png

  Scenario: No idle sessions — empty state
    Tool: Playwright
    Preconditions: All sessions are busy/active
    Steps:
      1. Navigate to context-recovery page
      2. Assert [data-testid="empty-state"] visible
      3. Assert text contains "idle 세션이 없습니다"
    Expected Result: Clean empty state message
    Evidence: .sisyphus/evidence/task-8-recovery-empty.png
  ```

  **Commit**: YES
  - Message: `feat: add context recovery page with session resume support`
  - Files: `server/frontend/src/components/pages/ContextRecoveryPage.svelte`, enrichment store updates
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 9. E2E 통합 테스트

  **What to do**:
  - Playwright E2E 테스트 스위트 작성:
    - **페이지 간 네비게이션 통합 테스트**: 모든 6개 뷰를 순회하며 데이터 로드 확인
    - **Cross-page 기능**: Projects 페이지 → 세션 클릭 → session-detail → back → Projects
    - **SSE 업데이트**: enrichment 데이터 갱신 시 페이지 자동 반영
    - **브라우저 back/forward**: 전체 히스토리 네비게이션
    - **Empty state**: DB 없을 때 모든 페이지의 graceful degradation
    - **기존 기능 회귀**: Dashboard overview, session-detail, prompt history가 동일하게 작동
  - 테스트 fixture: `server/e2e/helpers/` 에 enrichment test data 생성 유틸

  **Must NOT do**:
  - 기존 e2e 테스트 수정 금지 (새 파일에 추가)
  - 실제 opencode.db 사용 금지 (테스트 DB fixture 생성)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with Task 10)
  - **Blocks**: F1, F2, F3, F4
  - **Blocked By**: Tasks 4, 5, 6, 7, 8

  **References**:

  **Pattern References**:
  - `server/e2e/` — 기존 e2e 테스트 구조
  - `server/e2e/helpers/opencode-data.ts` — 테스트 DB fixture 생성 패턴
  - `server/playwright.config.ts` — Playwright 설정

  **Acceptance Criteria**:
  - [ ] `cd server && npx playwright test enrichment` → 전체 PASS
  - [ ] 모든 6개 뷰 네비게이션 테스트 통과
  - [ ] 기존 기능 회귀 테스트 통과

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full navigation circuit
    Tool: Playwright
    Steps:
      1. Start at Dashboard → Tokens → Impact → Timeline → Projects → Recovery → Dashboard
      2. Each transition: assert correct view loaded, URL updated
      3. Browser back 5 times → assert returns to Dashboard
    Expected Result: All views accessible, history works
    Evidence: .sisyphus/evidence/task-9-full-circuit.png

  Scenario: Regression — existing dashboard unchanged
    Tool: Playwright
    Steps:
      1. Navigate to Dashboard (no ?view)
      2. Assert active sessions sidebar visible
      3. Assert prompt history visible
      4. Click session → session-detail view
      5. Assert prompt filter works
      6. Click back → overview restored
    Expected Result: 100% identical behavior to before enrichment feature
    Evidence: .sisyphus/evidence/task-9-regression.png
  ```

  **Commit**: YES
  - Message: `test(e2e): add integration tests for all enrichment pages`
  - Files: `server/e2e/enrichment.spec.ts`, `server/e2e/helpers/enrichment-data.ts`
  - Pre-commit: `cd server && npx playwright test enrichment`

- [x] 10. 빌드 검증 + 기존 기능 회귀 테스트

  **What to do**:
  - 전체 빌드 파이프라인 검증:
    - `cd agent && npm run build && npm test` → 모든 테스트 통과, 타입 체크 통과
    - `cd server && npm run build && npm test` → 통과
    - `cd server/frontend && npm run build` → 에러 없음, 빌드 결과물 생성
  - 기존 Playwright 테스트 실행: `cd server && npx playwright test` → 기존 테스트 전부 통과
  - 기존 기능 수동 검증 (Playwright):
    - Dashboard overview 로드
    - Session-detail 뷰 정상
    - SSE 연결 + 실시간 업데이트
    - 머신 선택기 동작
    - 소스 필터 동작

  **Must NOT do**:
  - 기존 테스트 수정/삭제 금지
  - 기능 추가 금지 (검증만)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with Task 9)
  - **Blocks**: F1, F2, F3, F4
  - **Blocked By**: Tasks 4, 5, 6, 7, 8

  **References**:
  - `server/playwright.config.ts`, `server/playwright.opencode-regression.config.ts`
  - `agent/vitest.config.ts`, `server/vitest.config.ts`

  **Acceptance Criteria**:
  - [ ] `cd agent && npm run build && npm test` → PASS
  - [ ] `cd server && npm run build && npm test` → PASS
  - [ ] `cd server/frontend && npm run build` → no errors
  - [ ] `cd server && npx playwright test` → existing tests PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full build pipeline
    Tool: Bash
    Steps:
      1. cd agent && npm run build && npm test
      2. cd server && npm run build && npm test
      3. cd server/frontend && npm run build
      4. Assert all exit codes are 0
    Expected Result: Clean build across all packages
    Evidence: .sisyphus/evidence/task-10-build.txt

  Scenario: Existing tests pass
    Tool: Bash
    Steps:
      1. cd server && npx playwright test --config=playwright.opencode-regression.config.ts
      2. Assert all tests pass
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-10-regression.txt
  ```

  **Commit**: NO (검증만, 코드 변경 없음)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` in agent/ and server/. Run `npm test` in both. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify opencode.db is NEVER opened without `readonly: true`.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Navigate to each of 5 new pages via TopNav. Verify data loads, empty states, error states. Test browser back/forward across all pages. Test that existing Dashboard + session-detail view work identically. Save screenshots to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Task | Commits |
|------|---------|
| 1 | `feat(agent): add opencode-db-reader module with readonly access` |
| 2 | `feat(frontend): extend navigation to multi-page with TopNav tabs` |
| 3 | `feat(server): add enrichment backend module scaffolding` |
| 4 | `feat: add token/cost analytics page (agent + server + frontend)` |
| 5 | `feat: add code impact page (agent + server + frontend)` |
| 6 | `feat: add agent timeline swim-lane page (agent + server + frontend)` |
| 7 | `feat: add projects grouping page (agent + server + frontend)` |
| 8 | `feat: add context recovery page (agent + server + frontend)` |
| 9 | `test(e2e): add integration tests for all enrichment pages` |
| 10 | `test: regression tests for existing dashboard functionality` |

---

## Success Criteria

### Verification Commands
```bash
# Agent tests pass
cd agent && npm test                    # Expected: all tests pass, 80%+ coverage

# Server tests pass
cd server && npm test                   # Expected: all tests pass

# Frontend builds
cd server/frontend && npm run build     # Expected: no errors

# Agent enrichment endpoint works
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3098/api/enrichment   # Expected: { data: {...}, source: 'opencode-db' }

# E2E tests pass
cd server && npx playwright test        # Expected: all tests pass
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (vitest + Playwright)
- [ ] 80%+ test coverage for new modules
- [ ] `npm run build` succeeds in frontend
- [ ] 5 new pages accessible via TopNav
- [ ] Existing Dashboard + session-detail views unchanged
- [ ] opencode.db opened with readonly: true only
- [ ] Graceful degradation when DB missing/locked
