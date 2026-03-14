# BG 프롬프트 Parent 세션 리매핑

## TL;DR

> **Quick Summary**: 백그라운드 세션을 세션 목록에 child tree로 표시하는 대신, bg 세션의 프롬프트를 parent 세션에 매핑하여 RecentPrompts에서 표시/숨김 토글로 제어한다.
> 
> **Deliverables**:
> - RecentPrompts: bg query를 parent 세션으로 리매핑 + 시각적 구분
> - ActiveSessions: child session tree 제거 (commit 9ff95ab 롤백)
> - 기존 "bg 포함" 토글 활성화
> 
> **Estimated Effort**: Quick
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: Task 1 → Task 3 (build/deploy)

---

## Context

### Original Request
"백그라운드 세션은 표시하지 말고, 백그라운드 세션에서 수행한 프롬프트들은 parent 세션에 매핑하고 표시 여부를 토글하려고 합니다."

### Interview Summary
**Key Discussions**:
- ActiveSessions child tree (commit 9ff95ab): 제거하기로 결정
- bg 프롬프트 토글: 기존 "bg 포함" 토글 활용 (이미 구현되어 있으나 bgCount=0이라 미표시)
- 매핑 위치: 프론트엔드에서만 처리 (서버/agent 변경 없음)

**Research Findings**:
- `isBackgroundQuery()` (utils.ts L103-125): 3단계 감지 — explicit flag → parentSessionId → title pattern
- `filteredQueries` (RecentPrompts.svelte L26-40): 이미 showBackground 토글로 필터링
- `backgroundCount` (L50-64): 세션 필터에 동일한 버그 있음 — remap 없이는 부모 세션 선택 시 count=0
- `.background` CSS class binding (L129) 존재하나 CSS 규칙 없음 — dead code
- Agent는 이미 `isBackground=true`로 bg query를 전송 중 (commit 9ff95ab)

### Metis Review
**Identified Gaps** (addressed):
- `backgroundCount` 세션 필터 버그: remap과 동일한 parent 매칭 로직 필요 → Task 1에 포함
- `.background` CSS dead code: 실제 스타일 추가 필요 → Task 1에 포함  
- Orphaned bg sessions (parent 없음): parent lookup 실패 시 원본 유지 → Task 1에 명시
- `#each` key 안전성: `sessionId + timestamp + i` 이므로 충돌 없음 → 확인 완료
- Multi-level nesting: YAGNI, 단일 레벨로 충분 → 스코프 외

---

## Work Objectives

### Core Objective
bg 세션의 프롬프트를 parent 세션에 매핑하여 RecentPrompts에서 "bg 포함" 토글로 표시/숨김 제어. ActiveSessions에서 child tree 제거.

### Concrete Deliverables
- `server/frontend/src/components/RecentPrompts.svelte` — bg query remap + backgroundCount 수정 + CSS
- `server/frontend/src/components/ActiveSessions.svelte` — child tree 코드 제거

### Definition of Done
- [x] `npm run build` (frontend) — exit code 0
- [x] `npm test` (server) — all tests pass
- [x] bg query가 parent 세션 이름으로 표시됨 (showBackground=true 시)
- [x] "bg 포함" 토글 버튼이 정상 표시됨 (backgroundCount > 0)
- [x] ActiveSessions에서 expand/collapse 버튼 없음

### Must Have
- bg query의 sessionId/sessionTitle을 parent로 리매핑
- `backgroundCount`에서 parent sessionId 매칭
- bg query 카드 시각적 구분 (`.background` CSS)
- "bg 포함" 토글로 bg query 표시/숨김
- parent lookup 실패 시 원본 sessionId 유지
- ActiveSessions child tree 완전 제거

### Must NOT Have (Guardrails)
- 서버/agent 코드 변경 금지 — frontend-only
- `QueryEntry` 타입(types.ts) 변경 금지 — server 타입 미러
- `isBackgroundQuery()` 유틸 함수 수정 금지
- session store를 Map으로 리팩터링 금지 (별도 작업)
- TUI 컴포넌트 수정 금지
- multi-level nesting 재귀 처리 금지 (YAGNI)
- `topLevelSessions` derivation 삭제 금지 — child 세션 top-level 제외 로직 필요

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: Tests-after (기존 테스트 유지, 새 유닛 테스트 불필요 — UI 변경)
- **Framework**: vitest (server), vite build (frontend)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright — Navigate, interact, assert DOM, screenshot
- **Build**: Use Bash — npm run build, npm test

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — 2 tasks in parallel):
├── Task 1: RecentPrompts bg query remap + backgroundCount fix + CSS [quick]
└── Task 2: ActiveSessions child tree 제거 [quick]

Wave 2 (After Wave 1 — verification + deploy):
└── Task 3: Build 검증 + 테스트 + 배포 (test server only) [quick]

Wave FINAL (After ALL tasks):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 3
Parallel Speedup: Task 1 ∥ Task 2
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1    | —         | 3      |
| 2    | —         | 3      |
| 3    | 1, 2      | F1-F4  |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `quick`
- **Wave 2**: 1 task — T3 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. RecentPrompts: bg query를 parent 세션으로 리매핑 + backgroundCount 수정 + CSS

  **What to do**:
  
  **1-A. `filteredQueries` derivation에 remap `.map()` 삽입** (L26-40 부근)
  
  현재 `filteredQueries`는 `allQueries`에서 `.filter()`만 적용. bg 필터와 세션 필터 사이에 `.map()` 단계를 추가하여 bg query의 `sessionId`/`sessionTitle`을 parent로 교체:
  
  ```typescript
  // sessions store에서 세션 목록 가져오기 (이미 import 되어있음)
  // bg query의 parent 찾기:
  //   1. query.sessionId로 세션 찾기
  //   2. 해당 세션의 parentSessionId 확인
  //   3. parentSessionId로 parent 세션 찾기
  //   4. parent 있으면: sessionId = parentSessionId, sessionTitle = parent.title
  //   5. parent 없으면 (orphaned): 원본 유지
  ```
  
  구체적 remap 로직:
  ```typescript
  .map(q => {
    if (!isBackgroundQuery(q, sessions)) return q;
    const childSession = sessions.find(s => s.sessionId === q.sessionId);
    const parentId = childSession?.parentSessionId;
    if (!parentId) return q;  // orphaned — 원본 유지
    const parentSession = sessions.find(s => s.sessionId === parentId);
    if (!parentSession) return q;  // parent not in store — 원본 유지
    return { ...q, sessionId: parentId, sessionTitle: parentSession.title ?? parentId.slice(0, 8) };
  })
  ```
  
  **1-B. `backgroundCount` 세션 필터 수정** (L50-64 부근)
  
  현재 `backgroundCount`가 `q.sessionId === sid`로만 필터하여, 부모 세션 선택 시 bg query count=0. 수정:
  - bg query의 세션이 `parentSessionId === sid`인 경우도 매칭
  - 또는 위 remap을 먼저 적용한 후 count 계산
  
  ```typescript
  // backgroundCount 계산 시, bg query의 parentSessionId도 매칭
  .filter(q => {
    const sid = sessionIdFilter ?? selectedSessionId;
    if (!sid) return true;
    if (q.sessionId === sid) return true;
    // bg query의 parent가 선택된 세션인 경우
    const childSession = sessions.find(s => s.sessionId === q.sessionId);
    return childSession?.parentSessionId === sid;
  })
  ```
  
  **1-C. `.prompt-item.background` CSS 추가**
  
  현재 L129에 `class:background={entry.isBackground}` 바인딩이 있으나 CSS 규칙 없음. 추가:
  ```css
  .prompt-item.background {
    border-left: 2px solid rgba(139, 148, 158, 0.4);
    opacity: 0.85;
    background: rgba(139, 148, 158, 0.03);
  }
  ```
  미묘한 좌측 border + opacity로 bg query를 시각적으로 구분. 지나치게 눈에 띄지 않게.

  **Must NOT do**:
  - `QueryEntry` 타입 수정 금지
  - `isBackgroundQuery()` 유틸 함수 수정 금지
  - 서버/agent 코드 수정 금지
  - session store를 Map으로 리팩터링 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일의 derivation 로직 수정 + CSS 추가. 명확한 변경 범위.
  - **Skills**: []
    - Svelte 컴포넌트의 derived state 수정으로 특수 스킬 불필요
  - **Skills Evaluated but Omitted**:
    - `ui-ux-pro-max`: CSS 추가가 3줄이라 스킬 로드 오버헤드 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/RecentPrompts.svelte:26-40` — `filteredQueries` derivation chain. `.filter()` 사이에 `.map()` remap을 삽입할 위치
  - `server/frontend/src/components/RecentPrompts.svelte:50-64` — `backgroundCount` 계산. 세션 필터 조건 수정 필요
  - `server/frontend/src/components/RecentPrompts.svelte:98-112` — "bg 포함 (N)" 토글 버튼. `backgroundCount > 0`일 때만 표시
  - `server/frontend/src/components/RecentPrompts.svelte:129` — `class:background={entry.isBackground}` 바인딩 위치. CSS 규칙 추가 대상

  **API/Type References**:
  - `server/frontend/src/types.ts:QueryEntry` — sessionId, sessionTitle, isBackground 필드. 타입 수정 금지
  - `server/frontend/src/types.ts:DashboardSession` — parentSessionId, title 필드. parent lookup에 사용

  **Utility References**:
  - `server/frontend/src/lib/utils.ts:103-125` — `isBackgroundQuery(q, sessions)` 함수. bg 판별에 사용 (수정 금지)
  - `server/frontend/src/lib/stores/sessions.svelte.ts` — `getSessions()` import. 이미 RecentPrompts에서 사용 중

  **WHY Each Reference Matters**:
  - `filteredQueries` (L26-40): remap `.map()`을 삽입할 정확한 위치. filter chain 순서가 중요
  - `backgroundCount` (L50-64): 동일한 세션 필터 버그가 있어 반드시 함께 수정
  - `.background` binding (L129): CSS만 추가하면 되므로 바인딩 위치 확인
  - `isBackgroundQuery()`: 이미 구현된 bg 판별 로직 — 재사용, 수정 금지

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: bg 포함 토글 표시 확인
    Tool: Bash (curl)
    Preconditions: Test server deployed, bg queries exist (isBackground=true)
    Steps:
      1. curl -sf http://192.168.0.63:3097/api/queries | python3 -c "import json,sys; d=json.load(sys.stdin); bg=[q for q in d if q.get('isBackground')]; print(f'bg count: {len(bg)}')"
      2. Assert: bg count > 0
    Expected Result: bg query가 1개 이상 존재
    Failure Indicators: bg count: 0
    Evidence: .sisyphus/evidence/task-1-bg-query-count.txt

  Scenario: frontend build 성공
    Tool: Bash
    Preconditions: RecentPrompts.svelte 수정 완료
    Steps:
      1. cd server/frontend && npm run build
      2. Assert: exit code 0, no errors
    Expected Result: Build succeeds with 0 errors
    Failure Indicators: "error" in build output, non-zero exit code
    Evidence: .sisyphus/evidence/task-1-build.txt

  Scenario: backgroundCount 세션 필터 동작
    Tool: Bash (curl + jq)
    Preconditions: bg queries exist with parentSessionId mapping
    Steps:
      1. curl -sf http://192.168.0.63:3097/api/queries로 bg query 조회
      2. bg query의 sessionId로 해당 세션의 parentSessionId 확인
      3. parentSessionId가 있는 bg query가 1개 이상 존재 확인
    Expected Result: parentSessionId 매핑 가능한 bg query 존재
    Failure Indicators: 모든 bg query가 orphaned (parentSessionId 없음)
    Evidence: .sisyphus/evidence/task-1-parent-mapping.txt
  ```

  **Commit**: YES
  - Message: `fix(frontend): remap bg queries to parent session in RecentPrompts`
  - Files: `server/frontend/src/components/RecentPrompts.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

---

- [x] 2. ActiveSessions: child session tree 완전 제거

  **What to do**:
  
  **2-A. Script 섹션 정리** — 다음 코드 제거:
  - L26: `let expandedIds = $state<Set<string>>(new Set());`
  - L28-37: `toggleExpand()` 함수 전체
  - L94-96: `getChildren()` 함수 전체
  - L139: `{@const children = getChildren(session.sessionId)}` 
  - L146: `class:has-children={children.length > 0}`
  
  **2-B. Template 섹션 정리** — child tree block 제거:
  - L220-272 (commit 9ff95ab에서 추가한 expand toggle + children-list 전체)
  - 원래 있던 `<!-- 하위 세션 목록 숨김 -->` 주석으로 복원하거나, 주석 없이 깔끔하게 제거
  
  **2-C. CSS 섹션 정리** — 다음 CSS 규칙 제거:
  - `.session-item.has-children` (L275-278)
  - `.children-list` (L281-287)
  - `.child-item` (L289-295)
  - `.child-item:last-child` (L297-300)
  - `.child-item .session-title` (L373-376)
  - `.expand-toggle` (L378-390)
  - `.expand-toggle:hover` (L392-395)
  - `.expand-toggle.expanded` (L397-401)
  - `.expand-arrow` (L403-406)
  - `.child-count` (L408-416)
  - Mobile `.children-list` (L676-679 부근)
  - Tablet `.children-list` (L708-710 부근)
  - Touch `.expand-toggle` (L664-667 부근)
  
  **2-D. 유지해야 할 것**:
  - `topLevelSessions` derivation (L80-92) — child 세션을 top-level에서 제외하는 로직. 반드시 유지
  - `DashboardSession` 타입의 `parentSessionId`, `childSessionIds` 필드 — 타입 삭제 금지

  **Must NOT do**:
  - `topLevelSessions` derivation 삭제/수정 금지
  - `DashboardSession` 타입 수정 금지
  - 서버/agent 코드 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일에서 코드 제거만 수행. 로직 추가 없음.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `ui-ux-pro-max`: 제거 작업이므로 디자인 스킬 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:25-37` — expandedIds, toggleExpand 위치 (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:80-92` — topLevelSessions derivation (유지 대상!)
  - `server/frontend/src/components/ActiveSessions.svelte:94-96` — getChildren 함수 (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:139` — `{@const children}` (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:146` — `class:has-children` (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:220-272` — child tree template block (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:275-416` — child/expand CSS (제거 대상)

  **WHY Each Reference Matters**:
  - L80-92 (`topLevelSessions`): **절대 삭제하면 안 됨** — bg child 세션이 top-level에 노출됨
  - L220-272: commit 9ff95ab에서 추가한 핵심 제거 대상
  - CSS 규칙들: 미사용 CSS가 남으면 빌드는 되지만 dead code

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: child tree UI 제거 확인
    Tool: Bash (grep)
    Preconditions: ActiveSessions.svelte 수정 완료
    Steps:
      1. grep -n "expandedIds\|toggleExpand\|getChildren\|children-list\|child-item\|expand-toggle" server/frontend/src/components/ActiveSessions.svelte
      2. Assert: 결과 없음 (모든 관련 코드 제거됨)
    Expected Result: grep 결과 0줄
    Failure Indicators: grep에서 매칭되는 줄이 있음
    Evidence: .sisyphus/evidence/task-2-cleanup-check.txt

  Scenario: topLevelSessions 유지 확인
    Tool: Bash (grep)
    Preconditions: ActiveSessions.svelte 수정 완료
    Steps:
      1. grep -n "topLevelSessions\|parentSessionId" server/frontend/src/components/ActiveSessions.svelte
      2. Assert: topLevelSessions derivation이 존재함
    Expected Result: topLevelSessions 관련 코드가 유지됨
    Failure Indicators: topLevelSessions가 삭제됨
    Evidence: .sisyphus/evidence/task-2-preserve-check.txt

  Scenario: frontend build 성공
    Tool: Bash
    Preconditions: ActiveSessions.svelte 수정 완료
    Steps:
      1. cd server/frontend && npm run build
      2. Assert: exit code 0
    Expected Result: Build succeeds
    Failure Indicators: TypeScript/Svelte 컴파일 에러
    Evidence: .sisyphus/evidence/task-2-build.txt
  ```

  **Commit**: YES (groups with Task 1)
  - Message: `refactor(frontend): remove child session tree from ActiveSessions`
  - Files: `server/frontend/src/components/ActiveSessions.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

---

- [x] 3. Build 검증 + 테스트 + 테스트 서버 배포

  **What to do**:
  
  **3-A. 전체 빌드 및 테스트**:
  ```bash
  cd server && npm test              # vitest 유닛 테스트
  cd server/frontend && npm run build # frontend 프로덕션 빌드
  ```
  
  **3-B. Git commit + push**:
  - Task 1, 2의 변경사항을 하나의 커밋으로 통합 (또는 개별 커밋)
  - push to origin main
  
  **3-C. 테스트 서버 (192.168.0.63) 배포**:
  - Server: `cd server && docker compose up -d --build`
  - Agent 변경 없으므로 agent restart 불필요
  
  **3-D. 헬스 체크**:
  ```bash
  curl -sf http://192.168.0.63:3097/health
  ```
  
  **3-E. 운영 서버 (192.168.0.2) 배포**:
  - SSH 접속: `ssh sbbae@192.168.0.2`
  - `cd /home/sbbae/project/session-dashboard && git pull origin main`
  - `cd server && docker compose up -d --build`
  - Agent 변경 없으므로 agent restart 불필요
  - 헬스 체크: `curl -sf http://192.168.0.2:3097/health`

  **Must NOT do**:
  - 유닛 테스트 실패 상태에서 배포 금지
  - 테스트 서버 검증 없이 운영 배포 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 빌드/테스트/배포 명령어 실행만. 코드 변경 없음.
  - **Skills**: [`deploy-workflow`]
    - `deploy-workflow`: 테스트→운영 배포 순서 및 금지사항 참조

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 1, Task 2

  **References**:

  **Deploy References**:
  - `.sisyphus/skills/deploy-workflow/SKILL.md` — 배포 워크플로우 전체 절차
  - `server/machines.yml` — 머신 설정 (macbook: 192.168.0.63:3101)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 전체 테스트 통과
    Tool: Bash
    Preconditions: Task 1, 2 완료
    Steps:
      1. cd server && npm test
      2. Assert: all tests pass, exit code 0
    Expected Result: 157+ tests pass
    Failure Indicators: test failure, non-zero exit
    Evidence: .sisyphus/evidence/task-3-tests.txt

  Scenario: 테스트 서버 헬스 체크
    Tool: Bash (curl)
    Preconditions: docker compose up -d --build 완료
    Steps:
      1. curl -sf http://192.168.0.63:3097/health
      2. Assert: {"status":"ok"} 포함
    Expected Result: Server healthy
    Failure Indicators: connection refused, non-ok status
    Evidence: .sisyphus/evidence/task-3-health-test.txt

  Scenario: 운영 서버 헬스 체크
    Tool: Bash (curl)
    Preconditions: 운영 서버 docker compose up -d --build 완료
    Steps:
      1. curl -sf http://192.168.0.2:3097/health
      2. Assert: {"status":"ok"} 포함
    Expected Result: Server healthy
    Failure Indicators: connection refused, non-ok status
    Evidence: .sisyphus/evidence/task-3-health-prod.txt

  Scenario: bg query API 확인
    Tool: Bash (curl + python3)
    Preconditions: 테스트 서버 배포 완료
    Steps:
      1. curl -sf http://192.168.0.63:3097/api/queries | python3 -c "import json,sys; d=json.load(sys.stdin); bg=[q for q in d if q.get('isBackground')]; print(f'bg: {len(bg)}')"
      2. Assert: bg > 0
    Expected Result: bg query가 존재
    Evidence: .sisyphus/evidence/task-3-bg-verify.txt
  ```

  **Commit**: YES
  - Message: `feat(frontend): remap bg prompts to parent session with toggle`
  - Files: `server/frontend/src/components/RecentPrompts.svelte`, `server/frontend/src/components/ActiveSessions.svelte`
  - Pre-commit: `cd server && npm test && cd frontend && npm run build`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (grep code, check CSS). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npm test` + `npm run build`. Review changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction. Verify no dead CSS remains in ActiveSessions.
  Output: `Build [PASS/FAIL] | Tests [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from deployed state. Open http://192.168.0.63:3097. Verify:
  1. ActiveSessions에 expand/collapse 버튼 없음
  2. RecentPrompts에서 "bg 포함" 토글 버튼 표시됨
  3. 토글 ON: bg query 카드가 parent 세션 이름으로 표시, 시각적 구분 있음
  4. 토글 OFF: bg query 숨김
  5. 부모 세션 클릭 후 "bg 포함" 토글 여전히 표시
  Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git diff). Verify 1:1 — everything in spec was built, nothing beyond spec. Check "Must NOT do" compliance: no server changes, no type changes, no isBackgroundQuery changes. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | VERDICT`

---

## Commit Strategy

| Order | Message | Files | Gate |
|-------|---------|-------|------|
| 1 | `fix(frontend): remap bg queries to parent session in RecentPrompts` | RecentPrompts.svelte | `npm run build` |
| 2 | `refactor(frontend): remove child session tree from ActiveSessions` | ActiveSessions.svelte | `npm run build` |
| 3 | (deploy only — no code change) | — | `npm test` |

또는 Task 1+2를 하나의 커밋으로 통합:
- `feat(frontend): remap bg prompts to parent session, remove child tree`

---

## Success Criteria

### Verification Commands
```bash
cd server && npm test                    # Expected: 157+ tests pass
cd server/frontend && npm run build      # Expected: exit code 0
curl -sf http://192.168.0.63:3097/health # Expected: {"status":"ok"}
curl -sf http://192.168.0.2:3097/health  # Expected: {"status":"ok"}
```

### Final Checklist
- [x] bg query가 parent 세션 이름으로 표시 (showBackground=true)
- [x] "bg 포함" 토글 버튼 정상 표시 (backgroundCount > 0)
- [x] bg query 카드에 시각적 구분 (.background CSS)
- [x] ActiveSessions에서 expand/collapse 완전 제거
- [x] topLevelSessions derivation 유지됨
- [x] 서버/agent 코드 변경 없음
- [x] 테스트 서버 + 운영 서버 배포 완료
