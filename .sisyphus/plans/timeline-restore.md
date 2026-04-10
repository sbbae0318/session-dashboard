# Timeline Feature Full Restore & Refactoring

## TL;DR

> **Quick Summary**: Timeline 기능의 11개 버그 수정, Claude Code 세션 통합, UX 개선(반응형 SVG, 실시간 갱신, 성능 최적화)을 포함한 전면 리팩토링.
> 
> **Deliverables**:
> - SQL 쿼리 수정으로 누락 세션 문제 해결
> - Claude Code 세션을 Timeline에 통합 (active-only v1)
> - N+1 세그먼트 fetch → 배치 API로 교체
> - 반응형 SVG (ResizeObserver), 실시간 "Now" 라인 갱신
> - 프로젝트 표시 개선 (disambiguating shortPath)
> - TimelineEntry에 source 필드 추가 + api-contract.ts 통합
> - AbortController로 race condition 방지
> - TDD: 모든 수정에 대해 실패 테스트 먼저 작성
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1 → Task 3 → Task 5 → Task 7 → Task 10 → Task 13 → F1-F4

---

## Context

### Original Request
Timeline 기능 전면 리팩토링. 일부 세션만 보이고, 세션 이름이 정상 표시되지 않는 버그 수정. Claude Code 세션 통합. UX 전반 개선.

### Interview Summary
**Key Discussions**:
- 증상: 일부 세션만 표시, 이름 표시 불량
- 범위: 전면 리팩토링 (버그 + UX + 코드 구조 + Claude Code)
- Claude Code: OpenCode + Claude Code 모두 Timeline에 표시
- 테스트: TDD (vitest 기반, RED-GREEN-REFACTOR)

**Research Findings**:
- 코드 분석: 7개 핵심 파일 전수 분석 완료
- Timeline 아키텍처: Agent(SQL) → Server(Enrichment폴링+SQLite캐시) → Frontend(Svelte5 SVG)
- Claude Code: `claude-heartbeat.ts`에 active session 데이터만 있고 timeline endpoint 없음
- 기존 테스트: agent 328, server 285 tests (vitest)

### Metis Review
**Identified Gaps** (addressed):
- BUG-9 (NEW): `since` 파라미터가 BUG-2와 동일한 결함 — 함께 수정
- BUG-10 (NEW): 세그먼트 로딩 중 visual flash — 로딩 상태 추가
- BUG-11 (NEW): 세션 타이틀 나이브 truncation — 라벨 개선
- Claude Code historical sessions → active-only v1 (기본값 적용)
- TimelineEntry에 `source` 필드 없음 → 추가
- api-contract.ts에 Timeline 타입 미포함 → 추가
- enrichment-cache-db 스키마 마이그레이션 → ALTER TABLE 사용
- 요청 race condition → AbortController 추가
- 머신 오프라인 시 stale 세션 → staleness 감지 추가

---

## Work Objectives

### Core Objective
Timeline을 데이터 정확성, 성능, UX 측면에서 완전하게 복원하고, Claude Code 세션을 통합하여 모든 소스의 세션을 하나의 타임라인에서 볼 수 있게 만든다.

### Concrete Deliverables
- 수정된 SQL 쿼리 (agent/src/opencode-db-reader.ts)
- Claude Code timeline 변환 함수 (agent/src/claude-heartbeat.ts 또는 새 파일)
- 통합 timeline endpoint (agent/src/server.ts)
- 배치 세그먼트 API (agent + server)
- TimelineEntry + source 필드 (api-contract.ts, types.ts)
- 반응형 TimelinePage.svelte (ResizeObserver)
- 개선된 timeline-utils.ts (shortPath 분리, disambiguation)
- TDD 테스트 전체

### Definition of Done
- [ ] `cd agent && npm test` — ALL PASS
- [ ] `cd server && npm test` — ALL PASS
- [ ] `cd server && npm run build` — SUCCESS
- [ ] `cd server/frontend && npm run build` — SUCCESS
- [ ] Timeline 페이지에서 24h 범위로 OpenCode + Claude Code 세션 모두 표시
- [ ] 장시간 세션 (time window 밖에서 시작) 이 Timeline에 나타남
- [ ] 프로젝트 필터가 올바르게 작동하며 중복 없음
- [ ] SVG가 브라우저 너비에 맞게 자동 조절

### Must Have
- 모든 11개 버그 수정 (BUG-1~BUG-11)
- Claude Code active session timeline 통합
- 반응형 SVG width
- N+1 세그먼트 문제 해결
- TDD — 모든 수정에 실패 테스트 먼저

### Must NOT Have (Guardrails)
- ❌ d3.js, chart.js 등 외부 시각화 라이브러리 사용 금지
- ❌ Claude Code activity segments 구현 (v2로 연기, solid bar로 표시)
- ❌ enrichment 폴링 주기(10s) 또는 SSE 이벤트 형태 변경 금지
- ❌ SQLite 테이블 DROP/RECREATE 금지 — ALTER TABLE 사용
- ❌ 비-Timeline 페이지 (Dashboard, Queries, Settings) 영향 금지
- ❌ 프로젝트 필터를 searchable dropdown/multi-select로 재설계 금지
- ❌ 모바일/태블릿 레이아웃 금지
- ❌ zoom/pan, minimap, 키보드 네비게이션, 애니메이션 금지
- ❌ Claude Code historical session backfill 금지 (active-only v1)
- ❌ `as any`, `@ts-ignore` 사용 금지

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD (RED → GREEN → REFACTOR)
- **Framework**: vitest (agent + server), Playwright (e2e)
- **Each task**: 실패 테스트 먼저 작성 → 최소 구현 → 리팩토링

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Playwright — Navigate, interact, assert DOM, screenshot
- **API/Backend**: Bash (curl) — Send requests, assert status + response fields
- **Unit/Module**: Bash (vitest) — Run specific test file, assert pass

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — types, contracts, SQL fixes):
├── Task 1: TimelineEntry source 필드 + api-contract.ts 통합 [quick]
├── Task 2: SQL WHERE 수정 — 장시간 세션 포함 (BUG-2, BUG-9) [deep]
├── Task 3: timeline-utils.ts 리팩토링 — shortPath disambiguation [quick]
└── Task 4: enrichment-cache-db 스키마 마이그레이션 [quick]

Wave 2 (Core — Claude Code, batch segments, responsive):
├── Task 5: Claude Code timeline 변환 + agent endpoint 통합 (BUG-8) [deep]
├── Task 6: 배치 세그먼트 API (BUG-3 N+1 제거) [unspecified-high]
├── Task 7: 반응형 SVG — ResizeObserver (BUG-4) [visual-engineering]
└── Task 8: 실시간 갱신 — Now 라인 + active session (BUG-5, BUG-7) [quick]

Wave 3 (UX Polish — labels, race condition, loading states):
├── Task 9: 프로젝트 필터 개선 (BUG-1, BUG-6) [quick]
├── Task 10: AbortController + race condition 방지 (EC7) [quick]
├── Task 11: 세그먼트 로딩 상태 + visual flash 방지 (BUG-10, BUG-11) [visual-engineering]
└── Task 12: 머신 오프라인 staleness 감지 (EC1) [quick]

Wave 4 (Integration + E2E):
└── Task 13: E2E 테스트 + 통합 검증 [unspecified-high]

Wave FINAL (4 parallel reviews → user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: Task 1 → Task 5 → Task 7 → Task 13 → F1-F4 → user okay
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 4 (Wave 1, 2, 3)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2, 4, 5, 6 | 1 |
| 2 | 1 | 5, 13 | 1 |
| 3 | — | 9, 11 | 1 |
| 4 | 1 | 5 | 1 |
| 5 | 1, 2, 4 | 9, 13 | 2 |
| 6 | 1 | 8, 11, 13 | 2 |
| 7 | — | 11, 13 | 2 |
| 8 | 6 | 13 | 2 |
| 9 | 3, 5 | 13 | 3 |
| 10 | — | 13 | 3 |
| 11 | 3, 6, 7 | 13 | 3 |
| 12 | — | 13 | 3 |
| 13 | 5-12 | F1-F4 | 4 |
| F1-F4 | 13 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: **4** — T1 → `quick`, T2 → `deep`, T3 → `quick`, T4 → `quick`
- **Wave 2**: **4** — T5 → `deep`, T6 → `unspecified-high`, T7 → `visual-engineering`, T8 → `quick`
- **Wave 3**: **4** — T9 → `quick`, T10 → `quick`, T11 → `visual-engineering`, T12 → `quick`
- **Wave 4**: **1** — T13 → `unspecified-high`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. TimelineEntry source 필드 추가 + api-contract.ts 통합

  **What to do**:
  - `server/src/shared/api-contract.ts`에 `TimelineEntry`, `MergedTimelineEntry`, `ActivitySegment` 타입 추가
  - `TimelineEntry`에 `source?: 'opencode' | 'claude-code'` 필드 추가 (optional — 하위 호환)
  - `agent/src/opencode-db-reader.ts`의 `TimelineEntry` 인터페이스에 `source` 추가, `getSessionTimeline()` 반환 시 `source: 'opencode'` 설정
  - `server/src/modules/enrichment/types.ts`의 `TimelineEntry`를 api-contract에서 import하거나, source 필드 동기화
  - `server/frontend/src/lib/stores/enrichment.ts`의 `TimelineEntry`를 api-contract re-export 사용으로 전환
  - `server/frontend/src/types.ts`에서 Timeline 관련 타입 re-export
  - TDD: source 필드가 존재하고 정확한 값인지 검증하는 테스트 작성

  **Must NOT do**:
  - 기존 TimelineEntry를 사용하는 코드의 동작 변경 금지
  - source를 required로 만들지 말 것 (하위 호환)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 정의 추가 + re-export 작업, 파일당 소규모 변경
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `coding-standards`: 타입 변경만이라 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 2, 4, 5, 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `server/src/shared/api-contract.ts` — 프로젝트의 백엔드↔프론트엔드 타입 단일 진실 원천. 기존 타입(DashboardSession, SessionsResponse 등)의 패턴을 따를 것
  - `server/frontend/src/types.ts` — api-contract에서 re-export하는 패턴 참고

  **API/Type References**:
  - `agent/src/opencode-db-reader.ts:103-112` — 현재 TimelineEntry 정의 (source 필드 없음)
  - `server/src/modules/enrichment/types.ts:64-73` — 서버 측 TimelineEntry (source 없음)
  - `server/src/modules/enrichment/types.ts:118-121` — MergedTimelineEntry extends TimelineEntry
  - `server/frontend/src/lib/stores/enrichment.ts:56-65` — 프론트엔드 TimelineEntry (독립 정의)

  **WHY Each Reference Matters**:
  - api-contract.ts를 읽어서 기존 타입 정의 패턴(export interface, 그룹화)을 파악
  - opencode-db-reader.ts:103-112를 읽어서 agent 측 인터페이스에 source 추가
  - enrichment/types.ts:64-73을 읽어서 서버 측 동기화
  - frontend enrichment.ts:56-65를 읽어서 프론트엔드 타입을 api-contract re-export로 전환

  **Acceptance Criteria**:

  **TDD:**
  - [ ] agent 테스트: `getSessionTimeline()` 반환값에 `source: 'opencode'` 포함 확인
  - [ ] `cd agent && npm test` → PASS
  - [ ] `cd server && npm run build` → 0 errors

  **QA Scenarios:**

  ```
  Scenario: TimelineEntry에 source 필드가 포함된 API 응답 검증
    Tool: Bash (curl)
    Preconditions: Agent가 실행 중 (localhost:3098)
    Steps:
      1. curl -s -H "Authorization: Bearer $API_KEY" "http://localhost:3098/api/enrichment/timeline?from=0&to=9999999999999"
      2. jq '.[0].source // .data[0].source' 로 첫 엔트리의 source 필드 확인
    Expected Result: source 값이 "opencode"
    Failure Indicators: source가 undefined 또는 null
    Evidence: .sisyphus/evidence/task-1-source-field-api.json

  Scenario: 기존 코드가 source 필드 없이도 동작하는 하위 호환 검증
    Tool: Bash (vitest)
    Preconditions: 없음
    Steps:
      1. cd server && npm test
      2. cd agent && npm test
    Expected Result: 모든 기존 테스트 통과
    Failure Indicators: 새 source 필드로 인한 타입 에러 또는 테스트 실패
    Evidence: .sisyphus/evidence/task-1-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `refactor(types): add source field to TimelineEntry + api-contract`
  - Files: `server/src/shared/api-contract.ts`, `agent/src/opencode-db-reader.ts`, `server/src/modules/enrichment/types.ts`, `server/frontend/src/lib/stores/enrichment.ts`, `server/frontend/src/types.ts`
  - Pre-commit: `cd agent && npm test && cd ../server && npm test`

- [ ] 2. SQL WHERE 수정 — 장시간 세션 포함 (BUG-2, BUG-9)

  **What to do**:
  - `agent/src/opencode-db-reader.ts`의 `prepareTimelineStmt()`, `prepareTimelineByProjectStmt()` SQL 수정
  - 현재: `WHERE s.time_created >= ? AND s.time_created <= ?`
  - 변경: `WHERE s.time_created <= ? AND COALESCE(s.time_updated, s.time_created) >= ?`
  - 이렇게 하면 time window 전에 시작했지만 window 내에서 아직 활동 중인 세션도 포함
  - `since` 파라미터 사용 분기(lines 502-532)도 동일하게 수정 (BUG-9)
  - prepared statement 뿐 아니라 `since` path의 inline SQL도 수정
  - TDD: 2시간 전 시작, 현재 활동 중인 세션이 1h 범위 조회 시 포함되는지 검증

  **Must NOT do**:
  - 쿼리 결과의 정렬 순서 변경 금지 (ASC 유지)
  - 배경 세션 필터(NOT LIKE 'Background:%' 등) 제거 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SQL 수정은 데이터 정확성에 직접적 영향. 모든 분기를 꼼꼼히 확인해야 함
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: Tasks 5, 13
  - **Blocked By**: Task 1 (source 필드 정의)

  **References**:

  **Pattern References**:
  - `agent/src/opencode-db-reader.ts:882-896` — `prepareTimelineStmt()` 현재 SQL (수정 대상)
  - `agent/src/opencode-db-reader.ts:899-913` — `prepareTimelineByProjectStmt()` (수정 대상)
  - `agent/src/opencode-db-reader.ts:502-532` — `since` 파라미터 분기의 inline SQL (BUG-9, 동일 수정)

  **Test References**:
  - `agent/src/__tests__/` 디렉토리 — 기존 opencode-db-reader 테스트 패턴 참고

  **WHY Each Reference Matters**:
  - lines 882-896: prepared statement의 WHERE 절을 수정해야 함
  - lines 502-532: since 분기에서도 동일한 WHERE 패턴이 반복되므로 함께 수정
  - 테스트 디렉토리를 확인하여 기존 테스트 패턴(DB seeding, assertion)을 따름

  **Acceptance Criteria**:

  **TDD:**
  - [ ] RED: 2시간 전 시작, 현재 활동 중인 세션을 seed → `getSessionTimeline({from: now-1h, to: now})` → 테스트 FAIL (세션 안 나옴)
  - [ ] GREEN: SQL 수정 후 동일 테스트 PASS
  - [ ] `cd agent && npm test` → ALL PASS

  **QA Scenarios:**

  ```
  Scenario: 장시간 세션이 짧은 time window에 포함되는지 검증
    Tool: Bash (vitest)
    Preconditions: 테스트 DB에 time_created=now-2h, time_updated=now-5m 세션 seed
    Steps:
      1. cd agent && npx vitest run src/__tests__/opencode-db-reader.test.ts -t "long-running session"
    Expected Result: 테스트 통과 — 세션이 결과에 포함됨
    Failure Indicators: 빈 배열 반환 또는 assertion 실패
    Evidence: .sisyphus/evidence/task-2-long-running-session.txt

  Scenario: 기존 범위 내 세션이 여전히 정상 반환되는지 검증
    Tool: Bash (vitest)
    Preconditions: 테스트 DB에 범위 내 세션 seed
    Steps:
      1. cd agent && npx vitest run src/__tests__/opencode-db-reader.test.ts -t "timeline"
    Expected Result: 모든 기존 timeline 테스트 통과
    Failure Indicators: 기존 테스트 실패
    Evidence: .sisyphus/evidence/task-2-regression.txt
  ```

  **Commit**: YES
  - Message: `fix(agent): include long-running sessions in timeline SQL query`
  - Files: `agent/src/opencode-db-reader.ts`, `agent/src/__tests__/opencode-db-reader.test.ts`
  - Pre-commit: `cd agent && npm test`

- [ ] 3. timeline-utils.ts 리팩토링 — shortPath disambiguation 추출

  **What to do**:
  - `TimelinePage.svelte`에서 `shortPath()` 함수를 `timeline-utils.ts`로 이동
  - `shortPath()` 개선: 모든 프로젝트 디렉토리 목록을 받아 최소 구분 가능한 경로 생성
    - 예: `/home/user/project-a`와 `/work/repos/project-a` → `user/project-a`, `repos/project-a`
    - 모든 프로젝트가 고유하면 기존처럼 마지막 2 segment
    - 충돌 시 3 segment, 그래도 충돌 시 4 segment... (최대 전체 경로)
  - `disambiguateProjects(directories: string[]): Map<string, string>` 함수 추가
  - TDD: 같은 이름 프로젝트가 다른 경로일 때 구분되는지 검증

  **Must NOT do**:
  - `timeToX`, `formatTimeAxis`, `getTimeRange` 등 기존 유틸 함수 변경 금지
  - 외부 라이브러리 추가 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 유틸리티 함수 추출 + 개선, 단순 로직
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: Tasks 9, 11
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/timeline-utils.ts:1-65` — 기존 유틸 파일. 여기에 함수 추가
  - `server/frontend/src/components/pages/TimelinePage.svelte:87-90` — 현재 `shortPath()` 구현 (이동 대상)

  **WHY Each Reference Matters**:
  - timeline-utils.ts를 읽어서 기존 export 패턴과 코딩 스타일을 따름
  - TimelinePage.svelte:87-90의 현재 구현을 이해하고 개선

  **Acceptance Criteria**:

  **TDD:**
  - [ ] 테스트: `disambiguateProjects(['/a/b/project', '/c/d/project'])` → 각각 다른 문자열
  - [ ] 테스트: `disambiguateProjects(['/a/foo', '/b/bar'])` → `['foo', 'bar']` (마지막 1 segment 충분)
  - [ ] `cd server/frontend && npm run build` → SUCCESS

  **QA Scenarios:**

  ```
  Scenario: 동일 이름 프로젝트가 구분되는 경로로 표시
    Tool: Bash (vitest)
    Preconditions: 없음 (순수 함수 테스트)
    Steps:
      1. 테스트 파일에서 disambiguateProjects 함수 호출
      2. 같은 마지막 segment를 가진 2개 경로 입력
    Expected Result: 각 경로가 구분 가능한 짧은 문자열로 변환
    Failure Indicators: 두 경로가 동일한 문자열로 변환
    Evidence: .sisyphus/evidence/task-3-disambiguate.txt
  ```

  **Commit**: YES
  - Message: `refactor(frontend): extract shortPath to timeline-utils with disambiguation`
  - Files: `server/frontend/src/lib/timeline-utils.ts`, `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 4. enrichment-cache-db 스키마 마이그레이션 — source 컬럼

  **What to do**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts`의 `timeline_entries` 테이블에 `source` 컬럼 추가
  - 마이그레이션: `ALTER TABLE timeline_entries ADD COLUMN source TEXT DEFAULT 'opencode'` — try/catch로 "column already exists" 처리
  - `saveTimelineEntries()`: entry.source 값을 source 컬럼에 저장
  - `getTimelineEntries()`, `getAllTimelineEntries()`: JSON data에 source 포함 확인
  - TDD: 마이그레이션이 기존 DB에 안전하게 적용되는지 검증

  **Must NOT do**:
  - DROP TABLE / CREATE TABLE 금지
  - 기존 데이터 삭제 금지
  - PK 변경 금지 (session_id, machine_id 유지)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: ALTER TABLE 1줄 + 저장/조회 로직 소규모 수정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: Task 5
  - **Blocked By**: Task 1 (source 필드 타입 정의)

  **References**:

  **Pattern References**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts:53-65` — 현재 `timeline_entries` CREATE TABLE 스키마
  - `server/src/modules/enrichment/enrichment-cache-db.ts:144-178` — `saveTimelineEntries()` 구현
  - `server/src/modules/enrichment/enrichment-cache-db.ts:180-212` — `getTimelineEntries()`, `getAllTimelineEntries()`

  **WHY Each Reference Matters**:
  - 스키마(53-65)를 보고 ALTER TABLE 컬럼 위치/타입 결정
  - save(144-178)를 보고 INSERT 문에 source 파라미터 추가 방법 파악
  - get(180-212)을 보고 JSON.parse 결과에 source가 자연스럽게 포함되는지 확인

  **Acceptance Criteria**:

  **TDD:**
  - [ ] 테스트: 기존 DB에 ALTER TABLE 실행 → source 컬럼 존재 확인
  - [ ] 테스트: source='opencode'인 엔트리 저장 후 조회 → source 포함
  - [ ] `cd server && npm test` → ALL PASS

  **QA Scenarios:**

  ```
  Scenario: 마이그레이션이 기존 DB에 안전하게 적용
    Tool: Bash (vitest)
    Preconditions: 없음
    Steps:
      1. cd server && npx vitest run src/__tests__/ -t "enrichment-cache"
    Expected Result: 모든 enrichment cache 관련 테스트 통과
    Failure Indicators: SQLite 에러 또는 스키마 관련 실패
    Evidence: .sisyphus/evidence/task-4-migration.txt
  ```

  **Commit**: YES
  - Message: `fix(server): add source column to enrichment-cache-db schema`
  - Files: `server/src/modules/enrichment/enrichment-cache-db.ts`, `server/src/__tests__/enrichment-cache-db.test.ts`
  - Pre-commit: `cd server && npm test`

- [ ] 5. Claude Code timeline 변환 + agent endpoint 통합 (BUG-8)

  **What to do**:
  - `agent/src/claude-heartbeat.ts`에 `getTimelineEntries(): TimelineEntry[]` 메서드 추가
    - `getActiveSessions()`의 `ClaudeSessionInfo[]` → `TimelineEntry[]` 변환
    - 매핑: `sessionId`, `startTime` → 그대로, `directory: cwd`, `projectId: project`, `source: 'claude-code'`
    - `endTime`: active 세션은 null, stale(heartbeat > 4h)은 lastHeartbeat
    - `status`: busy/idle은 ClaudeSessionInfo.status에서, stale은 'completed'
    - `sessionTitle`: ClaudeSessionInfo.title ?? sessionId.slice(0,8)
  - `agent/src/server.ts`의 `/api/enrichment/timeline` endpoint 수정
    - OpenCode DB + Claude heartbeat 결과를 병합
    - startTime 기준 정렬
    - projectId 필터가 있을 경우 두 소스 모두에 적용
  - Claude Code가 없는 환경(SOURCE=opencode)에서는 기존 동작 유지
  - TDD: ClaudeSessionInfo mock → TimelineEntry 변환 검증, 병합 endpoint 검증

  **Must NOT do**:
  - Claude Code activity segments 구현 금지 (solid bar fallback 사용)
  - claude-heartbeat.ts의 기존 active session 로직 변경 금지
  - historical session backfill 금지 (active-only v1)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 두 데이터 소스 병합, 다양한 edge case (null cwd, missing project 등)
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8)
  - **Blocks**: Tasks 9, 13
  - **Blocked By**: Tasks 1, 2, 4

  **References**:

  **Pattern References**:
  - `agent/src/claude-heartbeat.ts:13-32` — `ClaudeSessionInfo` 인터페이스 (변환 소스)
  - `agent/src/opencode-db-reader.ts:489-557` — `getSessionTimeline()` (OpenCode 패턴 참고)
  - `agent/src/server.ts:460-468` — 현재 timeline endpoint (수정 대상)

  **API/Type References**:
  - `agent/src/opencode-db-reader.ts:103-112` — `TimelineEntry` (변환 타겟)
  - `agent/src/claude-heartbeat.ts:46` — `STALE_TTL_MS = 4h` (stale 판정 기준)

  **WHY Each Reference Matters**:
  - ClaudeSessionInfo(13-32)의 모든 필드를 이해해야 TimelineEntry로 정확히 매핑 가능
  - getSessionTimeline(489-557)은 OpenCode 측 변환 로직 — 동일한 패턴으로 Claude 측도 구현
  - server.ts(460-468)이 수정 대상 endpoint — 여기서 두 소스를 병합

  **Acceptance Criteria**:

  **TDD:**
  - [ ] RED: mock ClaudeSessionInfo → getTimelineEntries() → source가 'claude-code'인 엔트리 기대 → FAIL
  - [ ] GREEN: 변환 함수 구현 후 PASS
  - [ ] RED: timeline endpoint 호출 시 Claude 세션 포함 기대 → FAIL
  - [ ] GREEN: endpoint 수정 후 PASS
  - [ ] `cd agent && npm test` → ALL PASS

  **QA Scenarios:**

  ```
  Scenario: Claude Code 세션이 timeline API에 포함
    Tool: Bash (curl)
    Preconditions: Agent가 Claude Code 모드로 실행 (SOURCE=both)
    Steps:
      1. curl -s -H "Authorization: Bearer $API_KEY" "http://localhost:3098/api/enrichment/timeline?from=0&to=9999999999999"
      2. jq '.data[] | select(.source == "claude-code")' 로 Claude 엔트리 확인
    Expected Result: source가 "claude-code"인 엔트리가 1개 이상
    Failure Indicators: Claude 엔트리 없음 또는 source 필드 누락
    Evidence: .sisyphus/evidence/task-5-claude-timeline.json

  Scenario: OpenCode 전용 환경에서 기존 동작 유지
    Tool: Bash (vitest)
    Preconditions: SOURCE=opencode 환경
    Steps:
      1. cd agent && npx vitest run -t "timeline" 
    Expected Result: 모든 기존 테스트 통과, Claude 관련 코드가 안전하게 스킵
    Failure Indicators: OpenCode 전용 환경에서 에러
    Evidence: .sisyphus/evidence/task-5-opencode-only.txt
  ```

  **Commit**: YES
  - Message: `feat(agent): add Claude Code timeline extraction + merged endpoint`
  - Files: `agent/src/claude-heartbeat.ts`, `agent/src/server.ts`, `agent/src/__tests__/claude-timeline.test.ts`
  - Pre-commit: `cd agent && npm test`

- [ ] 6. 배치 세그먼트 API — N+1 제거 (BUG-3)

  **What to do**:
  - Agent: `/api/enrichment/timeline-segments-batch` 새 endpoint 추가
    - Query: `?sessionIds=id1,id2,id3` (comma-separated)
    - 응답: `{ segments: Record<string, ActivitySegment[]> }`
    - 내부적으로 각 sessionId에 대해 `getSessionActivitySegments()` 호출 (agent 내부에서는 DB 쿼리)
  - Server: `/api/enrichment/merged/timeline-segments-batch` 프록시 추가
    - 각 머신에 batch 요청 전달, 결과 병합
  - Frontend: `enrichment.ts`의 `fetchSessionSegments()` → `fetchSessionSegmentsBatch(sessionIds: string[])` 로 교체
    - 한 번의 API 호출로 모든 세션의 segments 수집
  - `TimelinePage.svelte`의 `$effect`를 수정:
    - `filteredSessions`가 변경될 때 sessionId 목록을 모아 batch 호출 1회
  - TDD: 20개 세션 ID로 batch 호출 시 1번의 HTTP 요청 + 모든 segments 반환 검증

  **Must NOT do**:
  - 기존 단건 `/api/enrichment/timeline-segments` endpoint 삭제 금지 (하위 호환)
  - Claude Code 세션에 대한 segment 구현 금지 (빈 배열 반환)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Agent + Server + Frontend 3곳 수정, API 설계 포함
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 7, 8)
  - **Blocks**: Tasks 8, 11, 13
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `agent/src/server.ts:475-487` — 기존 단건 segments endpoint (패턴 참고)
  - `agent/src/opencode-db-reader.ts:560-567` — `getSessionActivitySegments()` 단건 조회
  - `server/src/modules/enrichment/index.ts:68-104` — 서버 merged segments 프록시 (패턴)
  - `server/frontend/src/lib/stores/enrichment.ts:295-331` — 현재 단건 fetch (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:32-36` — N+1 $effect (수정 대상)

  **WHY Each Reference Matters**:
  - server.ts(475-487)의 기존 endpoint 패턴을 따라 batch endpoint 추가
  - enrichment index.ts(68-104)의 merged 프록시 패턴을 따라 batch 프록시 추가
  - frontend enrichment.ts(295-331)의 fetch 로직을 batch로 교체
  - TimelinePage.svelte(32-36)의 $effect를 batch 호출로 변경

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Agent 테스트: 3개 sessionId batch 요청 → 각각의 segments 반환
  - [ ] Frontend 테스트: 20개 세션 로드 시 segment 관련 HTTP 요청 1-2회 이하
  - [ ] `cd agent && npm test` → ALL PASS
  - [ ] `cd server && npm test` → ALL PASS

  **QA Scenarios:**

  ```
  Scenario: Batch segments API가 여러 세션 segments를 한 번에 반환
    Tool: Bash (curl)
    Preconditions: Agent 실행 중, 세션 데이터 존재
    Steps:
      1. 먼저 timeline에서 sessionId 3개 수집: curl ... | jq '.data[0:3] | .[].sessionId'
      2. batch endpoint 호출: curl "http://localhost:3098/api/enrichment/timeline-segments-batch?sessionIds=id1,id2,id3"
      3. 응답의 segments 객체에 3개 키 존재 확인
    Expected Result: { segments: { "id1": [...], "id2": [...], "id3": [...] } }
    Failure Indicators: 빈 응답 또는 일부 세션 누락
    Evidence: .sisyphus/evidence/task-6-batch-segments.json

  Scenario: N+1 제거 확인 — 프론트엔드 네트워크 요청 수
    Tool: Playwright
    Preconditions: 서버 실행 중, 세션 10개 이상
    Steps:
      1. Timeline 페이지 로드
      2. Network 요청 중 'timeline-segment' 포함 URL 카운트
    Expected Result: segment 관련 요청 2개 이하 (batch 1회 + 가능하면 0)
    Failure Indicators: segment 요청이 세션 수만큼 발생
    Evidence: .sisyphus/evidence/task-6-n1-elimination.png
  ```

  **Commit**: YES
  - Message: `refactor(agent+server+frontend): batch segment API replacing N+1`
  - Files: `agent/src/server.ts`, `server/src/modules/enrichment/index.ts`, `server/frontend/src/lib/stores/enrichment.ts`, `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd agent && npm test && cd ../server && npm test`

- [ ] 7. 반응형 SVG — ResizeObserver (BUG-4)

  **What to do**:
  - `TimelinePage.svelte`에서 `const SVG_WIDTH = 900` 제거
  - `svg-scroll` 컨테이너에 `bind:this`로 DOM 참조 획득
  - `ResizeObserver`로 컨테이너 너비 감지 → `svgWidth` reactive state에 저장
  - SVG의 `width` 속성을 `svgWidth`로 바인딩
  - `timeToX()` 호출 시 `SVG_WIDTH` → `svgWidth` 교체
  - debounce 적용 (resize 이벤트 과다 방지, 100ms)
  - onDestroy에서 ResizeObserver disconnect
  - 레인 라벨 높이와 SVG 레인 높이 동기화 유지
  - TDD: 컨테이너 너비 변경 시 SVG width가 따라가는지 검증

  **Must NOT do**:
  - d3.js, chart.js 등 외부 라이브러리 추가 금지
  - CSS viewBox 기반 스케일링 금지 (텍스트가 찌그러짐)
  - 모바일/태블릿 전용 레이아웃 금지

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: DOM 측정, ResizeObserver, 레이아웃 동기화 — 시각적 UI 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 8)
  - **Blocks**: Tasks 11, 13
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:15` — `const SVG_WIDTH = 900` (제거 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:152-157` — SVG element (width 바인딩 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:264-277` — `.svg-scroll` CSS (flex: 1, overflow-x)

  **External References**:
  - MDN ResizeObserver: https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver

  **WHY Each Reference Matters**:
  - line 15의 상수를 reactive로 교체
  - lines 152-157의 SVG width를 동적으로 변경
  - lines 264-277의 CSS가 flex 레이아웃이므로 ResizeObserver가 올바른 접근법 확인

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `cd server/frontend && npm run build` → SUCCESS

  **QA Scenarios:**

  ```
  Scenario: 브라우저 리사이즈 시 SVG 너비 자동 조절
    Tool: Playwright
    Preconditions: 서버 실행 중, Timeline 페이지에 데이터 존재
    Steps:
      1. page.setViewportSize({ width: 1920, height: 1080 })
      2. page.goto Timeline, SVG width 측정: page.locator('[data-testid=timeline-svg]').getAttribute('width')
      3. page.setViewportSize({ width: 1200, height: 1080 })
      4. 500ms 대기
      5. SVG width 다시 측정
    Expected Result: SVG width가 1920에서 >800, 1200에서 더 작은 값으로 변경. "900" 고정 아님
    Failure Indicators: width가 "900"으로 고정되어 있음
    Evidence: .sisyphus/evidence/task-7-responsive-1920.png, .sisyphus/evidence/task-7-responsive-1200.png

  Scenario: 레인 라벨과 SVG 레인이 정렬 유지
    Tool: Playwright
    Preconditions: 서버 실행 중
    Steps:
      1. Timeline 페이지 로드, 뷰포트 1600px
      2. .lane-label 첫 번째 요소의 getBoundingClientRect().top
      3. [data-testid=swim-lane] 첫 번째 요소의 getBoundingClientRect().top
      4. 두 값의 차이 확인
    Expected Result: 차이 < 5px (정렬됨)
    Failure Indicators: 라벨과 레인이 어긋남 (>10px 차이)
    Evidence: .sisyphus/evidence/task-7-alignment.png
  ```

  **Commit**: YES
  - Message: `fix(frontend): responsive SVG width with ResizeObserver`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 8. 실시간 갱신 — Now 라인 + active session 바 (BUG-5, BUG-7)

  **What to do**:
  - `TimelinePage.svelte`에 30초 `setInterval`로 `currentTime` state 갱신
  - `nowX` 계산을 `currentTime` 기반으로 변경 (기존: `Date.now()` 직접)
  - active session(endTime===null)의 endX 계산도 `currentTime` 사용
  - `onDestroy`에서 interval 정리
  - SSE로 time range가 갱신될 때 currentTime도 리셋
  - TDD: currentTime이 변경되면 nowX가 업데이트되는지 검증

  **Must NOT do**:
  - 1초마다 갱신하지 말 것 (30초면 충분, 성능 보호)
  - time range preset 자동 변경 금지 (사용자가 선택한 범위 유지)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: setInterval 추가 + 기존 derived 수정, 소규모 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7)
  - **Blocks**: Task 13
  - **Blocked By**: Task 6 (세그먼트 로딩 방식 확정 후)

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:45` — `nowX` derived (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:173` — `session.endTime ?? Date.now()` (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:213-219` — Now 라인 렌더링

  **WHY Each Reference Matters**:
  - line 45: nowX 계산을 currentTime 기반으로 변경
  - line 173: active session endX도 currentTime 사용
  - lines 213-219: Now 라인이 currentTime 변경에 반응하여 이동해야 함

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `cd server/frontend && npm run build` → SUCCESS

  **QA Scenarios:**

  ```
  Scenario: Now 라인이 30초 후 위치 변경
    Tool: Playwright
    Preconditions: Timeline 페이지에 데이터 존재
    Steps:
      1. Timeline 페이지 로드
      2. Now 라인의 x1 속성 기록 (line element with stroke=var(--error))
      3. 35초 대기
      4. Now 라인의 x1 속성 다시 기록
    Expected Result: x1 값이 변경됨 (>0.5px 이상 차이)
    Failure Indicators: 35초 후에도 x1 동일
    Evidence: .sisyphus/evidence/task-8-now-line-update.txt
  ```

  **Commit**: YES
  - Message: `fix(frontend): auto-refresh Now line + active session bars every 30s`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 9. 프로젝트 필터 개선 (BUG-1, BUG-6)

  **What to do**:
  - `TimelinePage.svelte`의 프로젝트 필터 로직 수정
  - BUG-1 수정: `projectId` 대신 `directory` 기준으로 프로젝트 그룹화
    - 같은 directory를 가진 세션들은 동일 프로젝트로 취급 (projectId가 달라도)
    - `projects` derived를 `directory` 기준 unique set으로 변경
  - BUG-6 수정: `shortPath()` → Task 3에서 만든 `disambiguateProjects()` 사용
  - 드롭다운 value를 `directory`로 변경, 서버 fetchTimelineData에 `projectId` 대신 client-side filter
  - Claude Code source badge: 드롭다운에 source 표시 (optional, 이미 source 필드 있음)
  - TDD: 같은 directory, 다른 projectId인 세션 2개 → 필터에 1개만 표시

  **Must NOT do**:
  - 프로젝트 필터를 searchable dropdown으로 변경 금지
  - multi-select 필터 금지
  - 프로젝트 20개 이상일 때 UI 분리 (scope creep)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 프론트엔드 필터 로직 변경 + disambiguate 함수 연결
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11, 12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 3, 5

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:38-39` — 현재 projects/projectDirectoryMap derived (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:123-128` — 드롭다운 렌더링 (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:24-28` — filteredSessions derived (수정 대상)
  - `server/frontend/src/lib/timeline-utils.ts` — disambiguateProjects() (Task 3에서 추가)

  **WHY Each Reference Matters**:
  - lines 38-39: projectId 기반 → directory 기반으로 변경
  - lines 123-128: 드롭다운 value/label 변경
  - lines 24-28: 필터 조건을 directory 기반으로 변경
  - timeline-utils.ts의 disambiguateProjects로 라벨 생성

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `cd server/frontend && npm run build` → SUCCESS

  **QA Scenarios:**

  ```
  Scenario: 같은 directory, 다른 projectId인 세션이 하나의 프로젝트로 표시
    Tool: Playwright
    Preconditions: 서버 실행 중, 동일 directory 세션 존재
    Steps:
      1. Timeline 페이지 로드
      2. 프로젝트 필터 드롭다운 열기
      3. 각 옵션의 텍스트 수집
    Expected Result: 같은 directory에 해당하는 옵션이 1개만 존재 (중복 없음)
    Failure Indicators: 동일 프로젝트가 여러 번 나열됨
    Evidence: .sisyphus/evidence/task-9-no-duplicate-projects.png
  ```

  **Commit**: YES
  - Message: `fix(frontend): improve project filter with directory-based grouping`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 10. AbortController + race condition 방지 (EC7)

  **What to do**:
  - `server/frontend/src/lib/stores/enrichment.ts`의 `fetchTimelineData()`에 AbortController 추가
  - 새 요청 시 이전 진행 중인 요청 abort
  - `fetchSessionSegmentsBatch()`에도 동일 적용
  - 모듈 레벨 변수로 `let currentTimelineAbort: AbortController | null`
  - `fetchJSON`에 `signal` 옵션 전달
  - abort된 요청의 에러를 무시 (AbortError 체크)
  - TDD: 연속 3회 호출 시 마지막 요청만 store에 반영되는지 검증

  **Must NOT do**:
  - fetchJSON 함수 자체 수정 금지 (signal 옵션은 fetch API 네이티브)
  - 다른 enrichment fetch 함수 (tokens, impact 등) 수정 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: AbortController 패턴 적용, 단순 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 11, 12)
  - **Blocks**: Task 13
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/enrichment.ts:199-223` — `fetchTimelineData()` (수정 대상)
  - `server/frontend/src/lib/api.ts` — `fetchJSON()` 구현 (signal 전달 가능한지 확인)

  **External References**:
  - MDN AbortController: https://developer.mozilla.org/en-US/docs/Web/API/AbortController

  **WHY Each Reference Matters**:
  - fetchTimelineData(199-223)에 abort 로직 추가
  - api.ts의 fetchJSON 시그니처를 확인하여 signal 전달 방법 파악

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `cd server/frontend && npm run build` → SUCCESS

  **QA Scenarios:**

  ```
  Scenario: 빠른 preset 변경 시 마지막 결과만 반영
    Tool: Playwright
    Preconditions: 서버 실행 중
    Steps:
      1. Timeline 페이지 로드
      2. 1h → 6h → 24h → 7d 버튼을 빠르게 연속 클릭 (100ms 간격)
      3. 2초 대기
      4. 네트워크 요청 중 'timeline' 포함 요청 확인
    Expected Result: abort된 요청 존재 (cancelled), 마지막 7d 결과만 UI에 표시
    Failure Indicators: 이전 범위의 데이터가 잠시 flash되었다가 사라짐
    Evidence: .sisyphus/evidence/task-10-abort-race.png
  ```

  **Commit**: YES
  - Message: `fix(frontend): add AbortController to timeline data fetch`
  - Files: `server/frontend/src/lib/stores/enrichment.ts`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 11. 세그먼트 로딩 상태 + visual flash 방지 + 라벨 개선 (BUG-10, BUG-11)

  **What to do**:
  - BUG-10: 세그먼트 로딩 중 표시 개선
    - `sessionSegmentsLoading` store 활용 → 레인에 로딩 표시 (pulsing bar 또는 skeleton)
    - segments가 undefined일 때 바로 solid bar 대신 "로딩 중" 상태 표시
    - segments 로딩 완료 후 부드럽게 전환 (CSS transition)
  - BUG-11: 세션 라벨 truncation 개선
    - 현재: `session.sessionTitle.slice(0, 20)` → 고정 문자 수 잘림
    - 변경: CSS `text-overflow: ellipsis` + `max-width` 활용 (font width 고려)
    - All mode에서 machineAlias 표시 시 라벨 포맷 개선
  - source badge: Claude Code 세션에 작은 아이콘/라벨 표시 (optional)

  **Must NOT do**:
  - 복잡한 애니메이션 금지 (opacity transition만 허용)
  - 라벨 영역 너비(180px) 크게 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: CSS 전환, 로딩 스켈레톤, 라벨 레이아웃 — 시각적 UI 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 10, 12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 3, 6, 7

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:199-208` — 현재 fallback rect (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:141-149` — 라벨 렌더링 (수정 대상)
  - `server/frontend/src/components/pages/TimelinePage.svelte:266-275` — `.lane-label` CSS
  - `server/frontend/src/lib/stores/enrichment.ts:293` — `sessionSegmentsLoading` store

  **WHY Each Reference Matters**:
  - lines 199-208: fallback rect를 로딩 표시로 교체
  - lines 141-149: 라벨 truncation 방식 변경
  - lines 266-275: CSS에 text-overflow 적용
  - enrichment.ts:293의 loading state를 활용하여 로딩 UI 표시

  **Acceptance Criteria**:

  **QA Scenarios:**

  ```
  Scenario: 세그먼트 로딩 중 skeleton 표시
    Tool: Playwright
    Preconditions: 서버 실행 중
    Steps:
      1. Timeline 페이지 로드
      2. 초기 로딩 시점에 swim-lane 내부 확인
    Expected Result: 세그먼트 도착 전 pulsing/skeleton bar 표시, 도착 후 실제 segments로 전환
    Failure Indicators: 갑작스러운 레이아웃 점프 (flash)
    Evidence: .sisyphus/evidence/task-11-loading-skeleton.png
  ```

  **Commit**: YES
  - Message: `fix(frontend): segment loading skeleton + improved label truncation`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 12. 머신 오프라인 staleness 감지 (EC1)

  **What to do**:
  - 프론트엔드: Timeline에서 오프라인 머신의 active 세션을 "stale" 표시
  - machine store에서 각 머신의 연결 상태 활용 (`/api/machines` 응답의 connected 필드)
  - `MergedTimelineEntry`의 `machineId`로 해당 머신 상태 조회
  - 오프라인 머신의 active(endTime=null) 세션에 특수 스타일 적용 (흐릿하게 또는 점선 테두리)
  - 툴팁에 "머신 오프라인 — 상태 불확실" 메시지 추가

  **Must NOT do**:
  - 서버 측 staleness 로직 추가 금지 (프론트엔드에서만 처리)
  - 오프라인 세션 자동 삭제/숨김 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 프론트엔드에서 machine 상태 조합 + 스타일 적용, 소규모
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 10, 11)
  - **Blocks**: Task 13
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/machine.svelte.ts` — machine 상태 store (connected 정보)
  - `server/frontend/src/components/pages/TimelinePage.svelte:142-143` — merged session의 machineAlias 사용

  **WHY Each Reference Matters**:
  - machine store에서 연결 상태를 확인하여 오프라인 여부 판단
  - line 142-143에서 machineId를 이미 사용하므로 같은 패턴으로 상태 조합

  **Acceptance Criteria**:

  **QA Scenarios:**

  ```
  Scenario: 오프라인 머신의 세션이 stale 스타일로 표시
    Tool: Playwright
    Preconditions: 다중 머신 환경, 하나가 오프라인
    Steps:
      1. Timeline 페이지 로드 (All Machines 모드)
      2. 오프라인 머신의 세션 bar 스타일 확인
    Expected Result: 오프라인 머신 세션이 투명도 낮음 또는 점선 테두리
    Failure Indicators: 모든 세션이 동일 스타일
    Evidence: .sisyphus/evidence/task-12-stale-sessions.png
  ```

  **Commit**: YES
  - Message: `fix(frontend): detect stale sessions from offline machines`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`
  - Pre-commit: `cd server/frontend && npm run build`

- [ ] 13. E2E 테스트 + 통합 검증

  **What to do**:
  - `server/e2e/ui/timeline.spec.ts` 새 파일 생성
  - Playwright로 Timeline 페이지 통합 테스트:
    - 페이지 로드 → SVG 렌더링 확인
    - time range preset 변경 → 데이터 리로드 확인
    - 프로젝트 필터 → 필터링 동작 확인
    - 반응형 → 뷰포트 리사이즈 후 SVG 너비 변경 확인
    - Now 라인 존재 확인
    - swim-lane 라벨과 SVG 정렬 확인
  - `server/e2e/api/timeline-api.spec.ts` 새 파일 생성
  - Playwright request로 API 계약 검증:
    - `/api/enrichment/merged/timeline` → TimelineEntry[] 스키마 검증 (source 필드 포함)
    - `/api/enrichment/merged/timeline-segments-batch` → batch 응답 스키마 검증
    - time range 파라미터 동작 검증
  - 모든 Task 1-12의 수정사항이 통합된 상태에서 실행

  **Must NOT do**:
  - 기존 e2e 테스트 파일 수정 금지
  - flaky 테스트 방지: 고정된 timeout 대신 waitFor 사용

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: E2E 테스트는 전체 시스템 이해 + Playwright 활용 필요
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (단독)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 5-12 (모든 구현 완료 후)

  **References**:

  **Pattern References**:
  - `server/e2e/ui/` — 기존 UI e2e 테스트 패턴
  - `server/e2e/api/` — 기존 API e2e 테스트 패턴
  - `server/playwright.config.ts` — Playwright 설정

  **WHY Each Reference Matters**:
  - 기존 e2e 디렉토리의 파일 구조, import 패턴, test 구조를 따름
  - playwright.config.ts에서 base URL, timeout 등 설정 확인

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `npx playwright test server/e2e/ui/timeline.spec.ts` → ALL PASS
  - [ ] `npx playwright test server/e2e/api/timeline-api.spec.ts` → ALL PASS

  **QA Scenarios:**

  ```
  Scenario: E2E 테스트 스위트 전체 통과
    Tool: Bash
    Preconditions: 서버 + 프론트엔드 빌드 완료, 서버 실행 중
    Steps:
      1. cd server && npx playwright test e2e/ --reporter=html
    Expected Result: 모든 테스트 통과, HTML 리포트 생성
    Failure Indicators: 1개 이상 테스트 실패
    Evidence: .sisyphus/evidence/task-13-e2e-report.html
  ```

  **Commit**: YES
  - Message: `test(e2e): add Timeline page integration tests`
  - Files: `server/e2e/ui/timeline.spec.ts`, `server/e2e/api/timeline-api.spec.ts`
  - Pre-commit: `npx playwright test server/e2e/`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` in server/ and agent/. Run linter. Run `npm test` in both. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (project filter + Claude Code sessions + responsive SVG). Test edge cases: empty state, rapid preset changes, machine offline. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| # | Message | Files | Pre-commit |
|---|---------|-------|------------|
| 1 | `refactor(types): add source field to TimelineEntry + api-contract` | api-contract.ts, enrichment/types.ts, opencode-db-reader.ts, enrichment.ts (frontend) | `npm test` in agent + server |
| 2 | `fix(agent): include long-running sessions in timeline SQL` | opencode-db-reader.ts, opencode-db-reader.test.ts | `npm test` in agent |
| 3 | `refactor(frontend): extract shortPath to timeline-utils with disambiguation` | timeline-utils.ts, TimelinePage.svelte | `npm run build` in frontend |
| 4 | `fix(server): add source column to enrichment-cache-db schema` | enrichment-cache-db.ts | `npm test` in server |
| 5 | `feat(agent): add Claude Code timeline extraction + merged endpoint` | claude-heartbeat.ts, server.ts, tests | `npm test` in agent |
| 6 | `refactor(agent+server): batch segment API replacing N+1` | server.ts, enrichment/index.ts, enrichment.ts (frontend) | `npm test` in agent + server |
| 7 | `fix(frontend): responsive SVG width with ResizeObserver` | TimelinePage.svelte | `npm run build` in frontend |
| 8 | `fix(frontend): auto-refresh Now line + active session bars` | TimelinePage.svelte | `npm run build` in frontend |
| 9 | `fix(frontend): improve project filter disambiguation` | TimelinePage.svelte, timeline-utils.ts | `npm run build` in frontend |
| 10 | `fix(frontend): add AbortController to timeline data fetch` | enrichment.ts (frontend) | `npm run build` in frontend |
| 11 | `fix(frontend): segment loading skeleton + label truncation` | TimelinePage.svelte | `npm run build` in frontend |
| 12 | `fix(frontend): detect stale sessions from offline machines` | TimelinePage.svelte, enrichment.ts | `npm run build` in frontend |
| 13 | `test(e2e): add Timeline page integration tests` | timeline.spec.ts | `npx playwright test` |

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm test              # Expected: ALL PASS (330+ tests)
cd server && npm test             # Expected: ALL PASS (290+ tests)
cd server && npm run build        # Expected: 0 errors
cd server/frontend && npm run build  # Expected: 0 errors
npx playwright test server/e2e/ui/timeline.spec.ts  # Expected: ALL PASS
```

### Final Checklist
- [ ] 11개 버그 모두 수정됨 (BUG-1~BUG-11)
- [ ] Claude Code active 세션이 Timeline에 표시
- [ ] SVG가 브라우저 너비에 반응
- [ ] N+1 세그먼트 문제 해결 (배치 API)
- [ ] "Now" 라인이 30-60초마다 자동 갱신
- [ ] 프로젝트 필터에 중복 없음, 구분 가능한 이름
- [ ] AbortController로 race condition 방지
- [ ] 모든 기존 테스트 통과
- [ ] Must NOT Have 항목 전부 준수
