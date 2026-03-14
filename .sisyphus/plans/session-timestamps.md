# Plan: Session List에 질의 시간 / 완료 시간 표시

**목표**: ActiveSessions(세션 목록)에서 각 세션의 가장 최근 프롬프트 전송 시간과 작업 완료 시간을 RecentPrompts와 동일한 `HH:MM → HH:MM` 포맷으로 표시한다.

**현재 상태**:
- RecentPrompts: `entry.timestamp → completionTs(cards)` 형식으로 이미 표시 ✅
- ActiveSessions: `lastActivityTime` 단일 시각만 표시 (meta row에 "방금 전" 등) ❌

**원하는 상태**:
- ActiveSessions: `{lastPromptTime} → {완료시각}` 또는 `{lastPromptTime} → ⏳(로더)` 표시

---

## 데이터 분석

### OpenCode 세션
- `lastPromptTime`: `CachedSessionDetail.lastPromptTime` (SSE 캐시) → 현재 `DashboardSession`에 미포함
- 완료 시간: `session.apiStatus === 'idle'` 이면 `lastActivityTime` ≈ 완료 시각

### Claude Code 세션
- `lastPromptTime`: JSONL 파일의 마지막 `type: 'user'` 엔트리 `timestamp` 필드 (ISO 8601 string)
- 완료 시간: `session.status === 'active'` + `status === 'idle'` 이면 `lastHeartbeat`(= JSONL mtime) ≈ 완료 시각

---

## 태스크 목록

- [ ] **Task 1 — Agent: Claude Code `lastPromptTime` 추출**
  - 파일: `agent/src/claude-heartbeat.ts`
  - `ClaudeSessionInfo`에 `lastPromptTime: number | null` 추가
  - JSONL에서 마지막 `type === 'user'` 엔트리의 `timestamp` (ISO → ms) 추출하는 메서드 추가
  - `readHeartbeatFile()` + `scanProjectsForActiveSessions()` 양쪽에서 설정
  - 테스트: `agent/src/__tests__/claude-heartbeat.test.ts`
  - 빌드: `agent/npm run build`

- [ ] **Task 2 — Server: `lastPromptTime` 파이프라인 전달**
  - 파일: `server/src/modules/active-sessions/index.ts`
    - `DashboardSession` 인터페이스에 `lastPromptTime: number | null` 추가
    - `buildSessionMap()`에서:
      - Claude Code: `(s.lastPromptTime as number) ?? null`
      - OpenCode: `cached?.lastPromptTime ?? null`
  - 파일: `server/frontend/src/types.ts`
    - `DashboardSession`에 `lastPromptTime: number | null` 추가
  - 테스트: `server/src/__tests__/active-sessions-claude.test.ts`에 lastPromptTime 관련 테스트 추가
  - 빌드: `server/npm run build` (TypeScript 컴파일만, Docker 재빌드는 Task 3 후)

- [ ] **Task 3 — Frontend: ActiveSessions UI 업데이트**
  - 파일: `server/frontend/src/components/ActiveSessions.svelte`
  - `formatTimestamp` import 추가 (이미 utils.ts에 존재)
  - meta row를:
    ```
    현재: {lastActivityTime 상대시간}
    변경: {lastPromptTime 절대시간} → {완료시간 절대시간} ({완료시간 상대})`
    ```
  - 로직:
    - `session.lastPromptTime` 있을 때:
      - `busy`: `{HH:MM} → ⏳ (작업 중)`  (dot-loader)
      - `idle/active`: `{HH:MM} → {HH:MM} ({relativeTime})`
    - `session.lastPromptTime` 없을 때: 기존 `relativeTime(lastActivityTime)` 유지 (폴백)
  - dot-loader 스타일 추가 (RecentPrompts에서 복사 또는 공통화)
  - `tick` reactive 업데이트 유지 (1분마다 relativeTime 갱신)
  - Docker 재빌드 및 재시작: `server/` 디렉토리에서

---

## 제약사항

- 수정 금지: `api.spec.ts`, `dashboard.spec.ts`, `machine-*.spec.ts`, `claude-code.spec.ts`, `playwright.config.ts`
- 테스트 삭제 금지 — 실패하면 코드를 수정
- 각 Task 완료 후 반드시 해당 테스트 suite 전체 통과 확인
- Task 3 완료 후 Docker 재빌드 필수 (변경이 컨테이너에 반영되어야 함)

---

## 의존성 순서

```
Task 1 (agent) → Task 2 (server pipeline) → Task 3 (UI + Docker)
```

Task 2는 Task 1의 `ClaudeSessionInfo.lastPromptTime` 필드를 알아야 타입을 맞출 수 있음.
Task 3는 Task 2의 `DashboardSession.lastPromptTime` 타입이 있어야 함.

---

## 참고 파일

- `agent/src/claude-heartbeat.ts`: `ClaudeSessionInfo`, `readHeartbeatFile`, `scanProjectsForActiveSessions`
- `server/src/modules/active-sessions/index.ts`: `DashboardSession`, `buildSessionMap`
- `server/frontend/src/types.ts`: 프론트엔드 타입
- `server/frontend/src/components/ActiveSessions.svelte`: UI
- `server/frontend/src/lib/utils.ts`: `formatTimestamp`, `relativeTime` 유틸

## 참고: JSONL timestamp 형식

```json
{"type": "user", "timestamp": "2026-03-08T16:08:50.930Z", ...}
{"type": "assistant", "timestamp": "2026-03-08T16:11:22.640Z", ...}
```
→ `new Date(entry.timestamp as string).getTime()` 로 ms 변환

## 참고: OpenCode lastPromptTime

`CachedSessionDetail` (server/src/machines/machine-manager.ts):
```typescript
interface CachedSessionDetail {
  lastPromptTime: number;  // ← 이미 존재, ms timestamp
  ...
}
```
→ `buildSessionMap`에서 `cached?.lastPromptTime ?? null` 로 전달하면 됨
