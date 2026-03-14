# Header Toolbar Compression — 1줄 통합 배치

## TL;DR

> **Quick Summary**: 대시보드 헤더 3줄(제목+상태, 장비필터, 소스필터) → 1줄 toolbar로 최대 압축. 제목 "Session Dashboard"를 아이콘으로 교체, 연결상태를 dot만으로 표시, 모든 필터를 같은 행에 inline 배치.
> 
> **Deliverables**:
> - `App.svelte`: HTML 구조 변경 (h1→아이콘, MachineSelector+source-filter를 header 안으로 이동)
> - `app.css`: `.dashboard-header` 1줄 flex toolbar로 변경, spacing 최소화
> - `MachineSelector.svelte`: inline 모드로 변경 (padding/background/border 제거)
> - 모바일: flex-wrap으로 자연스러운 줄바꿈
> 
> **Estimated Effort**: Quick
> **Parallel Execution**: NO — 3 files tightly coupled, sequential
> **Critical Path**: Task 1 (restructure) → Task 2 (build+test) → Task 3 (deploy)

---

## Context

### Original Request
"맨 위 제목, 장비 필터링, 에이전트 필터링 버튼 영역이 차지하는 부분이 비효율적인데 이 부분을 최대한 압축하여 표시하도록"

### Interview Summary
**Key Discussions**:
- 사용자가 "가장 공격적인 압축" 요청
- 제목은 아이콘으로 대체, 텍스트 제거
- 1줄로 최대 압축, 모바일도 동일
- Phase 1(spacing만) 아닌 Phase 2(구조 변경) 채택

**User Decisions**:
- 배치 방향: **1줄로 최대 압축** (3줄 → 1줄)
- 모바일: **동일 압축** (flex-wrap으로 자연 줄바꿈)
- 제목: **아이콘으로 대체** (텍스트 완전 제거)

**Research Findings**:
- 현재 수직 공간: ~129px (MachineSelector 미표시), ~166px (표시 시)
- 목표: ~35-40px (1줄 toolbar)
- E2E 테스트 확인 결과:
  - `page.toHaveTitle(/Session Dashboard/)` → HTML `<title>` 태그 체크, h1이 아님 → h1 제거 안전
  - `.connection-status` → CSS 클래스 가시성만 체크, 텍스트 내용 미참조 → dot만으로 변경 가능
  - `.source-filter-btn:has-text("Claude")` → 버튼 텍스트 유지 필수
  - `[data-testid="machine-selector"]` → data-testid 유지 필수

### Metis Review
**Identified Gaps** (addressed):
- CSS 스타일 3개 파일 분산 → 각 파일별 수정 범위 명시
- E2E 셀렉터 17곳 CSS 클래스 참조 → 클래스명 변경 금지
- `.source-filter` scoped(App.svelte) + global(app.css) 분산 → 양쪽 수정
- 모바일 터치 타겟 44px 유지 필요
- 구조 변경 시 MachineSelector의 조건부 렌더링 로직 보존 필요

---

## Work Objectives

### Core Objective
3줄 헤더(~125px)를 1줄 toolbar(~35-40px)로 압축. 제목→아이콘, 연결상태→dot, 필터들을 inline으로 통합 배치.

### Target Layout

```
현재 (3줄, ~125px):
┌─────────────────────────────────────────────────┐
│ Session Dashboard                    ● Connected│  ← 행1 (~64px)
├─────────────────────────────────────────────────┤
│ [전체] [Mac1] [Mac2]                            │  ← 행2 (~37px)
├─────────────────────────────────────────────────┤
│ [All] [OpenCode] [Claude]                       │  ← 행3 (~24px)
└─────────────────────────────────────────────────┘

목표 (1줄, ~35px):
┌─────────────────────────────────────────────────┐
│ [◆] ● [전체|Mac1|Mac2]  [All|OpenCode|Claude]  │  ← 단일 행
└─────────────────────────────────────────────────┘

모바일 (flex-wrap, ~70px):
┌──────────────────────────┐
│ [◆] ● [전체|Mac1|Mac2]  │  ← 행1
│ [All|OpenCode|Claude]    │  ← 행2 (자연 wrap)
└──────────────────────────┘
```

### Concrete Deliverables
- `server/frontend/src/App.svelte`: HTML 구조 재배치 + scoped CSS
- `server/frontend/src/app.css`: `.dashboard-header` toolbar 스타일 + 모바일 breakpoint
- `server/frontend/src/components/MachineSelector.svelte`: inline 모드 CSS
- 테스트 서버(0.63) 및 운영 서버(0.2) 배포

### Definition of Done
- [x] `vite build` 성공 (exit code 0)
- [x] `vitest run` 전체 통과
- [x] E2E 테스트 전체 통과
- [x] 데스크탑: 헤더 1줄, 수직 공간 ≤ 50px
- [x] 모바일: flex-wrap으로 자연 줄바꿈, 터치 타겟 ≥ 44px
- [x] 테스트 서버(0.63), 운영 서버(0.2) 배포 완료

### Must Have
- 대시보드 아이콘 (inline SVG, grid/dashboard 형태)
- 연결 상태 dot (●/○) 가시성 유지 (`.connection-status` 클래스 유지)
- tooltip으로 "Connected"/"Disconnected" 텍스트 접근성 보존 (`title` 속성)
- 모든 breakpoint 정상 렌더링
- 기존 E2E 테스트 전체 통과
- 모바일 터치 타겟 44px 유지
- MachineSelector 조건부 렌더링 동작 유지 (`shouldShowMachineFilter()`)

### Must NOT Have (Guardrails)
- CSS 클래스명 변경 금지 (`.source-filter-btn`, `.machine-btn`, `.machine-selector`, `.source-filter`, `.dashboard-header`, `.connection-status`)
- `data-testid` 속성 변경 금지
- 새 컴포넌트 파일 생성 금지
- CSS 커스텀 프로퍼티(변수) 신규 도입 금지
- `shouldShowMachineFilter()` 로직 변경 금지
- 버튼 색상, accent, border-radius(9999px), 활성 상태 스타일 변경 금지
- `.dashboard-layout` 이하 CSS 수정 금지 (sidebar, main-content, panel 등)
- `.source-filter-btn` 텍스트 내용 변경 금지 ("All", "OpenCode", "Claude")
- detail view (`.detail-header`) 스타일 변경 금지
- "compact mode" 토글 기능 추가 금지
- body/html global 스타일 변경 금지

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (tests-after — 기존 테스트 통과 확인)
- **Framework**: vitest (unit), playwright (E2E)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright — Navigate, interact, assert DOM, screenshot
- **Build**: Use Bash — `vite build`, `vitest run`, `playwright test`

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Sequential — 3 files tightly coupled):
└── Task 1: Header toolbar 통합 (App.svelte + app.css + MachineSelector.svelte) [visual-engineering]

Wave 2 (After Wave 1 — verification):
└── Task 2: 빌드 + 유닛 테스트 + E2E 테스트 [quick]

Wave 3 (After Wave 2 — deployment):
└── Task 3: 테스트 서버(0.63) → 운영 서버(0.2) 배포 [quick]

Critical Path: Task 1 → Task 2 → Task 3
Note: Task 1은 3개 파일이 밀접하게 연결되어 병렬 분리 불가 (HTML 구조 변경이 CSS에 영향)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | 2 |
| 2 | 1 | 3 |
| 3 | 2 | — |

### Agent Dispatch Summary

- **Wave 1**: **1** — T1 → `visual-engineering`
- **Wave 2**: **1** — T2 → `quick`
- **Wave 3**: **1** — T3 → `quick`

---

## TODOs

- [x] 1. Header toolbar 통합 — 3줄→1줄 구조 변경

  **What to do**:

  **A. App.svelte HTML 구조 변경** (L107-132):

  현재 구조:
  ```svelte
  <header class="dashboard-header">
    <h1>Session Dashboard</h1>
    <span class="connection-status" class:connected>
      {connected ? "● Connected" : "○ Disconnected"}
    </span>
  </header>
  <MachineSelector />
  <div class="source-filter">
    <button class="source-filter-btn" ...>All</button>
    <button class="source-filter-btn" ...>OpenCode</button>
    <button class="source-filter-btn" ...>Claude</button>
  </div>
  ```

  목표 구조:
  ```svelte
  <header class="dashboard-header">
    <svg class="dashboard-icon" width="18" height="18" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
    <span class="connection-status" class:connected
          title={connected ? "Connected" : "Disconnected"}>
      {connected ? "●" : "○"}
    </span>
    <MachineSelector />
    <div class="source-filter">
      <button class="source-filter-btn" class:active={sourceFilter === "all"}
              onclick={() => setSourceFilter("all")}>All</button>
      <button class="source-filter-btn" class:active={sourceFilter === "opencode"}
              onclick={() => setSourceFilter("opencode")}>OpenCode</button>
      <button class="source-filter-btn" class:active={sourceFilter === "claude-code"}
              onclick={() => setSourceFilter("claude-code")}>Claude</button>
    </div>
  </header>
  ```

  핵심 변경점:
  - `<h1>Session Dashboard</h1>` → inline SVG 아이콘 (4-square grid 대시보드 모양)
  - `connection-status` 텍스트 → dot만 (●/○), tooltip `title` 속성으로 접근성 보존
  - `<MachineSelector />` 를 `<header>` 안으로 이동
  - `<div class="source-filter">` 를 `<header>` 안으로 이동

  **B. App.svelte scoped CSS 변경** (L179-220):

  `.source-filter` 수정:
  - `margin-bottom: 0.5rem` → `margin-bottom: 0` (header 안이므로 불필요)
  - `padding: 0 1rem` → `padding: 0` (header가 padding 관리)
  - `margin-left: auto` 추가 (오른쪽 정렬 — 소스필터를 toolbar 우측에 배치)

  `.source-filter-btn` 수정:
  - `padding: 0.25rem 0.65rem` → `padding: 0.15rem 0.5rem` (약간 축소)
  - `font-size: 0.72rem` → `font-size: 0.7rem` (미세 축소)

  신규 CSS 추가:
  ```css
  .dashboard-icon {
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  ```

  **C. app.css global 스타일 변경**:

  `main` (L35-43):
  - `padding: 1.5rem` → `padding: 0.75rem 1.5rem` (상단 padding 축소)

  `.dashboard-header` (L48-55) — 완전 재작성:
  ```css
  .dashboard-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  ```
  변경: `justify-content: space-between` 제거, `padding-bottom` 제거, `border-bottom` 제거, `margin-bottom` 축소

  `.dashboard-header h1` (L57-61) — **삭제** (h1 더 이상 없음)

  `.connection-status` (L63-67):
  - `font-size: 0.8rem` → `font-size: 0.75rem`

  모바일 breakpoint `@media (max-width: 599px)` (L267-326):
  - `.dashboard-header` (L276-281): `margin-bottom: 0.75rem` → `margin-bottom: 0.35rem`, `flex-wrap: wrap` 유지, `gap: 0.5rem` → `gap: 0.35rem`
  - `.dashboard-header h1` (L282-284): **삭제** (h1 없음)
  - `.connection-status` (L285-287): 유지
  - `main` (L273-275): `padding: 0.5rem` → `padding: 0.35rem 0.5rem`
  - `.source-filter` (L322-325): `margin-bottom: 0.35rem` → `margin-bottom: 0`, `padding: 0 0.5rem` → `padding: 0`

  **D. MachineSelector.svelte scoped CSS 변경** (L36-100):

  `.machine-selector` (L37-46) — inline 모드로 변경:
  ```css
  .machine-selector {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  ```
  제거: `padding`, `background`, `border-bottom`, `overflow-x: auto`

  `.machine-btn` (L48-62):
  - `padding: 0.25rem 0.75rem` → `padding: 0.2rem 0.6rem` (약간 축소)
  - `font-size: 0.75rem` → `font-size: 0.72rem` (미세 축소)

  모바일 breakpoint `@media (max-width: 599px)` (L90-99):
  - `.machine-selector` (L91-93): `padding` 제거 (이미 inline)
  - `.machine-btn` (L95-98): `min-height: 44px` **반드시 유지**, padding만 약간 축소

  **Must NOT do**:
  - CSS 클래스명 변경 (`.dashboard-header`, `.connection-status`, `.machine-selector`, `.source-filter`, `.source-filter-btn`, `.machine-btn`)
  - `data-testid` 변경
  - `shouldShowMachineFilter()` 로직 변경 (MachineSelector.svelte 내부 조건부 렌더링 유지)
  - 버튼 텍스트 변경 ("All", "OpenCode", "Claude")
  - 색상, accent, border-radius(9999px), active 상태 스타일 변경
  - `.dashboard-layout` 이하 스타일 변경
  - `.detail-header` 스타일 변경
  - `.status-dot` 크기/스타일 변경
  - 모바일 `.machine-btn` `min-height: 44px` 제거/감소
  - 새 컴포넌트 파일 생성
  - CSS 커스텀 프로퍼티(변수) 신규 도입

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: HTML 구조 재배치 + CSS 레이아웃 변경 — UI 레이아웃 전문성 필요
  - **Skills**: []
    - 스킬 불필요 — Svelte/CSS 기본 지식으로 충분
  - **Skills Evaluated but Omitted**:
    - `ui-ux-pro-max`: 디자인 시스템 수준이 아닌 레이아웃 재배치
    - `frontend-design`: 새 UI 생성이 아닌 기존 요소 재배치
    - `playwright`: 구현 단계에서는 불필요 (Task 2에서 테스트)

  **Parallelization**:
  - **Can Run In Parallel**: NO (3개 파일이 밀접하게 연결)
  - **Parallel Group**: Wave 1 (단독)
  - **Blocks**: Task 2
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `server/frontend/src/App.svelte:107-132` — 현재 header + MachineSelector + source-filter HTML 구조. 이 영역 전체를 재배치
  - `server/frontend/src/App.svelte:179-220` — 현재 scoped CSS. `.source-filter`, `.source-filter-btn` 스타일 수정, `.dashboard-icon` 추가
  - `server/frontend/src/app.css:35-43` — `main` padding. 상단만 축소
  - `server/frontend/src/app.css:48-67` — `.dashboard-header`, `h1`, `.connection-status` 글로벌 스타일. header를 flex toolbar로 재작성, h1 규칙 삭제
  - `server/frontend/src/app.css:267-326` — 모바일 breakpoint. header 관련 규칙 업데이트
  - `server/frontend/src/components/MachineSelector.svelte:1-35` — HTML 구조 (template). 변경 없음 — 내부 조건부 렌더링 유지
  - `server/frontend/src/components/MachineSelector.svelte:36-100` — scoped CSS. `.machine-selector` inline 모드로 변경

  **Test References** (E2E 셀렉터 — 깨지지 않도록 주의):
  - `server/e2e/dashboard.spec.ts:17-20` — `page.toHaveTitle(/Session Dashboard/)` — HTML `<title>` 체크, h1 아님 → 안전
  - `server/e2e/dashboard.spec.ts:33-38` — `.connection-status` 클래스 가시성 체크 → 클래스 유지, 요소 가시성 유지
  - `server/e2e/machine-filter.spec.ts` — `[data-testid="machine-selector"]`, `.machine-btn` 셀렉터 → 클래스명+data-testid 유지
  - `server/e2e/claude-regression.spec.ts` — `.source-filter-btn:has-text("Claude")` — 버튼 텍스트 유지

  **Acceptance Criteria**:

  - [x] h1 "Session Dashboard" 텍스트 제거, inline SVG 아이콘으로 교체
  - [x] connection-status에 dot만 표시 (●/○), title 속성으로 접근성 보존
  - [x] MachineSelector가 header 안에서 inline 렌더링
  - [x] source-filter가 header 안에서 inline 렌더링
  - [x] 데스크탑: 1줄 배치
  - [x] 모바일: flex-wrap으로 자연 줄바꿈
  - [x] 모바일 `.machine-btn` min-height: 44px 유지

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 데스크탑 1줄 toolbar 렌더링
    Tool: Playwright
    Preconditions: 서버 dev 모드 실행 또는 빌드 완료
    Steps:
      1. page.goto("http://localhost:5173") 또는 빌드된 서버 URL
      2. page.setViewportSize({ width: 1280, height: 800 })
      3. const header = page.locator('.dashboard-header')
      4. await expect(header).toBeVisible()
      5. const box = await header.boundingBox()
      6. Assert: box.height <= 50
      7. h1 요소가 없는지 확인: await expect(page.locator('.dashboard-header h1')).toHaveCount(0)
      8. SVG 아이콘 존재 확인: await expect(page.locator('.dashboard-icon')).toBeVisible()
      9. connection-status 확인: await expect(page.locator('.connection-status')).toBeVisible()
      10. source-filter가 header 안에 있는지: await expect(page.locator('.dashboard-header .source-filter')).toBeVisible()
      11. 스크린샷: await page.screenshot({ path: '.sisyphus/evidence/task-1-desktop-toolbar.png' })
    Expected Result: header height ≤ 50px, 아이콘+dot+필터 1줄 배치
    Failure Indicators: header height > 50px, h1 텍스트 남아있음, 요소가 여러 줄로 배치
    Evidence: .sisyphus/evidence/task-1-desktop-toolbar.png

  Scenario: 모바일 flex-wrap 동작
    Tool: Playwright
    Preconditions: 동일
    Steps:
      1. page.setViewportSize({ width: 375, height: 812 })
      2. const header = page.locator('.dashboard-header')
      3. const box = await header.boundingBox()
      4. Assert: box.height <= 80 (wrap 허용)
      5. Assert: box.height >= 30 (최소 1줄)
      6. const machineBtn = page.locator('.machine-btn').first()
      7. if (await machineBtn.isVisible()) { const btnBox = await machineBtn.boundingBox(); Assert: btnBox.height >= 44 }
      8. 스크린샷: await page.screenshot({ path: '.sisyphus/evidence/task-1-mobile-wrap.png' })
    Expected Result: 자연 wrap, 터치 타겟 ≥ 44px
    Failure Indicators: 요소 잘림, 터치 타겟 < 44px
    Evidence: .sisyphus/evidence/task-1-mobile-wrap.png

  Scenario: E2E 셀렉터 호환성 검증
    Tool: Bash
    Preconditions: 수정 완료
    Steps:
      1. grep 'class="dashboard-header"' server/frontend/src/App.svelte
      2. grep 'class="connection-status"' server/frontend/src/App.svelte
      3. grep 'class="source-filter"' server/frontend/src/App.svelte
      4. grep 'class="source-filter-btn"' server/frontend/src/App.svelte (3개 존재)
      5. grep 'data-testid="machine-selector"' server/frontend/src/components/MachineSelector.svelte
      6. grep 'class="machine-btn"' server/frontend/src/components/MachineSelector.svelte
      7. grep ':has-text' 대상 텍스트 확인: "All", "OpenCode", "Claude" 버튼 텍스트 유지 확인
    Expected Result: 모든 CSS 클래스명, data-testid, 버튼 텍스트 존재
    Failure Indicators: 클래스명 누락 또는 변경
    Evidence: .sisyphus/evidence/task-1-selector-compat.txt
  ```

  **Commit**: YES
  - Message: `refactor(header): compress 3-row header into single-row toolbar with icon`
  - Files: `server/frontend/src/App.svelte`, `server/frontend/src/app.css`, `server/frontend/src/components/MachineSelector.svelte`
  - Pre-commit: `cd server/frontend && npx vite build`

- [x] 2. 빌드 검증 + 유닛 테스트 + E2E 테스트

  **What to do**:
  - `cd server/frontend && npx vite build` — 빌드 성공 확인
  - `cd server && npx vitest run` — 유닛 테스트 전체 통과
  - `cd server && npx playwright test` — E2E 테스트 전체 통과 (가장 중요)
  - 실패 시 Task 1 변경사항 디버깅 및 수정
  - **E2E 실패 시 주요 확인 사항**:
    - `.connection-status` 가시성 (dashboard.spec.ts:33-38)
    - `.source-filter-btn:has-text("Claude")` 찾기 (claude-regression)
    - `[data-testid="machine-selector"]` 가시성 (machine-filter)

  **Must NOT do**:
  - 테스트 파일 삭제
  - E2E 테스트 스킵
  - 테스트 실패를 무시하고 진행

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 명령어 실행 및 결과 확인
  - **Skills**: [`cleanup-after-test`]
    - `cleanup-after-test`: 테스트 실행 후 불필요한 아티팩트 정리

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 1)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `server/package.json` — test scripts, vitest config
  - `server/frontend/vite.config.ts` — build config

  **Test References**:
  - `server/e2e/dashboard.spec.ts` — 대시보드 로드, 패널 표시, connection-status 가시성
  - `server/e2e/machine-filter.spec.ts` — machine-selector, machine-btn 셀렉터
  - `server/e2e/claude-regression.spec.ts` — source-filter-btn:has-text("Claude")
  - `server/e2e/claude-real-pipeline.spec.ts` — source-filter-btn:has-text("Claude")

  **Acceptance Criteria**:

  - [x] `vite build` → exit code 0
  - [x] `vitest run` → all tests pass
  - [x] `playwright test` → all tests pass

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 빌드 성공
    Tool: Bash
    Preconditions: Task 1 완료
    Steps:
      1. cd server/frontend && npx vite build 2>&1
      2. exit code 확인
    Expected Result: exit code 0, "✓ built in" 메시지 출력
    Failure Indicators: "error" 메시지, exit code 1
    Evidence: .sisyphus/evidence/task-2-build.txt

  Scenario: 유닛 테스트 전체 통과
    Tool: Bash
    Preconditions: 빌드 성공
    Steps:
      1. cd server && npx vitest run 2>&1
      2. 결과 확인
    Expected Result: "Tests X passed", 0 failures
    Failure Indicators: "FAIL" 출력
    Evidence: .sisyphus/evidence/task-2-unit-test.txt

  Scenario: E2E 테스트 전체 통과
    Tool: Bash
    Preconditions: 빌드 성공
    Steps:
      1. cd server && npx playwright test 2>&1
      2. 결과 확인
    Expected Result: 모든 테스트 passed
    Failure Indicators: "failed" 또는 "timed out" 출력
    Evidence: .sisyphus/evidence/task-2-e2e-test.txt
  ```

  **Commit**: NO (Task 1에서 이미 커밋)

- [x] 3. 테스트 서버(0.63) → 운영 서버(0.2) 배포

  **What to do**:
  - 배포 워크플로우 스킬 로드: `deploy-workflow`
  - 테스트 서버(192.168.0.63) 먼저 배포 및 검증
  - 검증 통과 후 운영 서버(192.168.0.2) 배포
  - 프론트엔드만 변경이므로 서버 Docker만 재빌드 (agent 재시작 불필요)

  **Must NOT do**:
  - 테스트 서버 검증 없이 운영 배포 (절대 금지)
  - agent 재시작 (프론트엔드 전용 변경)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 배포 스크립트 실행
  - **Skills**: [`deploy-workflow`]
    - `deploy-workflow`: 배포 워크플로우 스킬 (테스트 → 운영 순서 보장)

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after Task 2)
  - **Blocks**: None
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `.sisyphus/skills/deploy-workflow/SKILL.md` — 배포 절차 상세

  **External References**:
  - 테스트 서버: `192.168.0.63` — agent port 3101, server Docker port 3097
  - 운영 서버: `192.168.0.2` — SSH `sbbae@192.168.0.2`, path `/home/sbbae/project/session-dashboard`
  - Server deploy: `cd server && docker compose up -d --build`

  **Acceptance Criteria**:

  - [x] 테스트 서버(0.63) 배포 및 정상 동작 확인
  - [x] 운영 서버(0.2) 배포 및 정상 동작 확인
  - [x] 두 서버 모두 `http://{ip}:3097` 접속 시 1줄 toolbar 확인

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 테스트 서버 배포 후 확인
    Tool: Bash (curl)
    Preconditions: 테스트 서버 배포 완료
    Steps:
      1. curl -s -o /dev/null -w "%{http_code}" http://192.168.0.63:3097/
      2. HTTP 200 확인
    Expected Result: HTTP 200
    Failure Indicators: 연결 실패, non-200 status
    Evidence: .sisyphus/evidence/task-3-test-deploy.txt

  Scenario: 운영 서버 배포 후 확인
    Tool: Bash (curl)
    Preconditions: 테스트 서버 검증 통과 후
    Steps:
      1. curl -s -o /dev/null -w "%{http_code}" http://192.168.0.2:3097/
      2. HTTP 200 확인
    Expected Result: HTTP 200
    Failure Indicators: 연결 실패, non-200 status
    Evidence: .sisyphus/evidence/task-3-prod-deploy.txt
  ```

  **Commit**: NO (Task 1에서 이미 커밋 완료)

---

## Final Verification Wave

> Task 2의 빌드/E2E 테스트 통과 + Task 3의 배포 검증으로 충분합니다.
> HTML 구조 변경이 포함되지만 범위가 작고 E2E 테스트가 핵심 셀렉터를 모두 커버합니다.

- [x] F1. **E2E 통합 검증** — Task 2에서 수행 (playwright test 전체 실행)
- [x] F2. **배포 검증** — Task 3에서 수행 (curl 응답 확인)

---

## Commit Strategy

- **1 (Task 1)**: `refactor(header): compress 3-row header into single-row toolbar with icon` — App.svelte, app.css, MachineSelector.svelte

---

## Success Criteria

### Verification Commands
```bash
cd server/frontend && npx vite build   # Expected: exit code 0
cd server && npx vitest run            # Expected: all tests pass
cd server && npx playwright test       # Expected: all tests pass
curl -s http://192.168.0.63:3097/      # Expected: HTTP 200
curl -s http://192.168.0.2:3097/       # Expected: HTTP 200
```

### Final Checklist
- [x] h1 제거, 아이콘으로 교체
- [x] 연결 상태 dot만 표시, title 속성으로 접근성 보존
- [x] 데스크탑: 1줄 toolbar, height ≤ 50px
- [x] 모바일: flex-wrap, 터치 타겟 ≥ 44px
- [x] E2E 테스트 전체 통과
- [x] CSS 클래스명 및 data-testid 변경 없음
- [x] 테스트 서버 + 운영 서버 배포 완료
