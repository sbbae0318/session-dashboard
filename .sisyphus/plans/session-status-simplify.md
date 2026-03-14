# Session Status Simplification + Deletion Detection

## TL;DR

> **Quick Summary**: 대시보드의 세션 상태를 oc-serve 실제 모델에 맞게 재편(Working/Waiting/Idle)하고, 삭제된 세션이 ghost로 남는 문제를 SSE 이벤트 + REST fallback으로 해결한다.
>
> **Deliverables**:
> - Agent: `pending` tool state 감지, `permission.updated`/`session.deleted` SSE 이벤트 처리, 삭제 세션 정리 로직
> - Server: 상태 판정 로직 단순화 (fabricated `completed` 제거)
> - Frontend: `getDisplayStatus()` 3상태 재편 (Working/Waiting/Idle)
> - TUI: `statusBadge()` 동기화
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 → T2,T3 → T5 → T7 → F1-F4

---

## Context

### Original Request
사용자가 대시보드에서 삭제한 세션이 계속 표시되고(이름 대신 ID가 보임), Waiting/Done 상태 구분이 oc-serve 실제 모델과 맞지 않아 혼란을 준다. 상태를 2~3단계로 단순화하고, 삭제된 세션을 자동으로 정리하는 메커니즘이 필요하다.

### Interview Summary
**Key Discussions**:
- oc-serve에는 `completed` 상태가 없음 — `busy`/`idle`/`retry` 3가지만 존재
- `idle`이 되면 `/session/status` 맵에서 삭제됨 → 대시보드가 이를 "completed"로 fabricate
- SSE cache에 `idle`이 24시간 유지 → 프론트엔드에서 `apiStatus=idle`이 `status=completed`를 override하여 "Waiting" 표시
- `ToolStatePending = { status: 'pending' }` + `permission.updated` SSE 이벤트로 사용자 입력 대기 감지 가능
- `session.deleted` SSE 이벤트가 oc-serve에 존재하지만 현재 agent가 처리하지 않음
- 사용자 확정: Working / Waiting / Idle 3상태 모델

**Research Findings**:
- OpenCode `SessionStatus.set()`: idle 시 `delete state()[sessionID]` — 상태 맵에서 제거
- `session.deleted` SSE: `Session.remove()` 호출 시 발행 → 즉시 cache 정리 가능
- `message.part.updated`의 `state.status === 'pending'` → 도구 승인 대기
- `permission.updated` SSE → 권한 승인 요청 알림
- 현재 `session-cache.ts`는 `pending` 상태를 무시하고 `running`/`completed`만 처리

### Metis Review
**Identified Gaps** (addressed):
- SSE 끊김 시 `session.deleted` 이벤트 유실 가능 → REST fallback 추가
- `pending` 상태 해제 시점 명확화 필요 → `running`/`completed`/`error` 전환 시 clear
- Claude Code 세션에는 `pending` 개념 없음 → OpenCode만 적용, Claude Code는 기존 로직 유지
- 타입 변경이 3개 레이어(agent/server/frontend+TUI)에 걸침 → Wave 1에서 일괄 처리

---

## Work Objectives

### Core Objective
oc-serve의 실제 상태 모델에 정직하게 맞춘 3상태 표시(Working/Waiting/Idle)로 전환하고, 삭제된 세션의 ghost 잔류 문제를 해결한다.

### Concrete Deliverables
- `agent/src/session-cache.ts`: 새 SSE 이벤트 처리 + 삭제 감지
- `agent/src/types.ts` 또는 `session-cache.ts` 내부 타입: `waitingForInput` 필드 추가
- `server/src/modules/active-sessions/index.ts`: 상태 로직 단순화
- `server/src/machines/machine-manager.ts`: `CachedSessionDetail` 타입 업데이트
- `server/frontend/src/types.ts`: `DashboardSession` 타입 업데이트
- `server/frontend/src/components/ActiveSessions.svelte`: `getDisplayStatus()` 재편
- `tui/src/types.ts`: `DashboardSession` 타입 동기화
- `tui/src/utils/format.ts`: `statusBadge()` 업데이트
- `tui/src/components/SessionList.tsx`: `badgeColor()` 업데이트

### Definition of Done
- [x] Working/Waiting/Idle 3상태만 표시됨 (Done, Stale, Orphaned, Active 제거)
- [x] 삭제된 세션이 대시보드에서 자동 제거됨
- [x] `bun test` (TUI), `npm test` (agent), `npm test` (server) 모두 PASS
- [x] 기존 E2E 테스트 통과 또는 업데이트

### Must Have
- oc-serve `session.deleted` SSE 이벤트 처리
- `pending` tool state로 "Waiting" 감지
- REST API fallback으로 삭제된 세션 정리
- 3개 레이어(agent/server/frontend) 타입 일관성

### Must NOT Have (Guardrails)
- oc-serve 자체 코드 수정 금지 (외부 의존성)
- `completed` 상태를 다른 이름으로 재도입하지 않음
- 불필요한 추상화 계층 추가 금지
- CSS 리팩토링이나 디자인 변경 최소화 (상태 badge 색상만 변경)
- Claude Code 세션에 OpenCode 전용 로직(pending/permission) 적용 금지

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest — agent, server / bun test — TUI)
- **Automated tests**: Tests-after (기존 테스트 업데이트 + 새 테스트 추가)
- **Framework**: vitest (agent, server), bun test (TUI)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Agent/Server**: Use Bash — Run tests, curl endpoints, compare output
- **Frontend**: Use Playwright — Navigate, interact, assert DOM, screenshot
- **TUI**: Use interactive_bash (tmux) — Run TUI, validate output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (foundation — types across all layers):
├── Task 1: Agent 타입 + SSE 이벤트 핸들링 (session-cache.ts) [deep]
├── Task 2: Agent 삭제 감지 로직 (session-cache.ts eviction 영역) [deep]

Wave 2 (server + frontend — parallel):
├── Task 3: Server 상태 로직 단순화 (active-sessions/index.ts + machine-manager.ts) [unspecified-high]
├── Task 4: Frontend 상태 표시 단순화 (ActiveSessions.svelte + types.ts) [visual-engineering]
├── Task 5: TUI 상태 표시 동기화 (format.ts + SessionList.tsx + types.ts) [quick]

Wave 3 (tests):
├── Task 6: Agent 테스트 업데이트 (session-cache.test.ts) [unspecified-high]
├── Task 7: Server 테스트 업데이트 (active-sessions.test.ts 등) [unspecified-high]

Wave FINAL (verification — 4 parallel):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
├── F4: Scope fidelity check (deep)

Critical Path: T1 → T3 → T7 → F1-F4
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 3 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2, T3, T4, T5 | 1 |
| T2 | T1 | T6 | 1 |
| T3 | T1 | T7 | 2 |
| T4 | T1 | F3 | 2 |
| T5 | T1 | F3 | 2 |
| T6 | T1, T2 | F2 | 3 |
| T7 | T3 | F2 | 3 |
| F1-F4 | T1-T7 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `deep`, T2 → `deep`
- **Wave 2**: **3** — T3 → `unspecified-high`, T4 → `visual-engineering`, T5 → `quick`
- **Wave 3**: **2** — T6 → `unspecified-high`, T7 → `unspecified-high`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Agent: `waitingForInput` 감지 + 새 SSE 이벤트 핸들링

  **What to do**:
  - `agent/src/session-cache.ts`의 `SessionDetail` 인터페이스에 `waitingForInput: boolean` 필드 추가 (기본값 `false`)
  - `defaultSessionDetail()` 함수에 `waitingForInput: false` 추가
  - `handleMessagePartUpdated()`에서 `pending` 상태 처리 추가:
    ```typescript
    } else if (toolStatus === 'pending') {
      this.store.upsert(sessionID, {
        ...existing,
        waitingForInput: true,
        currentTool: part.tool ?? null,
        directory: directory ?? existing.directory,
        updatedAt: Date.now(),
      });
    }
    ```
  - `handleMessagePartUpdated()`의 `running` 및 `completed` 분기에서 `waitingForInput: false`로 리셋
  - `handleRawEvent()`의 switch에 `permission.updated` 케이스 추가:
    ```typescript
    case 'permission.updated':
      this.handlePermissionUpdated(props, directory);
      break;
    ```
  - `handlePermissionUpdated()` 메서드 구현: `sessionID`를 추출하여 해당 세션의 `waitingForInput: true` 설정
  - `handleSessionStatus()`에서 `busy` 전환 시 `waitingForInput: false`로 리셋 (사용자가 응답하여 작업 재개)
  - `agent/src/session-store.ts`의 SQLite 스키마에 `waiting_for_input` 컬럼 추가 (INTEGER, 기본 0). `SessionStore.upsert()`와 `getAll()`에 반영

  **Must NOT do**:
  - oc-serve 코드 수정
  - Claude Code 세션에 pending 로직 적용
  - SSE 이벤트 파싱 로직 구조 변경 (기존 패턴 유지)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SSE 이벤트 흐름 이해 + SQLite 스키마 변경 + 상태 전이 정확성 필요
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: 백엔드 전용 태스크라 불필요

  **Parallelization**:
  - **Can Run In Parallel**: YES (T2와 동일 Wave지만 같은 파일 → 순차 권장)
  - **Parallel Group**: Wave 1
  - **Blocks**: T2, T3, T4, T5, T6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `agent/src/session-cache.ts:292-307` — `handleRawEvent()` switch문: 여기에 `permission.updated` 케이스 추가
  - `agent/src/session-cache.ts:350-378` — `handleMessagePartUpdated()`: `running`/`completed` 분기 사이에 `pending` 추가
  - `agent/src/session-cache.ts:325-340` — `handleSessionIdle()`: `waitingForInput` 리셋 패턴 참고
  - `agent/src/session-cache.ts:310-323` — `handleSessionStatus()`: `busy` 전환 시 리셋 포인트

  **API/Type References**:
  - `agent/src/session-cache.ts:19-26` — `SessionDetail` 인터페이스 정의
  - `agent/src/session-cache.ts:89-98` — `defaultSessionDetail()` 함수
  - `agent/src/session-store.ts` — SQLite CRUD (upsert/getAll/evict)
  - OpenCode SDK `ToolStatePending = { status: 'pending' }` (sst/opencode-sdk-js `src/resources/session.ts:477`)
  - OpenCode SDK `EventPermissionUpdated` (sst/opencode-sdk-js `src/resources/event.ts:127-153`): `{ properties: { id, sessionID, title, time } }`

  **WHY Each Reference Matters**:
  - `handleRawEvent` switch: 새 이벤트 케이스를 추가할 정확한 위치
  - `handleMessagePartUpdated`: `pending` 분기를 추가할 위치, 기존 `running`/`completed` 패턴을 따라야 함
  - `SessionDetail`: `waitingForInput` 필드를 추가할 인터페이스
  - `session-store.ts`: SQLite 스키마 마이그레이션이 필요한 persistence 레이어

  **Acceptance Criteria**:
  - [x] `SessionDetail` 인터페이스에 `waitingForInput: boolean` 필드 존재
  - [x] `message.part.updated` 이벤트에서 `state.status === 'pending'` 시 `waitingForInput: true` 설정
  - [x] `permission.updated` 이벤트 수신 시 해당 세션 `waitingForInput: true` 설정
  - [x] `running`/`completed`/`busy` 전환 시 `waitingForInput: false`로 리셋
  - [x] SQLite에 `waiting_for_input` 컨럼 추가, upsert/getAll 반영
  - [x] `npx tsc --noEmit` 통과 (agent 디렉토리)

  **QA Scenarios:**

  ```
  Scenario: pending tool state → waitingForInput 설정
    Tool: Bash
    Preconditions: Agent 빌드 완료 (npm run build in agent/)
    Steps:
      1. agent/src/session-cache.ts 읽기 → handleMessagePartUpdated에 pending 분기 존재 확인
      2. agent/src/session-cache.ts 읽기 → handleRawEvent switch에 'permission.updated' 케이스 존재 확인
      3. cd agent && npx tsc --noEmit → 타입 에러 0
    Expected Result: 모든 코드 경로에서 waitingForInput이 올바르게 설정/리셋됨
    Failure Indicators: tsc 에러, pending 분기 누락, permission.updated 핸들러 누락
    Evidence: .sisyphus/evidence/task-1-pending-detection.txt

  Scenario: SQLite 스키마에 waiting_for_input 컬럼 존재
    Tool: Bash
    Preconditions: agent/data/session-cache.db 존재
    Steps:
      1. cd agent && node -e "const Database = require('better-sqlite3'); const db = new Database('./data/session-cache.db'); console.log(db.pragma('table_info(session_status)'))"
      2. 출력에서 'waiting_for_input' 컬럼 확인
    Expected Result: waiting_for_input 컬럼이 INTEGER 타입으로 존재
    Failure Indicators: 컬럼 누락
    Evidence: .sisyphus/evidence/task-1-sqlite-schema.txt
  ```

  **Commit**: YES
  - Message: `refactor(agent): handle pending/permission SSE events for waitingForInput detection`
  - Files: `agent/src/session-cache.ts`, `agent/src/session-store.ts`
  - Pre-commit: `cd agent && npx tsc --noEmit`

---

- [x] 2. Agent: `session.deleted` SSE 처리 + REST fallback 삭제 감지

  **What to do**:
  - `agent/src/session-cache.ts`의 `handleRawEvent()` switch에 `session.deleted` 케이스 추가:
    ```typescript
    case 'session.deleted':
      this.handleSessionDeleted(props);
      break;
    ```
  - `handleSessionDeleted()` 메서드 구현: `props.info.id` 또는 `props.sessionID`에서 세션 ID 추출 → `this.store.delete(sessionID)`로 즉시 캐시에서 제거
  - REST fallback 삭제 감지 메서드 `checkDeletedSessions()` 추가:
    - 주기: 60초마다 (기존 eviction 타이머와 별도, 또는 evict() 내에서 호출)
    - 로직: cache에 있는 세션 ID들을 oc-serve `/session/{id}` 엔드포인트로 개별 확인
    - 404 응답 → `this.store.delete(sessionID)`
    - 성능 고려: 한 사이클당 최대 10개씩 체크 (round-robin), 각 요청 3초 타임아웃
    - SSE 연결 상태 무관하게 실행 (SSE 끊긴 동안 누락된 delete 이벤트 보완)
  - `start()` 메서드에 deletion check 타이머 등록, `stop()`에서 정리

  **Must NOT do**:
  - eviction() 로직 자체를 변경하지 않음 (기존 TTL/MAX_CACHE_SIZE 유지)
  - oc-serve에 batch 삭제 확인 API가 없으므로 개별 확인만 수행
  - 삭제 확인 실패(네트워크 에러) 시 세션을 지우지 않음 (false positive 방지)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: REST fallback 로직의 비동기 흐름 + 에러 핸들링 + 성능 제약 조건 준수 필요
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (T1과 같은 파일 수정 → T1 완료 후 실행)
  - **Parallel Group**: Wave 1 (T1 이후 순차)
  - **Blocks**: T6
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `agent/src/session-cache.ts:292-307` — `handleRawEvent()` switch: `session.deleted` 케이스 추가 위치
  - `agent/src/session-cache.ts:125-128` — `start()`: 새 타이머 등록 위치
  - `agent/src/session-cache.ts:130-146` — `stop()`: 타이머 정리 패턴
  - `agent/src/session-cache.ts:476-490` — `evict()`: 기존 정리 로직 (패턴 참고, 수정 금지)

  **API/Type References**:
  - `agent/src/oc-serve-proxy.ts`의 `fetchJson()` — HTTP GET 유틸리티 (3초 타임아웃 지원)
  - OpenCode REST API: `GET /session/{id}` — 404면 삭제됨
  - OpenCode SDK `EventSessionDeleted` (sst/opencode-sdk-js `src/resources/event.ts:19-30`): `{ properties: { info: Session } }`

  **WHY Each Reference Matters**:
  - `handleRawEvent`: `session.deleted` 이벤트를 받을 switch 케이스 추가 위치
  - `start()/stop()`: 새 deletion check 타이머의 생명주기 관리
  - `fetchJson()`: oc-serve REST 호출에 이미 사용 중인 유틸리티 재활용
  - `evict()`: 참고만 (수정 금지) — 기존 TTL 기반 정리와 별개로 동작해야 함

  **Acceptance Criteria**:
  - [x] `session.deleted` SSE 이벤트 수신 시 해당 세션이 cache에서 즉시 삭제됨
  - [x] REST fallback이 60초 간격으로 실행됨
  - [x] 404 응답 세션만 삭제, 네트워크 에러 시 보존
  - [x] 한 사이클당 최대 10개 세션 체크 (과부하 방지)
  - [x] `npx tsc --noEmit` 통과

  **QA Scenarios:**

  ```
  Scenario: session.deleted SSE 이벤트 처리
    Tool: Bash
    Preconditions: Agent 빌드 완료
    Steps:
      1. agent/src/session-cache.ts 읽기 → handleRawEvent switch에 'session.deleted' 케이스 존재 확인
      2. handleSessionDeleted 메서드가 this.store.delete() 호출하는지 확인
      3. cd agent && npx tsc --noEmit → 에러 0
    Expected Result: session.deleted 이벤트 핸들러가 존재하고 store.delete 호출
    Failure Indicators: 케이스 누락, delete 미호출
    Evidence: .sisyphus/evidence/task-2-session-deleted.txt

  Scenario: REST fallback 삭제 감지 로직
    Tool: Bash
    Preconditions: Agent 빌드 완료
    Steps:
      1. agent/src/session-cache.ts에서 checkDeletedSessions 메서드 존재 확인
      2. start()에서 deletion check 타이머 등록 확인
      3. stop()에서 타이머 정리 확인
      4. round-robin 최대 10개 제한 로직 확인
    Expected Result: 60초 간격, 최대 10개/사이클, 404만 삭제
    Failure Indicators: 타이머 미등록, 제한 로직 누락
    Evidence: .sisyphus/evidence/task-2-rest-fallback.txt
  ```

  **Commit**: YES (T1과 함께)
  - Message: `refactor(agent): handle session.deleted SSE + REST fallback deletion check`
  - Files: `agent/src/session-cache.ts`
  - Pre-commit: `cd agent && npx tsc --noEmit`

---

- [x] 3. Server: 상태 로직 단순화 — fabricated `completed` 제거

  **What to do**:
  - `server/src/modules/active-sessions/index.ts`:
    - `DashboardSession` 인터페이스의 `status` 필드: `"active" | "completed" | "orphaned"` → `"active" | "idle"`로 변경
    - `apiStatus` 필드: `"idle" | "busy" | "retry" | null` → 그대로 유지 (oc-serve 실제 값)
    - `waitingForInput: boolean` 필드 추가 (agent cache에서 전달)
    - `buildSessionMap()` 수정:
      - `status: isActive ? 'active' : 'completed'` → `status: isActive ? 'active' : 'idle'`로 변경
      - `cached.waitingForInput`을 `waitingForInput` 필드로 전달
    - orphan session 합성 시 `status: 'active'` → `status: 'idle'`로 변경 (SSE cache에 있지만 REST에 없으므로)
    - 필터링 로직 유지: `s.title !== null || s.apiStatus !== null` (기존 ghost 필터 유지)
  - `server/src/machines/machine-manager.ts`:
    - `CachedSessionDetail` 인터페이스에 `waitingForInput?: boolean` 필드 추가

  **Must NOT do**:
  - polling 주기(2초) 변경
  - 머신 관리 로직 변경
  - Claude Code 세션 처리 로직 변경 (기존 유지)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 타입 변경 + 로직 수정이 정확해야 하지만 deep 수준은 아님
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T4, T5와 병렬)
  - **Parallel Group**: Wave 2 (with T4, T5)
  - **Blocks**: T7
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `server/src/modules/active-sessions/index.ts:7-29` — `DashboardSession` 인터페이스 정의
  - `server/src/modules/active-sessions/index.ts:125-179` — `buildSessionMap()`: `isActive`, `apiStatus`, `status` 결정 로직
  - `server/src/modules/active-sessions/index.ts:181-212` — orphan session 합성 로직
  - `server/src/modules/active-sessions/index.ts:94-99` — ghost 세션 필터링

  **API/Type References**:
  - `server/src/machines/machine-manager.ts:19-32` — `CachedSessionDetail` 인터페이스
  - `agent/src/session-cache.ts:19-26` — Agent `SessionDetail` (source of truth for waitingForInput)

  **WHY Each Reference Matters**:
  - `DashboardSession`: status 타입 union 변경의 핵심 위치
  - `buildSessionMap()`: `completed` 판정 로직을 제거할 위치
  - `CachedSessionDetail`: agent → server 데이터 전달 타입

  **Acceptance Criteria**:
  - [x] `DashboardSession.status`에서 `completed`와 `orphaned`가 제거됨
  - [x] `DashboardSession`에 `waitingForInput: boolean` 필드 존재
  - [x] `CachedSessionDetail`에 `waitingForInput?: boolean` 필드 존재
  - [x] `buildSessionMap()`에서 `completed` 문자열 사용 없음
  - [x] `npx tsc --noEmit` 통과 (server 디렉토리)

  **QA Scenarios:**

  ```
  Scenario: completed 상태 완전 제거 확인
    Tool: Bash
    Preconditions: server 빌드 완료
    Steps:
      1. grep -rn "completed" server/src/modules/active-sessions/index.ts → 0 matches (문자열 리터럴)
      2. grep -rn "orphaned" server/src/modules/active-sessions/index.ts → 0 matches
      3. grep -rn "waitingForInput" server/src/modules/active-sessions/index.ts → 1+ matches
      4. cd server && npx tsc --noEmit → 에러 0
    Expected Result: completed/orphaned 제거, waitingForInput 존재, 타입 체크 통과
    Failure Indicators: completed/orphaned 잔류, tsc 에러
    Evidence: .sisyphus/evidence/task-3-server-status.txt
  ```

  **Commit**: YES
  - Message: `refactor(server): simplify session status model — remove fabricated completed/orphaned`
  - Files: `server/src/modules/active-sessions/index.ts`, `server/src/machines/machine-manager.ts`
  - Pre-commit: `cd server && npx tsc --noEmit`

---

- [x] 4. Frontend: `getDisplayStatus()` 3상태 재편 (Working/Waiting/Idle)

  **What to do**:
  - `server/frontend/src/types.ts`:
    - `DashboardSession.status`: `"active" | "completed" | "orphaned"` → `"active" | "idle"`
    - `waitingForInput?: boolean` 필드 추가
  - `server/frontend/src/components/ActiveSessions.svelte`:
    - `getDisplayStatus()` 함수 완전 재작성:
      ```typescript
      function getDisplayStatus(session: DashboardSession): DisplayStatus {
        // 1. Working: busy 또는 retry 또는 currentTool 실행 중 (단, pending 아닌 경우)
        if ((session.apiStatus === 'busy' || session.apiStatus === 'retry' || session.currentTool)
            && !session.waitingForInput) {
          const label = session.apiStatus === 'retry' ? 'Retry' : 'Working';
          return { label, cssClass: 'status-working' };
        }
        // 2. Waiting: 사용자 입력/승인 대기
        if (session.waitingForInput) {
          return { label: 'Waiting', cssClass: 'status-waiting' };
        }
        // 3. Idle: 그 외 모든 상태
        return { label: 'Idle', cssClass: 'status-idle' };
      }
      ```
    - `IDLE_THRESHOLD_MS` 상수 제거 (더 이상 5분 기준 Stale 판정 불필요)
    - CSS 클래스 정리: `.status-completed`, `.status-orphaned`, `.status-stale`, `.status-active` 제거
    - `.status-retry` CSS 제거 (Working에 통합되므로 별도 스타일 불필요)

  **Must NOT do**:
  - 레이아웃/카드 구조 변경
  - 색상 톤 대폭 변경 (기존 Working=파랑, Waiting=보라, Idle=초록 유지)
  - dismissed 세션 로직 변경

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Svelte 컴포넌트 + CSS 수정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T3, T5와 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: F3
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/ActiveSessions.svelte:87-113` — 현재 `getDisplayStatus()` 함수 (완전 교체)
  - `server/frontend/src/components/ActiveSessions.svelte:25` — `IDLE_THRESHOLD_MS` 상수 (제거)
  - `server/frontend/src/components/ActiveSessions.svelte:372-418` — CSS 상태 클래스 (정리 대상)

  **API/Type References**:
  - `server/frontend/src/types.ts:16-38` — `DashboardSession` 인터페이스

  **WHY Each Reference Matters**:
  - `getDisplayStatus()`: 상태 결정 로직의 핵심 — 완전 교체 필요
  - CSS 클래스: 사용되지 않는 클래스 정리로 dead code 제거

  **Acceptance Criteria**:
  - [x] `getDisplayStatus()`가 Working/Waiting/Idle 3상태만 반환
  - [x] Done/Stale/Orphaned/Active 문자열이 `getDisplayStatus()`에 없음
  - [x] `IDLE_THRESHOLD_MS` 상수 제거
  - [x] CSS에 `.status-completed`, `.status-orphaned`, `.status-stale` 없음
  - [x] `DashboardSession.status`에 `completed`/`orphaned` 없음
  - [x] `waitingForInput` 필드가 `DashboardSession`에 존재

  **QA Scenarios:**

  ```
  Scenario: 3상태만 표시되는지 확인 (Playwright)
    Tool: Playwright (playwright skill)
    Preconditions: server + agent 실행 중, 최소 1개 세션 존재
    Steps:
      1. http://localhost:3097 접속
      2. .status-badge 요소 전체 수집
      3. 각 badge의 textContent가 'Working', 'Waiting', 'Idle', 'Retry' 중 하나인지 확인
      4. 'Done', 'Stale', 'Orphaned', 'Active' 텍스트가 없는지 확인
      5. 스크린샷 캡처
    Expected Result: 모든 badge가 Working/Waiting/Idle/Retry 중 하나
    Failure Indicators: Done/Stale/Orphaned/Active badge 존재
    Evidence: .sisyphus/evidence/task-4-frontend-3states.png

  Scenario: CSS dead code 제거 확인
    Tool: Bash
    Preconditions: 없음
    Steps:
      1. grep -c 'status-completed\|status-orphaned\|status-stale' server/frontend/src/components/ActiveSessions.svelte → 0
    Expected Result: 제거된 CSS 클래스가 파일에 없음
    Failure Indicators: 1개 이상 잔류
    Evidence: .sisyphus/evidence/task-4-css-cleanup.txt
  ```

  **Commit**: YES
  - Message: `refactor(frontend): simplify getDisplayStatus to Working/Waiting/Idle 3-state model`
  - Files: `server/frontend/src/components/ActiveSessions.svelte`, `server/frontend/src/types.ts`
  - Pre-commit: `cd server/frontend && npx svelte-check --no-tsconfig 2>/dev/null || true`

---

- [x] 5. TUI: 상태 표시 동기화 (Working/Waiting/Idle)

  **What to do**:
  - `tui/src/types.ts`:
    - `DashboardSession.status`: `"active" | "completed" | "orphaned"` → `"active" | "idle"`
    - `waitingForInput?: boolean` 필드 추가
  - `tui/src/utils/format.ts`:
    - `statusBadge()` 함수 업데이트:
      ```typescript
      export function statusBadge(apiStatus: string | null, waitingForInput?: boolean): string {
        if (waitingForInput) return '⏳ WAIT';
        switch (apiStatus) {
          case 'busy': return '● WORK';
          case 'retry': return '↻ RETRY';
          case 'idle': return '○ IDLE';
          default: return '○ IDLE';
        }
      }
      ```
  - `tui/src/components/SessionList.tsx`:
    - `badgeColor()` 업데이트: `waitingForInput` 파라미터 추가, true면 `'magenta'` 반환
    - `SessionRow`에서 `statusBadge(session.apiStatus, session.waitingForInput)` 호출
    - `badgeColor(session.apiStatus, session.waitingForInput)` 호출

  **Must NOT do**:
  - TUI 레이아웃/네비게이션 변경
  - 새 의존성 추가

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 3개 파일의 간단한 타입/로직 수정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T3, T4와 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: F3
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `tui/src/utils/format.ts:104-115` — 현재 `statusBadge()` 함수
  - `tui/src/components/SessionList.tsx:42-47` — 현재 `badgeColor()` 함수
  - `tui/src/components/SessionList.tsx:58` — `statusBadge` 호출 위치

  **API/Type References**:
  - `tui/src/types.ts:14-33` — `DashboardSession` 인터페이스

  **Acceptance Criteria**:
  - [x] `statusBadge()`가 `waitingForInput` 파라미터 지원
  - [x] `badgeColor()`가 `waitingForInput` 파라미터 지원
  - [x] `DashboardSession.status`에서 `completed`/`orphaned` 제거
  - [x] `cd tui && bunx tsc --noEmit` 통과

  **QA Scenarios:**

  ```
  Scenario: TUI 타입 체크 통과
    Tool: Bash
    Preconditions: bun 설치됨, tui/ 디렉토리
    Steps:
      1. cd tui && bunx tsc --noEmit → 에러 0
      2. grep -c 'completed\|orphaned' tui/src/types.ts → 0
    Expected Result: 타입 체크 통과, completed/orphaned 문자열 없음
    Failure Indicators: tsc 에러, 잔류 문자열
    Evidence: .sisyphus/evidence/task-5-tui-typecheck.txt
  ```

  **Commit**: YES
  - Message: `refactor(tui): sync status badges with Working/Waiting/Idle model`
  - Files: `tui/src/types.ts`, `tui/src/utils/format.ts`, `tui/src/components/SessionList.tsx`
  - Pre-commit: `cd tui && bunx tsc --noEmit`

---

- [x] 6. Agent 테스트 업데이트

  **What to do**:
  - `agent/src/__tests__/session-cache.test.ts` 수정/추가:
    - `pending` tool state 처리 테스트:
      - `message.part.updated`에 `state: { status: 'pending' }` → `waitingForInput: true` 확인
      - `pending` → `running` 전환 시 `waitingForInput: false` 리셋 확인
    - `permission.updated` SSE 이벤트 테스트:
      - 이벤트 수신 → 해당 세션 `waitingForInput: true` 설정 확인
    - `session.deleted` SSE 이벤트 테스트:
      - 이벤트 수신 → 해당 세션 cache에서 삭제 확인
    - REST fallback 삭제 감지 테스트:
      - 404 응답 세션 삭제 확인
      - 네트워크 에러 시 세션 보존 확인
      - 한 사이클 최대 10개 제한 확인
    - 기존 테스트 중 `completed` 관련 assertion 업데이트/제거

  **Must NOT do**:
  - 테스트가 아닌 프로덕션 코드 수정
  - oc-serve 실제 연결 필요한 integration test 추가 (mock 사용)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 테스트 작성은 구현 이해가 필요하지만 deep 레벨은 아님
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T7과 병렬)
  - **Parallel Group**: Wave 3
  - **Blocks**: F2
  - **Blocked By**: T1, T2

  **References**:

  **Pattern References**:
  - `agent/src/__tests__/session-cache.test.ts` — 기존 테스트 파일 (전체 읽기)

  **API/Type References**:
  - `agent/src/session-cache.ts` — 구현 참고 (T1, T2에서 수정된 상태)

  **Acceptance Criteria**:
  - [x] `cd agent && npm test` → 모든 테스트 PASS
  - [x] `pending` tool state 테스트 존재
  - [x] `permission.updated` 테스트 존재
  - [x] `session.deleted` 테스트 존재
  - [x] REST fallback 테스트 존재 (404 삭제, 에러 보존, 10개 제한)

  **QA Scenarios:**

  ```
  Scenario: Agent 테스트 전체 통과
    Tool: Bash
    Preconditions: T1, T2 완료
    Steps:
      1. cd agent && npm test 2>&1
      2. 출력에서 'Tests: X passed, 0 failed' 확인
      3. 'pending' 관련 테스트명 존재 확인
      4. 'session.deleted' 관련 테스트명 존재 확인
    Expected Result: 모든 테스트 PASS, 새 테스트 포함
    Failure Indicators: 테스트 실패, 새 테스트 누락
    Evidence: .sisyphus/evidence/task-6-agent-tests.txt
  ```

  **Commit**: YES (T7과 함께)
  - Message: `test(agent): add tests for pending/permission/deleted event handling`
  - Files: `agent/src/__tests__/session-cache.test.ts`
  - Pre-commit: `cd agent && npm test`

---

- [x] 7. Server 테스트 업데이트

  **What to do**:
  - `server/src/__tests__/active-sessions.test.ts` 수정:
    - `completed` 상태 관련 테스트 → `idle`로 변경
    - `orphaned` 상태 관련 테스트 → 제거 또는 `idle`로 변경
    - `waitingForInput` 전달 테스트 추가: cached detail에 `waitingForInput: true` → DashboardSession에 반영 확인
  - `server/src/__tests__/active-sessions-claude.test.ts`: Claude Code 관련 테스트에서 status 변경 반영
  - `server/src/__tests__/aggregation.test.ts`: status 관련 assertion 업데이트
  - 기존 테스트 파일 전체에서 `completed`/`orphaned` 문자열 검색 → 업데이트

  **Must NOT do**:
  - 프로덕션 코드 수정
  - E2E(Playwright) 테스트 수정 (별도 태스크 또는 final verification에서)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 기존 테스트 패턴 이해 + 정확한 assertion 변경
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T6과 병렬)
  - **Parallel Group**: Wave 3
  - **Blocks**: F2
  - **Blocked By**: T3

  **References**:

  **Pattern References**:
  - `server/src/__tests__/active-sessions.test.ts` — 기존 테스트 파일
  - `server/src/__tests__/active-sessions-claude.test.ts` — Claude Code 테스트
  - `server/src/__tests__/aggregation.test.ts` — 통합 테스트

  **Acceptance Criteria**:
  - [x] `cd server && npm test` → 모든 테스트 PASS
  - [x] `completed`/`orphaned` 문자열이 테스트 파일에서 제거됨 (검색 0건)
  - [x] `waitingForInput` 전달 테스트 존재

  **QA Scenarios:**

  ```
  Scenario: Server 테스트 전체 통과
    Tool: Bash
    Preconditions: T3 완료
    Steps:
      1. cd server && npm test 2>&1
      2. 출력에서 모든 테스트 PASS 확인
      3. grep -rn 'completed\|orphaned' server/src/__tests__/ → DashboardSession status 관련 0건
    Expected Result: 모든 테스트 PASS, 구 상태 문자열 제거
    Failure Indicators: 테스트 실패, 잔류 문자열
    Evidence: .sisyphus/evidence/task-7-server-tests.txt
  ```

  **Commit**: YES (T6과 함께)
  - Message: `test(server): update status tests for Working/Waiting/Idle model`
  - Files: `server/src/__tests__/active-sessions.test.ts`, `server/src/__tests__/active-sessions-claude.test.ts`, `server/src/__tests__/aggregation.test.ts`
  - Pre-commit: `cd server && npm test`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` in agent/, server/. Run `npm test` in agent/, server/. Run `bun test` in tui/. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill for web UI)
  Start from clean state. Start agent + server. Verify web UI shows Working/Waiting/Idle badges (no Done/Stale/Orphaned). Create a session, verify Working state. Let it idle, verify Idle state. Delete a session in oc-serve, wait for cleanup cycle, verify it disappears from dashboard. Run TUI and verify same 3 states. Save screenshots to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **T1+T2**: `refactor(agent): handle pending/deleted SSE events and add waitingForInput detection` — session-cache.ts, types (if changed)
- **T3**: `refactor(server): simplify session status to Working/Waiting/Idle model` — active-sessions/index.ts, machine-manager.ts
- **T4**: `refactor(frontend): simplify getDisplayStatus to 3-state model` — ActiveSessions.svelte, types.ts
- **T5**: `refactor(tui): sync status badges with new 3-state model` — format.ts, SessionList.tsx, types.ts
- **T6+T7**: `test: update session status tests for new 3-state model` — session-cache.test.ts, active-sessions.test.ts

---

## Success Criteria

### Verification Commands
```bash
cd agent && npm test    # Expected: all tests pass
cd server && npm test   # Expected: all tests pass
cd tui && bun test      # Expected: all tests pass
```

### Final Checklist
- [x] Working/Waiting/Idle 3상태만 표시 (Done/Stale/Orphaned/Active 없음)
- [x] 삭제된 세션이 `session.deleted` SSE 수신 시 즉시 제거
- [x] SSE 끊김 시 REST fallback으로 삭제 세션 정리
- [x] `pending` tool state 시 "Waiting" 표시
- [x] `permission.updated` 수신 시 "Waiting" 표시
- [x] Claude Code 세션은 기존 로직 유지 (Working/Idle만)
- [x] 모든 테스트 통과
