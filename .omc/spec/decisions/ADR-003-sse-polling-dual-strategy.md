# ADR-003: SSE + 폴링 이중 전략

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted
**Deciders:** sb

## Context

프론트엔드에서 실시간 데이터를 수신하는 방식을 결정해야 했다. 선택지:

1. **WebSocket** — 양방향 통신
2. **SSE (Server-Sent Events)** — 단방향 서버→클라이언트
3. **Polling only** — 주기적 REST 호출
4. **SSE + Polling** — SSE 주력 + 폴링 fallback

## Decision

**SSE + 30초 폴링 이중 전략** 채택.

## Rationale

- **SSE 자동 재연결**: Native `EventSource`가 끊김 시 자동 재연결. WebSocket은 수동 구현 필요.
- **서버 단순성**: Fastify에서 SSE는 `text/event-stream` 응답만으로 구현. WebSocket은 별도 업그레이드 핸들링.
- **폴링 fallback**: SSE 연결 실패 시 (프록시, 방화벽 이슈 등) 30초 폴링으로 데이터 보장.
- **양방향 불필요**: 프론트엔드→서버 통신은 REST로 충분 (검색, 메모 CRUD 등).
- **Heartbeat 감지**: 40초 timeout으로 연결 상태 파악 (서버 heartbeat 주기 초과).

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 구현 복잡도 | SSE만으로 간단 | 폴링 + SSE 이중 로직 유지 |
| 실시간성 | SSE: 즉시, 폴링: 최대 30초 지연 | - |
| 서버 부하 | - | SSE 연결 유지 + 폴링 요청 동시 발생 |
| 호환성 | EventSource 모든 브라우저 지원 | - |

## Implementation

- `sse-client.ts`: Builder 패턴, heartbeat timeout 40초
- `App.svelte` onMount: SSE 연결 + 30초 `setInterval` 폴링
- `visibilitychange`: 탭 복귀 시 즉시 refresh
- SSE 이벤트 6종: session.update, query.new, machine.status, enrichment.updated, enrichment.merged.updated, enrichment.cache
