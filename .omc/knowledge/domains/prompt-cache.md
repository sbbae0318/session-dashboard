# Domain: Prompt Cache Architecture

**Scope**: Agent → Server → Frontend 프롬프트 수집/캐시/표시 파이프라인

---

## 데이터 흐름

```
[Agent]
  OcQueryCollector.collectFromSession() → 세션 전체 user 프롬프트 수집
  ClaudeSource.getRecentQueries()       → ~/.claude/history.jsonl tail 읽기
  PromptStore (SQLite, 20K cap, 30d TTL)
      ↓  GET /api/queries, /api/claude/queries
[Server]
  RecentPromptsModule.pollQueries(500)  → 2초 폴링, queryMap merge
  queryMap: Map<sessionId, QueryEntry[]> → 세션별 누적 캐시
  eviction: 7일 내 세션만 유지, 20K 하드캡
      ↓  GET /api/queries, SSE query.new
[Frontend]
  queries.svelte.ts store (5K cap)
  fetchQueries(500) → 초기 로드
  fetchSessionQueries(id, 500) → 세션 클릭 시
```

## 핵심 설계 결정

### collectFromSession — 전체 반환 (not 마지막 1개)
- `agent/src/oc-query-collector.ts:218-281`
- 모든 user 메시지를 entries[] 배열로 수집, 각각 completedAt 개별 추출
- 30초 간격 background collection에서 호출

### Server queryMap — 세션별 Map 누적
- `server/src/modules/recent-prompts/index.ts`
- 이전: `cachedQueries[]` 2초마다 100개 전체 교체
- 현재: `queryMap: Map<sessionId, QueryEntry[]>` merge 방식
- mergeQueries: sessionId+timestamp dedup, 시간순 정렬

### sessionId 조회 — 항상 agent fetch + merge
- 캐시 hit이어도 agent fetch 실행 (전역 폴링은 세션당 최신 1개만 유입)
- fetch 결과를 기존 캐시와 merge → queryMap에 저장

### query.new 감지 — 세션별 lastTimestamp 비교
- `latestTimestampBySession: Map<string, number>`
- 새 poll에서 세션의 timestamp가 이전보다 크면 → SSE broadcast
- 이전 방식(100개 배열 diff)보다 효율적 + 누락 방지

### Eviction 정책
- **시간 기반**: ActiveSessionsModule의 7일 내 세션 ID 기준. 밖의 세션 프롬프트 삭제
- **하드 캡**: 총 20,000 프롬프트 초과 시 가장 오래된 세션부터 제거
- **콜백**: `setActiveSessionIdsCallback()` — cli.ts에서 ActiveSessionsModule 연결

## 수량 파라미터

| 파라미터 | 위치 | 값 |
|---------|------|-----|
| UNCACHED_FETCH_LIMIT | oc-query-collector.ts | 50 |
| BG_SESSION_LIMIT | oc-query-collector.ts | 20 |
| INTERNAL_SESSION_FETCH_LIMIT | oc-query-collector.ts | 200 |
| DEFAULT_MAX_ENTRIES | prompt-store.ts | 20,000 |
| DEFAULT_MAX_AGE_MS | prompt-store.ts | 30일 |
| POLL_LIMIT | recent-prompts/index.ts | 500 |
| MAX_TOTAL_PROMPTS | recent-prompts/index.ts | 20,000 |
| Frontend store cap | queries.svelte.ts | 5,000 |
| Frontend fetch limit | queries.svelte.ts | 500 (initial), 500 (session) |

## 알려진 한계

- **Claude history.jsonl**: tail N개만 읽음 — 오래된 프롬프트는 PromptStore에 미유입
- **검색**: `/api/search`는 opencode.db만 대상 (Claude 프롬프트 미포함)
- **메시지 검색 7일 캡**: opencode-db-reader.ts에서 timeRange > 7일이면 메시지 내용 검색 안 함
