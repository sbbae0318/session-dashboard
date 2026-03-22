# Session List UI 개선 — 제목 확대, 삭제 버튼 이동, 카드 클릭 동작 변경

## TL;DR

> **Quick Summary**: 세션 카드에서 액션 버튼(› ×)을 제거해 제목 영역을 넓히고, 카드 클릭으로 디테일 뷰 진입(+커맨드 복사+필터링) 통합. 삭제(숨기기) 버튼은 디테일 헤더로 이동.
> 
> **Deliverables**:
> - 세션 카드에서 액션 버튼 제거 + 제목 영역 확대
> - 카드 클릭 → 디테일 뷰 진입 + 커맨드 복사 + 세션 필터링 통합
> - 디테일 뷰 헤더에 '숨기기' 버튼 추가
> - 기존 Playwright 테스트 업데이트
> 
> **Estimated Effort**: Quick
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

---

## Context

### Original Request
세션 리스트 UI 개선:
- 제목 영역이 너무 작아 안 보임
- 세션 삭제 버튼을 카드 바깥(디테일 헤더)으로 이동
- 자세히 보기 버튼 제거 → 세션 카드 클릭으로 디테일 진입
- 기존 필터링 + 커맨드 복사 기능 유지

### Interview Summary
**Key Discussions**:
- 삭제 버튼 위치: 디테일 뷰 헤더의 '← 돌아가기' 옆에 '숨기기' 버튼 배치
- 테스트 전략: 유닛 테스트 없이, Playwright QA로 시각적 검증

**Research Findings**:
- `.session-header-top`에서 status-badge + title + subagent-badge + header-actions(› ×) 한 줄 구성 → 사이드바 260px에서 title 공간 부족
- `dismissSession(sessionId, lastActivityTime)` — 두 파라미터 필요 → App.svelte에서 세션 객체 lookup 필요
- App.svelte의 `$effect`는 `getSessions()`(dismissed 미필터)를 검사 → 디테일에서 숨기기 후 자동 overview 복귀 안 됨 → 명시적 `popToOverview()` 필요

### Metis Review
**Identified Gaps** (addressed):
- **Playwright 테스트 깨짐**: `dashboard-features.spec.ts:177` 카드 클릭 → toast 테스트가 디테일 네비게이션으로 인해 실패 예상 → Task 5로 수정
- **Dismiss에서 자동 네비게이션 안 됨**: dismissed 세션이 `getSessions()`에 남아있음 → 명시적 `popToOverview()` 호출 필요 (Task 3)
- **lastActivityTime 조회**: App.svelte에서 `getSessions().find()` 활용 (Task 3)
- **Orphan CSS 정리**: `.header-actions`, `.action-btn`, `.action-detail`, `.action-dismiss` 등 CSS 제거 필요 (Task 1)
- **History double-push**: 같은 세션 재클릭 시 중복 history entry — 가드 조건 추가 (Task 2)

---

## Work Objectives

### Core Objective
세션 카드 UI를 단순화하여 제목 가독성을 높이고, 카드 클릭으로 디테일 뷰 진입을 통합하며, 삭제(숨기기) 기능을 디테일 헤더로 이동한다.

### Concrete Deliverables
- `ActiveSessions.svelte`: 액션 버튼 제거 + orphan CSS 정리
- `ActiveSessions.svelte`: `handleSessionClick`에 `pushSessionDetail` 추가
- `App.svelte`: 디테일 헤더에 숨기기 버튼 + dismiss 로직 추가
- `dashboard-features.spec.ts`: 카드 클릭 테스트 업데이트

### Definition of Done
- [ ] 세션 카드에 › × 버튼 없음
- [ ] 카드 클릭 → 디테일 뷰 진입 + 커맨드 복사 + 필터링
- [ ] 디테일 헤더에 '숨기기' 버튼 표시
- [ ] 숨기기 클릭 → 세션 dismiss + overview로 복귀
- [ ] 기존 Playwright 테스트 통과

### Must Have
- 카드 클릭 시 커맨드 클립보드 복사 유지
- 카드 클릭 시 세션 필터링(`selectSession`) 유지
- 카드 클릭 시 디테일 뷰 진입(`pushSessionDetail`) 추가
- 디테일 헤더에서 세션 숨기기 가능
- 숨기기 후 overview로 자동 복귀

### Must NOT Have (Guardrails)
- `filter.svelte.ts`, `navigation.svelte.ts`, `dismissed.svelte.ts` 스토어 파일 수정 금지
- 새 컴포넌트 파일 생성 금지
- 사이드바 너비/반응형 breakpoint 변경 금지
- 카드 레이아웃 재구조화 (버튼 제거 외 변경 금지)
- 클립보드 복사/토스트 동작 변경 금지
- dismiss 확인 다이얼로그 추가 금지
- `RecentPrompts`, `CommandPalette`, 페이지 컴포넌트 수정 금지

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest + Playwright)
- **Automated tests**: None (유닛 테스트 불필요)
- **Framework**: Playwright (E2E QA)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — independent changes):
├── Task 1: Remove action buttons + clean orphan CSS [quick]
├── Task 2: Wire card click → detail navigation [quick]
└── Task 3: Add dismiss button to detail header [quick]

Wave 2 (After Wave 1 — dependent):
├── Task 4: Build verification + integration QA [quick]
└── Task 5: Update Playwright tests [quick]

Critical Path: Task 1 → Task 4
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | 4, 5 |
| 2 | — | 4, 5 |
| 3 | — | 4, 5 |
| 4 | 1, 2, 3 | — |
| 5 | 1, 2, 3 | — |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 → `quick`, T2 → `quick`, T3 → `quick`
- **Wave 2**: 2 tasks — T4 → `unspecified-high`, T5 → `quick`

---

## TODOs

- [ ] 1. 세션 카드 액션 버튼 제거 + Orphan CSS 정리

  **What to do**:
  - `ActiveSessions.svelte`에서 `.header-actions` span 및 내부 버튼 2개(› detail, × dismiss) 제거 (lines 126-137)
  - `handleDismiss` 함수 제거 (lines 27-30) — 더 이상 이 컴포넌트에서 사용하지 않음
  - `import { dismissSession, ... }` 에서 `dismissSession` 제거 (line 6)
  - `import { getDetailSessionId, pushSessionDetail }` 에서 `getDetailSessionId` 제거 (line 7) — 더 이상 이 컴포넌트에서 사용하지 않음 (`detailId` derived도 제거)
  - `detailId` derived 변수 제거 (line 23)
  - `.session-item`의 `class:detail-active={detailId === session.sessionId}` 제거 (line 112)
  - Orphan CSS 정리:
    - `.header-actions` 및 관련 hover 규칙 (lines 282-293)
    - `.action-btn` 전체 (lines 457-473)
    - `.action-detail:hover` (lines 475-478)
    - `.action-dismiss:hover` (lines 480-483)
    - `.session-item.detail-active` (lines 229-233)
    - `@media (pointer: coarse)` 내 `.header-actions` 및 `.action-btn` (lines 516-527)
    - `@media (max-width: 599px)` 내 `.action-btn` (lines 553-557)

  **Must NOT do**:
  - 카드 레이아웃 구조 변경 (`.session-header-top` flex 구조 유지)
  - `pushSessionDetail` import 제거하지 말 것 (Task 2에서 사용)
  - 토스트/클립보드 관련 코드 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 파일 내 HTML 템플릿 삭제 + CSS 정리. 로직 변경 없음.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `ui-ux-pro-max`: CSS 정리만 하므로 디자인 스킬 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:118-137` — 현재 `.session-header-top` 구조 (제거 대상 `.header-actions` 포함)
  - `server/frontend/src/components/ActiveSessions.svelte:282-293` — `.header-actions` CSS (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:457-483` — `.action-btn` 관련 CSS (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:516-527` — touch 디바이스 CSS (제거 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:553-557` — 모바일 CSS (제거 대상)

  **WHY Each Reference Matters**:
  - lines 126-137: 제거할 HTML 템플릿 — `.header-actions` span과 두 버튼
  - lines 282-293: 제거할 CSS — hover 시 opacity 전환 로직
  - lines 457-483: 제거할 CSS — 버튼 스타일링 전체
  - lines 516-527, 553-557: 제거할 반응형 CSS — 터치/모바일에서의 액션 버튼 오버라이드

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Happy path — 세션 카드에 액션 버튼 없음
    Tool: Playwright
    Preconditions: 대시보드 로드 완료, 세션 1개 이상 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. const headerActions = page.locator('.header-actions')
      4. await expect(headerActions).toHaveCount(0)
      5. const actionBtns = page.locator('.action-btn')
      6. await expect(actionBtns).toHaveCount(0)
      7. page.screenshot({ path: '.sisyphus/evidence/task-1-no-action-buttons.png' })
    Expected Result: `.header-actions`와 `.action-btn` 셀렉터가 DOM에 0개
    Failure Indicators: count > 0
    Evidence: .sisyphus/evidence/task-1-no-action-buttons.png

  Scenario: 제목 영역 확장 확인
    Tool: Playwright
    Preconditions: 대시보드 로드 완료
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-title')
      3. const titleBox = await page.locator('.session-title').first().boundingBox()
      4. Assert titleBox.width > 150 (기존에는 ~80px 정도)
      5. page.screenshot({ path: '.sisyphus/evidence/task-1-title-expanded.png' })
    Expected Result: session-title의 width가 150px 이상
    Failure Indicators: width <= 100px
    Evidence: .sisyphus/evidence/task-1-title-expanded.png
  ```

  **Evidence to Capture:**
  - [ ] task-1-no-action-buttons.png
  - [ ] task-1-title-expanded.png

  **Commit**: YES (groups with Tasks 2, 3)
  - Message: `refactor(ui): simplify session card — remove action buttons, wire card click to detail, add dismiss to detail header`
  - Files: `server/frontend/src/components/ActiveSessions.svelte`

- [ ] 2. 카드 클릭 → 디테일 뷰 진입 연결

  **What to do**:
  - `ActiveSessions.svelte`의 `handleSessionClick` 함수 수정 (line 61-64):
    ```typescript
    function handleSessionClick(session: DashboardSession): void {
      selectSession(session.sessionId);
      copySessionCommand(session);
      pushSessionDetail(session.sessionId);  // 추가
    }
    ```
  - `pushSessionDetail`은 이미 line 7에서 import되어 있음 (Task 1에서 `getDetailSessionId`만 제거, `pushSessionDetail`은 유지)

  **Must NOT do**:
  - `selectSession` toggle 로직 변경 (filter.svelte.ts 수정 금지)
  - `pushSessionDetail` 로직 변경 (navigation.svelte.ts 수정 금지)
  - `copySessionCommand` 로직 변경
  - 중복 history.pushState 방지 가드 추가 금지 (기존 동작과 동일하게 유지 — benign duplicate)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 한 줄 추가. 기존 함수 호출만 추가.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:61-64` — 현재 `handleSessionClick` 함수 (수정 대상)
  - `server/frontend/src/components/ActiveSessions.svelte:7` — `pushSessionDetail` import (이미 존재)
  - `server/frontend/src/lib/stores/navigation.svelte.ts:97-113` — `pushSessionDetail` 함수 구현 (참고용 — URL 파라미터 설정, history.pushState 호출)

  **WHY Each Reference Matters**:
  - line 61-64: 수정 대상 함수 — `pushSessionDetail` 호출 한 줄 추가
  - line 7: import 확인 — 이미 존재하므로 import 추가 불필요
  - navigation.svelte.ts:97-113: `pushSessionDetail`이 URL에 `?session=ID` 설정 + history push 하는 것 확인 (사이드 이펙트 이해)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Happy path — 카드 클릭 시 디테일 뷰 진입
    Tool: Playwright
    Preconditions: 대시보드 로드 완료, 세션 1개 이상 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. await page.locator('.session-item').first().click()
      4. await expect(page.locator('.detail-header')).toBeVisible({ timeout: 3000 })
      5. const url = page.url()
      6. Assert url includes '?session='
      7. page.screenshot({ path: '.sisyphus/evidence/task-2-card-click-detail.png' })
    Expected Result: `.detail-header`가 표시되고 URL에 `?session=` 파라미터 존재
    Failure Indicators: `.detail-header` 미표시 또는 URL에 session 파라미터 없음
    Evidence: .sisyphus/evidence/task-2-card-click-detail.png

  Scenario: 카드 클릭 시 커맨드 복사 토스트 동시 표시
    Tool: Playwright
    Preconditions: 대시보드 로드 완료
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. await page.locator('.session-item').first().click()
      4. await expect(page.locator('.copy-toast')).toBeVisible({ timeout: 3000 })
      5. page.screenshot({ path: '.sisyphus/evidence/task-2-toast-with-detail.png' })
    Expected Result: 디테일 뷰 전환과 동시에 `.copy-toast`가 사이드바에 표시
    Failure Indicators: toast 미표시
    Evidence: .sisyphus/evidence/task-2-toast-with-detail.png

  Scenario: 키보드 Enter로도 디테일 진입
    Tool: Playwright
    Preconditions: 대시보드 로드 완료
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. await page.locator('.session-item').first().focus()
      4. await page.keyboard.press('Enter')
      5. await expect(page.locator('.detail-header')).toBeVisible({ timeout: 3000 })
    Expected Result: Enter 키로도 디테일 뷰 진입
    Failure Indicators: `.detail-header` 미표시
    Evidence: .sisyphus/evidence/task-2-keyboard-enter.png
  ```

  **Evidence to Capture:**
  - [ ] task-2-card-click-detail.png
  - [ ] task-2-toast-with-detail.png
  - [ ] task-2-keyboard-enter.png

  **Commit**: YES (groups with Tasks 1, 3)
  - Message: (same commit as Task 1)
  - Files: `server/frontend/src/components/ActiveSessions.svelte`

- [ ] 3. 디테일 헤더에 '숨기기' 버튼 추가

  **What to do**:
  - `App.svelte`에 `dismissSession` import 추가 (line 12 수정):
    ```typescript
    import { reviveSessions, dismissSession } from "./lib/stores/dismissed.svelte";
    ```
  - 디테일 헤더에 dismiss 핸들러 함수 추가 (script 영역):
    ```typescript
    function handleDismissFromDetail(): void {
      if (!detailId) return;
      const sessions = getSessions();
      const session = sessions.find(s => s.sessionId === detailId);
      if (!session) return;
      dismissSession(session.sessionId, session.lastActivityTime);
      popToOverview();
    }
    ```
  - 디테일 헤더 템플릿 수정 (lines 182-185):
    ```svelte
    <div class="detail-header view-transition">
      <button class="back-btn" onclick={popToOverview}>← 돌아가기</button>
      <span class="detail-session-id">{detailId}</span>
      <button class="dismiss-btn" onclick={handleDismissFromDetail}>숨기기</button>
    </div>
    ```
  - `.dismiss-btn` CSS 추가 (기존 `.back-btn` 스타일 참고하되, 위험 액션이므로 빨간 계열 hover):
    ```css
    .dismiss-btn {
      margin-left: auto;
      background: none;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.25rem 0.6rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      cursor: pointer;
      font-family: inherit;
      transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .dismiss-btn:hover {
      color: var(--error);
      border-color: var(--error);
      background: rgba(248, 81, 73, 0.1);
    }
    ```

  **Must NOT do**:
  - `dismissSession` 함수 시그니처 변경 (dismissed.svelte.ts 수정 금지)
  - `popToOverview` 함수 수정 (navigation.svelte.ts 수정 금지)
  - dismiss 확인 다이얼로그 추가
  - `detailId`가 null일 때의 복잡한 에러 핸들링 (간단한 early return으로 충분)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: App.svelte에 import 1개 + 함수 1개 + 버튼 1개 + CSS 추가. 단순 추가 작업.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/App.svelte:12` — 현재 dismissed store import (`reviveSessions`만 import 중 → `dismissSession` 추가)
  - `server/frontend/src/App.svelte:6` — `getSessions` import (이미 존재 — 세션 lookup에 사용)
  - `server/frontend/src/App.svelte:14` — `popToOverview` import (이미 존재)
  - `server/frontend/src/App.svelte:181-185` — 현재 디테일 헤더 구조 (수정 대상)
  - `server/frontend/src/App.svelte:30` — `detailId` derived 변수 (이미 존재)
  - `server/frontend/src/lib/stores/dismissed.svelte.ts:8-11` — `dismissSession(sessionId, lastActivityTime)` 시그니처 확인

  **API/Type References**:
  - `server/frontend/src/types.ts:DashboardSession` — `sessionId`, `lastActivityTime` 필드 확인

  **WHY Each Reference Matters**:
  - line 12: import 수정 지점 — `dismissSession`을 같은 import에 추가
  - line 6: `getSessions` 이미 import — 세션 객체 lookup에 활용
  - lines 181-185: 수정 대상 HTML — 여기에 버튼 추가
  - dismissed.svelte.ts:8-11: `dismissSession`에 `lastActivityTime`이 필수 파라미터임을 확인 — 세션 lookup이 필요한 이유

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Happy path — 디테일 헤더에 숨기기 버튼 존재
    Tool: Playwright
    Preconditions: 대시보드 로드 완료, 세션 1개 이상 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. await page.locator('.session-item').first().click()
      4. await expect(page.locator('.detail-header')).toBeVisible({ timeout: 3000 })
      5. const dismissBtn = page.locator('.dismiss-btn')
      6. await expect(dismissBtn).toBeVisible()
      7. await expect(dismissBtn).toHaveText('숨기기')
      8. page.screenshot({ path: '.sisyphus/evidence/task-3-dismiss-btn-visible.png' })
    Expected Result: 디테일 헤더에 '숨기기' 텍스트의 `.dismiss-btn` 버튼 존재
    Failure Indicators: `.dismiss-btn` 미표시 또는 텍스트 불일치
    Evidence: .sisyphus/evidence/task-3-dismiss-btn-visible.png

  Scenario: 숨기기 클릭 → overview 복귀 + 세션 숨김
    Tool: Playwright
    Preconditions: 대시보드 로드 완료, 세션 2개 이상 존재
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. const beforeCount = await page.locator('.session-item').count()
      4. await page.locator('.session-item').first().click()
      5. await expect(page.locator('.detail-header')).toBeVisible({ timeout: 3000 })
      6. await page.locator('.dismiss-btn').click()
      7. await expect(page.locator('.detail-header')).not.toBeVisible({ timeout: 3000 })
      8. const afterCount = await page.locator('.session-item').count()
      9. Assert afterCount === beforeCount - 1
      10. page.screenshot({ path: '.sisyphus/evidence/task-3-dismiss-overview.png' })
    Expected Result: 디테일 헤더 사라지고 overview로 복귀, 세션 수 1개 감소
    Failure Indicators: 디테일 헤더 유지, 세션 수 변화 없음
    Evidence: .sisyphus/evidence/task-3-dismiss-overview.png

  Scenario: Edge case — 숨긴 세션이 '복원' 버튼으로 복구
    Tool: Playwright
    Preconditions: 대시보드 로드 완료, 세션 2개 이상
    Steps:
      1. 위 시나리오 실행하여 세션 1개 숨김
      2. const restoreBtn = page.locator('.restore-btn')
      3. await expect(restoreBtn).toBeVisible()
      4. await restoreBtn.click()
      5. const restoredCount = await page.locator('.session-item').count()
      6. Assert restoredCount === beforeCount (원래 수로 복원)
    Expected Result: 복원 버튼 클릭 후 숨긴 세션이 다시 표시
    Failure Indicators: 복원 버튼 미표시 또는 세션 수 미복원
    Evidence: .sisyphus/evidence/task-3-restore-after-dismiss.png
  ```

  **Evidence to Capture:**
  - [ ] task-3-dismiss-btn-visible.png
  - [ ] task-3-dismiss-overview.png
  - [ ] task-3-restore-after-dismiss.png

  **Commit**: YES (groups with Tasks 1, 2)
  - Message: (same commit as Task 1)
  - Files: `server/frontend/src/App.svelte`

- [ ] 4. 빌드 검증 + 통합 QA

  **What to do**:
  - `server/frontend`에서 `npm run build` 실행하여 빌드 성공 확인
  - 빌드 에러 발생 시 수정 (미사용 import, 타입 에러 등)
  - 전체 플로우 통합 테스트: 카드 클릭 → 디테일 → 숨기기 → overview → 복원

  **Must NOT do**:
  - 빌드 에러와 무관한 코드 변경
  - 스토어 파일 수정

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 빌드 + 통합 QA — 여러 시나리오의 교차 검증 필요
  - **Skills**: [`playwright`]
    - `playwright`: 통합 QA 시나리오 실행에 필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 5)
  - **Blocks**: None
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/frontend/package.json` — build script 확인
  - Task 1-3의 모든 변경사항

  **WHY Each Reference Matters**:
  - package.json: 빌드 명령어 확인 (`npm run build`)
  - Task 1-3: 변경된 파일들이 빌드에 통과하는지 검증

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 빌드 성공
    Tool: Bash
    Preconditions: Tasks 1-3 완료
    Steps:
      1. cd server/frontend && npm run build
      2. Assert exit code === 0
      3. Assert no TypeScript errors in output
    Expected Result: 빌드 성공, exit code 0
    Failure Indicators: TypeScript 에러, 빌드 실패
    Evidence: .sisyphus/evidence/task-4-build-output.txt

  Scenario: 전체 플로우 통합 테스트
    Tool: Playwright
    Preconditions: 개발 서버 구동 중
    Steps:
      1. page.goto('http://localhost:3097')
      2. await page.waitForSelector('.session-item')
      3. Assert `.header-actions` count === 0 (Task 1)
      4. await page.locator('.session-item').first().click()
      5. await expect(page.locator('.detail-header')).toBeVisible() (Task 2)
      6. await expect(page.locator('.copy-toast')).toBeVisible() (커맨드 복사)
      7. await expect(page.locator('.dismiss-btn')).toBeVisible() (Task 3)
      8. await page.locator('.dismiss-btn').click()
      9. await expect(page.locator('.detail-header')).not.toBeVisible() (overview 복귀)
      10. page.screenshot({ path: '.sisyphus/evidence/task-4-full-flow.png' })
    Expected Result: 전체 플로우가 끊김 없이 작동
    Failure Indicators: 어느 단계에서든 assertion 실패
    Evidence: .sisyphus/evidence/task-4-full-flow.png

  Scenario: 뒤로 가기 버튼 작동 확인
    Tool: Playwright
    Preconditions: 세션 클릭하여 디테일 뷰 진입 상태
    Steps:
      1. await page.locator('.back-btn').click()
      2. await expect(page.locator('.detail-header')).not.toBeVisible({ timeout: 3000 })
      3. const url = page.url()
      4. Assert url does NOT include '?session='
    Expected Result: overview로 복귀, URL 파라미터 제거
    Failure Indicators: 디테일 뷰 유지
    Evidence: .sisyphus/evidence/task-4-back-btn.png
  ```

  **Evidence to Capture:**
  - [ ] task-4-build-output.txt
  - [ ] task-4-full-flow.png
  - [ ] task-4-back-btn.png

  **Commit**: NO (빌드 검증만 — 코드 수정 시 해당 Task 커밋에 포함)

- [ ] 5. Playwright 테스트 업데이트

  **What to do**:
  - `server/e2e/dashboard-features.spec.ts`의 "Session Command Copy" 테스트 업데이트:
    - **"clicking a session card copies command to clipboard and shows toast"** (line 177):
      - 카드 클릭 후 디테일 뷰로 전환되므로, toast 확인 전에 `.detail-header` visible 대기 추가
      - 또는 toast와 detail-header 둘 다 확인하도록 수정
    - **"toast disappears after a short time"** (line 184):
      - 동일하게 디테일 뷰 전환 고려
  - 새 테스트 추가: "clicking session card navigates to detail view"
  - 새 테스트 추가: "dismiss button in detail header hides session"

  **Must NOT do**:
  - 기존 테스트의 의미/목적 변경
  - 다른 테스트 파일 수정
  - `waitForDashboardReady` 헬퍼 함수 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 기존 테스트 2개 수정 + 새 테스트 2개 추가. 패턴 명확.
  - **Skills**: [`playwright`]
    - `playwright`: Playwright 테스트 작성 패턴 참조

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: None
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/e2e/dashboard-features.spec.ts:169-191` — 현재 "Session Command Copy" 테스트 (수정 대상)
  - `server/e2e/dashboard-features.spec.ts:170-175` — `beforeEach` 패턴 (session-item 대기 + skip 로직)
  - `server/e2e/dashboard.spec.ts` — 다른 Playwright 테스트 파일의 패턴 참고

  **Test References**:
  - `server/e2e/dashboard-features.spec.ts:177-182` — 기존 카드 클릭 테스트 (디테일 네비게이션 추가 필요)
  - `server/e2e/dashboard-features.spec.ts:184-190` — 기존 토스트 사라짐 테스트

  **WHY Each Reference Matters**:
  - lines 169-191: 수정 대상 테스트 블록 — 카드 클릭이 이제 디테일 뷰로도 진입하므로 assertion 업데이트 필요
  - lines 170-175: `beforeEach` 패턴 — 새 테스트 describe에서도 동일 패턴 사용

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 업데이트된 Playwright 테스트 전체 통과
    Tool: Bash
    Preconditions: Tasks 1-3 완료, 개발 서버 구동 중
    Steps:
      1. cd server && npx playwright test e2e/dashboard-features.spec.ts
      2. Assert all tests pass
      3. Assert no test failures or timeouts
    Expected Result: 0 failures
    Failure Indicators: 테스트 실패, timeout
    Evidence: .sisyphus/evidence/task-5-playwright-results.txt

  Scenario: 새 테스트가 정상 동작 확인
    Tool: Bash
    Preconditions: 개발 서버 구동 중
    Steps:
      1. cd server && npx playwright test e2e/dashboard-features.spec.ts --grep "navigates to detail"
      2. Assert pass
      3. cd server && npx playwright test e2e/dashboard-features.spec.ts --grep "dismiss"
      4. Assert pass
    Expected Result: 새로 추가된 테스트 2개 모두 통과
    Failure Indicators: 테스트 실패
    Evidence: .sisyphus/evidence/task-5-new-tests.txt
  ```

  **Evidence to Capture:**
  - [ ] task-5-playwright-results.txt
  - [ ] task-5-new-tests.txt

  **Commit**: YES
  - Message: `test(e2e): update Playwright tests for new session card click behavior`
  - Files: `server/e2e/dashboard-features.spec.ts`
  - Pre-commit: `cd server && npx playwright test e2e/dashboard-features.spec.ts`

---

## Final Verification Wave

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. Verify all "Must Have" items are implemented. Verify all "Must NOT Have" items are absent. Check evidence files in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run build` in `server/frontend/`. Review all changed files for: `as any`, empty catches, console.log in prod, commented-out code, unused imports. Check for dead CSS selectors referencing removed classes. Verify no orphan CSS rules remain.
  Output: `Build [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start dev server. Execute ALL QA scenarios from ALL tasks. Test cross-task integration (card click → detail → dismiss → back). Test edge cases: empty state, rapid clicks, keyboard navigation. Save screenshots to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 compliance. Check "Must NOT do" compliance. Flag any store files modified. Flag any new components created. Detect unaccounted changes.
  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Commit 1** (after Tasks 1-3): `refactor(ui): simplify session card — remove action buttons, wire card click to detail, add dismiss to detail header`
  - Files: `ActiveSessions.svelte`, `App.svelte`
  - Pre-commit: `npm run build` (server/frontend)
- **Commit 2** (after Task 5): `test(e2e): update Playwright tests for new session card behavior`
  - Files: `dashboard-features.spec.ts`
  - Pre-commit: existing Playwright tests pass

---

## Success Criteria

### Verification Commands
```bash
cd server/frontend && npm run build  # Expected: Build succeeds, no errors
cd server && npx playwright test     # Expected: All tests pass
```

### Final Checklist
- [ ] 세션 카드에 › × 버튼 없음 (DOM에 `.header-actions` 없음)
- [ ] 카드 클릭 → 디테일 뷰 전환 (`.detail-header` 표시)
- [ ] 카드 클릭 → 커맨드 복사 토스트 표시
- [ ] 디테일 헤더에 '숨기기' 버튼 표시
- [ ] 숨기기 클릭 → overview 복귀
- [ ] All tests pass
- [ ] All "Must NOT Have" absent
