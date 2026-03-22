# Learnings — timeline-macbook-fix

## [2026-03-15] Initial Setup

### Codebase Conventions
- Worktree: `/Users/sbbae/project/session-dashboard-timeline-fix` (branch: `feat/timeline-macbook-fix`)
- Main repo: `/Users/sbbae/project/session-dashboard`
- Build: `cd server && npm run build` (tsc only)
- Test: `cd server && npm test` (vitest)
- Deploy: `ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && docker compose build --no-cache && docker compose up -d --force-recreate"`
- Dashboard URL: http://192.168.0.2:3097

### LSP Errors (Known — Transient)
These are stale LSP state in the main repo IDE, NOT real errors. Vite build passes fine:
- TimelinePage.svelte - Missing enrichment store exports (false positive)
- App.svelte - ViewType comparison errors (false positive)
- enrichment.ts exports ARE correct: timelineData, timelineAvailable, timelineLoading, summaryCache, summaryLoadingIds

### Machine Config
- MacBook (0.63): machines.yml `id: macbook, alias: MacBook Pro, host: 192.168.0.63, port: 3101, apiKey: test-local-key`
- server/machines.yml is gitignored (already in .gitignore:6)
- Docker container uses extra_hosts: host.docker.internal:host-gateway

### Key Files
- `server/src/modules/enrichment/index.ts` — EnrichmentModule, pollFeature(), registerRoutes()
- `server/src/modules/enrichment/types.ts` — EnrichmentCache, EnrichmentResponse, TimelineEntry
- `server/frontend/src/lib/stores/enrichment.ts` — resolveEnrichmentMachineId(), fetch functions
- `server/src/machines/machine-manager.ts` — pollAllQueries() pattern (REFERENCE for merge)
- `agent/src/opencode-db-reader.ts` — DB reader (DO NOT MODIFY types)
- `agent/src/server.ts:357-365` — Agent timeline endpoint

### Critical Constraints
- NEVER modify agent/src types (TimelineEntry etc.)
- NEVER modify existing per-machine routes
- NEVER change per-machine cache structure
- No generic merge abstraction — keep it simple per-feature
- Inject machineId at server level (not agent level)

## [2026-03-15] Task 1 진단 결과

### 근본 원인: NaN 버그 (agent server.ts)

**버그 위치**: `agent/src/server.ts` line 360-361
```typescript
// 버그 있는 코드
const from = parseInt(request.query.from ?? '0', 10);
const to = parseInt(request.query.to ?? String(Date.now()), 10);
```

**버그 메커니즘**:
1. 서버 `EnrichmentModule.pollFeature()`가 `/api/enrichment/timeline` 파라미터 없이 호출
2. Fastify: query string 없을 때 `request.query.from = ''` (빈 문자열, undefined 아님!)
3. `'' ?? '0'` → `''` (빈 문자열은 nullish가 아님, `??` 통과 안 됨)
4. `parseInt('', 10)` → `NaN`
5. SQLite에 NaN 전달 → `WHERE time_created >= NaN` → 0개 결과

**검증 완료**:
- `curl http://localhost:3098/api/enrichment/timeline` → `{"data":[]}`
- `curl "http://localhost:3098/api/enrichment/timeline?from=0&to=<now>"` → 795개 데이터
- `better-sqlite3`에 NaN 전달 시 0개 반환 확인

### 실제 상태
- MacBook agent (192.168.0.63:3098): 정상 동작 ✅
- Docker 컨테이너에서 MacBook LAN IP 접근: 정상 ✅
- opencode.db 세션 수: 795개 ✅
- machines.yml port: 3098 (올바름) ✅
- 연결 문제: 없음 ✅
- 데이터 문제: NaN 버그로 빈 배열 반환 ❌

### 수정 방법 (agent/src/server.ts)
```typescript
// 수정: || 사용 (빈 문자열도 처리)
const from = parseInt(request.query.from || '0', 10);
const to = parseInt(request.query.to || String(Date.now()), 10);
```

### 추가 발견: 프론트엔드 LSP 에러 (실제 에러)
worktree 브랜치에서 enrichment store 리팩토링 중 발생한 실제 에러:
- `TimelinePage.svelte`: `timelineData`, `timelineAvailable`, `timelineLoading` export 없음
- `App.svelte`: ViewType 타입 불일치
- `machine.svelte`: `onMachineChange` export 없음
→ 이 에러들은 다음 task에서 수정 필요

### machines.yml 포트 불일치 발견
- 이전 learnings에 port: 3101로 기록되어 있었으나 실제 machines.yml은 port: 3098
- 실제 agent도 3098에서 실행 중 (PID 49982)
- 3101은 다른 agent 인스턴스 (PID 39877, 별도 프로세스)

## [2026-03-15] Task: Merged* 타입 추가

### 결과
- `server/src/modules/enrichment/types.ts`에 6개 Merged* 타입 추가 완료
- `tsc --noEmit` 에러 없음
- agent/src 파일 변경 없음

### 타입 구조
- `MergedTimelineEntry extends TimelineEntry` + machineId/machineAlias
- `MergedSessionCodeImpact extends SessionCodeImpact` + machineId/machineAlias
- `MergedRecoveryContext extends RecoveryContext` + machineId/machineAlias
- `MergedProjectSummary extends ProjectSummary` + machineId/machineAlias
- `MergedTokensData` — machines 배열 + grandTotal (per-machine TokensData 집계용)
- `MergedEnrichmentResponse<T>` — data + available + machineCount + cachedAt

### 핵심 패턴
- server types.ts에 이미 모든 base 타입 정의됨 (TimelineEntry, SessionCodeImpact 등)
- agent의 opencode-db-reader.ts 타입과 server types.ts 타입이 동일 구조 (별도 정의)
- extends 방식으로 base 타입 재사용, agent 파일 import 불필요

## [2026-03-15] Task: 서버사이드 병합 엔드포인트 구현

### 결과
- `GET /api/enrichment/merged/:feature` 라우트 추가 (5개 feature 지원)
- `EnrichmentModule.getMergedData()` 메서드 추가 (cache 기반 병합, HTTP 요청 없음)
- `enrichment-merge.test.ts` 11개 테스트 작성 — 모두 통과
- tsc clean, 188/188 테스트 통과

### 구현 패턴
- tokens: `MergedTokensData` — machines 배열 + grandTotal 합산
- array features (timeline/impact/projects/recovery): 각 머신 캐시에서 entries 수집 → machineId/machineAlias 주입 → feature별 정렬
- 정렬: timeline(startTime ASC), impact(timeUpdated DESC), projects(sessionCount DESC), recovery(lastActivityAt DESC)
- graceful degradation: 머신 캐시 없으면 skip, 나머지 데이터만 반환

### Fastify 라우팅 주의사항
- `/api/enrichment/merged/:feature` (static "merged") vs `/api/enrichment/:machineId/timeline` (parametric `:machineId`)
- Fastify find-my-way: static segment > parametric — 충돌 없음
- 기존 per-machine 라우트 미변경 확인

### TypeScript 타입 캐스팅
- `entry as Record<string, unknown>` → `entry as unknown as Record<string, unknown>` (double assertion 필요)
- `ReadonlyMap` → `Map` 변환도 동일 패턴
- interface 타입은 index signature 미포함이라 직접 `Record<string, unknown>` 변환 불가

## [Task 7] 빌드/배포/QA 학습사항

### 배포 프로세스
- worktree → main merge → push → SSH 배포 → agent 재시작 순서
- MacBook agent 재시작이 필수: NaN 버그 수정은 agent 코드 변경이므로
- 배포 후 enrichment 캐시 빌드까지 30초+ 소요

### 발견된 버그
1. `resolveEnrichmentMachineId()` 함수의 fallback 로직이 "전체" 모드에서 merged 엔드포인트를 차단
   - 수정: fallback `machines[0]?.id` 제거, null 그대로 반환
2. Projects 탭 TypeError - 데이터 로딩 시 undefined property 접근

### QA 결과
- 5개 탭 중 4개 정상 (Tokens, Impact, Timeline, Recovery)
- Projects 탭만 에러
- "전체" 모드는 macbook 데이터만 표시 (merged 아님)
- 개별 머신 선택 시 모든 탭 정상 작동

