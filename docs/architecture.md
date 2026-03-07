# 크로스 프로젝트 세션 상태 감지 문제 분석

## 1. 요약 (Executive Summary)

- `bae-settings` 프로젝트의 세션은 정상적으로 "Working"/"Waiting" 상태가 표시됨
- 다른 프로젝트(예: `doomcode`)의 세션은 "Waiting" 상태가 감지되지 않고 "Stale" 또는 "Idle"로 표시됨
- 근본 원인: `oc-serve`가 다른 프로젝트의 세션 상태를 반환하지 않아 `apiStatus`가 `null`이 됨

---

## 2. 아키텍처 개요

데이터 흐름은 다음과 같다:

```
oc-serve (port 4096)
  → SSE /global/event         → dashboard-agent (port 3101) SessionCache
  → REST /session/status?directory=  → dashboard-agent SessionCache

dashboard-agent
  → /proxy/session/details    → session-dashboard backend (port 3097) MachineManager
  → /proxy/session/status?directory= → session-dashboard backend MachineManager

session-dashboard backend
  → ActiveSessionsModule.buildSessionMap()  → DashboardSession with apiStatus
  → SSE session.update                      → Frontend

Frontend (ActiveSessions.svelte)
  → getDisplayStatus()  → 7가지 표시 상태
```

각 레이어는 독립적인 상태 표현을 가지며, 최종 표시 상태는 프론트엔드의 `getDisplayStatus()`에서 파생된다.

---

## 3. 상태 매핑 체계

### 3.1 oc-serve 레벨

- SSE `session.status` 이벤트: `type: 'busy' | 'idle' | 'retry'`
- REST `/session/status?directory=`: `Record<sessionId, { type: string }>`

### 3.2 dashboard-agent 레벨 (`session-cache.ts`)

- `SessionDetail.status: 'busy' | 'idle' | 'retry'`
- SSE 이벤트를 캐시하고 `/proxy/session/details`로 노출
- Bootstrap 시 `oc-serve /project` 목록을 조회한 뒤, 각 프로젝트별로 `/session/status?directory=`를 호출하여 초기 상태를 로드

### 3.3 session-dashboard 백엔드 레벨 (`active-sessions/index.ts`)

- `DashboardSession.status: 'active' | 'completed' | 'orphaned'` (라이프사이클 상태)
- `DashboardSession.apiStatus: 'busy' | 'idle' | 'retry' | null` (실시간 상태)
- `buildSessionMap()` 로직 (line 97-141):
  - `cachedDetails` (SSE 기반) 우선 적용
  - 없으면 `allStatuses` (REST 폴링) fallback
  - 둘 다 없으면 `null`

### 3.4 프론트엔드 레벨 (`ActiveSessions.svelte`)

`getDisplayStatus()` 함수 (line 54-77)의 우선순위:

| 우선순위 | 조건 | 표시 상태 | 색상 |
|---------|------|----------|------|
| 1 | `apiStatus === 'busy'` 또는 `currentTool` 존재 | Working | 파란색 |
| 2 | `apiStatus === 'idle'` | **Waiting** | 보라색 |
| 3 | `apiStatus === 'retry'` | Retry | 빨간색 |
| 4 | `status === 'completed'` | Done | 회색 |
| 5 | `status === 'orphaned'` | Orphaned | 노란색 |
| 6 | `lastActivityTime < 5분` | Idle | 초록색 |
| 7 | 그 외 | Stale | 노란색 |

"Waiting" 표시는 오직 `apiStatus === 'idle'`일 때만 가능하다. `apiStatus`가 `null`이면 우선순위 6 또는 7로 떨어진다.

---

## 4. 근본 원인 분석

### 원인 1: oc-serve가 다른 프로젝트의 세션 상태를 반환하지 않음

실제 API 호출 결과:

```bash
# directory 파라미터 없음 → bae-settings 세션 6개만 반환 (모두 type: "busy")
GET /session/status

# doomcode 프로젝트 → 빈 결과
GET /session/status?directory=/Users/sbbae/project/doomcode
# 응답: {}

# bae-settings 프로젝트 → 정상 반환
GET /session/status?directory=/Users/sbbae/project/bae-settings
# 응답: { "session-id-1": { "type": "busy" }, ... }
```

`oc-serve`는 외부 프로젝트이므로 직접 수정이 불가하다.

### 원인 2: `apiStatus`가 `null`이면 "Waiting"이 아닌 "Stale"/"Idle"로 표시

`getDisplayStatus()`에서 "Waiting"은 `apiStatus === 'idle'`일 때만 반환된다. `apiStatus`가 `null`이면 `status === 'active'`인 세션도 시간 기반 분기(우선순위 6, 7)로 처리된다. 결과적으로 `oc-serve`가 상태를 보고하지 않는 프로젝트의 세션은 절대 "Waiting"이 될 수 없다.

### 원인 3: SSE 이벤트의 directory 필드 의존성

`dashboard-agent`의 SSE 구독은 `/global/event`로 모든 프로젝트의 이벤트를 수신한다. 그러나 `oc-serve`가 특정 프로젝트의 이벤트를 발행하지 않으면 캐시에 해당 세션이 존재하지 않는다. Bootstrap 단계에서도 `/session/status?directory=`가 빈 결과를 반환하면 캐시에 추가되지 않는다.

### 원인 4: 타입 시스템에 'waiting'이 없음

`dashboard-agent`의 `SessionDetail.status`는 `'busy' | 'idle' | 'retry'`만 정의한다. "waiting"은 프론트엔드에서 `apiStatus === 'idle'`로 파생되는 표시 전용 상태다. `oc-serve`가 `'idle'` 상태를 전달하지 않으면 "Waiting" 표시 자체가 불가능하다.

---

## 5. 영향 범위

| 프로젝트 | 세션 목록 표시 | 상태 배지 |
|---------|-------------|---------|
| `bae-settings` | 정상 | 정상 (oc-serve가 상태 반환) |
| 다른 프로젝트 (예: `doomcode`) | 정상 | 부정확 ("Stale"/"Idle"로 표시) |

세션 목록 자체는 `/proxy/session?directory=`로 가져오므로 정상 표시된다. 상태 배지만 부정확하다. `apiStatus`가 `null`이 되어 "Waiting" 대신 "Stale" 또는 "Idle"로 표시된다.

---

## 6. 수정 권장사항

### 방안 A: 프론트엔드 상태 파생 로직 개선 (권장)

`status === 'active'`이고 `apiStatus === null`인 경우 "Unknown" 또는 "Active" 상태를 추가한다. 또는 `apiStatus`가 `null`이어도 `status === 'active'`이면 "Waiting"으로 표시하는 방식도 고려할 수 있다.

- 장점: `oc-serve` 수정 불필요, 즉시 적용 가능
- 단점: 실제 상태와 다를 수 있음

### 방안 B: dashboard-agent에서 REST 폴링 보완

SSE 캐시에 없는 active 세션에 대해 주기적으로 REST `/session/status?directory=`를 재호출한다.

- 장점: 더 정확한 상태 반영
- 단점: `oc-serve`가 빈 결과를 반환하면 여전히 해결되지 않음

### 방안 C: oc-serve 이슈 리포트

`oc-serve`에 `/session/status?directory=`가 특정 프로젝트에서 빈 결과를 반환하는 문제를 보고한다.

- 장점: 근본적 해결
- 단점: 외부 프로젝트 의존, 시간 소요

### 방안 D: 하이브리드 (A + C) (최종 권장)

- 즉시: 프론트엔드 상태 로직 개선 (방안 A)
- 장기: `oc-serve` 이슈 리포트 (방안 C)

---

## 7. 코드 참조

| 파일 | 위치 | 역할 |
|------|------|------|
| `services/dashboard-agent/src/session-cache.ts` | line 17-24 | `SessionDetail` 타입: `status: 'busy' \| 'idle' \| 'retry'` |
| `services/dashboard-agent/src/session-cache.ts` | line 285-298 | `handleSessionStatus()`: SSE 이벤트 → 캐시 업데이트 |
| `services/dashboard-agent/src/session-cache.ts` | line 386-427 | `bootstrap()`: 프로젝트별 초기 상태 로드 |
| `services/session-dashboard/src/machines/machine-manager.ts` | line 125-182 | `pollMachine()`: 프로젝트별 세션/상태 수집 |
| `services/session-dashboard/src/modules/active-sessions/index.ts` | line 97-141 | `buildSessionMap()`: `apiStatus` 결정 로직 |
| `services/session-dashboard/frontend/src/components/ActiveSessions.svelte` | line 54-77 | `getDisplayStatus()`: 7가지 표시 상태 파생 |
| `services/session-dashboard/frontend/src/types.ts` | line 45-64 | `DashboardSession`: `apiStatus` 타입 정의 |

---

## 8. 검증 방법

`oc-serve` API를 직접 호출하여 문제를 재현할 수 있다:

```bash
# bae-settings (정상 동작)
curl http://127.0.0.1:4096/session/status?directory=/Users/sbbae/project/bae-settings
# 응답: { "session-id-1": { "type": "busy" }, "session-id-2": { "type": "busy" }, ... }

# doomcode (문제 재현)
curl http://127.0.0.1:4096/session/status?directory=/Users/sbbae/project/doomcode
# 응답: {}
```

`doomcode`에서 빈 `{}`가 반환되면, `dashboard-agent` 캐시에 해당 세션의 상태가 없고, `buildSessionMap()`에서 `apiStatus: null`이 설정되며, 프론트엔드에서 "Waiting" 대신 "Stale"/"Idle"로 표시된다.

---

## 9. 결론

이 문제의 근본 원인은 `oc-serve`가 `bae-settings` 외 프로젝트의 세션 상태를 반환하지 않는 것이다.

대시보드 코드 자체에는 크로스 프로젝트 지원이 올바르게 구현되어 있다. 프로젝트별 `directory` 파라미터 사용, 병렬 수집, 머지 로직 모두 정상이다. `oc-serve`의 응답이 비어있어 `apiStatus`가 `null`이 되고, 프론트엔드에서 "Waiting" 대신 "Stale"/"Idle"로 표시되는 것이다.

단기적으로는 프론트엔드의 `getDisplayStatus()` 로직을 수정하여 `apiStatus === null`이고 `status === 'active'`인 경우를 별도로 처리하는 것이 가장 빠른 개선 방법이다. 장기적으로는 `oc-serve`의 크로스 프로젝트 상태 반환 문제를 해결해야 한다.
