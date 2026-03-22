# Timeline MacBook Pro 데이터 누락 + "전체" 모드 Enrichment 병합

## TL;DR

> **Quick Summary**: MacBook Pro 선택 시 Timeline "데이터 없음" 문제를 진단하고, "전체" 모드에서 모든 머신의 enrichment 데이터를 병합하여 표시하는 기능을 구현합니다.
> 
> **Deliverables**:
> - MacBook Pro Timeline 데이터 누락 원인 진단 및 수정
> - Server-side enrichment 병합 엔드포인트 (5개 feature 모두)
> - Frontend "전체" 모드 병합 로직 (resolveEnrichmentMachineId 개선)
> - Timeline swim-lane에 머신 레이블 추가
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 (진단) → Task 2 (서버 타입) → Task 3 (서버 병합) → Task 5 (프론트엔드) → Task 7 (E2E QA)

---

## Context

### Original Request
- Timeline에서 MacBook Pro 선택 시 "타임라인 데이터 없음" 표시 → 데이터가 안 보이는 문제
- "전체" 모드에서 모든 머신의 데이터를 병합하여 표시해야 함
- (취소) machines.yml gitignore → 이미 완료 확인됨

### Interview Summary
**Key Discussions**:
- MacBook Pro(192.168.0.63)는 항상 켜져 있음
- 0.2 서버에서도 opencode 사용 중 (자체 opencode.db)
- "전체" 모드 데이터 병합 필요 확인
- machines.yml gitignore → `.gitignore:6`에 이미 존재, `machines.yml.example`도 있음 → **취소**
- 테스트: tests-after 방식 (177개 기존 테스트)

**Research Findings**:
- EnrichmentModule이 모든 머신을 폴링하고 머신별로 캐시
- `resolveEnrichmentMachineId()`가 "전체" 모드에서 첫 번째 머신만 반환 → 나머지 머신 데이터 무시
- 기존 `MachineManager.pollAllQueries()` 패턴이 서버사이드 병합의 참고 모델
- TimelineEntry에 machineId 필드 없음 → 서버 병합 시 주입 필요 (agent 타입 변경 불가)
- "타임라인 데이터 없음"은 `timelineAvailable === true` + `data === []` → agent 도달 가능하지만 빈 데이터

### Metis Review
**Identified Gaps** (addressed):
- machines.yml gitignore 작업 취소 (이미 완료됨)
- 진단 우선 필수: 정확한 에러 메시지에 따라 수정 방향 결정
- "전체" 모드 버그가 Timeline뿐 아니라 5개 enrichment 페이지 전체에 영향 → 공유 함수 수정으로 전체 해결
- machineId는 agent 타입에 추가하지 말 것 → 서버 레벨에서 주입
- 기존 `MachineManager.pollAllQueries()` 패턴 따를 것

---

## Work Objectives

### Core Objective
MacBook Pro 데이터가 Timeline에 표시되지 않는 문제를 진단하고 수정하며, "전체" 모드에서 모든 머신의 enrichment 데이터를 병합하여 5개 enrichment 페이지 전체에서 올바르게 표시되도록 합니다.

### Concrete Deliverables
- MacBook agent 연결 진단 결과 (에러 로그, 응답 확인)
- Server: `EnrichmentModule`에 병합 엔드포인트 추가 (`/api/enrichment/merged/:feature`)
- Server: 병합 응답 타입에 `machineId` 필드 추가 (서버 타입만, agent 타입 불변)
- Frontend: enrichment store의 "전체" 모드 병합 로직
- Frontend: Timeline swim-lane에 머신 alias 레이블 표시
- MacBook 특정 문제 수정 (진단 결과에 따라)

### Definition of Done
- [ ] `curl http://localhost:3097/api/enrichment/merged/timeline` → 모든 머신 데이터가 machineId 포함하여 반환
- [ ] "전체" 모드에서 Timeline SVG에 여러 머신의 swim-lane 표시
- [ ] MacBook Pro 선택 시 Timeline에 데이터 표시됨
- [ ] `cd server && npm test` → 모든 테스트 통과
- [ ] `cd server && npm run build` → 빌드 성공
- [ ] 192.168.0.2:3097 배포 후 "전체" 모드 + MacBook Pro 모드 모두 데이터 표시

### Must Have
- 진단 우선: MacBook agent 상태 확인 후 코드 수정
- 서버사이드 병합: 기존 `MachineManager.pollAllQueries()` 패턴 준수
- 서버 병합 응답에 machineId 포함
- 머신 하나 불가 시에도 나머지 머신 데이터 표시 (graceful degradation)
- 기존 per-machine 라우트 유지 (새 병합 라우트 추가)

### Must NOT Have (Guardrails)
- ❌ agent/src의 타입 변경 (machineId는 서버 레벨에서 주입)
- ❌ 기존 per-machine 캐시 구조 변경
- ❌ 기존 `/api/enrichment/:machineId/:feature` 라우트 제거/수정
- ❌ 범용 merge 프레임워크/추상화 레이어
- ❌ Timeline swim-lane 레이아웃 재설계 (기존 레이아웃에 머신 badge만 추가)
- ❌ `as any` / `@ts-ignore`
- ❌ agent/frontend 변경을 같은 커밋에 섞기

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (177 tests)
- **Automated tests**: Tests-after
- **Framework**: vitest (server), Playwright (QA scenarios)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Server routes**: Bash (curl) — Send requests, assert status + response fields
- **Frontend/UI**: Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot
- **Diagnostic**: Bash (SSH + curl) — Check agent status, connectivity, DB state

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — 진단 + 서버 타입):
├── Task 1: MacBook agent 진단 (SSH + curl) [quick]
├── Task 2: Server enrichment 병합 타입 정의 [quick]

Wave 2 (After Wave 1 — 서버 병합 + MacBook 수정):
├── Task 3: Server EnrichmentModule 병합 엔드포인트 구현 (depends: 2) [deep]
├── Task 4: MacBook 특정 문제 수정 (depends: 1 결과에 따라) [quick/deep]

Wave 3 (After Wave 2 — 프론트엔드 + QA):
├── Task 5: Frontend enrichment store "전체" 모드 병합 로직 (depends: 3) [unspecified-high]
├── Task 6: Frontend TimelinePage swim-lane 머신 레이블 (depends: 5) [visual-engineering]

Wave 4 (After Wave 3 — 빌드 + 배포 + QA):
├── Task 7: 빌드 + 테스트 + 192.168.0.2 배포 + 브라우저 QA (depends: 5, 6) [deep]

Wave FINAL (After ALL tasks — 독립 리뷰, 병렬):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA — Playwright (unspecified-high)
├── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 2 → Task 3 → Task 5 → Task 7 → F1-F4
Max Concurrent: 2 (Wave 1, Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 4 | 1 |
| 2 | — | 3, 5 | 1 |
| 3 | 2 | 5, 7 | 2 |
| 4 | 1 | 7 | 2 |
| 5 | 3 | 6, 7 | 3 |
| 6 | 5 | 7 | 3 |
| 7 | 5, 6 | F1-F4 | 4 |
| F1-F4 | 7 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `quick`
- **Wave 2**: 2 tasks — T3 → `deep`, T4 → `quick` 또는 `deep` (진단 결과에 따라)
- **Wave 3**: 2 tasks — T5 → `unspecified-high`, T6 → `visual-engineering`
- **Wave 4**: 1 task — T7 → `deep`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. MacBook Agent 진단 — 연결 상태 + Timeline 데이터 확인

  **What to do**:
  - 0.2 서버(192.168.0.2)에 SSH 접속
  - MacBook agent(192.168.0.63:3101) 연결 가능 여부 확인: `curl -s -H "Authorization: Bearer test-local-key" http://192.168.0.63:3101/health`
  - MacBook agent의 Timeline enrichment 데이터 확인: `curl -s -H "Authorization: Bearer test-local-key" http://192.168.0.63:3101/api/enrichment/timeline | jq '.available, (.data | length)'`
  - 0.2 서버의 Docker 컨테이너 내부에서 MacBook agent 접근 확인: `docker exec session-dashboard wget -qO- http://192.168.0.63:3101/health`
  - 0.2 서버의 enrichment 캐시 상태 확인: `curl -s http://localhost:3097/api/enrichment | jq 'keys'`
  - 0.2 서버의 macbook 캐시 확인: `curl -s http://localhost:3097/api/enrichment/macbook | jq '.timeline'`
  - 0.2 서버에 등록된 machines 확인: `curl -s http://localhost:3097/api/machines | jq '.machines'`
  - **결과에 따라 Task 4의 방향이 결정됨**:
    - Agent 도달 불가 → Docker 네트워킹 또는 방화벽 문제
    - Agent 도달 가능 + data 빈 배열 → opencode.db 경로 또는 DB 내용 문제
    - Agent 도달 가능 + data 있음 → 서버 캐시 또는 프론트엔드 문제

  **Must NOT do**:
  - opencode.db에 쓰기 금지 (읽기 전용)
  - agent 코드 수정 (이 task는 진단만)
  - machines.yml 변경 (gitignore 확인 완료)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: SSH + curl 명령어 실행만으로 구성된 진단 작업
  - **Skills**: []
    - 별도 스킬 불필요 (bash 명령어만 사용)

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 2와 병렬)
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/machines.yml` — 현재 등록된 머신 설정 (macbook: 192.168.0.63:3101, apiKey: test-local-key)
  - `server/docker-compose.yml:8-9` — Docker extra_hosts 설정 (host.docker.internal:host-gateway)

  **API References**:
  - `agent/src/server.ts:357-365` — Agent timeline enrichment 엔드포인트 (`GET /api/enrichment/timeline`)
  - `server/src/modules/enrichment/index.ts:113-141` — Server의 pollFeature() 로직 (실패 시 warn 로그)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: MacBook agent 직접 연결 확인
    Tool: Bash (SSH + curl)
    Preconditions: 0.2 서버에 SSH 접속 가능
    Steps:
      1. `ssh sbbae@192.168.0.2`
      2. `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer test-local-key" http://192.168.0.63:3101/health`
      3. Assert HTTP status code
    Expected Result: 200 OK → agent 접근 가능 / connection refused or timeout → 네트워크 문제
    Evidence: .sisyphus/evidence/task-1-macbook-health.txt

  Scenario: Docker 컨테이너 내부에서 MacBook agent 접근
    Tool: Bash (docker exec)
    Preconditions: session-dashboard Docker 컨테이너 실행 중
    Steps:
      1. `docker exec session-dashboard wget -qO- --timeout=5 http://192.168.0.63:3101/health 2>&1`
      2. Assert response or error
    Expected Result: 성공 시 health JSON / 실패 시 "Connection timed out" 또는 유사 에러
    Evidence: .sisyphus/evidence/task-1-docker-connectivity.txt

  Scenario: MacBook agent timeline 데이터 확인
    Tool: Bash (curl + jq)
    Preconditions: MacBook agent 접근 가능
    Steps:
      1. `curl -s -H "Authorization: Bearer test-local-key" http://192.168.0.63:3101/api/enrichment/timeline | jq '{available: .available, count: (.data | length), sample: .data[0]}'`
    Expected Result: available=true, count > 0, sample에 sessionId/sessionTitle 포함
    Evidence: .sisyphus/evidence/task-1-macbook-timeline-data.json

  Scenario: 서버 enrichment 캐시 상태 확인
    Tool: Bash (curl + jq)
    Preconditions: 0.2 서버의 대시보드 서버 실행 중
    Steps:
      1. `curl -s http://localhost:3097/api/enrichment/macbook | jq '{timeline_available: .timeline.available, timeline_count: (.timeline.data | length), lastUpdated}'`
      2. `curl -s http://localhost:3097/api/machines | jq '.machines[] | {id, alias, status}'`
    Expected Result: macbook 머신의 캐시 상태와 연결 상태 확인
    Evidence: .sisyphus/evidence/task-1-server-cache-status.json
  ```

  **Evidence to Capture:**
  - [ ] task-1-macbook-health.txt — agent health 응답
  - [ ] task-1-docker-connectivity.txt — Docker 내부 연결 결과
  - [ ] task-1-macbook-timeline-data.json — agent timeline 데이터 샘플
  - [ ] task-1-server-cache-status.json — 서버 캐시 상태
  - [ ] task-1-diagnosis-summary.md — 진단 요약 및 Task 4 방향 결정

  **Commit**: NO (진단만, 코드 변경 없음)

---

- [x] 2. Server Enrichment 병합 타입 정의

  **What to do**:
  - `server/src/modules/enrichment/types.ts`에 병합 응답 타입 추가
  - 기존 `TimelineEntry`, `SessionCodeImpact`, `ProjectSummary`, `RecoveryContext`, `TokensData` 인터페이스는 변경 불가 (agent 측 타입)
  - 서버 전용 확장 타입 정의:
    ```typescript
    // 서버에서 병합 시 machineId를 주입한 타입
    export interface MergedTimelineEntry extends TimelineEntry {
      machineId: string;
      machineAlias: string;
    }
    export interface MergedSessionCodeImpact extends SessionCodeImpact {
      machineId: string;
      machineAlias: string;
    }
    export interface MergedRecoveryContext extends RecoveryContext {
      machineId: string;
      machineAlias: string;
    }
    export interface MergedProjectSummary extends ProjectSummary {
      machineId: string;
      machineAlias: string;
    }
    // TokensData는 배열이 아니라 aggregate 객체이므로 별도 병합 타입:
    export interface MergedTokensData {
      machines: Array<{ machineId: string; machineAlias: string; data: TokensData }>;
      grandTotal: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheCreationTokens: number;
        totalCacheReadTokens: number;
        totalCost: number;
      };
    }
    // 범용 병합 응답 타입
    export interface MergedEnrichmentResponse<T> {
      data: T;
      available: boolean;
      machineCount: number;
      cachedAt: number;
    }
    ```
  - `EnrichmentModule`에서 사용할 병합 메서드 시그니처 정의

  **Must NOT do**:
  - agent/src의 기존 타입 변경 불가 (TimelineEntry 등)
  - 기존 `EnrichmentResponse<T>` 타입 변경 불가
  - 범용 merge 프레임워크 생성 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 정의만으로 구성된 작은 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 1과 병렬)
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3, Task 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/enrichment/types.ts` — 기존 enrichment 타입 정의 (EnrichmentResponse, EnrichmentCache, TimelineEntry 등)
  - `server/src/machines/machine-manager.ts:533-574` — `pollAllQueries()` 패턴: 머신별 데이터에 machineId 태깅
  - `server/src/machines/machine-manager.ts:578-629` — `pollSessionDetails()` 패턴: machineId 주입 방식

  **API/Type References**:
  - `agent/src/opencode-db-reader.ts:94-103` — TimelineEntry 인터페이스 원본 (변경 금지)
  - `agent/src/opencode-db-reader.ts:29-51` — TokensData 인터페이스 (grandTotal 구조)
  - `agent/src/opencode-db-reader.ts:53-64` — SessionCodeImpact 인터페이스

  **WHY Each Reference Matters**:
  - `types.ts` — 기존 타입을 extends하여 새 Merged* 타입 생성
  - `machine-manager.ts` — 서버사이드 병합 시 machineId 주입 패턴 참고
  - `opencode-db-reader.ts` — agent 측 원본 타입 확인 (변경 불가 제약 확인용)

  **Acceptance Criteria**:

  - [ ] `server/src/modules/enrichment/types.ts`에 Merged* 타입 추가됨
  - [ ] TypeScript 컴파일 에러 없음: `cd server && npx tsc --noEmit`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 타입 컴파일 확인
    Tool: Bash
    Preconditions: server 디렉토리에서 npm install 완료
    Steps:
      1. `cd server && npx tsc --noEmit 2>&1`
      2. Assert exit code 0
    Expected Result: 컴파일 에러 없음
    Failure Indicators: "error TS" 출력
    Evidence: .sisyphus/evidence/task-2-tsc-check.txt

  Scenario: 기존 타입 미변경 확인
    Tool: Bash (git diff)
    Preconditions: Task 2 완료 후
    Steps:
      1. `git diff -- agent/src/opencode-db-reader.ts`
      2. Assert empty output (agent 파일 변경 없음)
    Expected Result: 빈 diff (agent 코드 미변경)
    Evidence: .sisyphus/evidence/task-2-no-agent-change.txt
  ```

  **Commit**: YES (Task 3과 함께)
  - Message: `feat(server): add merged enrichment endpoints for all-machines mode`
  - Files: `server/src/modules/enrichment/types.ts`

- [x] 3. Server EnrichmentModule 병합 엔드포인트 구현

  **What to do**:
  - `server/src/modules/enrichment/index.ts`에 병합 메서드 추가:
    ```typescript
    getMergedFeatureData<T>(feature: EnrichmentFeature): MergedEnrichmentResponse<Array<T & { machineId: string; machineAlias: string }>>
    ```
  - 기존 `MachineManager.pollAllQueries()` 패턴 따르기:
    1. `this.cache` 순회하며 각 머신의 feature 데이터 수집
    2. 각 entry에 `machineId`, `machineAlias` 주입
    3. `startTime` 또는 적절한 시간 필드로 정렬
    4. 머신 연결 실패 시 graceful skip (다른 머신 데이터는 포함)
  - 새 라우트 등록: `GET /api/enrichment/merged/:feature`
    - timeline: TimelineEntry[] → MergedTimelineEntry[] (startTime 정렬)
    - impact: SessionCodeImpact[] → MergedSessionCodeImpact[] (세션 시간 정렬)
    - projects: ProjectSummary[] → MergedProjectSummary[] (sessionCount 내림차순)
    - recovery: RecoveryContext[] → MergedRecoveryContext[] (lastActivity 내림차순)
    - tokens: TokensData → MergedTokensData (machines 배열 + grandTotal 합산)
  - TokensData 병합은 특별 처리 필요:
    - `grandTotal`의 각 필드를 합산
    - `sessions`는 배열 concat + machineId 주입
    - `modelBreakdown`은 모델별로 합산
  - 기존 `GET /api/enrichment/:machineId/:feature` 라우트는 유지 (변경 금지)
  - 테스트 파일 `server/src/__tests__/enrichment-merge.test.ts` 작성:
    - 빈 캐시 시 빈 배열 반환 테스트
    - 단일 머신 데이터 병합 테스트
    - 다수 머신 데이터 병합 + machineId 주입 확인
    - 머신 하나 데이터 없는 경우 나머지만 반환
    - TokensData grandTotal 합산 정확도 테스트

  **Must NOT do**:
  - 기존 per-machine 라우트 수정/제거
  - 기존 캐시 구조 변경
  - 범용 merge 추상화 레이어 생성
  - pollFeature() 로직 변경

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 서버사이드 병합 로직 + 5개 feature 각각의 merge 구현 + 테스트 작성
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 4와 병렬)
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: Task 5, Task 7
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `server/src/machines/machine-manager.ts:533-574` — `pollAllQueries()`: `Promise.allSettled`로 각 머신 데이터 수집 → machineId/machineAlias 태깅 → 배열 합산
  - `server/src/machines/machine-manager.ts:578-629` — `pollSessionDetails()`: 머신별 상세 데이터 수집 + machineId 주입 패턴
  - `server/src/modules/enrichment/index.ts:47-69` — 기존 라우트 등록 패턴 (registerRoutes)
  - `server/src/modules/enrichment/index.ts:113-141` — pollFeature() 내 머신 순회 + 캐시 저장 패턴

  **API/Type References**:
  - `server/src/modules/enrichment/types.ts` — EnrichmentCache, EnrichmentFeature, 각 데이터 타입 + 새로 추가할 Merged* 타입 (Task 2)
  - `agent/src/opencode-db-reader.ts:29-51` — TokensData 구조 (grandTotal, sessions, modelBreakdown 필드)

  **Test References**:
  - `server/src/__tests__/` — 기존 테스트 파일 구조 참고
  - `server/src/machines/machine-manager.ts` 의 머신별 데이터 수집 패턴을 테스트에 mock으로 활용

  **WHY Each Reference Matters**:
  - `pollAllQueries()` — 서버사이드 병합의 정확한 패턴 (Promise.allSettled + machineId 태깅)
  - `EnrichmentCache` — 캐시에서 데이터를 읽는 방법
  - `TokensData` — grandTotal 합산 시 어떤 필드를 합산해야 하는지

  **Acceptance Criteria**:

  - [ ] `GET /api/enrichment/merged/timeline` 응답에 machineId, machineAlias 포함
  - [ ] `GET /api/enrichment/merged/tokens` 응답에 grandTotal 합산값 포함
  - [ ] 기존 `GET /api/enrichment/:machineId/timeline` 라우트 정상 작동
  - [ ] enrichment-merge.test.ts 테스트 모두 통과

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 병합 timeline 엔드포인트 정상 응답
    Tool: Bash (curl + jq)
    Preconditions: 서버 로컬 실행 중, 최소 1개 머신 데이터 캐시됨
    Steps:
      1. `curl -s http://localhost:3097/api/enrichment/merged/timeline | jq '{available: .available, machineCount: .machineCount, dataCount: (.data | length), firstEntry: .data[0] | {sessionId, machineId, machineAlias}}'`
      2. Assert available === true
      3. Assert machineCount >= 1
      4. Assert firstEntry.machineId 존재
    Expected Result: `{ available: true, machineCount: 1+, dataCount: N, firstEntry: { sessionId: "...", machineId: "macbook", machineAlias: "MacBook Pro" } }`
    Evidence: .sisyphus/evidence/task-3-merged-timeline.json

  Scenario: 병합 tokens 엔드포인트 grandTotal 합산
    Tool: Bash (curl + jq)
    Preconditions: 서버 로컬 실행 중
    Steps:
      1. `curl -s http://localhost:3097/api/enrichment/merged/tokens | jq '{available: .available, grandTotal: .data.grandTotal, machineCount: .data.machines | length}'`
    Expected Result: grandTotal에 totalCost, totalInputTokens 등 합산값 포함
    Evidence: .sisyphus/evidence/task-3-merged-tokens.json

  Scenario: 기존 per-machine 라우트 미영향 확인
    Tool: Bash (curl + jq)
    Preconditions: 서버 로컬 실행 중
    Steps:
      1. `curl -s http://localhost:3097/api/enrichment/macbook/timeline | jq '.available'`
      2. Assert response 형식이 변경 전과 동일
    Expected Result: 기존 EnrichmentResponse<TimelineEntry[]> 형식 유지
    Evidence: .sisyphus/evidence/task-3-per-machine-unchanged.json

  Scenario: 머신 하나 캐시 없을 때 graceful 처리
    Tool: Bash (unit test)
    Preconditions: enrichment-merge.test.ts 존재
    Steps:
      1. `cd server && npx vitest run src/__tests__/enrichment-merge.test.ts`
      2. Assert "머신 하나 캐시 없음" 테스트 통과
    Expected Result: 모든 테스트 PASS
    Evidence: .sisyphus/evidence/task-3-merge-tests.txt
  ```

  **Commit**: YES
  - Message: `feat(server): add merged enrichment endpoints for all-machines mode`
  - Files: `server/src/modules/enrichment/index.ts`, `server/src/modules/enrichment/types.ts`, `server/src/__tests__/enrichment-merge.test.ts`
  - Pre-commit: `cd server && npm test`

---

- [x] 4. MacBook 특정 문제 수정 (Task 1 진단 결과에 따라)

  **What to do**:
  - **Task 1 진단 결과에 따라 분기**:
  
  - **Case A: Docker 컨테이너에서 MacBook agent 접근 불가**
    - Docker 네트워크 설정 확인 (`docker-compose.yml`)
    - `machines.yml`의 host 값을 MacBook의 실제 IP(192.168.0.63)로 확인
    - 0.2 서버에서 MacBook 3101 포트 방화벽 확인
    - 필요시 Docker `network_mode: host` 또는 추가 `extra_hosts` 설정
  
  - **Case B: Agent 접근 가능하지만 timeline 데이터 빈 배열**
    - MacBook agent의 OPENCODE_DB_PATH 확인: `cat agent/.env | grep OPENCODE_DB_PATH`
    - DB 파일 존재 여부: `ls -la <DB_PATH>`
    - DB에 세션 데이터 존재 여부: `sqlite3 <DB_PATH> "SELECT count(*) FROM session;"`
    - DB 경로가 잘못되었다면 agent `.env` 수정 후 재시작
  
  - **Case C: 서버 캐시에 데이터가 있지만 프론트엔드에서 안 보임**
    - 브라우저 콘솔 에러 확인
    - `fetchTimelineData()` 호출 시 machineId 값 확인
    - 서버 응답 형식과 프론트엔드 파싱 일치 여부 확인

  **Must NOT do**:
  - opencode.db에 쓰기 금지
  - 문제 원인과 무관한 코드 수정

  **Recommended Agent Profile**:
  - **Category**: `quick` (Case A/B) 또는 `deep` (Case C)
    - Reason: 설정 문제면 quick, 코드 디버깅이면 deep
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 3과 병렬)
  - **Parallel Group**: Wave 2 (with Task 3)
  - **Blocks**: Task 7
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `agent/.env` — OPENCODE_DB_PATH 설정 확인
  - `agent/src/index.ts:53` — agent listen 설정 (host: '0.0.0.0')
  - `server/docker-compose.yml:8-9` — Docker extra_hosts 설정

  **API References**:
  - `agent/src/server.ts:357-365` — timeline enrichment 엔드포인트
  - `agent/src/opencode-db-reader.ts:404-439` — getSessionTimeline() SQL 쿼리

  **WHY Each Reference Matters**:
  - `.env` — OPENCODE_DB_PATH가 정확한지 확인하는 첫 번째 체크포인트
  - `docker-compose.yml` — 네트워크 접근 문제 시 Docker 설정 확인용
  - `getSessionTimeline()` — 빈 결과가 SQL 쿼리 문제인지 확인용

  **Acceptance Criteria**:

  - [ ] MacBook agent에서 timeline 데이터가 정상 반환됨
  - [ ] 서버 enrichment 캐시에 macbook timeline 데이터 존재

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: MacBook agent timeline 데이터 정상 반환
    Tool: Bash (curl + jq)
    Preconditions: Task 4 수정 적용 후
    Steps:
      1. `curl -s -H "Authorization: Bearer test-local-key" http://192.168.0.63:3101/api/enrichment/timeline | jq '{available: .available, count: (.data | length)}'`
      2. Assert available === true AND count > 0
    Expected Result: `{ available: true, count: N }` (N > 0)
    Evidence: .sisyphus/evidence/task-4-macbook-timeline-fixed.json

  Scenario: 서버 캐시에 macbook 데이터 반영
    Tool: Bash (curl + jq)
    Preconditions: 서버 실행 중, 폴링 완료 (10초 대기)
    Steps:
      1. `sleep 15 && curl -s http://localhost:3097/api/enrichment/macbook/timeline | jq '{available: .available, count: (.data | length)}'`
      2. Assert count > 0
    Expected Result: 서버 캐시에 macbook timeline 데이터 존재
    Evidence: .sisyphus/evidence/task-4-server-cache-macbook.json
  ```

  **Commit**: YES
  - Message: `fix(agent/server): resolve MacBook timeline data issue`
  - Files: (진단 결과에 따라 결정)

- [x] 5. Frontend Enrichment Store "전체" 모드 병합 로직

  **What to do**:
  - `server/frontend/src/lib/stores/enrichment.ts` 수정:
    1. `resolveEnrichmentMachineId()` 함수 로직 변경:
       - 특정 머신 선택 시: 기존대로 해당 machineId 반환
       - "전체" 모드 시: `null` 반환 (기존과 동일)
    2. 각 fetch 함수에서 machineId가 null일 때 병합 엔드포인트 호출:
       - `fetchTimelineData()`: machineId가 null이면 `/api/enrichment/merged/timeline` 호출
       - `fetchTokenData()`: `/api/enrichment/merged/tokens`
       - `fetchImpactData()`: `/api/enrichment/merged/impact`
       - `fetchProjectsData()`: `/api/enrichment/merged/projects`
       - `fetchRecoveryData()`: `/api/enrichment/merged/recovery`
       - machineId가 있으면 기존 `/api/enrichment/${machineId}/${feature}` 유지
    3. 응답 타입 처리:
       - 병합 응답은 `MergedEnrichmentResponse<T>` → `data` 필드 추출
       - per-machine 응답은 기존 `EnrichmentResponse<T>` → `data` 필드 추출
       - 두 경로 모두 같은 store 변수에 저장 (타입 호환)
  - 프론트엔드 enrichment 타입 정의 업데이트 필요 시 추가 (MergedTimelineEntry 등)

  **Must NOT do**:
  - 기존 fetch 함수의 인터페이스(파라미터, 반환타입) 변경
  - 다른 store 파일 수정
  - 새로운 store 파일 생성

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: enrichment store의 5개 fetch 함수 수정 + 타입 처리
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 6, Task 7
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/enrichment.ts:5-10` — `resolveEnrichmentMachineId()` 현재 로직 (첫 번째 머신 fallback)
  - `server/frontend/src/lib/stores/enrichment.ts:156-176` — `fetchTimelineData()` 현재 구현
  - `server/frontend/src/lib/stores/machine.svelte.ts` — `getSelectedMachineId()`, `getMachines()` 함수

  **API/Type References**:
  - Task 2에서 정의한 서버 Merged* 타입 — 프론트엔드에서 동일 타입 정의 필요
  - `server/src/modules/enrichment/types.ts` — MergedEnrichmentResponse, MergedTimelineEntry 등

  **WHY Each Reference Matters**:
  - `resolveEnrichmentMachineId()` — "전체" 모드 감지 로직의 핵심
  - `fetchTimelineData()` — 병합 분기의 구현 위치
  - `machine.svelte.ts` — 선택된 머신 ID를 어떻게 가져오는지

  **Acceptance Criteria**:

  - [ ] "전체" 모드 시 `/api/enrichment/merged/timeline` 호출됨
  - [ ] 특정 머신 선택 시 기존 `/api/enrichment/{machineId}/timeline` 호출됨
  - [ ] 빌드 성공: `cd server/frontend && npm run build`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: "전체" 모드에서 병합 엔드포인트 호출 확인
    Tool: Playwright (playwright skill)
    Preconditions: 로컬 서버 실행 중, 최소 1개 머신 데이터 있음
    Steps:
      1. Navigate to http://localhost:3097
      2. 머신 선택기에서 "전체" 선택
      3. Timeline 탭 클릭
      4. 브라우저 Network 탭에서 `/api/enrichment/merged/timeline` 요청 확인
      5. Assert: 요청 응답에 `machineId` 필드가 포함된 데이터
    Expected Result: 병합 엔드포인트가 호출되고 데이터 반환
    Evidence: .sisyphus/evidence/task-5-merged-endpoint-called.png

  Scenario: 특정 머신 선택 시 기존 엔드포인트 유지
    Tool: Playwright
    Preconditions: 로컬 서버 실행 중
    Steps:
      1. Navigate to http://localhost:3097
      2. 머신 선택기에서 "MacBook Pro" 선택
      3. Timeline 탭 클릭
      4. Network 탭에서 `/api/enrichment/macbook/timeline` 요청 확인
    Expected Result: per-machine 엔드포인트가 호출됨
    Evidence: .sisyphus/evidence/task-5-per-machine-endpoint.png

  Scenario: 5개 enrichment 페이지 모두 "전체" 모드 정상
    Tool: Playwright
    Preconditions: 로컬 서버 실행 중
    Steps:
      1. 머신 선택기에서 "전체" 선택
      2. Token/Cost 탭 → 데이터 표시 확인
      3. Code Impact 탭 → 데이터 표시 확인
      4. Timeline 탭 → 데이터 표시 확인
      5. Projects 탭 → 데이터 표시 확인
      6. Context Recovery 탭 → 데이터 표시 확인
    Expected Result: 5개 탭 모두 에러 없이 데이터 표시
    Evidence: .sisyphus/evidence/task-5-all-enrichment-pages.png
  ```

  **Commit**: YES (Task 6와 함께)
  - Message: `feat(frontend): implement enrichment data merging for all-machines mode`
  - Files: `server/frontend/src/lib/stores/enrichment.ts`
  - Pre-commit: `cd server && npm run build`

---

- [x] 6. Frontend TimelinePage Swim-Lane 머신 레이블 추가

  **What to do**:
  - `server/frontend/src/components/pages/TimelinePage.svelte` 수정:
    1. "전체" 모드일 때 swim-lane 레이블에 머신 alias 표시
       - 현재: `{session.sessionTitle.slice(0, 20)}`
       - 변경: "전체" 모드에서는 `{session.machineAlias}: {session.sessionTitle.slice(0, 15)}` 형식
       - 특정 머신 선택 시에는 기존대로 sessionTitle만 표시
    2. Swim-lane 색상으로 머신 구분 (선택적):
       - 머신별로 약간 다른 색상 tone 적용 (기존 status 색상 유지하되 opacity나 border로 구분)
    3. 머신 레이블 스타일:
       - 작은 badge 형태로 머신 alias 표시
       - CSS 변수 활용 (Tailwind 금지)

  **Must NOT do**:
  - Timeline swim-lane 레이아웃 전체 재설계
  - 새로운 CSS 라이브러리 도입
  - Tailwind 사용
  - 다른 enrichment 페이지 UI 수정 (이 task는 Timeline만)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI 컴포넌트 수정 + CSS 스타일링
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (Task 5 후)
  - **Parallel Group**: Wave 3 (Task 5 이후)
  - **Blocks**: Task 7
  - **Blocked By**: Task 5

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/TimelinePage.svelte:86-94` — 현재 swim-lane 레이블 렌더링
  - `server/frontend/src/components/pages/TimelinePage.svelte:120-133` — SVG swim-lane 블록 렌더링
  - `server/frontend/src/components/pages/TimelinePage.svelte:149-197` — 현재 CSS 스타일

  **API/Type References**:
  - `MergedTimelineEntry` (Task 2) — `machineId`, `machineAlias` 필드
  - `server/frontend/src/lib/stores/machine.svelte.ts` — `getSelectedMachineId()` (null이면 "전체" 모드)

  **WHY Each Reference Matters**:
  - 현재 swim-lane 코드를 이해하고 최소한의 변경으로 머신 레이블 추가
  - `getSelectedMachineId()` — "전체" 모드 감지에 사용

  **Acceptance Criteria**:

  - [ ] "전체" 모드에서 swim-lane 레이블에 머신 alias 포함
  - [ ] 특정 머신 선택 시 기존대로 sessionTitle만 표시
  - [ ] CSS 변수만 사용 (Tailwind 미사용)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: "전체" 모드 swim-lane 머신 레이블 표시
    Tool: Playwright (playwright skill)
    Preconditions: 서버 실행 중, 최소 1개 머신에 timeline 데이터 있음
    Steps:
      1. Navigate to http://localhost:3097
      2. "전체" 모드 선택
      3. Timeline 탭 클릭
      4. `.lane-label` 요소 텍스트 확인
      5. Assert: 레이블에 머신 alias 포함 (예: "MacBook Pro: session-title...")
    Expected Result: swim-lane 레이블에 "{machineAlias}: {sessionTitle}" 형식
    Evidence: .sisyphus/evidence/task-6-machine-label-all-mode.png

  Scenario: 특정 머신 선택 시 기존 레이블 유지
    Tool: Playwright
    Preconditions: 서버 실행 중
    Steps:
      1. "MacBook Pro" 머신 선택
      2. Timeline 탭 클릭
      3. `.lane-label` 요소 텍스트 확인
      4. Assert: 레이블에 머신 alias 미포함, sessionTitle만
    Expected Result: 기존대로 "{sessionTitle}" 형식
    Evidence: .sisyphus/evidence/task-6-machine-label-single-mode.png
  ```

  **Commit**: YES (Task 5와 함께)
  - Message: `feat(frontend): implement enrichment data merging for all-machines mode`
  - Files: `server/frontend/src/components/pages/TimelinePage.svelte`

---

- [x] 7. 빌드 + 테스트 + 192.168.0.2 배포 + 브라우저 QA

  **What to do**:
  - 로컬 빌드 확인:
    1. `cd server && npm run build` — 빌드 성공 확인
    2. `cd server && npm test` — 전체 테스트 통과 확인
  - 192.168.0.2 배포:
    ```bash
    ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && docker compose build --no-cache && docker compose up -d --force-recreate"
    ```
  - 배포 후 브라우저 QA:
    1. http://192.168.0.2:3097 접속
    2. "전체" 모드에서 Timeline 데이터 확인 (모든 머신 데이터 병합)
    3. "MacBook Pro" 선택 시 Timeline 데이터 확인 (이전에 "데이터 없음"이던 것)
    4. 5개 enrichment 탭 모두 정상 확인
    5. 기존 기능 (Active Sessions, Recent Prompts) 정상 확인

  **Must NOT do**:
  - 소스 코드 수정 (이 task는 빌드/배포/QA만)
  - 0.2 서버의 agent/machines.yml 수동 수정

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 빌드 + 배포 + 종합 QA는 여러 단계 검증 필요
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (마지막)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 5, Task 6

  **References**:

  **Pattern References**:
  - 배포 명령어: `ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && docker compose build --no-cache && docker compose up -d --force-recreate"`

  **Acceptance Criteria**:

  - [ ] `cd server && npm run build` → 빌드 성공
  - [ ] `cd server && npm test` → 모든 테스트 통과
  - [ ] 192.168.0.2 배포 성공 (docker container 실행 중)
  - [ ] http://192.168.0.2:3097에서 "전체" 모드 5개 enrichment 탭 데이터 표시
  - [ ] http://192.168.0.2:3097에서 "MacBook Pro" 선택 시 Timeline 데이터 표시

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 로컬 빌드 + 테스트 통과
    Tool: Bash
    Steps:
      1. `cd server && npm run build 2>&1`
      2. Assert exit code 0
      3. `cd server && npm test 2>&1`
      4. Assert all tests pass
    Expected Result: 빌드 성공, 테스트 전부 통과
    Evidence: .sisyphus/evidence/task-7-build-test.txt

  Scenario: 192.168.0.2 배포 성공
    Tool: Bash (SSH)
    Steps:
      1. 배포 명령어 실행
      2. `ssh sbbae@192.168.0.2 "docker ps --filter name=session-dashboard --format '{{.Status}}'"` 
      3. Assert: "Up" 상태
    Expected Result: 컨테이너 실행 중
    Evidence: .sisyphus/evidence/task-7-deploy-status.txt

  Scenario: "전체" 모드 Timeline 병합 확인 (192.168.0.2)
    Tool: Playwright (playwright skill)
    Preconditions: 배포 완료
    Steps:
      1. Navigate to http://192.168.0.2:3097
      2. 머신 선택기에서 "전체" 선택
      3. Timeline 탭 클릭
      4. `[data-testid="timeline-svg"]` 존재 확인
      5. `[data-testid="swim-lane"]` 개수 > 0 확인
      6. Screenshot 캡처
    Expected Result: Timeline SVG에 swim-lane 표시됨
    Evidence: .sisyphus/evidence/task-7-deployed-timeline-all.png

  Scenario: "MacBook Pro" 선택 시 Timeline 데이터 표시 (192.168.0.2)
    Tool: Playwright
    Steps:
      1. Navigate to http://192.168.0.2:3097
      2. 머신 선택기에서 "MacBook Pro" 선택
      3. Timeline 탭 클릭
      4. `[data-testid="empty-state"]`가 보이지 않아야 함
      5. `[data-testid="timeline-svg"]` 존재 확인
    Expected Result: "타임라인 데이터 없음" 대신 실제 Timeline 표시
    Failure Indicators: `[data-testid="empty-state"]` 요소 존재
    Evidence: .sisyphus/evidence/task-7-deployed-timeline-macbook.png

  Scenario: 5개 enrichment 탭 "전체" 모드 확인
    Tool: Playwright
    Steps:
      1. Navigate to http://192.168.0.2:3097
      2. "전체" 모드 선택
      3. Token/Cost → 데이터 표시 확인, Screenshot
      4. Code Impact → 데이터 표시 확인, Screenshot
      5. Timeline → 데이터 표시 확인 (이미 위에서 확인)
      6. Projects → 데이터 표시 확인, Screenshot
      7. Context Recovery → 데이터 표시 확인, Screenshot
    Expected Result: 5개 탭 모두 에러 메시지 없이 데이터 표시
    Evidence: .sisyphus/evidence/task-7-all-enrichment-tabs.png
  ```

  **Commit**: NO (배포/QA만, 소스 변경 없음)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `npm test` in server/. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (features working together, not isolation). Test edge cases: empty state, invalid input, rapid actions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Commit 1** (Task 1): `chore(ops): diagnose MacBook agent connectivity and timeline data` — diagnostic output only
- **Commit 2** (Task 2+3): `feat(server): add merged enrichment endpoints for all-machines mode` — server/src/modules/enrichment/
- **Commit 3** (Task 4): `fix(agent/server): resolve MacBook timeline data issue` — depends on diagnostic findings
- **Commit 4** (Task 5+6): `feat(frontend): implement enrichment data merging for all-machines mode` — server/frontend/src/
- **Commit 5** (Task 7): `chore(deploy): build, test, and deploy to 192.168.0.2` — no source changes

---

## Success Criteria

### Verification Commands
```bash
# Server 병합 엔드포인트
curl -s http://localhost:3097/api/enrichment/merged/timeline | jq '.data | length'  # Expected: > 0

# MacBook 개별 엔드포인트
curl -s http://localhost:3097/api/enrichment/macbook/timeline | jq '.available'  # Expected: true

# 테스트
cd server && npm test  # Expected: all pass

# 빌드
cd server && npm run build  # Expected: success

# 192.168.0.2 배포 후
curl -s http://192.168.0.2:3097/api/enrichment/merged/timeline | jq '.data | length'  # Expected: > 0
```

### Final Checklist
- [ ] MacBook Pro 선택 시 Timeline에 데이터 표시
- [ ] "전체" 모드에서 모든 머신의 Timeline 데이터 병합 표시
- [ ] "전체" 모드에서 5개 enrichment 페이지 모두 정상
- [ ] 머신 하나 불가 시 나머지 머신 데이터 정상 표시
- [ ] 기존 per-machine 라우트 정상 작동
- [ ] 192.168.0.2 배포 완료
- [ ] 모든 테스트 통과
