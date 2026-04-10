# Draft: Timeline Feature Gap Analysis & Restore

## 현재 상태 분석 완료

### 아키텍처 개요
```
OpenCode DB (per machine)
  → Agent: opencode-db-reader.ts getSessionTimeline()
    → SQL: session JOIN project, COALESCE(worktree, directory, project_id) AS directory
    → Filters: parent_id IS NULL, NOT LIKE 'Background:%', 'Task:%', '%@%'
  → Server: EnrichmentModule pollFeature('timeline') every 10s
    → enrichment-cache-db.ts saveTimelineEntries() (SQLite 영속화)
    → SSE broadcast: enrichment.updated / enrichment.merged.updated
  → Frontend: TimelinePage.svelte
    → enrichment.ts fetchTimelineData() → /api/enrichment/merged/timeline
    → filteredSessions → SVG swim-lane rendering
    → fetchSessionSegments() per session (activity blocks)
```

### 핵심 파일
- `agent/src/opencode-db-reader.ts` — Timeline 데이터 원본 (SQL 쿼리)
- `server/src/modules/enrichment/index.ts` — 서버 측 폴링 + 라우트
- `server/src/modules/enrichment/enrichment-cache-db.ts` — SQLite 캐시
- `server/src/modules/enrichment/types.ts` — TimelineEntry, MergedTimelineEntry 타입
- `server/frontend/src/components/pages/TimelinePage.svelte` — UI 컴포넌트 (300줄)
- `server/frontend/src/lib/stores/enrichment.ts` — 프론트 데이터 스토어
- `server/frontend/src/lib/timeline-utils.ts` — 시간→X 좌표, 축 포매팅

### 발견된 문제점 (Gap Analysis)

#### BUG-1: 프로젝트 필터가 projectId (해시)를 사용하지만 표시는 directory
- 프론트엔드: `projects = [...new Set(data.map(s => s.projectId))]`
- 드롭다운 value: `projectId` (해시), label: `shortPath(directory)`
- 서버 re-fetch 시: `fetchTimelineData(from, to, projectId)` — 서버로 해시 전달
- **문제**: 동일 디렉토리가 다른 projectId를 가질 수 있음 (opencode가 project를 재생성하면)
- **결과**: 같은 프로젝트인데 필터에 중복 표시

#### BUG-2: `time_created` 기반 필터링이 장시간 세션을 누락
- SQL: `WHERE s.time_created >= ? AND s.time_created <= ?`
- 3일 전에 시작해서 아직 진행 중인 세션 → 24h 범위로 조회 시 누락
- **수정 필요**: `time_created <= to AND time_updated >= from` (겹치는 세션 모두 포함)

#### BUG-3: Segments N+1 문제 (성능)
- `$effect()` 안에서 filteredSessions 순회 → 세션마다 fetchSessionSegments() 호출
- 30개 세션이면 30개의 HTTP 요청 동시 발사
- 캐시 있지만 최초 로드 시 병목

#### BUG-4: SVG_WIDTH 고정 900px — 반응형 미지원
- 넓은 모니터에서 낭비, 좁은 화면에서 스크롤 필요
- 현재: `const SVG_WIDTH = 900;`

#### BUG-5: Time range preset이 현재 시간 기준 고정
- `getTimeRange('24h')` → `{ from: now - 24h, to: now }`
- 브라우저 탭이 열린 상태로 오래 있으면, 리프레시 하지 않는 한 범위가 갱신 안됨
- SSE refetch 시 저장된 timeRange 사용 → stale 범위

#### BUG-6: 프로젝트 이름 표시 — shortPath 함수 한계
- `shortPath()`: 마지막 2 segment만 표시 (e.g., `project/session-dashboard`)
- 같은 이름의 다른 프로젝트가 있으면 구분 불가
- directory가 project_id (해시)로 fallback 시 의미 없는 문자열 표시

#### BUG-7: endTime null 처리 — 진행 중인 세션
- `endTime = time_updated !== time_created ? time_updated : null`
- endTime이 null이면 프론트엔드에서 `Date.now()` 사용
- 하지만 SVG는 렌더 시점의 `Date.now()`로 그려지고 갱신되지 않음

#### BUG-8: Claude Code 세션이 Timeline에 안 나올 수 있음
- agent/src/server.ts의 timeline은 opencode-db-reader만 사용
- Claude Code 세션은 enrichment의 다른 경로 (claude-heartbeat.ts)를 통해 수집되나
  timeline에는 포함되지 않을 가능성

## Interview Decisions (확정)

### 사용자 보고 증상
- 일부 세션만 보임 (전체가 아닌 일부만 Timeline에 나타남)
- 세션 이름이 정상적으로 표시되지 않음

### 수정 범위: 전면 리팩토링
- 버그 수정 + UX 개선 + 코드 구조 정리
- Timeline을 제대로 된 기능으로 만들기

### Claude Code: 통합 필요
- 현재: agent의 `/api/enrichment/timeline`은 opencode-db-reader만 사용
- Claude Code 세션은 claude-heartbeat.ts에서 관리되지만 timeline endpoint에 미포함
- **필요 작업**: claude-heartbeat.ts에 timeline 데이터 추출 메서드 추가,
  agent의 timeline endpoint에서 두 소스 병합

## Scope Boundaries
- INCLUDE: 
  - 8개 버그 수정 (BUG-1~BUG-8)
  - Claude Code Timeline 통합
  - 반응형 SVG
  - 세그먼트 성능 최적화
  - 프로젝트 표시 개선
  - 시간범위 필터 개선
- EXCLUDE:
  - TUI에서의 Timeline (브라우저 SPA만)
  - Timeline 데이터 export 기능
  - Timeline에서 세션 클릭→상세 네비게이션 (별도 이슈)

## Test Strategy Decision
- **Infrastructure exists**: YES (vitest — agent 328 tests, server 285 tests)
- **Automated tests**: TBD (사용자 확인 필요)
- **Agent-Executed QA**: ALWAYS
