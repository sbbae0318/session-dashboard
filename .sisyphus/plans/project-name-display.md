# Project Name Display Fix

## TL;DR

> **Quick Summary**: Agent의 SQL 쿼리가 `session.project_id`(cryptic ID)를 `directory` 필드에 매핑하고 있어, Timeline/Code Impact/Tokens 페이지에서 프로젝트 이름이 cryptic하게 표시됨. `project` 테이블을 LEFT JOIN하여 `worktree` (실제 경로)를 가져오고, 프론트엔드 드롭다운도 수정.
> 
> **Deliverables**:
> - Agent SQL 쿼리 7개 수정 (LEFT JOIN project table)
> - Frontend 드롭다운 2곳 수정 (TimelinePage, CodeImpactPage)
> - TDD 테스트 추가 (directory assertion, orphaned session, mismatched directory)
> 
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

---

## Context

### Original Request
"추가된 메모, 타임라인 등의 기능에서 프로젝트 이름이 뭔가 키나 시드 이름으로 나오는데 사람이 알아볼 수 있는 이름으로 표시하도록 수정"

### Interview Summary
**Key Discussions**:
- Explore agent가 codebase를 조사하여 root cause 확인
- `opencode-db-reader.ts`에서 `directory: r.project_id`로 매핑하는 2곳 발견 (line 446, 509)
- `prepareTokensDataStmt`는 `session.directory`를 사용하는데, 이 값이 종종 NULL
- 프론트엔드 드롭다운 (TimelinePage line 77, CodeImpactPage line 67)이 `projectId`로 표시 텍스트 생성

**Research Findings**:
- `ProjectsPage.svelte`는 이미 `shortPath(project.worktree)` 사용 → 정상 ✓
- `MemosPage.svelte`는 자체 `projectSlug` + enrichment `worktree` 병합 로직 있음 → 정상 ✓
- `TokenCostPage.svelte` line 45: `projectLabel(s.directory || s.projectId)` fallback 있음 → agent fix만으로 해결 ✓
- `ContextRecoveryPage.svelte`: `ctx.directory.split(...)` 사용 → agent fix만으로 해결 ✓
- `getAllProjects()`, `getAllProjectsTokenStats()`는 이미 project 테이블 JOIN → 올바른 패턴 참조용

### Metis Review
**Identified Gaps** (addressed):
- **프론트엔드 드롭다운 누락**: agent fix만으로는 `TimelinePage`와 `CodeImpactPage`의 드롭다운이 여전히 cryptic ID 표시. 별도 프론트엔드 수정 필요.
- **Orphaned session 처리**: `INNER JOIN` 사용 시 project 없는 세션이 사라짐. `LEFT JOIN` + `COALESCE` fallback 필요.
- **`getTokensData()`도 수정 필요**: `session.directory` 대신 `project.worktree` 사용해야 함.
- **Test false-positive**: 현재 테스트가 `session.directory == project.worktree`인 seed data 사용 → mismatch 테스트 필요.

---

## Work Objectives

### Core Objective
프로젝트 이름이 cryptic ID 대신 `worktree` 경로에서 파생된 사람이 읽을 수 있는 이름으로 표시되도록 수정.

### Concrete Deliverables
- `agent/src/opencode-db-reader.ts`: 7개 SQL 쿼리에 `LEFT JOIN project` 추가
- `agent/src/__tests__/opencode-db-reader.test.ts`: directory assertion + orphaned/mismatch 테스트
- `server/frontend/src/components/pages/TimelinePage.svelte`: 드롭다운 표시 수정
- `server/frontend/src/components/pages/CodeImpactPage.svelte`: 드롭다운 표시 수정

### Definition of Done
- [ ] `cd agent && npm test` — ALL PASS
- [ ] `cd server/frontend && npm run build` — no errors
- [ ] Timeline 드롭다운에서 프로젝트가 경로 기반 이름으로 표시
- [ ] Code Impact 드롭다운에서 프로젝트가 경로 기반 이름으로 표시
- [ ] Tokens 페이지에서 프로젝트별 집계가 경로 기반 이름 사용
- [ ] Orphaned session (project 없는)이 fallback 이름으로 표시 (사라지지 않음)

### Must Have
- `LEFT JOIN` 사용 (INNER JOIN 절대 금지)
- `COALESCE(p.worktree, s.directory, s.project_id)` fallback chain
- 드롭다운 `value`는 `projectId` 유지 (필터 기능 보존)
- 드롭다운 표시 텍스트만 `directory` (worktree) 기반으로 변경

### Must NOT Have (Guardrails)
- `INNER JOIN` 사용 금지 — orphaned session 데이터 손실 위험
- 내보내기 인터페이스 (`TimelineEntry`, `SessionCodeImpact`, `SessionTokenStats`) 수정 금지 — `directory` 필드 이미 존재, 값만 변경
- `projectId` 필드 값 변경 금지 — API 필터링용 canonical identifier
- `MemosPage`, `ProjectsPage`, `ContextRecoveryPage` 변경 금지 — 이미 정상 동작하거나 agent fix로 자동 해결
- inline timeline 쿼리 (lines 468-490)를 prepared statement로 리팩터링 금지 — scope creep
- `shortPath()` 중복 함수를 shared utility로 추출 금지 — scope creep, 별도 PR
- `as any` / `@ts-ignore` 사용 금지
- agent/frontend 변경을 같은 커밋에 섞기 금지

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (agent: bun test, server: vitest + vite build)
- **Automated tests**: YES (TDD for agent, build check for frontend)
- **Framework**: bun test (agent), vitest (server frontend)
- **TDD flow**: RED (failing tests) → GREEN (SQL fix) → verify

### QA Policy
Every task includes agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Agent**: Bash (`cd agent && npm test`)
- **Frontend**: Bash (`cd server/frontend && npm run build`)
- **API verification**: Bash (`curl`) against deployed agent
- **UI verification**: Playwright for dropdown display

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Sequential — TDD agent pipeline):
├── Task 1: Agent TDD tests — write failing tests [quick]
├── Task 2: Agent SQL fix — LEFT JOIN + COALESCE [quick]
└── Task 3: Agent deploy verify [quick]

Wave 2 (After Wave 1 — frontend fixes, parallel):
├── Task 4: Frontend dropdown fix — TimelinePage + CodeImpactPage [quick]
└── Task 5: Deploy + Final QA [quick]

Wave FINAL (After ALL — verification):
├── Task F1: Plan compliance audit [oracle]
├── Task F2: Code quality review [unspecified-high]
├── Task F3: Playwright QA [unspecified-high]
└── Task F4: Scope fidelity check [deep]
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2 | 1 |
| T2 | T1 | T3, T4 | 1 |
| T3 | T2 | T4 | 1 |
| T4 | T3 | T5 | 2 |
| T5 | T4 | F1-F4 | 2 |
| F1-F4 | T5 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 `quick`, T2 `quick`, T3 `quick`
- **Wave 2**: 2 tasks — T4 `quick`, T5 `quick` + `deploy-session-dashboard`
- **FINAL**: 4 tasks — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high` + `playwright`, F4 `deep`

---

## TODOs

- [ ] 1. Agent TDD Tests — Write Failing Tests for directory Field

  **What to do**:
  - `agent/src/__tests__/opencode-db-reader.test.ts`에 다음 테스트 추가/수정:
  - `getAllSessionsCodeImpact` 테스트 블록에서 반환된 `directory`가 `project.worktree` 값(예: `/home/user/my-app`)과 일치하는지 assertion 추가
  - `getSessionTimeline` 테스트 블록에서 반환된 `directory`가 `project.worktree` 값과 일치하는지 assertion 추가
  - Orphaned session 테스트 추가: seed data에 `project_id = 'proj_orphan'`인 session을 추가하되 matching project row 없음. `getAllSessionsCodeImpact()`와 `getSessionTimeline()`에서 해당 session이 결과에 포함되고, `directory` 필드가 빈 문자열이나 project_id로 fallback되는지 확인
  - Mismatched directory 테스트 추가: `session.directory = '/different/path'`이고 `project.worktree = '/home/user/my-app'`인 케이스에서 결과의 `directory`가 `project.worktree` 값인지 확인 (session.directory가 아닌)
  - `getTokensData` 테스트에서도 `directory`가 `project.worktree` 값인지 assertion 추가

  **Must NOT do**:
  - 내보내기 타입/인터페이스 수정 금지
  - Agent SQL 쿼리 수정 금지 (이 task는 RED phase — 테스트만 작성)
  - 테스트 seed data 외 다른 파일 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 테스트 파일 수정, 기존 패턴 따르기
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `cleanup-after-test`: 테스트 정리용 — 여기선 테스트 작성이므로 불필요

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential with Task 2)
  - **Blocks**: Task 2
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `agent/src/__tests__/opencode-db-reader.test.ts` — 기존 테스트 패턴 (seed data 구조, describe/it 블록, assertion 스타일)

  **API/Type References** (contracts to implement against):
  - `agent/src/opencode-db-reader.ts:15-23` — `ProjectSummary` interface (id, worktree 필드)
  - `agent/src/opencode-db-reader.ts:56-65` — `TimelineEntry` interface (directory 필드 확인)
  - `agent/src/opencode-db-reader.ts:80-93` — `SessionCodeImpact` interface (directory 필드 확인)

  **Test References**:
  - `agent/src/__tests__/opencode-db-reader.test.ts:describe("getAllSessionsCodeImpact")` — Code Impact 테스트 블록 (directory assertion 추가 위치)
  - `agent/src/__tests__/opencode-db-reader.test.ts:describe("getSessionTimeline")` — Timeline 테스트 블록 (directory assertion 추가 위치)
  - `agent/src/__tests__/opencode-db-reader.test.ts:describe("getTokensData")` — Tokens 테스트 블록

  **WHY Each Reference Matters**:
  - `ProjectSummary` interface에서 `worktree` 필드 이름 확인 → seed data에서 project 레코드 구성 시 참고
  - `TimelineEntry`/`SessionCodeImpact` interface에서 `directory` 필드 존재 확인 → assertion 대상
  - 기존 테스트 패턴에서 seed data insert 방식, DB setup/teardown 패턴 확인

  **Acceptance Criteria**:

  - [ ] `cd agent && npm test` → 새로 추가한 directory assertion 테스트들이 **FAIL** (TDD RED phase)
  - [ ] 기존 테스트들은 여전히 PASS (새 테스트만 fail)
  - [ ] Orphaned session 테스트 존재 — project 없는 세션이 결과에 포함되는지 테스트
  - [ ] Mismatched directory 테스트 존재 — worktree vs session.directory 중 worktree를 반환하는지 테스트

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: New tests FAIL (TDD RED phase)
    Tool: Bash
    Preconditions: agent/src/opencode-db-reader.ts 미수정 상태
    Steps:
      1. cd agent && npm test 2>&1 | tail -30
      2. 결과에서 "directory" 관련 assertion failure 확인
    Expected Result: 새 directory assertion 테스트만 FAIL, 기존 테스트는 PASS
    Failure Indicators: 기존 테스트도 fail하거나, 새 테스트가 pass (아직 SQL 수정 안 했으므로 pass하면 안됨)
    Evidence: .sisyphus/evidence/task-1-tdd-red.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-tdd-red.txt — npm test 출력 (새 테스트 FAIL 확인)

  **Commit**: YES
  - Message: `test(agent): add directory field assertions for project name display fix`
  - Files: `agent/src/__tests__/opencode-db-reader.test.ts`
  - Pre-commit: `cd agent && npm test` (일부 fail 예상 — TDD RED이므로 commit은 수동 진행)

- [ ] 2. Agent SQL Fix — LEFT JOIN project table for worktree

  **What to do**:
  - `agent/src/opencode-db-reader.ts`에서 다음 7개 SQL 쿼리 수정:
  
  1. `prepareTimelineStmt` (line 823): `FROM session` → `FROM session s LEFT JOIN project p ON s.project_id = p.id`. SELECT에 `COALESCE(p.worktree, s.directory, s.project_id) AS directory` 추가. 모든 컬럼 참조에 `s.` prefix 추가.
  
  2. `prepareTimelineByProjectStmt` (line 837): 동일 패턴.
  
  3. `prepareAllCodeImpactStmt` (line 803): 동일 패턴.
  
  4. `prepareAllCodeImpactByProjectStmt` (line 813): 동일 패턴.
  
  5-6. `getSessionTimeline()`의 inline 쿼리 2개 (lines 468-478, 480-490): 동일 패턴. inline이므로 그 자리에서 직접 수정.
  
  7. `prepareTokensDataStmt` (line 897): 기존 `s.directory` → `COALESCE(p.worktree, s.directory, s.project_id) AS directory`. `LEFT JOIN project p ON s.project_id = p.id` 추가.
  
  - `getSessionTimeline()` 내 row mapping (line 509): `directory: r.project_id` → `directory: r.directory ?? r.project_id`
  - `getAllSessionsCodeImpact()` 내 row mapping (line 446): 동일 수정
  - `getTokensData()` 내 row mapping (line 382): 이미 `r.directory ?? ''` 사용 → SQL에서 올바른 값 오므로 OK
  
  - 로컬 타입 수정:
    - `TimelineRow` type (line 457): `directory: string;` 필드 추가
    - `getAllSessionsCodeImpact`의 inline cast type (lines 431-440): `directory: string;` 필드 추가

  **Must NOT do**:
  - `INNER JOIN` 사용 금지 — 반드시 `LEFT JOIN`
  - 내보내기 인터페이스 (`TimelineEntry`, `SessionCodeImpact`, `SessionTokenStats`) 수정 금지
  - `INSERT OR REPLACE` 사용 금지
  - inline 쿼리를 prepared statement로 리팩터링 금지
  - `session` alias를 `s`로 통일 시, `GROUP BY` 절도 함께 수정

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일 내 SQL 쿼리 수정, 패턴이 동일
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (after Task 1)
  - **Blocks**: Task 3, Task 4
  - **Blocked By**: Task 1

  **References**:

  **Pattern References** (existing code to follow):
  - `agent/src/opencode-db-reader.ts:871-895` — `prepareProjectTokenStatsStmt`: 이미 `LEFT JOIN project p ON s.project_id = p.id` 패턴을 올바르게 사용. 이 쿼리를 참고하여 동일한 JOIN 패턴 적용.
  - `agent/src/opencode-db-reader.ts:722-745` — `prepareAllProjectsStmt`: project 테이블 직접 쿼리 패턴 참고.

  **API/Type References**:
  - `agent/src/opencode-db-reader.ts:56-65` — `TimelineEntry` interface: `directory: string` 필드 존재 확인
  - `agent/src/opencode-db-reader.ts:80-93` — `SessionCodeImpact` interface: `directory: string` 필드 존재 확인

  **WHY Each Reference Matters**:
  - `prepareProjectTokenStatsStmt`는 이 프로젝트에서 이미 검증된 LEFT JOIN 패턴. 동일한 alias (`s`, `p`), COALESCE 패턴, GROUP BY 호환성이 증명됨.
  - Interface 참조는 `directory` 필드가 이미 존재하므로 값만 변경하면 된다는 것을 확인.

  **Acceptance Criteria**:

  - [ ] `cd agent && npm test` → ALL PASS (TDD GREEN phase — Task 1에서 추가한 테스트 포함)
  - [ ] `grep -n 'INNER JOIN project' agent/src/opencode-db-reader.ts` → 결과 없음
  - [ ] `grep -n 'LEFT JOIN project' agent/src/opencode-db-reader.ts` → 7개 이상 매칭
  - [ ] `grep -n 'directory: r.project_id' agent/src/opencode-db-reader.ts` → 결과 없음 (모두 제거됨)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: All agent tests pass (TDD GREEN phase)
    Tool: Bash
    Preconditions: Task 1의 테스트가 이미 추가된 상태
    Steps:
      1. cd agent && npm test 2>&1
      2. 모든 테스트 PASS 확인
      3. grep -c 'LEFT JOIN project' agent/src/opencode-db-reader.ts → 7 이상
      4. grep -c 'directory: r.project_id' agent/src/opencode-db-reader.ts → 0
    Expected Result: 모든 테스트 PASS, LEFT JOIN 7개, directory: r.project_id 0개
    Failure Indicators: 테스트 FAIL, INNER JOIN 발견, directory: r.project_id 잔존
    Evidence: .sisyphus/evidence/task-2-tdd-green.txt

  Scenario: Orphaned session fallback works
    Tool: Bash
    Preconditions: orphaned session seed data 포함된 테스트
    Steps:
      1. cd agent && npm test -- --grep "orphan" 2>&1
      2. orphaned session 테스트 PASS 확인
    Expected Result: orphaned session이 결과에 포함되고 directory fallback 작동
    Failure Indicators: orphaned session이 결과에서 누락 (INNER JOIN 사용 시)
    Evidence: .sisyphus/evidence/task-2-orphan-test.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-tdd-green.txt — npm test 전체 출력
  - [ ] task-2-orphan-test.txt — orphan 테스트 결과

  **Commit**: YES
  - Message: `feat(agent): join project table to resolve worktree for directory field`
  - Files: `agent/src/opencode-db-reader.ts`
  - Pre-commit: `cd agent && npm test`

- [ ] 3. Agent Deploy & API Verify

  **What to do**:
  - Agent 빌드 및 재시작: `cd agent && npm run build`
  - 배포 서버(192.168.0.2)에서 agent 재시작
  - API 호출하여 `directory` 필드가 worktree 경로인지 확인

  **Must NOT do**:
  - 코드 변경 금지 (검증만)
  - 서버 프론트엔드 빌드/배포 금지 (Task 4 이후)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 빌드 + curl 검증만
  - **Skills**: [`deploy-session-dashboard`]
    - `deploy-session-dashboard`: 배포 서버 접속 및 agent 재시작 절차 참고

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (after Task 2)
  - **Blocks**: Task 4
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `install/agent.sh` — agent 빌드/재시작 스크립트
  - `.sisyphus/evidence/f1-smoke-test.txt` — Phase 3의 API 검증 패턴 참고

  **External References**:
  - 배포 서버: `192.168.0.2`, agent port: `3098`

  **Acceptance Criteria**:

  - [ ] Agent 빌드 성공
  - [ ] API 응답의 `directory` 필드가 경로 형태 (예: `/Users/sbbae/project/session-dashboard`)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: API returns worktree paths
    Tool: Bash (curl)
    Preconditions: Agent rebuilt and restarted on 192.168.0.2
    Steps:
      1. curl -s -H "Authorization: Bearer $API_KEY" http://192.168.0.2:3098/api/enrichment/timeline?from=0&to=99999999999999 | head -c 500
      2. directory 필드 값 확인 — 경로 형태인지 (/ 포함)
      3. curl -s -H "Authorization: Bearer $API_KEY" http://192.168.0.2:3098/api/enrichment/code-impact | head -c 500
      4. directory 필드 값 확인
    Expected Result: directory 필드가 `/.../.../project-name` 형태
    Failure Indicators: directory가 `proj_` prefix이거나 cryptic ID
    Evidence: .sisyphus/evidence/task-3-api-verify.txt

  Scenario: No data loss (entry count matches)
    Tool: Bash (curl)
    Steps:
      1. curl -s http://192.168.0.2:3098/api/enrichment/timeline?from=0&to=99999999999999 | jq 'length'
      2. 이전 배포 대비 entry 수 유사한지 확인 (배포 전 count도 기록)
    Expected Result: entry 수가 0이 아니고, 이전과 유사
    Failure Indicators: entry 수가 0이거나 크게 감소 (INNER JOIN 사용 시 발생 가능)
    Evidence: .sisyphus/evidence/task-3-count-verify.txt
  ```

  **Commit**: NO (검증만)

- [ ] 4. Frontend Dropdown Fix — TimelinePage + CodeImpactPage

  **What to do**:
  - `server/frontend/src/components/pages/TimelinePage.svelte`:
    - `projects` derived (line 28)에서 `projectId` 대신 `{id: projectId, label: directory}` 형태의 객체 배열 생성
    - 또는 더 간단하게: `projectId → directory` Map을 derived로 생성
    - 드롭다운 `<option value={proj}>{shortPath(proj)}</option>` (line 77)에서:
      - `value`는 `projectId` 유지 (필터링용)
      - 표시 텍스트를 `shortPath(projectDirectoryMap.get(proj) ?? proj)`로 변경
    - `projectDirectoryMap` 생성: `$timelineData`에서 `new Map(data.map(s => [s.projectId, s.directory]))`
  
  - `server/frontend/src/components/pages/CodeImpactPage.svelte`:
    - 동일 패턴 적용
    - `projects` derived (line 15-16)에서 projectId 목록 유지
    - `projectDirectoryMap` derived 추가
    - 드롭다운 (line 66-68): `value`는 `projectId`, 표시 텍스트는 `shortPath(directory)`

  **Must NOT do**:
  - `projectId` 값을 `directory`로 변경 금지 — 필터 기능 깨짐
  - `MemosPage.svelte`, `ProjectsPage.svelte` 수정 금지
  - 새로운 shared utility 파일 생성 금지
  - CSS 변경 금지 (표시 텍스트만 변경)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 2개 Svelte 파일의 드롭다운 표시 로직만 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 3)
  - **Blocks**: Task 5
  - **Blocked By**: Task 3

  **References**:

  **Pattern References** (existing code to follow):
  - `server/frontend/src/components/pages/TokenCostPage.svelte:42-66` — `getProjectRows()`에서 `projectLabel(s.directory || s.projectId)` 패턴. directory fallback chain의 좋은 예시.
  - `server/frontend/src/components/pages/MemosPage.svelte:51-74` — `mergedProjects` derived에서 `projectId → slug` 매핑 패턴. Map 사용법 참고.
  - `server/frontend/src/components/pages/TimelinePage.svelte:38-41` — 기존 `shortPath()` 함수 (재사용)

  **API/Type References**:
  - `server/frontend/src/lib/stores/enrichment.ts:56-65` — `TimelineEntry` interface: `projectId`와 `directory` 필드 모두 존재
  - `server/frontend/src/lib/stores/enrichment.ts:45-54` — `SessionCodeImpact` interface: 동일

  **WHY Each Reference Matters**:
  - `TokenCostPage`의 `s.directory || s.projectId` 패턴은 이미 검증된 fallback — 동일 로직 적용
  - `MemosPage`의 Map 패턴은 `projectId → display name` 매핑의 좋은 예시
  - `shortPath()`는 이미 각 컴포넌트에 존재 — 새 함수 작성 불필요

  **Acceptance Criteria**:

  - [ ] `cd server/frontend && npm run build` → no errors
  - [ ] TimelinePage 드롭다운의 `<option value>`는 여전히 `projectId`
  - [ ] TimelinePage 드롭다운의 표시 텍스트는 `shortPath(directory)` (path 기반)
  - [ ] CodeImpactPage 드롭다운도 동일
  - [ ] 프로젝트 필터 선택 시 필터링 기능 정상 동작

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Frontend builds without errors
    Tool: Bash
    Preconditions: TimelinePage.svelte, CodeImpactPage.svelte 수정 완료
    Steps:
      1. cd server/frontend && npm run build 2>&1
      2. 에러 없음 확인
    Expected Result: Build successful, no TypeScript/Svelte errors
    Failure Indicators: Build errors, type mismatches
    Evidence: .sisyphus/evidence/task-4-build.txt

  Scenario: Dropdown option values preserved as projectId
    Tool: Bash (grep)
    Preconditions: Frontend source files modified
    Steps:
      1. grep -n 'value={proj' server/frontend/src/components/pages/TimelinePage.svelte
      2. grep -n 'value={project' server/frontend/src/components/pages/CodeImpactPage.svelte
      3. option value가 projectId 기반인지 확인
    Expected Result: option value가 projectId 변수 사용
    Failure Indicators: option value가 directory 변수 사용
    Evidence: .sisyphus/evidence/task-4-dropdown-check.txt
  ```

  **Evidence to Capture:**
  - [ ] task-4-build.txt — frontend build 출력
  - [ ] task-4-dropdown-check.txt — grep 결과

  **Commit**: YES
  - Message: `feat(frontend): display human-readable project names in dropdowns`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`, `server/frontend/src/components/pages/CodeImpactPage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 5. Full Deploy + Production QA

  **What to do**:
  - `deploy-session-dashboard` 스킬 로드하여 전체 배포 실행
  - 배포 후 프로덕션 서버(192.168.0.2:3097)에서 검증:
    - Timeline 페이지: 프로젝트 드롭다운에 사람 읽기 이름 표시
    - Code Impact 페이지: 프로젝트 드롭다운에 사람 읽기 이름 표시
    - Tokens 페이지: 프로젝트별 집계에 사람 읽기 이름 표시
    - Memos 페이지: 변경 없음 확인 (이전과 동일)
    - Projects 페이지: 변경 없음 확인 (이전과 동일)

  **Must NOT do**:
  - 코드 변경 금지 (배포 + 검증만)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 배포 실행 + curl/playwright 검증
  - **Skills**: [`deploy-session-dashboard`, `playwright`]
    - `deploy-session-dashboard`: 배포 프로세스 (git push → SSH deploy → verify)
    - `playwright`: 브라우저에서 드롭다운 확인

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 4)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 4

  **References**:

  **Pattern References**:
  - `.sisyphus/evidence/f1-smoke-test.txt` — Phase 3 배포 검증 패턴
  - `.sisyphus/evidence/f2-timeline-qa.png` — Phase 3 Playwright QA 패턴
  - `install/server.sh` — 서버 빌드/배포 스크립트

  **External References**:
  - Production: `http://192.168.0.2:3097`
  - Agent: `http://192.168.0.2:3098`

  **Acceptance Criteria**:

  - [ ] 배포 성공 (container healthy)
  - [ ] Timeline 드롭다운: 사람 읽기 이름 표시 (예: `project/session-dashboard`)
  - [ ] Code Impact 드롭다운: 사람 읽기 이름 표시
  - [ ] Token 페이지: 프로젝트별 집계에 경로 기반 이름 표시
  - [ ] Memos/Projects 페이지: 이전과 동일 동작

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Timeline page shows readable project names
    Tool: Playwright
    Preconditions: 배포 완료, 서버 healthy
    Steps:
      1. Navigate to http://192.168.0.2:3097/?view=timeline
      2. Wait for page load (타임라인 로딩 완료)
      3. Click on project filter dropdown (.project-filter)
      4. Read all <option> text values
      5. Assert: NO option text contains 'proj_' prefix
      6. Assert: At least one option text contains '/' (path separator)
      7. Screenshot
    Expected Result: 모든 프로젝트 옵션이 경로 기반 이름 (예: project/session-dashboard)
    Failure Indicators: 옵션에 'proj_' prefix 있거나 cryptic ID 표시
    Evidence: .sisyphus/evidence/task-5-timeline-dropdown.png

  Scenario: Code Impact page shows readable project names
    Tool: Playwright
    Preconditions: 배포 완료
    Steps:
      1. Navigate to http://192.168.0.2:3097/?view=code-impact
      2. Wait for page load
      3. Read #project-filter dropdown options
      4. Assert: NO option text contains 'proj_' prefix
      5. Assert: .project-path elements show path-based names
      6. Screenshot
    Expected Result: 드롭다운과 항목 모두 경로 기반 이름
    Failure Indicators: cryptic ID 표시
    Evidence: .sisyphus/evidence/task-5-impact-dropdown.png

  Scenario: Token page shows readable project names
    Tool: Playwright
    Preconditions: 배포 완료
    Steps:
      1. Navigate to http://192.168.0.2:3097/?view=tokens
      2. Wait for page load
      3. Read project column values in the table
      4. Assert: project names contain '/' (path separator)
      5. Screenshot
    Expected Result: 프로젝트 열에 경로 기반 이름
    Evidence: .sisyphus/evidence/task-5-tokens-projects.png

  Scenario: Memos page unchanged
    Tool: Playwright
    Preconditions: 배포 완료
    Steps:
      1. Navigate to http://192.168.0.2:3097/?view=memos
      2. Wait for page load
      3. Assert page loads without errors
      4. Screenshot for comparison
    Expected Result: 페이지 정상 로드, 이전과 동일
    Evidence: .sisyphus/evidence/task-5-memos-check.png
  ```

  **Evidence to Capture:**
  - [ ] task-5-timeline-dropdown.png
  - [ ] task-5-impact-dropdown.png
  - [ ] task-5-tokens-projects.png
  - [ ] task-5-memos-check.png

  **Commit**: NO (배포 + 검증만)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `cd agent && npm test` + `cd server/frontend && npm run build`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify LEFT JOIN used everywhere (no INNER JOIN). Verify COALESCE fallback chain present.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Playwright QA** — `unspecified-high` (+ `playwright` skill)
  Load skill `playwright`. Navigate to `http://192.168.0.2:3097`. For each page (Timeline, Code Impact, Tokens): verify project filter dropdown shows human-readable names (path segments, not cryptic IDs). Verify filtering works after selecting a project. Take screenshots as evidence.
  Output: `Pages [N/N pass] | Dropdowns [N/N readable] | Filters [N/N working] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (`git log --oneline`, `git diff`). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Verify MemosPage, ProjectsPage, ContextRecoveryPage were NOT modified. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Scope [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| Commit | Type | Scope | Files |
|--------|------|-------|-------|
| 1 | test(agent) | Add directory assertions + orphaned session tests | `agent/src/__tests__/opencode-db-reader.test.ts` |
| 2 | feat(agent) | Fix SQL queries to JOIN project table for worktree | `agent/src/opencode-db-reader.ts` |
| 3 | feat(frontend) | Fix dropdown display to use worktree-based names | `TimelinePage.svelte`, `CodeImpactPage.svelte` |

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm test  # Expected: ALL PASS (including new directory assertions)
cd server/frontend && npm run build  # Expected: no errors
curl -s http://192.168.0.2:3098/api/enrichment/timeline?from=0&to=99999999999999 | jq '.[0].directory'  # Expected: path string, not cryptic ID
```

### Final Checklist
- [ ] All "Must Have" present (LEFT JOIN, COALESCE, dropdown value=projectId)
- [ ] All "Must NOT Have" absent (no INNER JOIN, no interface changes, no out-of-scope page changes)
- [ ] All agent tests pass
- [ ] Frontend builds without errors
- [ ] Project names display as human-readable paths in production
