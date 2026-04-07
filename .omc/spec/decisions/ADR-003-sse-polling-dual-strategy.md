# ADR-003: SSE + Hook Push + 폴링 삼중 전략

**Date:** 2026-04-07 (코드 역분석) → 2026-04-07 갱신 (B' 추가)
**Status:** Accepted (Superseded: 이중→삼중)
**Deciders:** sb

## Context

프론트엔드에서 실시간 데이터를 수신하는 방식을 결정해야 했다.
초기에는 SSE + 폴링 이중 전략이었으나, 짧은 상태 전환(WAITING→WORKING 등)이
Server→Agent 폴링 간격(2초) 내에 소실되는 문제를 발견하여 삼중 전략으로 확장.

선택지 (B' 설계 시 재평가):

1. **A. 폴링 주기 축소** (2초→500ms) — 간단하나 부하 증가
2. **B'. Agent hook SSE push** — Agent가 hook 이벤트 시 즉시 Server에 SSE push
3. **C. Agent→Server WebSocket** — 양방향 불필요, 과잉
4. **D. 전환 히스토리 버퍼** — 누락 0%이나 실시간성 해결 못함

## Decision

**SSE + hook push + 폴링 삼중 전략** 채택.

- **Server→Frontend**: SSE push (즉시) + 30초 폴링 fallback (기존)
- **Agent→Server**: Hook-event SSE push (즉시) + 1초 폴링 fallback (신규 B')

## Rationale

- **기존 장점 유지**: Server→Frontend SSE 자동 재연결 + 폴링 fallback
- **Agent→Server 병목 해소**: hook 이벤트 즉시 push로 0ms 지연 (폴링 1초 대기 제거)
- **Full snapshot 전송**: Server가 hook 이벤트를 해석할 필요 없음 — cachedDetails 구조 재활용
- **oc-serve 패턴 재활용**: SessionCache의 SSE 구독 패턴을 역방향으로 적용 (검증된 아키텍처)
- **D(전환 히스토리) 보류**: push가 실시간성을 해결하므로 버퍼링 불필요

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 실시간성 | Hook 즉시 → ~100ms 이내 프론트엔드 반영 | - |
| 구현 복잡도 | - | 삼중 레이어 유지 (hook SSE + 폴링 + 프론트 SSE) |
| 안정성 | 폴링 fallback으로 SSE 실패 커버 | SSE 끊김 시 재연결 backoff 필요 |
| 부하 | push는 이벤트 발생 시에만 | Agent에 SSE 클라이언트 관리 추가 |

## Implementation

### Layer 1: Agent → Server (hook push)
- Agent `GET /api/claude/events`: hook 발생 시 `hook.sessionUpdate` SSE 브로드캐스트
- Server `MachineManager.subscribeToHookEvents()`: claude 소스 머신에 SSE 구독
- `handleHookSseMessage()` → `hookCachedDetails` 갱신 → `triggerPoll()` (100ms debounce)
- 재연결: exponential backoff 2초→30초

### Layer 2: Server → Frontend (기존)
- `sse-client.ts`: Builder 패턴, heartbeat timeout 40초
- SSE 이벤트 6종

### Layer 3: 폴링 Fallback
- Server→Agent: 1초 (hook SSE fallback)
- Frontend: 30초 + visibilitychange 즉시 refresh
