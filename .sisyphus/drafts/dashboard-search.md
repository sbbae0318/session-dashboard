# Dashboard Search Feature — Architecture Plan

## 1. Executive Summary

CommandPalette(Cmd+K)를 확장하여 **실시간 데이터 + 히스토리 검색**을 지원하는 2-Phase 검색 아키텍처.
Sentry의 시간 윈도우 필터링, Grafana의 progressive disclosure 패턴을 소규모 OSS에 맞게 적용.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CommandPalette (Enhanced)                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  🔍 [검색어 입력...]              [1h ▾] [7d ▾] [30d ▾]      │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │                                                               │  │
│  │  ── 현재 세션 (instant) ──────────────────────── 2 results    │  │
│  │  │ ● session-dashboard refactoring     3m ago   MacBook      │  │
│  │  │ ● API 엔드포인트 추가                idle     Desktop      │  │
│  │  │                                                            │  │
│  │  ── 히스토리 (server) ──────── ⏳ loading... ── 15 results    │  │
│  │  │ ○ DB migration 작업          2d ago    MacBook             │  │
│  │  │ ○ 검색 기능 프롬프트           3d ago    Desktop            │  │
│  │  │ ○ ...                                                      │  │
│  │                                                               │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │  ↑↓ 이동  ↵ 선택  ⇥ 시간범위  Esc 닫기                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

      Phase 1 (0ms)            Phase 2 (300ms debounce)
      Client-side              Server-side
          │                        │
          ▼                        ▼
┌──────────────────┐    ┌──────────────────────────────────┐
│  Svelte Stores   │    │   POST /api/search               │
│  (in-memory)     │    │   { query, timeRange, limit }    │
│                  │    │                                  │
│  sessions[]      │    │   Dashboard Server (Fastify)     │
│  queries[0:200]  │    │   ┌───────────────────────────┐  │
│                  │    │   │    SearchModule            │  │
│  fuzzyMatch()    │    │   │    ├─ Fan-out to agents    │  │
│  ↓               │    │   │    ├─ Merge + dedup       │  │
│  instant results │    │   │    ├─ LRU cache (5min)    │  │
└──────────────────┘    │   │    └─ Rate limit          │  │
                        │   └───────────┬───────────────┘  │
                        └───────────────┼──────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │   Agent A    │   │   Agent B    │   │   Agent C    │
            │   (:3098)    │   │   (:3098)    │   │   (:3098)    │
            │              │   │              │   │              │
            │ GET /api/    │   │ GET /api/    │   │ GET /api/    │
            │   search     │   │   search     │   │   search     │
            │              │   │              │   │              │
            │ OpenCode DB  │   │ OpenCode DB  │   │ Claude Code  │
            │ (SQLite)     │   │ (SQLite)     │   │ (JSONL)      │
            │              │   │              │   │              │
            │ session +    │   │ session +    │   │ history.jsonl│
            │ message tbl  │   │ message tbl  │   │ (grep-like)  │
            │ WHERE        │   │              │   │              │
            │ time >= ?    │   │              │   │              │
            │ AND LIKE ?   │   │              │   │              │
            └──────────────┘   └──────────────┘   └──────────────┘
```

---

## 3. Data Flow Diagram

```
User Keystroke
    │
    ├──[즉시]──▶ Phase 1: Client-side fuzzy search
    │            ├─ getSessions() → fuzzyMatch(title, id, alias)
    │            ├─ getQueries()  → fuzzyMatch(query, sessionTitle)
    │            └─ 결과 즉시 렌더링 (기존 로직 유지)
    │
    └──[300ms debounce]──▶ Phase 2: Server-side search
                          │
                          ├─ AbortController: 이전 요청 취소
                          ├─ 최소 2자 이상일 때만 발동
                          │
                          ▼
                   POST /api/search
                   {
                     query: "검색어",
                     timeRange: "7d",     ← Sentry 패턴: 시간 윈도우
                     limit: 50,
                     offset: 0            ← 페이지네이션
                   }
                          │
                   Dashboard Server
                          │
                   ┌──────┴──────┐
                   │ SearchModule │
                   │             │
                   │ 1. LRU 캐시 확인 (hit → 즉시 반환)
                   │ 2. Promise.allSettled() → 모든 Agent에 fan-out
                   │ 3. 각 Agent 응답 수집 (timeout 5s)
                   │ 4. 결과 merge + sessionId 기준 dedup
                   │ 5. relevance scoring → 정렬
                   │ 6. LRU 캐시 저장 (TTL 5min)
                   │ 7. 응답 반환
                   └──────┬──────┘
                          │
                   각 Agent
                          │
                   ┌──────┴──────┐
                   │ /api/search │
                   │             │
                   │ OpenCode:   │
                   │  SELECT s.id, s.title, m.data
                   │  FROM session s
                   │  LEFT JOIN message m ...
                   │  WHERE s.time_created >= ?    ← 시간 바운드
                   │    AND s.time_created <= ?
                   │    AND (s.title LIKE ?         ← 세션명 매칭
                   │     OR json_extract(m.data, '$.content') LIKE ?)
                   │  ORDER BY s.time_updated DESC
                   │  LIMIT 50
                   │             │
                   │ Claude Code: │
                   │  history.jsonl 역순 스캔
                   │  + 시간 필터 + 텍스트 매칭
                   └─────────────┘
```

---

## 4. 참고한 패턴 & 적용 방식

### 4.1 Sentry — Issue Search Architecture

| Sentry 패턴 | 우리 적용 | 이유 |
|---|---|---|
| **Time-windowed queries** (기본 14d) | **기본 7일, 선택 가능** (1h/24h/7d/30d/90d) | 가장 중요한 성능 최적화. DB 스캔 범위를 시간으로 제한 |
| **Structured search** (`key:value`) | **Phase 2에서 고려** | 초기엔 free-text, 향후 `project:foo status:idle` 지원 가능 |
| **Search result retention** | **LRU 캐시 (5min TTL, 100 entries)** | 같은 검색어 반복 시 Agent 재호출 방지 |
| **Rate limiting** | **서버 검색 10 req/min per client** | Agent 부하 방지 |
| **Progressive loading** | **Phase 1 즉시 + Phase 2 비동기** | UX: 기다림 없이 즉각 결과, 서버 결과는 점진 추가 |

### 4.2 Grafana — Explore/Search

| Grafana 패턴 | 우리 적용 | 이유 |
|---|---|---|
| **Dual-mode search** (dashboard + explore) | **CommandPalette가 dual-mode** | instant(메모리) + deep(서버) 동시 수행 |
| **Time range picker** | **시간 범위 칩/드롭다운** | 검색 범위 제어의 핵심 UI |
| **Recent searches** | **localStorage에 최근 10개** | 재검색 편의성 |
| **Result highlighting** | **매칭 부분 `<mark>` 태그** | 왜 이 결과가 나왔는지 시각적 피드백 |

### 4.3 Spotlight / Command Palette (Raycast, Linear, Vercel)

| 패턴 | 우리 적용 | 이유 |
|---|---|---|
| **Cmd+K 단축키** | **이미 구현됨** | 표준 패턴 유지 |
| **Grouped results** (세션/프롬프트) | **이미 구현됨** | 컨텍스트별 그룹화 |
| **Keyboard navigation** | **이미 구현됨** | ↑↓/Enter |
| **Debounce 200-300ms** | **300ms (서버 검색)** | 타이핑 중 불필요한 요청 방지 |
| **Minimum query length** | **2자 이상** | 너무 짧은 쿼리로 DB 풀스캔 방지 |

### 4.4 SQLite 검색 전략 (소규모 OSS 최적화)

```
┌─────────────────────────────────────────────────────┐
│              검색 전략 결정 트리                       │
│                                                     │
│  세션 수 < 5,000?                                    │
│  ├── YES → LIKE + 시간 바운드 (충분히 빠름)            │
│  │         인덱스: session(time_created)              │
│  │         쿼리 시간: < 50ms                         │
│  │                                                  │
│  └── NO  → SQLite FTS5 고려                          │
│            CREATE VIRTUAL TABLE search_idx           │
│            USING fts5(title, content, ...)           │
│            쿼리 시간: < 10ms                         │
│                                                     │
│  ★ 현재 Phase: LIKE + 시간 바운드                     │
│    (소규모 OSS에서 FTS5는 과도한 복잡성)               │
└─────────────────────────────────────────────────────┘
```

**Phase 1 (현재 계획)**: `LIKE '%query%'` + `time_created >= ? AND time_created <= ?`
- OpenCode DB의 `session.time_created`에 이미 인덱스 존재
- 5,000 세션 이하에서 50ms 미만 응답
- 메시지 내용 검색 시 `json_extract(m.data, '$.content') LIKE ?` 추가

**Phase 2 (스케일 시)**: SQLite FTS5
- 별도 인덱스 테이블 생성
- trigram tokenizer로 한국어/영어 모두 지원
- Agent 시작 시 인덱스 빌드, 이후 증분 업데이트

---

## 5. 설계 고려사항 & 최적화 전략

### 5.1 성능 최적화 (오래된 데이터 검색 문제)

```
┌─────────────────────────────────────────────────────────┐
│                Performance Optimization Stack            │
│                                                         │
│  Layer 1: Client Memory (0ms)                           │
│  ├─ 현재 로드된 sessions[] + queries[0:200]              │
│  ├─ fuzzyMatch() — 순수 JS, 메모리 내                    │
│  └─ 결과: 즉시 표시                                      │
│                                                         │
│  Layer 2: Time-Bounded Query (< 50ms)                   │
│  ├─ WHERE time_created >= (now - 7d)                    │
│  ├─ 인덱스 스캔 (full table scan 회피)                    │
│  └─ 대부분의 검색이 여기서 해결                            │
│                                                         │
│  Layer 3: LRU Cache (0ms on hit)                        │
│  ├─ 캐시 키: hash(query + timeRange)                    │
│  ├─ TTL: 5분 / Max: 100 entries                         │
│  └─ 같은 검색어 재입력 시 Agent 미호출                    │
│                                                         │
│  Layer 4: Request Dedup & Abort (네트워크 절약)           │
│  ├─ AbortController — 타이핑 중 이전 요청 취소            │
│  ├─ 동일 쿼리 중복 요청 방지                              │
│  └─ Agent timeout: 5s (느린 머신 대기 제한)               │
│                                                         │
│  Layer 5: Rate Limiting (Agent 보호)                     │
│  ├─ 서버: 10 search req/min per client IP                │
│  └─ Agent: 20 search req/min (서버에서만 호출)            │
└─────────────────────────────────────────────────────────┘
```

### 5.2 시간 윈도우 기본값 선택 근거

| 시간 범위 | 예상 세션 수 (활발한 사용) | DB 스캔 비용 | UX 적합성 |
|---|---|---|---|
| 1시간 | 1-5 | 매우 낮음 | 방금 작업한 것 찾기 |
| 24시간 | 5-30 | 낮음 | 오늘 작업한 것 찾기 |
| **7일 (기본값)** | **30-150** | **적정** | **지난주 작업 = 가장 빈번한 검색 패턴** |
| 30일 | 100-500 | 중간 | 지난달 작업 |
| 90일 | 300-1500 | 높음 | 아카이브 수준 |

→ Sentry도 기본 14d, Grafana도 기본 6h/24h. **7일이 개발자 워크플로우에 가장 적합**.

### 5.3 검색 대상 필드 우선순위

```
검색 매칭 우선순위 (relevance scoring):

1. session.title         LIKE '%query%'    (가중치: 3x)  ← 가장 직관적
2. query.query           LIKE '%query%'    (가중치: 2x)  ← 프롬프트 텍스트
3. session.directory     LIKE '%query%'    (가중치: 1x)  ← 프로젝트 경로
4. message.content       LIKE '%query%'    (가중치: 1x)  ← 메시지 본문 (비용 높음)

※ message.content 검색은 timeRange가 7d 이하일 때만 활성화
※ 30d/90d에서는 session.title + query.query만 검색 (성능 보호)
```

### 5.4 다중 머신 검색 시 Fan-out 전략

```
Dashboard Server
    │
    ├── Promise.allSettled([agentA.search(), agentB.search(), ...])
    │   ├── timeout: 5s per agent
    │   ├── 실패한 agent는 빈 결과 반환 (partial results OK)
    │   └── 전체 timeout: 8s (서버 → 클라이언트)
    │
    ├── Merge Strategy:
    │   ├── sessionId 기준 dedup (같은 세션이 여러 agent에서 올 수 있음?)
    │   │   └── 실제로는 각 agent가 다른 머신이므로 중복 가능성 낮음
    │   ├── relevance score 기반 정렬
    │   └── machineAlias 필드 보존 (어느 머신에서 온 결과인지)
    │
    └── Response:
        {
          results: SearchResult[],
          meta: {
            totalCount: number,
            searchTimeMs: number,
            machinesSearched: number,
            machinesFailed: string[],  // 실패한 머신 목록
            timeRange: { from, to },
            hasMore: boolean           // 페이지네이션
          }
        }
```

---

## 6. 구현 범위 (Phased Approach)

### Phase 1: Enhanced CommandPalette (MVP)
가장 작은 변경으로 가장 큰 효과

| 항목 | 변경 내용 | 파일 |
|---|---|---|
| **Agent: 검색 API** | `GET /api/search?q=&from=&to=&limit=` | `agent/src/server.ts` + 새 `search-handler.ts` |
| **Agent: DB 검색 로직** | `OpenCodeDBReader`에 `searchSessions()` 메서드 추가 | `agent/src/opencode-db-reader.ts` |
| **Server: 검색 모듈** | `SearchModule` — fan-out to agents, merge, cache | 새 `server/src/modules/search/` |
| **Server: API 라우트** | `POST /api/search` | `SearchModule.registerRoutes()` |
| **Frontend: 검색 store** | `search.svelte.ts` — 서버 검색 상태 관리 | 새 store |
| **Frontend: CommandPalette** | Phase 2 비동기 결과 표시, 시간 범위 UI, 하이라이팅 | `CommandPalette.svelte` 확장 |

### Phase 2: Advanced Features (향후)
- Structured search (`project:foo status:active`)
- 최근 검색어 저장 (localStorage)
- 검색 결과 내 메시지 본문 미리보기
- SQLite FTS5 인덱싱 (스케일 시)
- Claude Code JSONL 검색 지원

---

## 7. API 스펙 (Draft)

### Agent: GET /api/search

```
GET /api/search?q=검색어&from=1710000000000&to=1710600000000&limit=50&offset=0
Authorization: Bearer <API_KEY>

Response:
{
  "results": [
    {
      "type": "session",
      "sessionId": "ses_abc123",
      "title": "Dashboard 검색 기능 구현",
      "directory": "/Users/sbbae/project/session-dashboard",
      "timeCreated": 1710000000000,
      "timeUpdated": 1710100000000,
      "matchField": "title",        // 어떤 필드에서 매칭됐는지
      "matchSnippet": "Dashboard <mark>검색</mark> 기능 구현"
    },
    {
      "type": "prompt",
      "sessionId": "ses_abc123",
      "sessionTitle": "Dashboard 검색 기능 구현",
      "query": "세션명으로 <mark>검색</mark>하는 기능을 만들어주세요",
      "timestamp": 1710050000000,
      "matchField": "query"
    }
  ],
  "total": 15,
  "hasMore": false
}
```

### Server: POST /api/search

```
POST /api/search
Content-Type: application/json

{
  "query": "검색어",
  "timeRange": "7d",          // 1h | 24h | 7d | 30d | 90d
  "limit": 50,
  "offset": 0,
  "searchIn": ["title", "prompt"]  // 검색 대상 (옵션)
}

Response:
{
  "results": [...],           // merged from all agents
  "meta": {
    "totalCount": 42,
    "searchTimeMs": 230,
    "machinesSearched": 2,
    "machinesFailed": [],
    "timeRange": { "from": 1710000000000, "to": 1710600000000 },
    "hasMore": true,
    "cached": false
  }
}
```

---

## 8. 리스크 & 완화 전략

| 리스크 | 영향 | 완화 |
|---|---|---|
| OpenCode DB 동시 읽기 충돌 | Agent crash | `readonly: true`로 이미 열고 있음. 안전 |
| 대량 메시지 LIKE 검색 느림 | 응답 > 5s | 시간 윈도우 + limit + message 검색은 7d 이하만 |
| Agent 응답 지연/실패 | 검색 결과 불완전 | `Promise.allSettled` + partial results + 실패 머신 표시 |
| 검색 스팸 | Agent 과부하 | Rate limit (서버 10/min, agent 20/min) |
| Docker 재빌드 필요 | 배포 번거로움 | Server만 변경 시 `docker-compose build && up -d`로 충분 |
| 한국어 검색 정확도 | LIKE가 형태소 분석 안 함 | Phase 1에서는 substring match로 충분. FTS5는 Phase 2 |

---

## 9. 파일 변경 목록 (예상)

```
agent/
├── src/
│   ├── opencode-db-reader.ts    # searchSessions() 메서드 추가
│   ├── server.ts                # GET /api/search 라우트 등록
│   └── search-handler.ts        # [NEW] 검색 요청 핸들러

server/
├── src/
│   ├── modules/
│   │   └── search/
│   │       └── index.ts         # [NEW] SearchModule (fan-out, cache, merge)
│   └── index.ts                 # SearchModule 등록

server/frontend/
├── src/
│   ├── lib/
│   │   ├── stores/
│   │   │   └── search.svelte.ts # [NEW] 서버 검색 상태
│   │   └── search-client.ts     # [NEW] 검색 API 호출 (debounce, abort)
│   └── components/
│       └── CommandPalette.svelte # 확장: Phase 2 결과, 시간 범위, 하이라이팅
```

---

## 10. Non-Goals (범위 밖)

- Full-text search 인덱스 (FTS5) — Phase 2로 미룸
- Claude Code JSONL 검색 — 별도 작업
- Elasticsearch/Meilisearch 같은 외부 검색 엔진 — 소규모 OSS에 과도
- 검색 분석/통계 — 불필요
- 실시간 검색 결과 SSE 스트리밍 — REST로 충분
