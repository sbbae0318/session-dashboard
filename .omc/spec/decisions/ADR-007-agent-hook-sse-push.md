# ADR-007: Agent Hook-Event SSE Push (B')

**Date:** 2026-04-07
**Status:** Accepted
**Deciders:** sb

## Context

세션 상태 전환(WAITING→WORKING 등)이 짧은 경우(< 2초), Server→Agent 폴링 간격 내에
소실되어 프론트엔드에서 감지 못하는 문제 발생. 상태 변경 flash 효과가 작동하지 않음.

검토한 대안:
1. **A. 폴링 주기 축소** (2초→500ms) — 간단하나 Agent 부하 4배
2. **B'. Agent hook SSE push** — hook 이벤트 시 즉시 push
3. **C. WebSocket** — 양방향 불필요, 과잉
4. **D. 전환 히스토리 버퍼** — 누락 0%이나 실시간성 미해결 (2초 뒤 flash는 의미 없음)

## Decision

**B'. Agent hook-event SSE push** 채택.

Agent가 `/api/claude/events` SSE 엔드포인트 제공. Claude Code hook 이벤트 발생 시
세션 full snapshot을 구독자(Server)에게 즉시 브로드캐스트.

## Rationale

- **Full snapshot 전송**: Server가 hook 이벤트(PreToolUse 등)를 해석할 필요 없음 — cachedDetails 구조 재활용
- **oc-serve 패턴 재활용**: SessionCache의 SSE 구독 패턴을 역방향으로 적용 (검증된 아키텍처)
- **폴링과 독립**: push가 주력, 폴링은 fallback — push 실패 시에도 1초 내 복구
- **D 보류**: push가 실시간성을 해결하므로 버퍼링 복잡도 불필요

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 실시간성 | 0ms 지연 (hook→push→100ms debounce→SSE) | - |
| 구현 복잡도 | - | Agent SSE 엔드포인트 + Server SSE 클라이언트 |
| 안정성 | 폴링 fallback | SSE 끊김 시 재연결 backoff (2초~30초) |
| A와의 관계 | A(1초 폴링) 유지 가능 — push 안정화 후 2초로 복원 가능 | - |

## Implementation

- Agent: `GET /api/claude/events` SSE + `broadcastHookUpdate()` (server.ts)
- Agent: `getSession()` 메서드 (claude-heartbeat.ts)
- Server: `subscribeToHookEvents()` + `handleHookSseMessage()` (machine-manager.ts)
- Server: `triggerPoll()` 100ms debounce (active-sessions/index.ts)
- Health: Agent `hookSseClients` 수 표시
