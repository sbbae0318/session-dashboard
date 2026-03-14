# Learnings

## [2026-03-10] Session Init

### Key Architecture Facts
- oc-serve StatusMap: idle 전환 시 맵에서 `delete state()[sessionID]` 호출 → `/session/status`에서 사라짐
- Agent SSE Cache TTL: 24시간, eviction 60초마다
- Worktree: `/Users/sbbae/project/session-dashboard-status-simplify` (branch: feat/session-status-simplify)

### oc-serve SSE Event Types (relevant)
- `session.status` — busy/idle/retry 전환
- `session.idle` — deprecated, idle 시 발행
- `session.deleted` — 세션 삭제 시 발행 (`Session.remove()` 호출 시)
- `message.part.updated` — 도구 상태 변경 (`ToolStatePending = { status: 'pending' }`)
- `permission.updated` — 권한 요청 (`{ properties: { id, sessionID, title, time } }`)

### Current Agent session-cache.ts Gaps
- `handleMessagePartUpdated()`: `running`/`completed`만 처리, `pending` 무시
- `session.deleted` 이벤트: switch 케이스 없음 → ghost 세션 생성
- `permission.updated` 이벤트: 처리 없음

### Type Changes Required (3 layers)
1. Agent: `SessionDetail` + SQLite `session_status` 테이블 → `waiting_for_input` 컬럼
2. Server: `DashboardSession.status` + `CachedSessionDetail` → `waitingForInput`
3. Frontend+TUI: `DashboardSession.status` union 수정 + `waitingForInput` 추가

### State Model Decision
- Working: `apiStatus === 'busy'` OR `apiStatus === 'retry'` OR `currentTool`, AND NOT `waitingForInput`
- Waiting: `waitingForInput === true` (tool pending 또는 permission 요청)
- Idle: 그 외 (기존 Waiting+Done+Stale+Active 통합)

## T1: waitingForInput Detection (2026-03-11)
- worktree에 `node_modules` 없을 수 있음 → `npm install` 먼저 필요
- SQLite 마이그레이션: `ALTER TABLE ADD COLUMN`을 try/catch로 감싸면 기존 DB와 호환 가능
- `handleRawEvent()` switch-case에 새 이벤트 추가 시 닫는 괄호 주의 (switch `}` + method `}`)
- `bootstrapProject()`에서 직접 객체 리터럴로 upsert 호출 → 새 필드 추가 시 여기도 반드시 수정
- 테스트 helper `makeDetail()`에도 새 필드 기본값 추가 필요

## T2: session.deleted + REST fallback
- `fetchJson()` 404 응답은 `HTTP 404: Not Found` 형태의 Error message로 throw됨 → `msg.includes('404')` 패턴으로 잡기 적합
- round-robin offset: ids.length가 매 사이클 변할 수 있으므로, offset >= length이면 0으로 리셋 필수
- `handleSessionDeleted`는 props 구조가 다를 수 있어 `info.id` 우선, `sessionID` fallback으로 방어적 추출
- start()에 setInterval, stop()에 clearInterval — 기존 evictionTimer 패턴 동일하게 적용
