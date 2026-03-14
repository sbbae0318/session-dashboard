# Fix Session Status Stale Data Propagation Chain

## TL;DR

> **Quick Summary**: Agent→Server→Frontend 3계층에 걸친 stale 데이터 전파 체인을 수정. SSE 재연결 gap 중 잘못된 상태 반환, bootstrap race condition, 서버 폴링 불일치 3건의 CRITICAL 버그 해결.
> 
> **Deliverables**:
> - Agent `/proxy/session/details` 응답에 SSE 연결 상태 메타데이터 추가
> - Bootstrap race condition 해소 (timestamp 기반 조건부 skip)
> - Server 폴링에서 staleness-aware merge 로직 구현
> - 각 버그별 단위 테스트 추가
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 3 → Task 5 → Task 6 → F1-F4

---

## Context

### Original Request
세션 상태 모니터링이 정상 작동하다가 간헐적으로 잘못된 상태로 나오는 반복 버그 수정. Fallback 로직과 폴링 문제 의심.

### Interview Summary
**Key Discussions**:
- 분석 결과 3개 CRITICAL 버그가 "stale data propagation chain" 형성
- Bug 1: Agent SSE 끊김 시 stale 캐시를 신선도 표시 없이 반환
- Bug 2: Bootstrap REST 데이터가 더 신선한 SSE 이벤트를 덮어씀
- Bug 3: Server가 session list와 details를 별도 시점에 폴링 → 불일치

**Research Findings**:
- Agent SSE 재연결 exponential backoff: 1s → 30s max
- Bootstrap은 `void this.bootstrap()`로 fire-and-forget
- Server 2초 간격 폴링, `Promise.allSettled`로 병렬 실행
- 기존 테스트 인프라: vitest, agent 200개+ / server 142개+ 테스트

### Metis Review
**Identified Gaps** (addressed):
- `CachedSessionDetail` 인터페이스 변경 시 server import 동기화 필요 → Task 3에 포함
- `existing === null` (첫 부팅) 시 bootstrap skip 방지 필요 → Task 1 acceptance criteria에 포함
- Bootstrap 중 재연결 시 early return 필요 → Task 1에 edge case 처리 포함
- 다중 agent 환경에서 per-agent staleness 처리 → Task 3에 포함

---

## Work Objectives

### Core Objective
SSE 재연결 gap, bootstrap race, 폴링 불일치로 인한 간헐적 세션 상태 오류를 제거하여, 대시보드가 항상 정확한 세션 상태를 표시하도록 한다.

### Concrete Deliverables
- `agent/src/session-cache.ts` — sseConnectedAt 캡처 + bootstrap 조건부 skip + 응답 메타데이터
- `agent/src/session-store.ts` — (변경 없음, 기존 유지)
- `server/src/machines/machine-manager.ts` — `CachedSessionDetail` 인터페이스 확장 + `fetchSessionDetails` 파싱 변경
- `server/src/modules/active-sessions/index.ts` — staleness-aware merge 로직
- 테스트 파일 4개 수정/추가

### Definition of Done
- [x] `cd agent && npm test -- --run` → 0 failures
- [x] `cd server && npm test -- --run` → 0 failures
- [x] `cd agent && npx tsc --noEmit` → 0 errors
- [x] `cd server && npx tsc --noEmit` → 0 errors
- [x] SSE 연결 중: `/proxy/session/details` 응답에 `meta.sseConnected: true` 포함
- [x] SSE 끊김 중: 서버가 해당 agent의 캐시 데이터를 fallback 처리
- [x] Bootstrap이 SSE 이벤트보다 오래된 데이터로 캐시를 덮어쓰지 않음

### Must Have
- Agent가 SSE 연결 상태를 `/proxy/session/details` 응답에 포함
- Bootstrap race condition에서 최신 SSE 데이터가 보존됨
- Server가 stale agent 데이터를 감지하고 fallback 처리
- 모든 기존 테스트 통과 (회귀 없음)
- 각 버그별 최소 2개 신규 테스트

### Must NOT Have (Guardrails)
- 프론트엔드 코드 변경 (ActiveSessions.svelte, sse-client.ts 등)
- `DashboardSession` 타입 변경
- SSE 재연결 전략 변경 (exponential backoff 유지)
- Grace period 로직 변경
- TUI 클라이언트 수정
- `updatedAt` 필드 의미 변경
- 기존 테스트 삭제/수정

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after)
- **Framework**: vitest (agent/, server/)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Backend**: Use Bash (curl + npm test) — Send requests, assert status + response fields
- **Library/Module**: Use Bash (node REPL or npm test) — Run tests, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — Agent 수정, 독립적):
├── Task 1: Bug 2 — Bootstrap race condition 해소 [deep]
├── Task 2: Bug 2 테스트 추가 [quick]

Wave 2 (After Wave 1 — Agent 응답 확장 + Server 수정):
├── Task 3: Bug 1 — Agent staleness 메타데이터 + Server 인터페이스 동기화 [deep]
├── Task 4: Bug 1 테스트 추가 [quick]

Wave 3 (After Wave 2 — Server merge 로직):
├── Task 5: Bug 3 — Server staleness-aware merge [deep]
├── Task 6: Bug 3 테스트 + 전체 회귀 검증 [unspecified-high]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
├── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 3 → Task 5 → Task 6 → F1-F4
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 2 (Waves 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2, 3 | 1 |
| 2 | 1 | 3 | 1 |
| 3 | 1, 2 | 4, 5 | 2 |
| 4 | 3 | 5 | 2 |
| 5 | 3, 4 | 6 | 3 |
| 6 | 5 | F1-F4 | 3 |
| F1-F4 | 6 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `deep`, T2 → `quick`
- **Wave 2**: 2 tasks — T3 → `deep`, T4 → `quick`
- **Wave 3**: 2 tasks — T5 → `deep`, T6 → `unspecified-high`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

- [x] 1. Bug 2 — Bootstrap Race Condition 해소 (sseConnectedAt 기반)

  **What to do**:
  - `agent/src/session-cache.ts`에 `private sseConnectedAt: number = 0` 인스턴스 필드 추가
  - `connectSse()` 내 `this.connectionState = 'connected'` 직후(line 166)에 `this.sseConnectedAt = Date.now()` 추가
  - `bootstrapProject()` 내 upsert 로직(line 436-444) 수정:
    - `const existing = this.store.get(sessionID)` 후
    - `if (existing && existing.updatedAt >= this.sseConnectedAt)` → skip (SSE가 이미 더 신선한 데이터 제공)
    - `if (!existing)` → 무조건 upsert (첫 부팅 시나리오 보호)
  - `bootstrap()` 내에서 각 `bootstrapProject()` 호출 전 `this.connectionState !== 'connected'`이면 early return
  - `sseConnectedAt` 값을 외부에서 읽을 수 있도록 `getSseConnectedAt(): number` getter 추가

  **Must NOT do**:
  - `void this.bootstrap()`를 `await this.bootstrap()`로 변경 금지
  - `updatedAt` 필드의 의미 변경 금지
  - 기존 `lastPrompt/lastPromptTime/currentTool` 보존 로직 변경 금지
  - SSE 재연결 전략(exponential backoff) 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 2, Task 3
  - **Blocked By**: None

  **References**:
  - `agent/src/session-cache.ts:159-192` — `connectSse()`: SSE 연결, connectionState 설정, bootstrap() 호출 위치
  - `agent/src/session-cache.ts:426-446` — `bootstrapProject()`: 현재 upsert 로직, existing 보존 패턴
  - `agent/src/session-cache.ts:405-424` — `bootstrap()`: 프로젝트별 status fetch
  - `agent/src/session-cache.ts:290-303` — `handleSessionStatus()`: SSE 이벤트로 캐시 업데이트 패턴
  - `agent/src/session-cache.ts:19-26` — `SessionDetail` 인터페이스
  - `agent/src/session-cache.ts:84-93` — `defaultSessionDetail()`: 새 세션 기본값

  **Acceptance Criteria**:

  ```
  Scenario: Bootstrap이 SSE보다 오래된 데이터로 덮어쓰지 않음
    Tool: Bash (npm test)
    Steps: cd agent && npm test -- --run -t "bootstrap.*skip"
    Expected: PASS — SSE로 busy된 세션이 bootstrap의 idle로 덮어쓰이지 않음
    Evidence: .sisyphus/evidence/task-1-bootstrap-skip.txt

  Scenario: 첫 부팅 시 bootstrap 데이터 정상 수용
    Tool: Bash (npm test)
    Steps: cd agent && npm test -- --run -t "bootstrap.*first"
    Expected: PASS — 캐시 비어있을 때 bootstrap 데이터 정상 저장
    Evidence: .sisyphus/evidence/task-1-bootstrap-first-boot.txt

  Scenario: Bootstrap 중 SSE 재disconnect 시 early return
    Tool: Bash (npm test)
    Steps: cd agent && npm test -- --run -t "bootstrap.*disconnect"
    Expected: bootstrap 중단, stale 데이터 미기록
    Evidence: .sisyphus/evidence/task-1-bootstrap-disconnect.txt
  ```

  **Commit**: YES (groups with Task 2)
  - Message: `fix(agent): resolve bootstrap race condition with timestamp-based skip`
  - Files: `agent/src/session-cache.ts`
  - Pre-commit: `cd agent && npm test -- --run`

- [x] 2. Bug 2 — Bootstrap Race Condition 테스트 추가

  **What to do**:
  - `agent/src/__tests__/session-cache.test.ts`에 테스트 추가 (기존 패턴 따름)
  - 테스트 3개: bootstrap skip, first boot, disconnect during bootstrap
  - 기존 헬퍼 활용: `createMockResponse()`, `simulateSseEvent()`, `flushPromises()`

  **Must NOT do**:
  - 기존 테스트 수정/삭제 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential with Task 1)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1

  **References**:
  - `agent/src/__tests__/session-cache.test.ts` — 기존 테스트 패턴, mock 헬퍼

  **Acceptance Criteria**:

  ```
  Scenario: 신규 테스트 + 기존 테스트 모두 PASS
    Tool: Bash (npm test)
    Steps: cd agent && npm test -- --run
    Expected: 0 failures
    Evidence: .sisyphus/evidence/task-2-all-tests.txt

  Scenario: tsc 컴파일 에러 없음
    Tool: Bash
    Steps: cd agent && npx tsc --noEmit
    Expected: 에러 0개
    Evidence: .sisyphus/evidence/task-2-tsc.txt
  ```

  **Commit**: YES (groups with Task 1)
  - Message: `fix(agent): resolve bootstrap race condition with timestamp-based skip`
  - Files: `agent/src/session-cache.ts`, `agent/src/__tests__/session-cache.test.ts`

- [x] 3. Bug 1 — Agent Staleness 메타데이터 + Server 인터페이스 동기화

  **What to do**:
  - **Agent** (`agent/src/session-cache.ts`):
    - `getSessionDetails()` 반환값을 `{ meta: SessionDetailsMeta, sessions: Record<string, SessionDetail> }` wrapper로 변경
    - `SessionDetailsMeta` 타입: `{ sseConnected: boolean, lastSseEventAt: number, sseConnectedAt: number }`
    - `private lastSseEventAt: number = 0` 필드 추가, `parseSseChunk()`에서 갱신
    - `/proxy/session/details` 응답 구조 변경
  - **Server** (`server/src/machines/machine-manager.ts`):
    - `fetchSessionDetails()` 파싱 변경: 새 wrapper + 기존 flat 하위 호환
    - `pollSessionDetails()` 반환값에 per-machine `sseConnected` 포함

  **Must NOT do**:
  - `DashboardSession` 타입 변경 금지
  - `/health` 엔드포인트 수정 금지
  - `CachedSessionDetail` 기존 필드 삭제/이름 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 4, Task 5
  - **Blocked By**: Task 1, Task 2

  **References**:
  - `agent/src/session-cache.ts:141-153` — 현재 `getSessionDetails()`, `registerRoutes()`
  - `agent/src/session-cache.ts:145-147` — `getConnectionState()` getter 패턴
  - `server/src/machines/machine-manager.ts:19-30` — `CachedSessionDetail` 인터페이스
  - `server/src/machines/machine-manager.ts:411-416` — `fetchSessionDetails()` REST 파싱
  - `server/src/machines/machine-manager.ts:350-400` — `pollSessionDetails()` 병렬 폴링
  - `server/src/modules/active-sessions/index.ts:4,106` — `CachedSessionDetail` import/사용

  **Acceptance Criteria**:

  ```
  Scenario: Agent 응답에 meta 포함
    Tool: Bash (curl)
    Steps: curl -s http://localhost:3098/proxy/session/details | python3 -c "import sys,json; d=json.load(sys.stdin); print('meta' in d, d.get('meta',{}).get('sseConnected'))"
    Expected: True True
    Evidence: .sisyphus/evidence/task-3-agent-meta.txt

  Scenario: Agent + Server tsc 통과
    Tool: Bash
    Steps: cd agent && npx tsc --noEmit && cd ../server && npx tsc --noEmit
    Expected: 에러 0개
    Evidence: .sisyphus/evidence/task-3-tsc.txt
  ```

  **Commit**: YES (groups with Task 4)
  - Message: `fix(agent,server): add SSE staleness metadata to session details response`
  - Files: `agent/src/session-cache.ts`, `server/src/machines/machine-manager.ts`

- [x] 4. Bug 1 — Staleness 메타데이터 테스트 추가

  **What to do**:
  - Agent 테스트: `/proxy/session/details` meta 필드 포함, sseConnected true/false 검증
  - Server 테스트: `fetchSessionDetails()` 새 wrapper 파싱 검증

  **Must NOT do**: 기존 테스트 수정/삭제 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential with Task 3)
  - **Blocks**: Task 5
  - **Blocked By**: Task 3

  **References**:
  - `agent/src/__tests__/session-cache.test.ts` — 기존 테스트 패턴
  - `server/src/__tests__/machine-manager.test.ts` — 서버 테스트 패턴

  **Acceptance Criteria**:

  ```
  Scenario: 모든 테스트 PASS
    Tool: Bash
    Steps: cd agent && npm test -- --run && cd ../server && npm test -- --run
    Expected: 0 failures 양쪽 모두
    Evidence: .sisyphus/evidence/task-4-all-tests.txt
  ```

  **Commit**: YES (groups with Task 3)
  - Files: `agent/src/__tests__/session-cache.test.ts`, `server/src/__tests__/machine-manager.test.ts`

- [x] 5. Bug 3 — Server Staleness-Aware Merge

  **What to do**:
  - `server/src/modules/active-sessions/index.ts` `buildSessionMap()` 수정:
    - `apiStatus` 결정 로직(line 119-127):
      - `cached && cached.sseConnected` → SSE 캐시 우선 (기존 동작)
      - `cached && !cached.sseConnected` → SSE 캐시 무시, REST fallback
      - `!cached && isActive` → REST 상태 사용 (기존 동작)
    - Orphan 세션 합성(line 157-185): `!cached.sseConnected` → skip

  **Must NOT do**:
  - `Promise.allSettled` 구조 변경 금지
  - `MachineManager` 시그니처 변경 금지
  - `DashboardSession` 타입 변경 금지
  - 프론트엔드 코드 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 6
  - **Blocked By**: Task 3, Task 4

  **References**:
  - `server/src/modules/active-sessions/index.ts:103-188` — `buildSessionMap()` 전체
  - `server/src/modules/active-sessions/index.ts:119-127` — `apiStatus` 우선순위 로직
  - `server/src/modules/active-sessions/index.ts:157-185` — orphan 합성 로직
  - `server/src/modules/active-sessions/index.ts:69-100` — `poll()` Promise.allSettled 구조
  - `server/src/machines/machine-manager.ts:19-30` — `CachedSessionDetail` 인터페이스

  **Acceptance Criteria**:

  ```
  Scenario: sseConnected=false → REST fallback
    Tool: Bash (npm test)
    Steps: cd server && npm test -- --run -t "staleness"
    Expected: apiStatus가 REST fallback 사용
    Evidence: .sisyphus/evidence/task-5-staleness-merge.txt

  Scenario: sseConnected=false → orphan 합성 skip
    Tool: Bash (npm test)
    Steps: cd server && npm test -- --run -t "orphan.*stale"
    Expected: stale 캐시에서 orphan 미합성
    Evidence: .sisyphus/evidence/task-5-orphan-stale.txt

  Scenario: sseConnected=true → 기존 동작 유지
    Tool: Bash (npm test)
    Steps: cd server && npm test -- --run -t "sseConnected.*true"
    Expected: SSE 캐시 우선 사용 (기존과 동일)
    Evidence: .sisyphus/evidence/task-5-sse-connected.txt
  ```

  **Commit**: YES (groups with Task 6)
  - Message: `fix(server): staleness-aware merge in session polling`
  - Files: `server/src/modules/active-sessions/index.ts`

- [x] 6. Bug 3 — Server 테스트 + 전체 회귀 검증 + 배포

  **What to do**:
  - `server/src/__tests__/active-sessions.test.ts`에 staleness merge 테스트 추가
  - 전체 회귀 검증: agent + server tsc + npm test
  - Agent 재빌드/재시작 (로컬 + 원격)
  - Server Docker 재배포

  **Must NOT do**: 기존 테스트 수정/삭제 금지, 프론트엔드 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential with Task 5)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 5

  **References**:
  - `server/src/__tests__/active-sessions.test.ts` — 기존 테스트 패턴
  - `server/src/__tests__/active-sessions-claude.test.ts` — Claude Code 관련 테스트

  **Acceptance Criteria**:

  ```
  Scenario: 전체 테스트 통과
    Tool: Bash
    Steps: cd agent && npm test -- --run && cd ../server && npm test -- --run
    Expected: 0 failures 양쪽 모두
    Evidence: .sisyphus/evidence/task-6-all-tests.txt

  Scenario: tsc 컴파일 통과
    Tool: Bash
    Steps: cd agent && npx tsc --noEmit && cd ../server && npx tsc --noEmit
    Expected: 에러 0개
    Evidence: .sisyphus/evidence/task-6-tsc.txt

  Scenario: 배포 후 API 정상
    Tool: Bash (curl)
    Steps:
      1. curl -s http://localhost:3098/proxy/session/details | python3 -c "import sys,json; d=json.load(sys.stdin); print('sseConnected:', d.get('meta',{}).get('sseConnected'))"
      2. curl -s http://192.168.0.2:3097/api/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print('sessions:', len(d.get('sessions',[])))"
    Expected: sseConnected: True, sessions: N (N >= 0)
    Evidence: .sisyphus/evidence/task-6-api-check.txt
  ```

  **Commit**: YES (groups with Task 5)
  - Message: `fix(server): staleness-aware merge in session polling`
  - Files: `server/src/modules/active-sessions/index.ts`, `server/src/__tests__/active-sessions.test.ts`
  - Pre-commit: `cd agent && npm test -- --run && cd ../server && npm test -- --run`
---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` (agent + server) + `npm test -- --run` (agent + server). Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Commit 1** (after Wave 1): `fix(agent): resolve bootstrap race condition with timestamp-based skip` — session-cache.ts, session-cache.test.ts
- **Commit 2** (after Wave 2): `fix(agent,server): add SSE staleness metadata to session details response` — session-cache.ts, machine-manager.ts, active-sessions tests
- **Commit 3** (after Wave 3): `fix(server): staleness-aware merge in session polling` — active-sessions/index.ts, tests
- **Pre-commit**: `cd agent && npm test -- --run && cd ../server && npm test -- --run`

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm test -- --run        # Expected: 0 failures
cd server && npm test -- --run       # Expected: 0 failures  
cd agent && npx tsc --noEmit         # Expected: 0 errors
cd server && npx tsc --noEmit        # Expected: 0 errors
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass
- [x] SSE 끊김 중 stale 데이터가 서버에서 올바르게 fallback 처리됨
- [x] Bootstrap이 최신 SSE 데이터를 덮어쓰지 않음
