# Timeline 로딩 성능 최적화 — 백그라운드 세션 제거 + SSE Refetch 수정

## TL;DR

> **Quick Summary**: Timeline 페이지가 SSE 이벤트마다 전체 데이터(414KB, 1,128건)를 refetch하고, 그 중 84%가 백그라운드 세션. Agent SQL에서 백그라운드 세션을 완전 필터링하고, SSE 핸들러가 현재 시간 범위를 유지하도록 수정합니다.
> 
> **Deliverables**:
> - Agent: `getSessionTimeline()` SQL에서 백그라운드 세션 필터링 (parent_id + title 패턴)
> - Server: `timeline_entries` 읽기 시 백그라운드 필터 + 기존 데이터 정리
> - Frontend: SSE 핸들러가 현재 시간 범위로 refetch하도록 수정
> - 배포: 192.168.0.2:3097
> 
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: T1 → T2 → T3 → T4 → T5 → T6

---

## Context

### Original Request
- "백엔드 캐싱이 적용되었는데 timeline 로딩이 오래 걸리는 이유는?"
- "렌더링 되는 세션에서 백그라운드는 제거해야함 (유저가 직접 제어한 세션만 표기)"

### Interview Summary
**Key Discussions**:
- 서버 API는 빠름 (6ms). 문제는 프론트엔드 SSE 핸들러 + 과도한 데이터.
- 전체 1,128건 중 939건(84%)이 백그라운드 세션 — `isBackgroundSession()` 패턴: Background:, Task:, @ 포함
- 유저가 직접 제어한 세션은 189건(16.7%)만
- 백그라운드 세션: 토글 없이 **완전 제거** 결정

**Research Findings**:
- `opencode-db-reader.ts:455` — `parentId: null` hardcoded (DB에 parent_id 컬럼 존재하지만 미사용)
- `enrichment.ts:259` — SSE 핸들러가 `fetchTimelineData()` from/to 없이 호출 (전체 414KB 반환)
- `getSessionTimeline()`에 4개의 독립적 SQL 쿼리 경로 존재 — 모두 필터링 필요
- `handleMergedEnrichmentSSEUpdate`도 같은 버그 존재 — 두 핸들러 모두 수정 필요
- 서버 SQLite `timeline_entries`에 이미 저장된 백그라운드 엔트리가 90일간 잔존

### Metis Review
**Identified Gaps** (addressed):
- 4개 SQL 쿼리 경로 모두 필터링 필요 (since+projectId, since, projectId, 기본) → 모든 경로에 WHERE 조건 추가
- 양쪽 SSE 핸들러 수정 필요 (enrichment.updated + enrichment.merged.updated) → 둘 다 수정
- 서버 SQLite에 기존 백그라운드 엔트리 잔존 문제 → 읽기 시 필터 + cleanup 메서드
- `@` 패턴 false positive 위험 → production 데이터 확인 결과 모두 `@subagent` 패턴, 안전

---

## Work Objectives

### Core Objective
Agent SQL 소스에서 백그라운드 세션(parent_id 있거나 title이 Background:/Task:/@패턴)을 제거하고, 프론트엔드 SSE 핸들러가 시간 범위를 유지하여 refetch하도록 수정합니다.

### Concrete Deliverables
- `agent/src/opencode-db-reader.ts` — 4개 SQL 쿼리에 parent_id + title 필터 추가
- `server/src/modules/enrichment/enrichment-cache-db.ts` — 읽기 시 백그라운드 필터 + cleanup 메서드
- `server/frontend/src/lib/stores/enrichment.ts` — SSE 핸들러에 시간 범위 전달

### Definition of Done
- [ ] Agent timeline API: 백그라운드 세션 0건 반환
- [ ] SSE 이벤트 후 timeline refetch 시 from/to 파라미터 포함
- [ ] 서버 merged/timeline 전체 payload < 100KB (현재 414KB)
- [ ] 서버 merged/timeline 24h payload < 30KB
- [ ] 192.168.0.2:3097 배포 후 timeline 정상 동작
- [ ] `cd agent && npm test` → 모든 테스트 통과
- [ ] `cd server && npm test` → 모든 테스트 통과

### Must Have
- Agent SQL 4개 경로 모두에 `parent_id IS NULL` + title 패턴 필터 적용
- SSE 핸들러 2개 모두 수정 (enrichment.updated + enrichment.merged.updated)
- 서버 SQLite 읽기 시 백그라운드 엔트리 필터링 (stale 데이터 방어)
- 기존 `TimelineEntry` 인터페이스 유지

### Must NOT Have (Guardrails)
- ❌ 백그라운드 세션 토글 UI (완전 제거 결정)
- ❌ agent/src 원본 타입(`TimelineEntry` 등) 인터페이스 변경
- ❌ opencode.db 쓰기
- ❌ `as any` / `@ts-ignore`
- ❌ agent/frontend 변경을 같은 커밋에 섞기
- ❌ tokens/impact/projects/recovery SSE 핸들러 수정 (timeline만)
- ❌ pagination, 세션 hierarchy 표시, polling 주기 변경
- ❌ `isBackgroundSession()` 함수 리팩터링

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (204 tests, vitest)
- **Automated tests**: Tests-after
- **Framework**: vitest

### QA Policy
- **Agent filtering**: curl로 API 호출 → 백그라운드 세션 0건 확인
- **SSE behavior**: unit test로 SSE 이벤트 후 fetchTimelineData 호출 시 from/to 포함 확인
- **Payload size**: curl + wc -c로 크기 확인
- **Frontend**: Playwright로 timeline 페이지 동작 확인

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — agent 수정, 2 parallel):
├── Task 1: Agent SQL 백그라운드 필터링 (4개 쿼리 경로) [quick]
├── Task 2: Agent 테스트 추가 (background filtering) [quick]

Wave 2 (After Wave 1 — server + frontend, 2 parallel):
├── Task 3: Server SQLite 읽기 필터 + cleanup [quick]
├── Task 4: Frontend SSE 핸들러 시간 범위 수정 [quick]

Wave 3 (After Wave 2 — build + deploy):
├── Task 5: Build + Test 통과 확인 [quick]
├── Task 6: Deploy to 192.168.0.2 + QA [quick]

Wave FINAL (After ALL — 독립 리뷰, 2 parallel):
├── Task F1: Smoke test — curl 기반 검증 [quick]
├── Task F2: Playwright QA — timeline 페이지 [unspecified-high]

Critical Path: T1 → T3 → T5 → T6 → F1
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 2
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2, 3, 5 | 1 |
| 2 | 1 | 5 | 1 |
| 3 | 1 | 5 | 2 |
| 4 | — | 5 | 2 |
| 5 | 1, 2, 3, 4 | 6 | 3 |
| 6 | 5 | F1, F2 | 3 |
| F1, F2 | 6 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `quick`
- **Wave 2**: 2 tasks — T3 → `quick`, T4 → `quick`
- **Wave 3**: 2 tasks — T5 → `quick`, T6 → `quick`
- **FINAL**: 2 tasks — F1 → `quick`, F2 → `unspecified-high` + `playwright`

---

## TODOs

- [x] 1. Agent SQL 백그라운드 세션 필터링 (4개 쿼리 경로)

  **What to do**:
  - `agent/src/opencode-db-reader.ts`의 `getSessionTimeline()` 메서드 수정:
    1. **TimelineRow 타입** (line 407-412): `parent_id: string | null` 필드 추가
    2. **SQL SELECT절**: 4개 쿼리 모두 `parent_id` 컬럼 추가
    3. **SQL WHERE절**: 4개 쿼리 모두 다음 조건 추가:
       ```sql
       AND parent_id IS NULL
       AND title NOT LIKE 'Background:%'
       AND title NOT LIKE 'Task:%'
       AND title NOT LIKE '%@%'
       ```
    4. **결과 매핑** (line 455): `parentId: null` 대신 `parentId: r.parent_id ?? null`
  - **4개 쿼리 경로** (모두 수정 필수):
    - Line 418-424: `since` + `projectId` → inline SQL
    - Line 426-432: `since` only → inline SQL
    - Line 436: `projectId` only → prepared statement `stmtTimelineByProject` (재정의 필요)
    - Line 437: 기본 → prepared statement `stmtTimeline` (재정의 필요)
  - prepared statement 정의도 확인하고 업데이트:
    - `stmtTimeline` (약 line 705-712)
    - `stmtTimelineByProject` (약 line 715-722)

  **Must NOT do**:
  - `TimelineEntry` 인터페이스 변경 (line 94-103)
  - `isBackgroundSession()` 함수 수정
  - opencode.db 쓰기

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: SQL WHERE 조건 추가 + prepared statement 업데이트. 로직 변경 없음.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T2와 병렬)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 3, Task 5
  - **Blocked By**: None

  **References**:
  - `agent/src/opencode-db-reader.ts:404-458` — `getSessionTimeline()` 전체 코드, 4개 SQL 경로
  - `agent/src/opencode-db-reader.ts:705-722` — prepared statements `stmtTimeline`, `stmtTimelineByProject`
  - `agent/src/opencode-db-reader.ts:226-254` — `getProjectSessions()`에서 parent_id 올바르게 사용하는 패턴 참고
  - `agent/src/prompt-extractor.ts:67-74` — `isBackgroundSession()` 패턴 (Background:, Task:, @)

  **Acceptance Criteria**:
  - [ ] 4개 SQL 쿼리 모두 `parent_id IS NULL` 조건 포함
  - [ ] 4개 SQL 쿼리 모두 title 패턴 필터 포함
  - [ ] `cd agent && npx tsc --noEmit` → 에러 없음

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 4개 SQL 경로 모두 필터 적용 확인
    Tool: Bash (ast-grep 또는 grep)
    Steps:
      1. grep -c "parent_id IS NULL" agent/src/opencode-db-reader.ts
      2. Assert: >= 4 (4개 쿼리 경로)
      3. grep -c "Background:" agent/src/opencode-db-reader.ts
      4. Assert: >= 4 (title 패턴 필터)
    Expected Result: 4개 경로 모두 필터 적용
    Evidence: .sisyphus/evidence/task-1-sql-filter.txt

  Scenario: TypeScript 컴파일
    Tool: Bash
    Steps:
      1. cd agent && npx tsc --noEmit 2>&1
    Expected Result: 에러 없음
    Evidence: .sisyphus/evidence/task-1-tsc.txt
  ```

  **Commit**: YES (T2와 함께)
  - Message: `feat(agent): filter background sessions from timeline API`
  - Files: `agent/src/opencode-db-reader.ts`

---

- [x] 2. Agent 테스트 추가 — background session filtering

  **What to do**:
  - `agent/src/__tests__/opencode-db-reader.test.ts`에 새 describe 블록 추가:
    ```typescript
    describe('getSessionTimeline — background filtering', () => {
      // 테스트 seed data에 background 세션 추가:
      // - parent_id가 있는 세션 (subagent)
      // - title이 "Background: explore" 인 세션
      // - title이 "Task: something" 인 세션
      // - title에 "@subagent" 포함된 세션
      // - 정상 유저 세션 (parent_id null, 일반 title)
      
      it('should exclude sessions with parent_id', ...);
      it('should exclude sessions with Background: title', ...);
      it('should exclude sessions with Task: title', ...);
      it('should exclude sessions with @ in title', ...);
      it('should include normal user sessions', ...);
      it('should work with since parameter', ...);
      it('should work with projectId parameter', ...);
      it('should return empty array when all sessions are background', ...);
    });
    ```
  - 기존 테스트 seed data 패턴 따르기: `agent/src/__tests__/opencode-db-reader.test.ts:59-103`

  **Must NOT do**:
  - 기존 테스트 삭제/변경
  - 실제 프로덕션 DB 사용

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 테스트 케이스 추가만
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T1 이후)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 5
  - **Blocked By**: Task 1

  **References**:
  - `agent/src/__tests__/opencode-db-reader.test.ts:59-103` — 테스트 seed data 패턴 (세션 삽입 방법)
  - `agent/src/__tests__/opencode-db-reader.test.ts:110` — `OpenCodeDBReader.fromDatabase(db)` 팩토리 패턴
  - `agent/src/opencode-db-reader.ts:28` — `parent_id` 컬럼 존재 확인

  **Acceptance Criteria**:
  - [ ] 최소 8개 새 테스트 추가
  - [ ] `cd agent && npm test` → 모든 테스트 통과
  - [ ] 4개 쿼리 경로(기본, since, projectId, since+projectId) 모두 테스트 커버

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 테스트 통과
    Tool: Bash
    Steps:
      1. cd agent && npm test 2>&1
      2. Assert: 모든 테스트 통과
    Expected Result: 0 failures
    Evidence: .sisyphus/evidence/task-2-tests.txt

  Scenario: 빈 결과 처리
    Tool: Bash
    Steps:
      1. cd agent && npx vitest run src/__tests__/opencode-db-reader.test.ts 2>&1 | grep "background"
      2. Assert: 관련 테스트 모두 PASS
    Expected Result: 백그라운드만 있는 경우 빈 배열 반환
    Evidence: .sisyphus/evidence/task-2-empty-result.txt
  ```

  **Commit**: YES (T1과 함께)

---

- [x] 3. Server SQLite 읽기 필터 + 기존 백그라운드 엔트리 정리

  **What to do**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts` 수정:
    1. **`getTimelineEntries()`** — SQL WHERE에 백그라운드 필터 추가:
       ```sql
       -- data JSON에서 sessionTitle 추출하여 필터링
       AND json_extract(data, '$.sessionTitle') NOT LIKE 'Background:%'
       AND json_extract(data, '$.sessionTitle') NOT LIKE 'Task:%'
       AND json_extract(data, '$.sessionTitle') NOT LIKE '%@%'
       ```
    2. **`getAllTimelineEntries()`** — 동일 필터 추가
    3. **`deleteBackgroundEntries()`** 메서드 신규 추가:
       ```typescript
       deleteBackgroundEntries(): number {
         // 기존에 저장된 백그라운드 엔트리 일괄 삭제
         const result = this.db.prepare(`
           DELETE FROM timeline_entries WHERE
             json_extract(data, '$.sessionTitle') LIKE 'Background:%'
             OR json_extract(data, '$.sessionTitle') LIKE 'Task:%'
             OR json_extract(data, '$.sessionTitle') LIKE '%@%'
         `).run();
         return result.changes;
       }
       ```
    4. `EnrichmentModule.start()`에서 서버 시작 시 `deleteBackgroundEntries()` 호출
  - `server/src/__tests__/enrichment-cache-db.test.ts`에 테스트 추가:
    - 백그라운드 엔트리 저장 후 `getTimelineEntries()`에서 필터링 확인
    - `deleteBackgroundEntries()` 동작 확인

  **Must NOT do**:
  - `saveTimelineEntries()` 저장 로직 변경 (agent에서 이미 필터됨, 서버는 방어적 필터)
  - enrichment_cache 또는 enrichment_merged 테이블 수정

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: SQL WHERE 조건 추가 + 메서드 1개 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T4와 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 5
  - **Blocked By**: Task 1

  **References**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts:140-175` — `getTimelineEntries()`, `getAllTimelineEntries()`
  - `server/src/modules/enrichment/enrichment-cache-db.ts:72-137` — `saveTimelineEntries()` 패턴
  - `server/src/__tests__/enrichment-cache-db.test.ts` — 기존 테스트 패턴

  **Acceptance Criteria**:
  - [ ] `getTimelineEntries()`에 title 필터 포함
  - [ ] `deleteBackgroundEntries()` 메서드 존재
  - [ ] `cd server && npm test` → 모든 테스트 통과

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 서버 테스트 통과
    Tool: Bash
    Steps:
      1. cd server && npm test 2>&1
      2. Assert: 모든 테스트 통과
    Expected Result: 0 failures
    Evidence: .sisyphus/evidence/task-3-tests.txt

  Scenario: json_extract 필터 확인
    Tool: Bash (grep)
    Steps:
      1. grep -c "json_extract" server/src/modules/enrichment/enrichment-cache-db.ts
      2. Assert: >= 3 (getTimelineEntries + getAllTimelineEntries + deleteBackgroundEntries)
    Expected Result: 3개 이상의 json_extract 호출
    Evidence: .sisyphus/evidence/task-3-filter-check.txt
  ```

  **Commit**: YES
  - Message: `feat(server): add background session filter to timeline cache reads`
  - Files: `server/src/modules/enrichment/enrichment-cache-db.ts`, `server/src/modules/enrichment/index.ts`

---

- [x] 4. Frontend SSE 핸들러 시간 범위 수정

  **What to do**:
  - `server/frontend/src/lib/stores/enrichment.ts` 수정:
    1. **시간 범위 store 추가**:
       ```typescript
       // 현재 timeline이 사용 중인 시간 범위를 저장
       export const timelineTimeRange = writable<{ from: number; to: number } | null>(null);
       ```
    2. **`fetchTimelineData()` 수정** — 호출 시 시간 범위를 store에 기록:
       ```typescript
       export async function fetchTimelineData(from?: number, to?: number, projectId?: string): Promise<void> {
         // 시간 범위가 있으면 store에 기록
         if (from !== undefined && to !== undefined) {
           timelineTimeRange.set({ from, to });
         }
         // ... 기존 로직
       }
       ```
    3. **`handleEnrichmentSSEUpdate()` 수정** (line 259):
       ```typescript
       case 'timeline': {
         // 현재 시간 범위를 유지하여 refetch
         const range = get(timelineTimeRange);
         if (range) {
           void fetchTimelineData(range.from, range.to);
         }
         // range가 없으면 (timeline 페이지를 아직 안 열었으면) 아무것도 안 함
         break;
       }
       ```
    4. `import { get } from 'svelte/store'` 추가

  **Must NOT do**:
  - tokens/impact/projects/recovery SSE 핸들러 수정
  - TimelinePage.svelte 수정 (이미 from/to 전달 중)
  - 기존 fetch 함수 시그니처 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: store 1개 추가 + SSE 핸들러 수정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T3와 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `server/frontend/src/lib/stores/enrichment.ts:197-218` — `fetchTimelineData()` 현재 코드
  - `server/frontend/src/lib/stores/enrichment.ts:257-265` — `handleEnrichmentSSEUpdate()` 현재 코드
  - `server/frontend/src/lib/stores/enrichment.ts:268-273` — `handleMergedEnrichmentSSEUpdate()` 현재 코드
  - `server/frontend/src/components/pages/TimelinePage.svelte:43-51` — onMount에서 from/to 전달 패턴

  **Acceptance Criteria**:
  - [ ] `timelineTimeRange` store 존재
  - [ ] SSE 핸들러에서 from/to 포함하여 fetchTimelineData 호출
  - [ ] range가 없으면 (timeline 미방문) fetchTimelineData 호출하지 않음
  - [ ] `cd server/frontend && npm run build` → 빌드 성공

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: SSE 핸들러 코드 검증
    Tool: Bash (grep)
    Steps:
      1. grep -A5 "case 'timeline'" server/frontend/src/lib/stores/enrichment.ts
      2. Assert: "timelineTimeRange" 참조 존재
      3. Assert: "fetchTimelineData(range.from" 존재
    Expected Result: SSE 핸들러가 시간 범위를 사용
    Evidence: .sisyphus/evidence/task-4-sse-handler.txt

  Scenario: 프론트엔드 빌드
    Tool: Bash
    Steps:
      1. cd server/frontend && npm run build 2>&1
      2. Assert: exit 0
    Expected Result: 빌드 성공
    Evidence: .sisyphus/evidence/task-4-build.txt
  ```

  **Commit**: YES
  - Message: `fix(frontend): pass time range params in SSE timeline refetch handler`
  - Files: `server/frontend/src/lib/stores/enrichment.ts`

---

- [x] 5. Build + Test 통합 확인

  **What to do**:
  - Agent 빌드 + 테스트: `cd agent && npm run build && npm test`
  - Server 빌드 + 테스트: `cd server && npm run build && npm test`
  - Frontend 빌드: `cd server/frontend && npm run build`
  - TypeScript 검증: `cd agent && npx tsc --noEmit && cd ../server && npx tsc --noEmit`

  **Must NOT do**:
  - 코드 수정 (빌드/테스트만)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 6
  - **Blocked By**: Task 1, 2, 3, 4

  **References**: 없음 (빌드/테스트 확인만)

  **Acceptance Criteria**:
  - [ ] Agent: build + test 통과
  - [ ] Server: build + test 통과
  - [ ] Frontend: build 통과

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 전체 빌드 + 테스트
    Tool: Bash
    Steps:
      1. cd agent && npm run build && npm test 2>&1
      2. cd server && npm run build && npm test 2>&1
      3. cd server/frontend && npm run build 2>&1
    Expected Result: 모두 통과
    Evidence: .sisyphus/evidence/task-5-build-test.txt
  ```

  **Commit**: NO

---

- [x] 6. Deploy to 192.168.0.2 + Smoke QA

  **What to do**:
  - 배포:
    ```bash
    ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && docker compose build --no-cache && docker compose up -d --force-recreate"
    ```
  - 배포 후 smoke test:
    1. 컨테이너 healthy 확인
    2. merged/timeline payload 크기 확인 (< 100KB)
    3. 24h 필터 payload 크기 확인 (< 30KB)
    4. timeline 페이지 접속 확인

  **Must NOT do**:
  - 코드 수정
  - 직접적인 서버 설정 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: F1, F2
  - **Blocked By**: Task 5

  **References**:
  - 배포 서버: 192.168.0.2, SSH user: sbbae
  - Docker: `cd server && docker compose`
  - URL: http://192.168.0.2:3097

  **Acceptance Criteria**:
  - [ ] 컨테이너 healthy
  - [ ] merged/timeline payload < 100KB
  - [ ] 24h payload < 30KB
  - [ ] http://192.168.0.2:3097/?view=timeline 접속 정상

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 배포 + payload 확인
    Tool: Bash (SSH)
    Steps:
      1. ssh sbbae@192.168.0.2 "docker ps | grep session"
      2. Assert: healthy
      3. ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline' | wc -c"
      4. Assert: < 102400
      5. NOW=$(date +%s)000; FROM=$((NOW - 86400000))
         ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline?from=$FROM&to=$NOW' | wc -c"
      6. Assert: < 30720
    Expected Result: 배포 성공, payload 크기 기준 통과
    Evidence: .sisyphus/evidence/task-6-deploy.txt
  ```

  **Commit**: NO

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 2 review agents run in PARALLEL. Both must APPROVE.

- [x] F1. **Smoke Test — curl 기반 검증** — `quick`
  Agent API에서 백그라운드 세션 0건, 서버 merged API payload < 100KB, SSE 이벤트 수신 확인.
  ```bash
  # Agent: 백그라운드 세션 없음 확인
  curl -s "http://localhost:3098/api/enrichment/timeline?from=0&to=9999999999999" \
    -H "Authorization: Bearer $API_KEY" | python3 -c '
  import sys,json; d=json.load(sys.stdin); entries=d.get("data",[])
  bg=[e for e in entries if e.get("sessionTitle","").startswith("Background:") or e.get("sessionTitle","").startswith("Task:") or "@" in e.get("sessionTitle","")]
  print("total:", len(entries), "background:", len(bg))'
  # Expected: background: 0

  # Server: payload 크기
  ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline' | wc -c"
  # Expected: < 102400 (100KB)
  ```
  Output: `Agent BG [0] | Payload [N KB] | VERDICT: APPROVE/REJECT`

- [x] F2. **Playwright QA — Timeline 페이지** — `unspecified-high` + `playwright`
  http://192.168.0.2:3097/?view=timeline 접속. 24h 프리셋으로 timeline 로드, 세션 제목에 "Background:", "Task:", "@" 패턴 없음 확인. SSE 이벤트 후 데이터 유지 확인 (새로고침 없이 15초 대기). 모든 시간 프리셋(1h, 6h, 24h, 7d) 전환 시 정상 동작.
  Output: `Timeline [PASS/FAIL] | No BG Sessions [PASS/FAIL] | SSE Update [PASS/FAIL] | Presets [PASS/FAIL] | VERDICT`

---

## Commit Strategy

- **Commit 1** (T1+T2): `feat(agent): filter background sessions from timeline API` — agent/src/opencode-db-reader.ts + agent tests
- **Commit 2** (T3): `feat(server): add background session filter to timeline cache reads` — server/src/modules/enrichment/enrichment-cache-db.ts
- **Commit 3** (T4): `fix(frontend): pass time range params in SSE timeline refetch handler` — server/frontend/src/lib/stores/enrichment.ts

---

## Success Criteria

### Verification Commands
```bash
# Agent: 백그라운드 세션 필터 확인
curl -s "http://localhost:3098/api/enrichment/timeline?from=0&to=9999999999999" \
  -H "Authorization: Bearer $API_KEY" | python3 -c '
import sys,json; d=json.load(sys.stdin)
print("total:", len(d.get("data",[])))
bg=[e for e in d.get("data",[]) if e.get("sessionTitle","").startswith("Background:") or "@" in e.get("sessionTitle","")]
print("background:", len(bg))'
# Expected: background: 0

# Server payload 크기
ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline' | wc -c"
# Expected: < 102400

# 전체 테스트
cd agent && npm test   # Expected: all pass
cd server && npm test  # Expected: all pass
cd server && npm run build  # Expected: success
```

### Final Checklist
- [ ] Agent timeline API에서 백그라운드 세션 0건 반환
- [ ] SSE 이벤트 후 from/to 파라미터 포함하여 refetch
- [ ] merged/timeline 전체 payload < 100KB
- [ ] 192.168.0.2:3097 배포 완료
- [ ] 모든 테스트 통과
