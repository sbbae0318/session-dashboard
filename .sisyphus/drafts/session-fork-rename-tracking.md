# Draft: 세션 포크 + 이름 변경 시 추적 실패

## Requirements (confirmed)
- 세션을 포크하고 이름을 변경한 경우, 대시보드에서 세션 ID만 노출됨
- 제목(title)이 정상적으로 표시되어야 함
- regression을 일으키지 않는 방식으로 수정 필요

## Known Architecture
- Agent: oc-serve SSE 구독 → SessionCache → SQLite (SessionStore)
- SSE 이벤트에는 title, parentSessionId, createdAt가 포함되지 않음 (기존 발견사항)
- Bootstrap (REST): /session?directory=X 로 세션 목록 가져옴 — title 포함
- Bootstrap은 agent 시작 시 1회 실행, 이후에는 SSE 이벤트로만 업데이트
- MAX_CACHE_SIZE = 500으로 제한

## Hypothesis
- 포크된 세션은 **새 session ID**를 가짐
- bootstrap 이후에 포크가 발생하면, SSE 이벤트로만 새 세션을 알게 됨
- SSE 이벤트에 title 필드가 없으므로 → title = null → 세션 ID로 표시
- 이름 변경(rename)도 SSE로 전파되지 않을 가능성

## Open Questions
- oc-serve SSE에 session.created / session.renamed 이벤트가 있는가?
- 포크 시 SSE에 어떤 이벤트가 발생하는가?
- REST API로 개별 세션 title을 가져올 수 있는 endpoint가 있는가?
- 현재 title이 null인 세션에 대해 title을 보충하는 메커니즘이 있는가?

## Research Findings

### Root Cause (확정)

**데이터 흐름 단절점 3곳:**

1. **SSE 이벤트에 title 없음** — oc-serve SSE는 `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `permission.updated`, `session.deleted`만 전송. `session.renamed`/`session.updated` 이벤트 없음.

2. **메타데이터 fetch 1회성 + 레이스 컨디션** — 새 세션 감지 시 `scheduleMetadataFetch(sessionID)` → REST `/session/{id}` 호출하지만:
   - 포크 직후 rename이 아직 oc-serve에 persist되지 않았으면 `title: null` 반환
   - 이후 **재시도 없음** — null title이 SQLite에 영구 저장

3. **정기적 title refresh 메커니즘 부재** — `title: null`인 세션을 재확인하는 로직 없음. Bootstrap은 1회만 실행.

### 관련 코드 위치

| 파일 | 라인 | 역할 |
|------|------|------|
| `agent/src/session-cache.ts:372-394` | SSE 이벤트 디스패치 | title 관련 이벤트 핸들러 없음 |
| `agent/src/session-cache.ts:402-413` | 새 세션 감지 | `scheduleMetadataFetch()` 호출 |
| `agent/src/session-cache.ts:611-641` | `fetchSessionMetadata()` | REST `/session/{id}` 1회 호출 |
| `agent/src/session-store.ts:60-86` | SQLite 스키마 | title 컬럼 존재, upsert 지원 |
| `server/src/modules/active-sessions/index.ts:231` | orphan 합성 | `previousSessionMap.get(id)?.title ?? null` |

### 포크+이름변경 실패 시나리오

```
T0: Agent 시작 → bootstrap() → 기존 세션 title 캐시 ✓
T1: User가 세션 포크 → 새 session ID (ses-xyz) 생성
T2: SSE: session.status for ses-xyz (title 없음)
T3: handleSessionStatus() → isNew → scheduleMetadataFetch(ses-xyz)
T4: fetchSessionMetadata() → GET /session/ses-xyz
    ⚠️ oc-serve에 rename이 아직 안 됐으면 → title: null
T5: SQLite: INSERT ses-xyz (title=null)
T6: (이후 title 재확인 없음) → 영구적으로 null
T7: Dashboard: 세션 ID 표시 ❌
```

## 탐색 결과 종합 (3개 에이전트 일치)

### 기존 메커니즘
- `scheduleMetadataFetch(sessionID)` 이미 존재 — 새 세션 감지 시 REST `/session/{id}` 호출
- 응답에서 `title`, `parentID`, `createdAt` 추출 → SQLite upsert
- **문제**: 1회성 호출, 레이스 컨디션 시 재시도 없음, rename 후 refresh 없음

### 가능한 수정 전략

**Option A: null-title 세션 주기적 재시도 (Agent 측)**
- 30~60초 주기로 `title: null`인 세션들을 batch REST fetch
- 장점: 단순, oc-serve 변경 불필요
- 단점: 최대 60초 지연

**Option B: 메타데이터 fetch 재시도 로직 추가 (Agent 측)**
- `fetchSessionMetadata()` 실패 or `title: null` 반환 시, 5초 후 재시도 (최대 3회)
- 장점: 포크 직후 빠른 title 확보 (5~15초)
- 단점: rename에는 대응 못함

**Option C: SSE 이벤트 기반 title 변경 감지 (불가)**
- oc-serve에 `session.renamed` 이벤트 없음 → 불가

**Option D: A + B 조합**
- 새 세션: 재시도 로직으로 빠른 title 확보
- rename: 주기적 null-title 스캔으로 보완
- 가장 완전한 해결

## Technical Decision
- **전략**: Option D (재시도 + 주기적 스캔)
  - 새 세션: `fetchSessionMetadata()` 실패/null title 시 5초 후 재시도, 최대 3회
  - 기존 null-title: 30~60초 주기 batch REST fetch로 보완
- **변경 범위**: `agent/src/session-cache.ts` (핵심), `agent/src/session-store.ts` (쿼리 추가 가능)
- **oc-serve 수정 불필요**: REST API만 활용

## Scope Boundaries
- INCLUDE: 포크 + 이름 변경 세션의 title 추적 수정
- INCLUDE: regression 테스트 추가
- EXCLUDE: 다른 UI 변경, 전반적인 아키텍처 변경, oc-serve 수정
