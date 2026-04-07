# ADR-006: Session Dismiss Auto-revive

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted
**Deciders:** sb

## Context

세션 dismiss(숨기기) 기능의 복원 전략을 결정해야 했다. 선택지:

1. **수동 복원만** — 사용자가 "복원" 버튼 클릭
2. **TTL 기반 자동 복원** — N시간 후 자동 표시
3. **Activity 기반 auto-revive** — 세션 활동 재개 시 자동 복원

## Decision

**Activity 기반 auto-revive** 채택.

## Rationale

- **핵심 시나리오**: 사용자가 "지금은 안 쓰는 세션"을 숨기지만, 해당 세션이 다시 활성화되면 모니터링 필요.
- **Dismiss 시 lastActivityTime 기록**: dismiss 시점의 lastActivityTime을 localStorage에 저장.
- **SSE/폴링에서 비교**: 세션 목록 갱신 시 dismissed 세션의 현재 lastActivityTime이 기록값과 다르면 → 새로운 활동 발생 → 자동 복원.
- **오탐 방지**: lastActivityTime이 실제로 변경된 경우에만 복원. 단순히 목록에 존재하는 것만으로는 복원하지 않음.

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| UX | 재활성 세션 놓칠 위험 제거 | 사용자가 "영구 숨기기" 의도인 경우 반복 표시 |
| 복잡도 | - | Map<sessionId, lastActivityTime> 비교 로직 |
| 영속성 | localStorage — 브라우저 간 비공유 | 다른 브라우저에서 접근 시 dismissed 상태 미반영 |

## Implementation

```typescript
// dismissed.svelte.ts
dismissed: Map<string, number>  // sessionId -> lastActivityTime at dismiss

dismissSession(id, lastActivityTime)  // dismiss 시 기록
isDismissed(id)                       // 필터링에서 사용
reviveSessions(sessions)              // SSE/폴링 후 호출 — activity 변경 시 복원
restoreAll()                          // 일괄 복원 버튼
```

- localStorage key: `session-dashboard:dismissed`
- `reviveSessions()`은 `App.svelte`에서 SSE session.update 및 fetchSessions() 후 호출
