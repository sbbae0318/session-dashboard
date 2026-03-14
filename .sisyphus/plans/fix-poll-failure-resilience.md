# Fix: Poll Failure Resilience — 502 시 세션 소실 방지

## Problem Statement

MacBook agent 폴링이 간헐적으로 실패(oc-serve 502)할 때 해당 머신의 **모든 세션이 대시보드에서 사라졌다가 다시 나타남** (깜빡임).

### Root Cause Chain

```
1. pollMachine() — /proxy/projects 호출에 에러 핸들링 없음
   → oc-serve 502 한 번이면 해당 머신의 전체 poll 실패

2. poll() — pollAllSessions 실패 시 rawSessions = []
   → 해당 머신의 세션이 첫 번째 루프에서 처리 안 됨

3. buildSessionMap() — Orphan 합성 경로에서 title: null, source: undefined
   → ghost 필터 (.filter(s => s.source === 'claude-code' || s.title !== null)) 에 의해 전부 제거

4. this.cachedSessions 덮어쓰기
   → 해당 머신 세션이 대시보드에서 완전히 사라짐
   → 다음 성공 poll에서 다시 나타남 = 깜빡임
```

### Scope

- **서버 코드만 수정** (agent 변경 없음)
- **프론트엔드 코드 변경 없음**
- `DashboardSession` 타입 변경 없음

---

## Concrete Deliverables

- `server/src/modules/active-sessions/index.ts` — orphan 합성 필드 보완 + 이전 데이터 보존
- `server/src/machines/machine-manager.ts` — `/proxy/projects` 에러 핸들링 추가
- `server/src/__tests__/active-sessions.test.ts` — 신규 테스트
- `server/src/__tests__/machine-manager.test.ts` — 신규 테스트

### Definition of Done

- [ ] `cd server && npm test -- --run` → 0 failures
- [ ] `cd server && npx tsc --noEmit` → 0 errors
- [ ] Poll 실패 시 이전 세션 데이터 유지 (깜빡임 없음)
- [ ] Orphan 합성 세션이 ghost 필터에 의해 제거되지 않음
- [ ] `/proxy/projects` 502 시 pollMachine이 크래시하지 않음

### Must Have

- Poll 실패 시 이전 세션 목록 보존 (graceful degradation)
- Orphan 합성 시 `source` 필드 포함
- `/proxy/projects` 에러 핸들링 (try-catch + 캐시 fallback)
- 각 수정별 최소 2개 신규 테스트
- 모든 기존 테스트 통과 (회귀 없음)

### Must NOT Have (Guardrails)

- 프론트엔드 코드 변경
- `DashboardSession` 타입 변경
- Agent 코드 변경
- Poll 간격 변경
- Grace period 로직 변경
- 기존 테스트 삭제/수정

---

## Implementation Tasks

### Task 1: Orphan 합성 필드 보완

**파일**: `server/src/modules/active-sessions/index.ts`

**What to do**:
- Orphan 합성 블록(L170-188)에 `source: 'opencode'` 필드 추가
  - SSE 캐시는 OpenCode 전용이므로 항상 `'opencode'`
  - Claude Code 세션은 별도 경로(`fetchClaudeSessions`)로 처리되어 orphan 합성에 도달하지 않음

**Must NOT do**:
- `DashboardSession` 타입 변경
- 첫 번째 루프(rawSessions 처리) 수정

**테스트** (2개):
1. Orphan 합성 세션에 `source: 'opencode'` 포함 확인
2. Orphan 합성 세션이 ghost 필터에서 살아남는지 확인 (`source === 'opencode'`이지만 `title === null`인 경우 필터 동작 확인)

> **Note**: `source: 'opencode'`를 추가해도 현재 ghost 필터 `(s.source === 'claude-code' || s.title !== null)`에서 `'opencode' !== 'claude-code'` AND `title === null` → 여전히 필터링됨. 따라서 Task 3의 ghost 필터 수정과 함께 적용해야 함.

---

### Task 2: `/proxy/projects` 에러 핸들링

**파일**: `server/src/machines/machine-manager.ts`

**What to do**:
- `pollMachine()` 내 `/proxy/projects` 호출을 try-catch로 감싸기
- 실패 시 이전 성공 응답을 캐시에서 반환 (graceful fallback)
- 캐시 구조: `private projectsCache: Map<string, Array<{ id: string; worktree: string }>>` (machineId → projects)
- 성공 시 캐시 업데이트, 실패 시 캐시 사용
- 캐시도 없으면 빈 배열 반환 (OpenCode 블록 skip)

**Must NOT do**:
- `httpGet` 메서드 시그니처 변경
- `pollAllSessions` 반환 타입 변경
- Grace period 로직 수정

**테스트** (3개):
1. `/proxy/projects` 성공 시 캐시 업데이트 확인
2. `/proxy/projects` 실패 시 캐시된 프로젝트 목록으로 폴링 계속
3. 캐시 없고 `/proxy/projects` 실패 시 빈 배열로 graceful skip

---

### Task 3: Ghost 필터 보완 + 이전 데이터 보존

**파일**: `server/src/modules/active-sessions/index.ts`

**What to do**:

**A. Ghost 필터 보완 (L97)**:
- 현재: `.filter(s => s.source === 'claude-code' || (s.title !== null && s.title !== ''))`
- 변경: `.filter(s => s.source === 'claude-code' || s.title !== null || s.apiStatus !== null)`
- 근거: `apiStatus`가 있는 세션(SSE 캐시에서 온 활성 세션)은 title이 없어도 유지해야 함
- `apiStatus !== null`은 SSE 캐시에서 status가 확인된 실제 활성 세션을 의미

**B. 이전 폴 데이터 보존**:
- `private previousSessionMap: Map<string, DashboardSession> = new Map()` 필드 추가
- `buildSessionMap()` 완료 후, 현재 결과에 없는 머신의 이전 세션을 병합
- 조건: 해당 머신의 `machineStatus.connected === true`이면서 rawSessions에 해당 머신 세션이 0개인 경우 → 이전 데이터 유지
- 이전 데이터 유지 시 `lastActivityTime`은 업데이트하지 않음 (stale 표시 가능)

**Must NOT do**:
- `DashboardSession` 타입 변경
- `buildSessionMap` 시그니처 변경
- 프론트엔드 코드 수정

**테스트** (4개):
1. `apiStatus !== null` + `title === null` 세션이 필터에서 유지됨
2. `apiStatus === null` + `title === null` + `source !== 'claude-code'` 세션은 필터링됨 (기존 동작 유지)
3. Machine poll 실패 시 이전 세션 데이터 보존
4. Machine poll 성공 시 이전 데이터를 새 데이터로 교체

---

## Commit Strategy

- **Commit 1** (Task 1+2): `fix(server): add error handling for /proxy/projects and fix orphan source field`
  - Files: `machine-manager.ts`, `active-sessions/index.ts`, tests
- **Commit 2** (Task 3): `fix(server): preserve session data across poll failures and fix ghost filter`
  - Files: `active-sessions/index.ts`, tests
- **Pre-commit**: `cd server && npm test -- --run && npx tsc --noEmit`

---

## Verification

### Manual QA Scenarios

1. **oc-serve 정상**: 모든 세션 정상 표시, `apiStatus` 정확
2. **oc-serve 일시 중단**: 세션 목록 유지, 깜빡임 없음
3. **oc-serve 복구**: 즉시 최신 데이터로 갱신
4. **신규 프로젝트 등록 후 oc-serve 실패**: 캐시된 프로젝트 목록으로 계속 폴링

### Success Criteria

```bash
cd server && npm test -- --run       # Expected: 0 failures
cd server && npx tsc --noEmit        # Expected: 0 errors
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Poll 실패 시 세션 깜빡임 없음
- [ ] Orphan 세션이 대시보드에 정상 표시됨
