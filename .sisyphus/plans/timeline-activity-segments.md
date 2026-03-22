# Timeline Activity Segments

## TL;DR

> **Quick Summary**: 타임라인에서 세션당 단일 블록 대신, AI 작업중(Working) 구간을 색상으로 칠하고 유저 대기(Waiting) 구간은 빈 배경으로 표시. 세그먼트 hover 시 툴팁으로 시간/duration 표시.
> 
> **Deliverables**:
> - Agent: `getSessionActivitySegments()` 메서드 + `/api/enrichment/timeline-segments` 엔드포인트
> - Server: 세그먼트 proxy 라우트 + `ActivitySegment` 타입
> - Frontend: 다중 세그먼트 SVG 렌더링 + 툴팁
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Task 5 → Task 6 → Task 7

---

## Context

### Original Request
타임라인에서 작업중 시간을 표시하고 유저 waiting 대기중은 다른 색깔로 칠하고 싶다.

### Interview Summary
**Key Discussions**:
- 현재 타임라인은 세션당 하나의 사각형 블록만 표시 (busy/idle/completed 색상)
- opencode.db message 테이블에 assistant msg의 time.created/time.completed가 있어 세그먼트 재구성 가능
- 실시간 SSE에서 waitingForInput 상태도 추적 중

**User Decisions**:
- 데이터 소스: 과거(opencode.db messages) + 실시간(SSE) 모두
- Waiting 표시: 빈 공간(배경만) — Working 세그먼트만 칠함
- 추가 기능: 세그먼트 + 툴팁 (hover 시 시간, 작업내용 표시)
- 통계/비율 요약: 이번 스코프 제외

### Metis Review
**Identified Gaps** (addressed):
- 활성 세션에서 time.completed가 null인 경우 → session.time_updated를 fallback으로 사용
- 세그먼트를 기존 timeline poll에 포함하면 payload 급증 → on-demand 별도 엔드포인트로 분리
- 툴팁 내용 범위 → V1은 시간 범위 + duration만 (tool breakdown은 미래 확장)
- SVG 렌더링 성능 → 인접한 극소 세그먼트 병합 고려

---

## Work Objectives

### Core Objective
타임라인의 각 세션 레인에서, AI가 실제 작업한 시간(Working)만 색상 블록으로 표시하고, 유저 입력을 기다리는 시간(Waiting)은 빈 배경으로 남겨 활동 패턴을 시각화.

### Concrete Deliverables
- `agent/src/opencode-db-reader.ts`: `getSessionActivitySegments(sessionId)` 메서드
- `agent/src/server.ts`: `GET /api/enrichment/timeline-segments?sessionId=<id>` 엔드포인트
- `server/src/modules/enrichment/types.ts`: `ActivitySegment`, `SessionSegmentsResponse` 타입
- `server/src/modules/enrichment/index.ts`: Agent proxy 라우트
- `server/frontend/src/lib/stores/enrichment.ts`: `fetchSessionSegments()` 함수
- `server/frontend/src/components/pages/TimelinePage.svelte`: 다중 세그먼트 렌더링 + SVG 툴팁

### Definition of Done
- [ ] `cd agent && npx vitest run` — 모든 테스트 pass (기존 + 새로운 세그먼트 테스트)
- [ ] `cd server && npx vitest run` — 모든 테스트 pass
- [ ] `cd server/frontend && npm run build` — 빌드 성공
- [ ] Production에서 타임라인 세그먼트가 정상 렌더링됨 (Playwright 검증)

### Must Have
- 세션별 Working 세그먼트가 accent 색상으로 표시
- Waiting 구간은 빈 lane 배경
- 세그먼트 hover 시 툴팁 (시간 범위, duration)
- time.completed null 처리 (fallback to time_updated)
- 기존 타임라인 기능 유지 (regression 없음)

### Must NOT Have (Guardrails)
- `TimelineEntry` 타입 수정 금지 — 새 타입으로 additive하게 추가
- `getSessionTimeline()` 수정 금지 — 기존 함수 그대로 유지
- 10초 polling 사이클에 세그먼트 추가 금지 — on-demand만
- `part` 테이블 쿼리 금지 (V1) — message 테이블만
- opencode.db 쓰기 금지
- 새 CSS 변수/Tailwind 금지
- agent/frontend 변경을 같은 커밋에 혼합 금지
- 세그먼트 통계/비율 요약 금지 (이번 스코프 아님)
- 세그먼트 애니메이션/트랜지션 금지
- 모델별 다른 색상 금지 — 단일 accent 색상
- 클릭 시 세션 상세 패널 금지 — 툴팁만

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (tests-after)
- **Framework**: vitest (agent + server), Playwright (frontend QA)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Agent/Server**: Bash (vitest run, curl) — 테스트 실행, API 응답 검증
- **Frontend**: Playwright — 세그먼트 렌더링, 툴팁 동작 검증

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — types + agent query):
├── Task 1: Agent - getSessionActivitySegments() + tests [deep]
├── Task 2: Agent - /api/enrichment/timeline-segments endpoint [quick]
├── Task 3: Server - ActivitySegment types [quick]

Wave 2 (Server + Frontend data layer):
├── Task 4: Server - timeline-segments proxy route + tests (depends: 2, 3) [unspecified-high]
├── Task 5: Frontend - fetchSessionSegments() store function (depends: 3) [quick]

Wave 3 (Frontend rendering + QA):
├── Task 6: Frontend - multi-segment SVG rendering (depends: 5) [visual-engineering]
├── Task 7: Frontend - SVG tooltip for segments (depends: 6) [visual-engineering]

Wave FINAL (Verification):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Production QA with Playwright (unspecified-high + playwright)
├── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 2 → Task 4 → Task 5 → Task 6 → Task 7 → F1-F4
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | 2 |
| 2 | 1 | 4 |
| 3 | — | 4, 5 |
| 4 | 2, 3 | F1-F4 |
| 5 | 3 | 6 |
| 6 | 5 | 7 |
| 7 | 6 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 `deep`, T2 `quick`, T3 `quick`
- **Wave 2**: 2 tasks — T4 `unspecified-high`, T5 `quick`
- **Wave 3**: 2 tasks — T6 `visual-engineering`, T7 `visual-engineering`
- **FINAL**: 4 tasks — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. Agent — getSessionActivitySegments() 메서드 + 테스트
- [x] 2. Agent — /api/enrichment/timeline-segments 엔드포인트
- [x] 3. Server — ActivitySegment 타입 정의

  **What to do**:
  - `server/src/modules/enrichment/types.ts`에 타입 추가:
    ```typescript
    export interface ActivitySegment {
      startTime: number;
      endTime: number;
      type: 'working';
    }
    export interface SessionSegmentsResponse {
      sessionId: string;
      segments: ActivitySegment[];
    }
    export interface MergedSessionSegmentsResponse extends SessionSegmentsResponse {
      machineId: string;
      machineAlias: string;
    }
    ```
  - 기존 `TimelineEntry` 타입은 절대 수정하지 않음

  **Must NOT do**:
  - `TimelineEntry` 수정 금지
  - 기존 타입 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 추가만, 3-4줄
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/enrichment/types.ts:64-73` — `TimelineEntry` 타입 정의 패턴. 동일한 구조로 `ActivitySegment` 추가
  - `server/src/modules/enrichment/types.ts:118-121` — `MergedTimelineEntry extends TimelineEntry` 패턴. `MergedSessionSegmentsResponse`도 동일 패턴

  **Acceptance Criteria**:

  - [ ] `cd server && npx vitest run` → PASS (기존 테스트 regression 없음)
  - [ ] `TimelineEntry` 타입 변경 없음 (ast_grep_search로 확인)

  **QA Scenarios**:

  ```
  Scenario: Type 추가 후 빌드 확인
    Tool: Bash
    Steps:
      1. cd server && npx tsc --noEmit
      2. 에러 0개 확인
    Expected Result: 0 errors
    Evidence: .sisyphus/evidence/task-3-typecheck.txt

  Scenario: TimelineEntry 미변경 확인
    Tool: ast_grep_search
    Steps:
      1. ast_grep_search로 TimelineEntry interface 검색
      2. 원본과 동일한지 확인 (sessionId, sessionTitle, projectId, directory, startTime, endTime, status, parentId)
    Expected Result: TimelineEntry 원형 유지
    Evidence: .sisyphus/evidence/task-3-timeline-unchanged.txt
  ```

  **Commit**: YES (Task 4와 함께 server 커밋으로 합칠 수 있음)
  - Message: `feat(server): add ActivitySegment types for timeline segments`
  - Files: `server/src/modules/enrichment/types.ts`
  - Pre-commit: `cd server && npx vitest run`

- [x] 4. Server — timeline-segments proxy 라우트 + 테스트

  **What to do**:
  - `server/src/modules/enrichment/index.ts`에 두 개의 proxy 라우트 추가:
    1. **Per-machine**: `GET /api/enrichment/:machineId/timeline-segments?sessionId=<id>` — 특정 머신의 Agent로 요청 프록시
    2. **Merged**: `GET /api/enrichment/merged/timeline-segments?sessionId=<id>` — 모든 머신에 요청 후 첫 번째 응답 반환 (세션은 하나의 머신에만 존재)
  - `sessionId` 쿼리 파라미터 필수 — 없으면 400 에러 반환
  - Per-machine 라우트는 `machineManager.fetchFromMachine(machine, /api/enrichment/timeline-segments?sessionId=...)` 패턴 사용
  - Merged 라우트는 모든 머신에 병렬 요청 후, `segments` 배열이 비어있지 않은 첫 번째 결과 반환 + `machineId`, `machineAlias` 추가
  - 기존 `enrichment-module.test.ts` 패턴을 따라 테스트 작성:
    - Per-machine 라우트 정상 작동 (mock fetchFromMachine)
    - Merged 라우트 정상 작동 (2대 머신, 1대만 segments 있음)
    - sessionId 파라미터 누락 시 400 반환

  **Must NOT do**:
  - 기존 `/api/enrichment/:machineId/timeline` 라우트 수정 금지
  - polling loop에 segments 추가 금지 (on-demand만)
  - EnrichmentCache에 segments 필드 추가 금지

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: proxy 라우트 + merged 로직 + 테스트, 패턴은 기존 코드에 명확히 있으나 merged 처리 로직이 필요
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: Server API 테스트이므로 불필요

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (with Task 5)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 2, Task 3

  **References**:

  **Pattern References**:
  - `server/src/modules/enrichment/index.ts:108-131` — Per-machine timeline proxy 라우트 패턴: machineId 파라미터, 쿼리스트링 전달, `db.getTimelineEntries()` or `cache` 반환. 동일 구조로 segments proxy 구현하되, Agent로 fetchFromMachine 호출
  - `server/src/modules/enrichment/index.ts:67-104` — Merged endpoint 패턴: 모든 머신 순회, 데이터 집계. Segments는 세션이 하나의 머신에만 존재하므로 `Promise.allSettled` → 첫 non-empty 결과 반환
  - `server/src/modules/enrichment/index.ts:147-159` — `fetchFromMachine(machine, path, options)` 프록시 패턴: machineManager를 통해 Agent API 호출

  **API/Type References**:
  - `server/src/modules/enrichment/types.ts` — Task 3에서 추가하는 `ActivitySegment`, `SessionSegmentsResponse`, `MergedSessionSegmentsResponse` 타입 사용
  - Agent 엔드포인트 응답: `{ data: { sessionId, segments: ActivitySegment[] }, available: boolean }`

  **Test References**:
  - `server/src/__tests__/enrichment-module.test.ts:1-43` — 테스트 구조: `createMockMachineManager()`, `createMockSseManager()`, Fastify 인스턴스 생성 패턴
  - `server/src/__tests__/enrichment-module.test.ts:55-60` — `fetchFromMachine` mock + 응답 검증 패턴

  **Acceptance Criteria**:

  - [ ] `cd server && npx vitest run` → PASS (기존 + 새 테스트)
  - [ ] Per-machine endpoint: `GET /api/enrichment/mac-test/timeline-segments?sessionId=ses_123` → 200
  - [ ] Merged endpoint: `GET /api/enrichment/merged/timeline-segments?sessionId=ses_123` → 200 (machineId, machineAlias 포함)
  - [ ] Missing sessionId: → 400

  **QA Scenarios**:

  ```
  Scenario: Happy path — per-machine segments proxy
    Tool: Bash (vitest)
    Preconditions: MockMachineManager.fetchFromMachine이 segments 데이터 반환하도록 설정
    Steps:
      1. Fastify inject GET /api/enrichment/mac-test/timeline-segments?sessionId=ses_123
      2. 응답 status 200 확인
      3. 응답 body에 data.sessionId = 'ses_123', data.segments 배열 존재 확인
    Expected Result: 200, segments 배열 포함
    Failure Indicators: 404 (라우트 없음), 500, segments 누락
    Evidence: .sisyphus/evidence/task-4-per-machine.txt

  Scenario: Happy path — merged segments proxy
    Tool: Bash (vitest)
    Preconditions: 2대 머신 mock, 1대만 non-empty segments 반환
    Steps:
      1. Fastify inject GET /api/enrichment/merged/timeline-segments?sessionId=ses_123
      2. 응답 status 200 확인
      3. 응답 body에 machineId, machineAlias 포함 확인
    Expected Result: 200, 실제 데이터를 가진 머신의 segments 반환
    Failure Indicators: 빈 segments, machineId 누락
    Evidence: .sisyphus/evidence/task-4-merged.txt

  Scenario: Error — sessionId 파라미터 누락
    Tool: Bash (vitest)
    Preconditions: 없음
    Steps:
      1. Fastify inject GET /api/enrichment/mac-test/timeline-segments (no sessionId)
      2. 응답 status 400 확인
    Expected Result: 400 에러 응답
    Evidence: .sisyphus/evidence/task-4-missing-param.txt
  ```

  **Commit**: YES (Task 3과 합쳐서 server 커밋)
  - Message: `feat(server): add timeline-segments proxy routes (per-machine + merged)`
  - Files: `server/src/modules/enrichment/index.ts`, `server/src/__tests__/enrichment-module.test.ts`
  - Pre-commit: `cd server && npx vitest run`

- [x] 5. Frontend — fetchSessionSegments() store 함수

  **What to do**:
  - `server/frontend/src/lib/stores/enrichment.ts`에 세그먼트 fetch 함수 + 관련 store 추가:
    ```typescript
    // Stores
    export const sessionSegmentsData = writable<Map<string, ActivitySegment[]>>(new Map());
    export const sessionSegmentsLoading = writable<Map<string, boolean>>(new Map());

    // Fetch function
    export async function fetchSessionSegments(sessionId: string): Promise<ActivitySegment[]>
    ```
  - `fetchSessionSegments(sessionId)`:
    - 이미 캐시에 있으면 캐시 반환 (중복 요청 방지)
    - `resolveEnrichmentMachineId()`로 머신 결정
    - machineId가 있으면 `/api/enrichment/${machineId}/timeline-segments?sessionId=${sessionId}`
    - machineId가 없으면 `/api/enrichment/merged/timeline-segments?sessionId=${sessionId}`
    - 응답에서 `data.segments` 추출 → `sessionSegmentsData` Map에 저장
    - loading 상태 관리 (`sessionSegmentsLoading` Map)
  - `ActivitySegment` 타입은 로컬에 재정의 (frontend는 server 타입 직접 import 불가)

  **Must NOT do**:
  - 기존 `fetchTimelineData()` 수정 금지
  - 10초 polling 주기에 세그먼트 추가 금지 (on-demand only, hover 시 호출)
  - 새 CSS 변수 추가 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 기존 `fetchTimelineData()` 패턴을 그대로 따르는 단순 fetch 함수 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 4와 병렬 가능)
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: Task 6
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/enrichment.ts:199-222` — `fetchTimelineData()` 패턴: `resolveEnrichmentMachineId()` → URL 분기 → `fetchJSON()` → store.set(). 동일 패턴으로 segments fetch 구현
  - `server/frontend/src/lib/stores/enrichment.ts:1-7` — import 패턴: `writable`, `fetchJSON`, `resolveEnrichmentMachineId()`
  - `server/frontend/src/lib/stores/enrichment.ts:9-14` — `EnrichmentResponse<T>` 제네릭 타입 (응답 파싱용)

  **API/Type References**:
  - Server 응답 형태: `{ data: { sessionId: string, segments: ActivitySegment[] }, available: boolean }` 또는 merged일 때 `{ data: { sessionId, segments, machineId, machineAlias }, available: boolean }`
  - `ActivitySegment` 로컬 타입: `{ startTime: number; endTime: number; type: 'working' }`

  **Acceptance Criteria**:

  - [ ] `cd server/frontend && npm run build` → 빌드 성공
  - [ ] `sessionSegmentsData` store가 export됨
  - [ ] `fetchSessionSegments()` 함수가 export됨
  - [ ] 동일 sessionId 중복 호출 시 네트워크 요청 1회만 발생 (캐시)

  **QA Scenarios**:

  ```
  Scenario: 빌드 확인 — store 함수 추가 후 타입 에러 없음
    Tool: Bash
    Steps:
      1. cd server/frontend && npm run build
      2. exit code 0 확인
    Expected Result: 빌드 성공, 0 에러
    Failure Indicators: TypeScript 타입 에러, import 실패
    Evidence: .sisyphus/evidence/task-5-build.txt

  Scenario: Store export 확인 — ast_grep으로 함수 존재 확인
    Tool: ast_grep_search
    Steps:
      1. `export async function fetchSessionSegments` 패턴 검색
      2. `export const sessionSegmentsData` 패턴 검색
    Expected Result: 두 export 모두 enrichment.ts에 존재
    Failure Indicators: export 누락
    Evidence: .sisyphus/evidence/task-5-exports.txt
  ```

  **Commit**: YES (Task 6, 7과 합쳐서 frontend 커밋)
  - Message: `feat(frontend): add fetchSessionSegments() store function`
  - Files: `server/frontend/src/lib/stores/enrichment.ts`
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 6. Frontend — 다중 세그먼트 SVG 렌더링

  **What to do**:
  - `server/frontend/src/components/pages/TimelinePage.svelte`의 swim-lane 렌더링을 변경:
    - **기존**: 세션당 단일 `<rect>` 블록 (L132-140)
    - **변경**: 세션 hover/진입 시 `fetchSessionSegments(session.sessionId)` 호출 → 세그먼트별 `<rect>` 렌더링
  - 세그먼트 렌더링 로직:
    ```svelte
    {#each filteredSessions as session, i}
      {@const y = AXIS_HEIGHT + PADDING_TOP + i * LANE_HEIGHT}
      {@const laneY = y + 5}
      {@const laneH = LANE_HEIGHT - 10}

      <g data-testid="swim-lane" class="swim-lane">
        <!-- Lane background -->
        <rect x={0} y={y} width={SVG_WIDTH} height={LANE_HEIGHT}
          fill={i % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)'} opacity="0.5" />

        {#if segments.has(session.sessionId)}
          <!-- 세그먼트 모드: 각 working 구간을 개별 rect로 -->
          {#each segments.get(session.sessionId) ?? [] as seg}
            {@const segStartX = timeToX(seg.startTime, timeRange.from, timeRange.to, SVG_WIDTH)}
            {@const segEndX = timeToX(seg.endTime, timeRange.from, timeRange.to, SVG_WIDTH)}
            {@const segWidth = Math.max(segEndX - segStartX, 2)}
            <rect
              x={segStartX} y={laneY} width={segWidth} height={laneH}
              rx="2"
              fill="var(--accent)"
              opacity="0.8"
              class="segment-rect"
            />
          {/each}
        {:else}
          <!-- Fallback: 기존 단일 블록 (세그먼트 로드 전) -->
          {@const startX = timeToX(session.startTime, timeRange.from, timeRange.to, SVG_WIDTH)}
          {@const endX = timeToX(session.endTime ?? Date.now(), timeRange.from, timeRange.to, SVG_WIDTH)}
          {@const blockWidth = Math.max(endX - startX, 4)}
          <rect x={startX} y={laneY} width={blockWidth} height={laneH}
            rx="3"
            fill={session.status === 'busy' ? 'var(--accent)' : session.status === 'completed' ? 'var(--success)' : 'var(--text-secondary)'}
            opacity="0.4"
          />
        {/if}
      </g>
    {/each}
    ```
  - 세그먼트 데이터 로드 전략:
    - **Eager load**: 타임라인 데이터 로드 완료 후, `filteredSessions`의 각 session에 대해 `fetchSessionSegments()` 호출 (단, 캐시 있으면 스킵)
    - reactive `$derived` 또는 `$effect`로 `filteredSessions` 변경 시 자동 로드
    - `sessionSegmentsLoading`이 true인 동안은 fallback (기존 단일 블록) 표시
  - `segments` 변수를 `$derived`로 `$sessionSegmentsData`에서 파생:
    ```typescript
    let segments = $derived($sessionSegmentsData);
    ```
  - CSS 추가 (기존 변수만 사용):
    ```css
    .segment-rect { transition: none; }
    .segment-rect:hover { opacity: 1; }
    ```

  **Must NOT do**:
  - `TimelinePage.svelte`의 SVG 기본 구조 (시간축, Now 라인, 컨트롤) 변경 금지
  - 새 CSS 변수 추가 금지 (기존 `--accent`, `--bg-secondary` 등만)
  - 세그먼트 애니메이션/트랜지션 금지 (hover opacity 변경만 허용)
  - 모델별 다른 색상 금지 — 모든 세그먼트는 `var(--accent)` 단일 색상
  - Lane label 영역 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: SVG 렌더링 변경, Svelte 5 reactivity ($derived, $effect), CSS — 시각적 UI 작업
  - **Skills**: [`ui-ux-pro-max`]
    - `ui-ux-pro-max`: SVG + Svelte 5 렌더링 패턴, 시각적 품질 보장
  - **Skills Evaluated but Omitted**:
    - `playwright`: Task 7 이후 F3에서 통합 QA로 검증
    - `frontend-design`: SVG 수정은 디자인보다 구현 중심

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential)
  - **Blocks**: Task 7
  - **Blocked By**: Task 5

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:120-141` — 현재 swim-lane 렌더링: `{#each filteredSessions}` → `<g>` 안에 배경 rect + 세션 rect. 이 구조를 세그먼트 모드로 확장
  - `server/frontend/src/components/pages/TimelinePage.svelte:13-16` — SVG 상수: `SVG_WIDTH=900`, `LANE_HEIGHT=40`, `AXIS_HEIGHT=30`, `PADDING_TOP=10`
  - `server/frontend/src/components/pages/TimelinePage.svelte:22-26` — `filteredSessions` $derived 패턴. 동일하게 `segments` 파생
  - `server/frontend/src/lib/timeline-utils.ts` — `timeToX()` 함수: 타임스탬프를 SVG X좌표로 변환

  **API/Type References**:
  - Task 5에서 정의하는 `sessionSegmentsData: Writable<Map<string, ActivitySegment[]>>` store
  - Task 5에서 정의하는 `fetchSessionSegments(sessionId: string): Promise<ActivitySegment[]>` 함수
  - `ActivitySegment` 타입: `{ startTime: number; endTime: number; type: 'working' }`

  **Acceptance Criteria**:

  - [ ] `cd server/frontend && npm run build` → 빌드 성공
  - [ ] 세그먼트 데이터가 있는 세션: 개별 `<rect>` 요소가 lane 안에 렌더링
  - [ ] 세그먼트가 없는 세션: 기존 단일 블록 fallback 표시
  - [ ] 모든 세그먼트 rect의 fill = `var(--accent)`
  - [ ] Waiting 구간(세그먼트 사이): 빈 lane 배경만 표시

  **QA Scenarios**:

  ```
  Scenario: Happy path — 세그먼트가 있는 세션의 다중 rect 렌더링
    Tool: Playwright
    Preconditions: 192.168.0.2:3097에 배포 완료, 실제 세션 데이터 존재
    Steps:
      1. page.goto('http://192.168.0.2:3097')
      2. Timeline 탭 클릭 (data-testid="nav-timeline" 또는 해당 네비게이션)
      3. page.waitForSelector('[data-testid="timeline-svg"]')
      4. page.waitForSelector('.segment-rect', { timeout: 10000 })
      5. const segmentRects = await page.$$('.segment-rect')
      6. segmentRects.length > 0 확인
      7. 첫 번째 rect의 fill 속성이 'var(--accent)' 확인
    Expected Result: 1개 이상의 .segment-rect가 SVG 안에 렌더링
    Failure Indicators: .segment-rect 없음 (세그먼트 로드 실패), 기존 단일 블록만 표시
    Evidence: .sisyphus/evidence/task-6-segments-render.png

  Scenario: Fallback — 세그먼트 로드 전 기존 블록 표시
    Tool: Playwright
    Preconditions: 타임라인 페이지 로드 직후 (세그먼트 fetch 전)
    Steps:
      1. page.goto('http://192.168.0.2:3097') → Timeline
      2. 즉시 swim-lane 내 rect 존재 확인 (fallback 블록)
      3. 시간 경과 후 .segment-rect로 교체되는지 확인
    Expected Result: 초기에 fallback 블록 → 세그먼트 로드 후 다중 rect로 전환
    Evidence: .sisyphus/evidence/task-6-fallback.png
  ```

  **Commit**: YES (Task 5, 7과 합쳐서 frontend 커밋)
  - Message: `feat(frontend): render activity segments in timeline lanes`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [x] 7. Frontend — SVG 세그먼트 툴팁

  **What to do**:
  - `TimelinePage.svelte`의 각 세그먼트 `<rect>`에 hover 시 툴팁 표시:
  - **구현 방식**: Positioned `<div>` 오버레이 (SVG `<title>`은 스타일링 불가하므로)
    ```svelte
    <!-- Script 추가 -->
    let tooltip = $state<{ x: number; y: number; startTime: number; endTime: number } | null>(null);

    function showTooltip(e: MouseEvent, seg: ActivitySegment) {
      tooltip = {
        x: e.clientX,
        y: e.clientY,
        startTime: seg.startTime,
        endTime: seg.endTime,
      };
    }
    function hideTooltip() { tooltip = null; }

    function formatDuration(ms: number): string {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ${sec % 60}s`;
      const hr = Math.floor(min / 60);
      return `${hr}h ${min % 60}m`;
    }
    ```
  - 각 세그먼트 rect에 이벤트 핸들러 추가:
    ```svelte
    <rect ... onmouseenter={(e) => showTooltip(e, seg)} onmouseleave={hideTooltip} />
    ```
  - 툴팁 DOM (SVG 외부, page-container 끝에):
    ```svelte
    {#if tooltip}
      <div class="segment-tooltip" style="left: {tooltip.x + 10}px; top: {tooltip.y - 40}px">
        <div class="tooltip-time">
          {new Date(tooltip.startTime).toLocaleTimeString()} — {new Date(tooltip.endTime).toLocaleTimeString()}
        </div>
        <div class="tooltip-duration">
          Duration: {formatDuration(tooltip.endTime - tooltip.startTime)}
        </div>
      </div>
    {/if}
    ```
  - 툴팁 CSS (기존 CSS 변수만 사용):
    ```css
    .segment-tooltip {
      position: fixed;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.4rem 0.6rem;
      font-size: 0.75rem;
      color: var(--text-primary);
      pointer-events: none;
      z-index: 100;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .tooltip-time { font-weight: 500; }
    .tooltip-duration { color: var(--text-secondary); margin-top: 0.15rem; }
    ```

  **Must NOT do**:
  - 외부 tooltip 라이브러리 도입 금지
  - SVG `<title>` 사용 금지 (스타일 제어 불가)
  - 새 CSS 변수 추가 금지
  - 클릭 이벤트로 상세 패널 열기 금지 — hover 툴팁만
  - tooltip에 모델/도구 정보 표시 금지 (V1은 시간 범위 + duration만)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: SVG 위에 positioned div 오버레이, CSS 스타일링, 마우스 이벤트 핸들링
  - **Skills**: [`ui-ux-pro-max`]
    - `ui-ux-pro-max`: tooltip 디자인 품질, positioning 로직
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: tooltip은 작은 요소, 전체 디자인 스킬 불필요

  **Parallelization**:
  - **Can Run In Parallel**: NO (Task 6 이후 순차)
  - **Parallel Group**: Wave 3 (sequential after Task 6)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 6

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:132-140` — 기존 rect에 이벤트 핸들러가 없음. `onmouseenter`/`onmouseleave` 추가 패턴
  - `server/frontend/src/components/pages/TimelinePage.svelte:157-205` — 기존 CSS 섹션: `var(--border)`, `var(--bg-secondary)`, `var(--text-primary)`, `var(--radius-sm)` 등 사용 가능한 변수 목록

  **API/Type References**:
  - Task 5의 `ActivitySegment` 타입: `{ startTime: number; endTime: number; type: 'working' }` — tooltip에서 startTime, endTime 표시
  - `$state` (Svelte 5 runes): tooltip 상태 관리용

  **Acceptance Criteria**:

  - [ ] `cd server/frontend && npm run build` → 빌드 성공
  - [ ] 세그먼트 rect hover 시 `.segment-tooltip` div가 나타남
  - [ ] 툴팁에 시간 범위 (HH:MM:SS — HH:MM:SS) 표시
  - [ ] 툴팁에 Duration (Xm Ys 형식) 표시
  - [ ] 마우스가 rect를 떠나면 툴팁 사라짐

  **QA Scenarios**:

  ```
  Scenario: Happy path — 세그먼트 hover 시 툴팁 표시
    Tool: Playwright
    Preconditions: 세그먼트가 렌더링된 타임라인 (Task 6 완료)
    Steps:
      1. page.goto('http://192.168.0.2:3097') → Timeline
      2. page.waitForSelector('.segment-rect', { timeout: 10000 })
      3. const seg = page.locator('.segment-rect').first()
      4. seg.hover()
      5. page.waitForSelector('.segment-tooltip', { timeout: 3000 })
      6. const tooltipText = await page.locator('.segment-tooltip').textContent()
      7. tooltipText에 'Duration' 포함 확인
      8. tooltipText에 ':' 포함 확인 (시간 형식)
    Expected Result: 툴팁에 시간 범위 + Duration 표시
    Failure Indicators: 툴팁 미출현, Duration 텍스트 없음
    Evidence: .sisyphus/evidence/task-7-tooltip-hover.png

  Scenario: 툴팁 사라짐 — 마우스 떠남 시
    Tool: Playwright
    Preconditions: 세그먼트 hover 상태 (툴팁 표시 중)
    Steps:
      1. 세그먼트 hover → 툴팁 표시 확인
      2. page.mouse.move(0, 0) — 세그먼트 밖으로 이동
      3. page.waitForSelector('.segment-tooltip', { state: 'detached', timeout: 3000 })
    Expected Result: 툴팁이 DOM에서 제거됨
    Failure Indicators: 툴팁이 남아있음
    Evidence: .sisyphus/evidence/task-7-tooltip-hide.txt

  Scenario: Duration 포맷 — 다양한 길이
    Tool: Bash
    Preconditions: formatDuration 함수 단위 테스트 (또는 인라인 검증)
    Steps:
      1. formatDuration(30000) → '30s' 확인
      2. formatDuration(150000) → '2m 30s' 확인
      3. formatDuration(3720000) → '1h 2m' 확인
    Expected Result: 각 포맷이 정확히 일치
    Evidence: .sisyphus/evidence/task-7-duration-format.txt
  ```

  **Commit**: YES (Task 5, 6과 합쳐서 frontend 커밋)
  - Message: `feat(frontend): add segment tooltip with time range and duration`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

---

## Final Verification Wave

- [x] F1. **Plan Compliance Audit** — `oracle`
- [x] F2. **Code Quality Review** — `unspecified-high`
- [x] F3. **Production QA** — `unspecified-high` (+ `playwright` skill)
- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| Order | Scope | Message | Pre-commit |
|-------|-------|---------|------------|
| 1 | agent | `feat(agent): add getSessionActivitySegments() for timeline segments` | `cd agent && npx vitest run` |
| 2 | agent | `feat(agent): add /api/enrichment/timeline-segments endpoint` | `cd agent && npx vitest run` |
| 3 | server | `feat(server): add ActivitySegment types and timeline-segments proxy` | `cd server && npx vitest run` |
| 4 | frontend | `feat(frontend): add segment rendering and tooltip to TimelinePage` | `cd server/frontend && npm run build` |

---

## Success Criteria

### Verification Commands
```bash
cd agent && npx vitest run    # Expected: all pass, 0 failures
cd server && npx vitest run   # Expected: all pass, 0 failures
cd server/frontend && npm run build  # Expected: build success
curl -sf http://192.168.0.2:3097/health  # Expected: {"status":"ok",...}
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass
- [x] Production deployment verified via Playwright
