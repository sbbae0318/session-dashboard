# Enrichment 데이터 파이프라인 최적화 — SQLite 영속화 + SSE 실시간 업데이트

## TL;DR

> **Quick Summary**: 서버 enrichment 캐시를 인메모리 Map에서 SQLite 영속 저장으로 전환하고, 시간 윈도우 필터링 + merged 사전 계산 + SSE 알림 기반 프론트엔드 업데이트로 파이프라인을 최적화합니다.
> 
> **Deliverables**:
> - Server: SQLite 기반 enrichment 캐시 (재기동 시 즉시 로드)
> - Server: API 응답에 시간 윈도우 필터링 적용 (390KB → ~23KB)
> - Server: merged 결과 사전 계산 (요청마다 재계산 제거)
> - Server: SSE로 enrichment 업데이트 알림
> - Frontend: SSE 구독 → 알림 시 자동 fetch (HTTP 타이머 폴링 제거)
> - Agent: 증분 쿼리 지원 (since 파라미터)
> - Docker: volume mount로 DB 영속화
> - 90일 데이터 자동 정리
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 (Docker 검증) → T2 (SQLite 스키마) → T5 (서버 리팩터) → T6 (시간 필터링) → T9 (프론트 SSE) → T12 (배포+QA)

---

## Context

### Original Request
- "타임라인 로딩이 오래 걸린다. 모든 데이터를 on-demand로 처리하면 안 된다."
- "백엔드 서버에서 일정 주기로 집계하고 상황을 저장하는 로직이 필요하고, 프론트에서는 해당 데이터를 로딩만 하면 되는데"

### Interview Summary
**Key Discussions**:
- 영속 저장소: SQLite (better-sqlite3, agent에서 이미 사용 중)
- 프론트엔드: SSE 기반 업데이트 (HTTP 타이머 폴링 제거)
- 5개 enrichment feature 전부 최적화
- 데이터 보존: 90일, 자동 정리
- 테스트: tests-after

**Research Findings**:
- Timeline payload: 390KB (1,063 entries), 83%가 7일 이상 된 데이터
- 기본 24h 뷰에서 필요한 데이터는 전체의 10.7% (114개, ~23KB)
- 서버 SSE 인프라 존재하지만 프론트엔드에서 미사용 (EventSource 코드 없음)
- 서버 EnrichmentModule.cache = new Map() → 재기동 시 완전 초기화
- 서버 API가 from/to 파라미터를 완전히 무시 → 전체 데이터 반환

### Metis Review
**Identified Gaps** (addressed):
- Docker + better-sqlite3 Alpine 빌드: python3/make/g++ 필요 → T1에서 검증
- WAL mode + PRAGMA 설정 필수 → T2 스키마에 포함
- UPSERT: ON CONFLICT DO UPDATE 사용 (INSERT OR REPLACE 금지) → 가드레일 추가
- 배치 삭제: 90일 정리 시 1000건씩 삭제 (WAL explosion 방지) → T8에 포함
- Docker non-root user 권한: /app/data/ 소유권 설정 → T1에 포함
- 기존 enrichment-module.test.ts 업데이트 필요 → T11에 포함
- SSE 대용량 payload 비효율 → notification + HTTP fetch 패턴 채택

---

## Work Objectives

### Core Objective
enrichment 데이터를 서버에서 주기적으로 집계하고 SQLite에 영속 저장하여, 프론트엔드에서는 SSE 알림 수신 후 사전 필터링된 데이터를 즉시 로드만 하도록 파이프라인을 최적화합니다.

### Concrete Deliverables
- `server/src/modules/enrichment/enrichment-cache-db.ts` — SQLite 영속 캐시 클래스
- `server/src/modules/enrichment/index.ts` — SQLite 기반 리팩터링
- `server/src/modules/enrichment/types.ts` — 시간 윈도우 응답 타입 추가
- `server/frontend/src/lib/stores/enrichment.ts` — SSE-driven 리팩터
- `server/frontend/src/lib/sse-client.ts` — EventSource 구독 모듈
- `server/docker-compose.yml` — volume mount 추가
- `server/Dockerfile` — better-sqlite3 빌드 의존성 추가
- `agent/src/server.ts` — since 파라미터 지원

### Definition of Done
- [ ] 서버 재기동 후 즉시 enrichment 데이터 제공 (cold start 0초)
- [ ] `curl .../merged/timeline?from=X&to=Y` → 시간 범위 필터링된 결과 반환
- [ ] 프론트엔드에 EventSource 구독 코드 존재, HTTP 타이머 폴링 없음
- [ ] 24h 뷰 timeline payload < 50KB (현재 390KB)
- [ ] `cd server && npm test` → 모든 테스트 통과
- [ ] `cd server && npm run build` → 빌드 성공
- [ ] 192.168.0.2:3097 배포 후 5개 enrichment 탭 정상 동작
- [ ] Docker 재기동 후 데이터 유지 확인

### Must Have
- SQLite WAL mode + synchronous=NORMAL
- UPSERT: ON CONFLICT DO UPDATE 패턴만 사용
- 서버 재기동 시 SQLite에서 즉시 로드 (cold start 대기 없음)
- 시간 윈도우 필터링 (from/to) 서버사이드 적용
- 머신 하나 불가 시 나머지 데이터 제공 (graceful degradation 유지)
- 기존 per-machine API 라우트 유지
- Docker volume mount로 DB 영속화

### Must NOT Have (Guardrails)
- ❌ `INSERT OR REPLACE` 사용 (반드시 `ON CONFLICT DO UPDATE`)
- ❌ SSE로 390KB+ 대용량 데이터 직접 전송 (notification + HTTP fetch 패턴 사용)
- ❌ 기존 `/api/enrichment/:machineId/:feature` 라우트 제거
- ❌ agent/src 원본 타입 변경 (TimelineEntry 등)
- ❌ `as any` / `@ts-ignore`
- ❌ agent/frontend 변경을 같은 커밋에 섞기
- ❌ Tailwind CSS 사용 (기존 CSS 변수만)
- ❌ 범용 ORM/migration 프레임워크 도입 (raw better-sqlite3 사용)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (188 tests, vitest)
- **Automated tests**: Tests-after
- **Framework**: vitest (server), Playwright (QA scenarios)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Server routes**: Bash (curl) — time-windowed 응답, SQLite 영속성 검증
- **Frontend/UI**: Playwright — SSE 연결, 탭 전환, 데이터 로드 확인
- **Docker**: Bash — 컨테이너 재기동 후 데이터 유지 확인

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, 4 parallel):
├── Task 1: Docker better-sqlite3 빌드 검증 + Dockerfile + volume mount [quick]
├── Task 2: SQLite 스키마 + EnrichmentCacheDB 클래스 [deep]
├── Task 3: Server enrichment 타입 업데이트 (시간 윈도우 응답) [quick]
├── Task 4: Agent 증분 쿼리 (since 파라미터) [quick]

Wave 2 (After Wave 1 — server core, 4 parallel):
├── Task 5: EnrichmentModule SQLite 리팩터 (persist on poll + load on start) (depends: 1,2,3) [deep]
├── Task 6: 서버사이드 시간 윈도우 필터링 + merged 사전 계산 (depends: 5) [unspecified-high]
├── Task 7: SSE enrichment 알림 강화 (depends: 5) [quick]
├── Task 8: 90일 데이터 retention cleanup (depends: 2) [quick]

Wave 3 (After Wave 2 — frontend, 2 tasks):
├── Task 9: Frontend SSE 클라이언트 + enrichment store 리팩터 (depends: 7) [deep]
├── Task 10: Frontend 5개 페이지 SSE 통합 검증 (depends: 9) [visual-engineering]

Wave 4 (After Wave 3 — QA):
├── Task 11: 신규 테스트 작성 (SQLite, 필터링, SSE, retention) (depends: 5,6,9) [unspecified-high]
├── Task 12: Build + Deploy + QA on 192.168.0.2 (depends: all) [deep]

Wave FINAL (After ALL — 독립 리뷰, 병렬):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA — Playwright (unspecified-high)
├── Task F4: Scope fidelity check (deep)

Critical Path: T1 → T2 → T5 → T6 → T9 → T12 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 4 (Wave 1, Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 5 | 1 |
| 2 | — | 5, 8 | 1 |
| 3 | — | 5 | 1 |
| 4 | — | 12 | 1 |
| 5 | 1, 2, 3 | 6, 7, 11 | 2 |
| 6 | 5 | 9, 11, 12 | 2 |
| 7 | 5 | 9 | 2 |
| 8 | 2 | 12 | 2 |
| 9 | 6, 7 | 10, 11 | 3 |
| 10 | 9 | 12 | 3 |
| 11 | 5, 6, 9 | 12 | 4 |
| 12 | all | F1-F4 | 4 |
| F1-F4 | 12 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 4 tasks — T1 → `quick`, T2 → `deep`, T3 → `quick`, T4 → `quick`
- **Wave 2**: 4 tasks — T5 → `deep`, T6 → `unspecified-high`, T7 → `quick`, T8 → `quick`
- **Wave 3**: 2 tasks — T9 → `deep`, T10 → `visual-engineering`
- **Wave 4**: 2 tasks — T11 → `unspecified-high`, T12 → `deep`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Docker better-sqlite3 빌드 검증 + Dockerfile 수정 + volume mount

  **What to do**:
  - `server/Dockerfile`에 better-sqlite3 네이티브 빌드 의존성 추가:
    - Alpine 빌드 스테이지에 `RUN apk add --no-cache python3 make g++` 추가
    - 또는 builder 스테이지에서 빌드 후 런타임 스테이지로 복사
  - `server/docker-compose.yml`에 volume mount 추가:
    ```yaml
    volumes:
      - ./machines.yml:/app/machines.yml:ro
      - ./data:/app/data          # ← 추가: SQLite DB 영속화
    ```
  - Dockerfile에 `/app/data` 디렉토리 생성 + 소유권 설정:
    ```dockerfile
    RUN mkdir -p /app/data && chown node:node /app/data
    ```
  - `server/package.json`에 `better-sqlite3` 의존성 추가 (`npm install better-sqlite3`)
  - `@types/better-sqlite3` devDependencies 추가
  - Docker 빌드 검증: `cd server && docker compose build --no-cache`
  - 컨테이너 내부에서 better-sqlite3 import 검증

  **Must NOT do**:
  - 기존 Dockerfile 구조 완전 재작성 (최소 변경만)
  - 다른 패키지 추가

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Dockerfile + docker-compose 설정 변경, npm install
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T2, T3, T4와 병렬)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `server/Dockerfile` — 현재 멀티스테이지 빌드 구조
  - `server/docker-compose.yml` — 현재 volume mount (machines.yml만)
  - `server/package.json` — 현재 의존성 목록
  - `agent/package.json` — better-sqlite3 버전 참고 (agent에서 이미 사용 중)

  **Acceptance Criteria**:
  - [ ] `cd server && docker compose build --no-cache` → 빌드 성공
  - [ ] `docker exec session-dashboard node -e "require('better-sqlite3')"` → 에러 없음
  - [ ] `docker exec session-dashboard ls -la /app/data/` → 디렉토리 존재, node 소유

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Docker 빌드 성공
    Tool: Bash
    Steps:
      1. `cd server && docker compose build --no-cache 2>&1 | tail -20`
      2. Assert exit code 0
    Expected Result: 빌드 성공, better-sqlite3 네이티브 모듈 컴파일 완료
    Evidence: .sisyphus/evidence/task-1-docker-build.txt

  Scenario: 컨테이너 내부 better-sqlite3 동작
    Tool: Bash
    Steps:
      1. `docker compose up -d && sleep 5`
      2. `docker exec session-dashboard node -e "const db = require('better-sqlite3')('/app/data/test.db'); db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER)'); console.log('OK'); db.close()"`
      3. Assert "OK" 출력
    Expected Result: SQLite DB 생성 및 테이블 생성 성공
    Evidence: .sisyphus/evidence/task-1-sqlite-test.txt
  ```

  **Commit**: YES
  - Message: `chore(server): add better-sqlite3 dependency and Docker volume mount`
  - Files: `server/Dockerfile`, `server/docker-compose.yml`, `server/package.json`, `server/package-lock.json`

---

- [x] 2. SQLite 스키마 + EnrichmentCacheDB 영속 캐시 클래스

  **What to do**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts` 신규 생성:
    ```typescript
    export class EnrichmentCacheDB {
      constructor(dbPath: string)  // better-sqlite3 DB 열기
      // PRAGMA 설정: WAL mode, synchronous=NORMAL, cache_size=-32000, temp_store=MEMORY
      
      // 저장 (poll 완료 시 호출)
      saveFeatureData(machineId: string, feature: EnrichmentFeature, data: unknown, available: boolean): void
      // ON CONFLICT DO UPDATE 패턴 사용
      
      // 로드 (서버 시작 시 호출)
      loadAllCache(): Map<string, EnrichmentCache>
      
      // 시간 윈도우 필터링 조회
      getTimelineEntries(machineId: string, from: number, to: number): TimelineEntry[]
      getAllTimelineEntries(from: number, to: number): MergedTimelineEntry[]  // merged
      
      // 사전 계산된 merged 저장/조회
      saveMergedData(feature: EnrichmentFeature, data: unknown): void
      getMergedData(feature: EnrichmentFeature): unknown | null
      
      // 90일 retention cleanup
      deleteOldEntries(cutoffTimestamp: number, batchSize?: number): number
      
      // 리소스 정리
      close(): void
    }
    ```
  - SQLite 스키마:
    ```sql
    -- 머신별 feature 캐시 (원본 데이터)
    CREATE TABLE IF NOT EXISTS enrichment_cache (
      machine_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      data TEXT NOT NULL,        -- JSON serialized
      available INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (machine_id, feature)
    );
    
    -- 사전 계산된 merged 결과
    CREATE TABLE IF NOT EXISTS enrichment_merged (
      feature TEXT PRIMARY KEY,
      data TEXT NOT NULL,         -- JSON serialized
      machine_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    
    -- timeline entries 개별 저장 (시간 윈도우 필터링용)
    CREATE TABLE IF NOT EXISTS timeline_entries (
      session_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      machine_alias TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      data TEXT NOT NULL,          -- full entry JSON
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, machine_id)
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_start ON timeline_entries(start_time);
    CREATE INDEX IF NOT EXISTS idx_timeline_machine ON timeline_entries(machine_id, start_time);
    ```
  - PRAGMA 설정: WAL, synchronous=NORMAL, cache_size=-32000, temp_store=MEMORY
  - 모든 write에 `ON CONFLICT DO UPDATE` 사용 (INSERT OR REPLACE 금지)

  **Must NOT do**:
  - ORM/migration 프레임워크 도입
  - `INSERT OR REPLACE` 사용
  - agent/src 코드 변경

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SQLite 스키마 설계 + 영속 캐시 클래스 전체 구현
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T1, T3, T4와 병렬)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 5, Task 8
  - **Blocked By**: None

  **References**:
  - `agent/src/opencode-db-reader.ts:1-10` — better-sqlite3 사용 패턴 (import, constructor)
  - `server/src/modules/enrichment/types.ts` — EnrichmentCache, EnrichmentFeature, 각 데이터 타입
  - `server/src/modules/enrichment/index.ts:37-47` — 현재 Map 기반 캐시 구조

  **Acceptance Criteria**:
  - [ ] `enrichment-cache-db.ts` 파일 생성됨
  - [ ] `cd server && npx tsc --noEmit` → 컴파일 에러 없음
  - [ ] saveFeatureData + loadAllCache 라운드트립 테스트 통과
  - [ ] ON CONFLICT DO UPDATE 패턴 사용 확인 (INSERT OR REPLACE 없음)

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: SQLite 라운드트립 테스트
    Tool: Bash (node REPL)
    Steps:
      1. 임시 스크립트로 EnrichmentCacheDB 인스턴스 생성
      2. saveFeatureData('macbook', 'timeline', [...], true) 호출
      3. loadAllCache() → Map에 macbook timeline 데이터 존재
    Expected Result: 저장 후 로드 시 동일 데이터 반환
    Evidence: .sisyphus/evidence/task-2-roundtrip.txt

  Scenario: INSERT OR REPLACE 미사용 확인
    Tool: Bash (grep)
    Steps:
      1. `grep -n "INSERT OR REPLACE" server/src/modules/enrichment/enrichment-cache-db.ts`
      2. Assert 결과 없음
      3. `grep -n "ON CONFLICT" server/src/modules/enrichment/enrichment-cache-db.ts`
      4. Assert 결과 있음
    Expected Result: ON CONFLICT DO UPDATE만 사용
    Evidence: .sisyphus/evidence/task-2-upsert-check.txt
  ```

  **Commit**: YES (T3과 함께)
  - Message: `feat(server): add SQLite enrichment cache schema and persistence layer`
  - Files: `server/src/modules/enrichment/enrichment-cache-db.ts`

---

- [x] 3. Server enrichment 타입 업데이트 — 시간 윈도우 응답

  **What to do**:
  - `server/src/modules/enrichment/types.ts`에 시간 윈도우 쿼리 파라미터 타입 추가:
    ```typescript
    export interface TimeWindowQuery {
      from?: number;   // epoch ms
      to?: number;     // epoch ms
      limit?: number;  // max entries
    }
    ```
  - 기존 `EnrichmentResponse<T>`와 `MergedEnrichmentResponse<T>`는 유지
  - 필요 시 `EnrichmentCacheRow` 타입 추가 (SQLite 행 매핑용)

  **Must NOT do**:
  - 기존 타입 삭제/변경
  - agent/src 타입 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 정의 추가만
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T1, T2, T4와 병렬)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `server/src/modules/enrichment/types.ts` — 기존 타입 정의

  **Acceptance Criteria**:
  - [ ] `cd server && npx tsc --noEmit` → 에러 없음

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 타입 컴파일 확인
    Tool: Bash
    Steps:
      1. `cd server && npx tsc --noEmit 2>&1`
    Expected Result: 에러 없음
    Evidence: .sisyphus/evidence/task-3-tsc.txt
  ```

  **Commit**: YES (T2와 함께)

---

- [x] 4. Agent 증분 쿼리 — since 파라미터 지원

  **What to do**:
  - `agent/src/server.ts`의 `/api/enrichment/timeline` 엔드포인트에 `since` 쿼리 파라미터 추가:
    ```typescript
    app.get<{ Querystring: { from?: string; to?: string; projectId?: string; since?: string } }>(
      '/api/enrichment/timeline',
      async (request) => {
        const from = parseInt(request.query.from || '0', 10);
        const to = parseInt(request.query.to || String(Date.now()), 10);
        const since = request.query.since ? parseInt(request.query.since, 10) : undefined;
        const { projectId } = request.query;
        return enrichResponse(() => ocDbReader!.getSessionTimeline({ from, to, projectId, since }));
      },
    );
    ```
  - `agent/src/opencode-db-reader.ts`의 `getSessionTimeline()` 메서드에 `since` 옵션 추가:
    - `since`가 있으면 `WHERE time_updated >= :since` 조건 추가 (증분 쿼리)
    - `since`가 없으면 기존 동작 유지 (하위 호환)
  - 같은 패턴을 `/api/enrichment/impact`, `/api/enrichment/recovery`에도 적용 (선택적)

  **Must NOT do**:
  - agent/src의 기존 타입 인터페이스 변경
  - 기존 from/to 동작 변경 (since는 추가 옵션)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 쿼리 파라미터 추가 + SQL WHERE 조건 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T1, T2, T3와 병렬)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 12
  - **Blocked By**: None

  **References**:
  - `agent/src/server.ts:357-365` — 현재 timeline 엔드포인트 (from/to 파라미터)
  - `agent/src/opencode-db-reader.ts:404-439` — getSessionTimeline() SQL 쿼리
  - `agent/src/opencode-db-reader.ts:200-250` — prepared statements

  **Acceptance Criteria**:
  - [ ] `curl .../api/enrichment/timeline?since=<timestamp>` → 해당 시점 이후 변경된 데이터만 반환
  - [ ] `curl .../api/enrichment/timeline` → 기존과 동일 (하위 호환)
  - [ ] `cd agent && npm test` → 테스트 통과

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: since 파라미터 동작 확인
    Tool: Bash (curl)
    Steps:
      1. RECENT=$(date -v-1H +%s)000  # 1시간 전
      2. `curl -s "http://localhost:3098/api/enrichment/timeline?since=$RECENT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("count:", len(d.get("data",[])))'`
      3. `curl -s "http://localhost:3098/api/enrichment/timeline" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("count:", len(d.get("data",[])))'`
      4. Assert since 결과 < 전체 결과
    Expected Result: since 사용 시 더 적은 수의 항목 반환
    Evidence: .sisyphus/evidence/task-4-since-query.txt

  Scenario: 하위 호환 확인
    Tool: Bash (curl)
    Steps:
      1. `curl -s "http://localhost:3098/api/enrichment/timeline" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("available:", d.get("available")); print("count:", len(d.get("data",[])))'`
    Expected Result: since 없이 기존과 동일하게 전체 데이터 반환
    Evidence: .sisyphus/evidence/task-4-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `feat(agent): add since parameter for incremental enrichment queries`
  - Files: `agent/src/server.ts`, `agent/src/opencode-db-reader.ts`

---

- [x] 5. EnrichmentModule SQLite 리팩터 — persist on poll + load on start

  **What to do**:
  - `server/src/modules/enrichment/index.ts` 리팩터:
    1. **constructor**: `EnrichmentCacheDB` 인스턴스 생성 (dbPath: `/app/data/enrichment-cache.db`)
    2. **start()**: SQLite에서 캐시 로드 (`this.cache = this.db.loadAllCache()`) → 즉시 warm cache
    3. **pollFeature()**: 기존 agent 폴링 후 `this.db.saveFeatureData()` 호출하여 SQLite에 영속화
    4. **pollFeature()** 중 timeline: 개별 엔트리를 `timeline_entries` 테이블에도 저장 (시간 윈도우 쿼리용)
    5. **stop()**: `this.db.close()` 호출
  - 기존 `this.cache` (Map)는 유지 — SQLite는 영속 백업, Map은 런타임 조회용
  - 시작 순서: DB 로드 → Map 채우기 → poll 타이머 시작
  - 에러 처리: DB 쓰기 실패 시 warn 로그, 인메모리 캐시로 fallback (graceful)

  **Must NOT do**:
  - 기존 API 라우트 시그니처 변경
  - Map 캐시 제거 (런타임 성능용으로 유지)
  - pollFeature() 기본 로직 변경 (agent 폴링 방식 유지)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 핵심 모듈 리팩터링, 영속화 로직 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6, Task 7, Task 11
  - **Blocked By**: Task 1, Task 2, Task 3

  **References**:
  - `server/src/modules/enrichment/index.ts` — 현재 EnrichmentModule 전체 코드
  - `server/src/modules/enrichment/enrichment-cache-db.ts` — T2에서 생성한 SQLite 캐시 클래스
  - `server/src/cli.ts` — 서버 시작 코드 (EnrichmentModule 생성 위치)

  **Acceptance Criteria**:
  - [ ] 서버 시작 시 SQLite에서 캐시 로드 (로그 확인)
  - [ ] pollFeature 완료 시 SQLite에 데이터 저장 (DB 파일 크기 > 0)
  - [ ] 서버 재기동 후 즉시 `/api/enrichment/merged/timeline` → available: true
  - [ ] `cd server && npm run build` → 빌드 성공

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 서버 재기동 후 즉시 데이터 제공
    Tool: Bash
    Steps:
      1. 서버 시작, 30초 대기 (poll 완료)
      2. `curl -s http://localhost:3097/api/enrichment/merged/timeline | python3 -c 'import sys,json; d=json.load(sys.stdin); print("before restart:", len(d.get("data",[])))'`
      3. 서버 재기동 (docker compose restart)
      4. 5초 대기 (cold start + DB 로드)
      5. `curl -s http://localhost:3097/api/enrichment/merged/timeline | python3 -c 'import sys,json; d=json.load(sys.stdin); print("after restart:", len(d.get("data",[])))'`
      6. Assert: after restart > 0 (즉시 데이터 제공)
    Expected Result: 재기동 후 poll 대기 없이 데이터 반환
    Evidence: .sisyphus/evidence/task-5-restart-persistence.txt

  Scenario: SQLite DB 파일 생성 확인
    Tool: Bash
    Steps:
      1. `ls -la /app/data/enrichment-cache.db`
      2. Assert 파일 존재, 크기 > 0
    Expected Result: DB 파일 생성됨
    Evidence: .sisyphus/evidence/task-5-db-file.txt
  ```

  **Commit**: YES
  - Message: `feat(server): refactor EnrichmentModule to use SQLite persistence`
  - Files: `server/src/modules/enrichment/index.ts`, `server/src/cli.ts` (DB 경로 설정)

---

- [x] 6. 서버사이드 시간 윈도우 필터링 + merged 사전 계산

  **What to do**:
  - **시간 윈도우 필터링**:
    - `/api/enrichment/:machineId/timeline` 라우트에서 `from`/`to` 쿼리 파라미터 처리:
      - `from`/`to` 있으면: `timeline_entries` 테이블에서 `WHERE start_time >= :from AND start_time <= :to` 쿼리
      - `from`/`to` 없으면: 인메모리 캐시에서 전체 반환 (기존 동작 유지)
    - `/api/enrichment/merged/timeline` 라우트에도 동일 적용:
      - `from`/`to` 있으면: `timeline_entries` 테이블에서 전체 머신 데이터 시간 필터링 조회
      - `from`/`to` 없으면: 사전 계산된 merged 캐시 반환
  - **merged 사전 계산**:
    - `pollFeature()` 완료 후 `getMergedData()` 결과를 `enrichment_merged` 테이블에 저장
    - `/api/enrichment/merged/:feature` 라우트에서 사전 계산된 결과 반환 (매번 재계산 제거)
    - 단, `from`/`to` 파라미터가 있으면 동적 필터링 쿼리 사용

  **Must NOT do**:
  - 기존 per-machine 라우트 제거
  - `from`/`to` 없는 요청의 기존 동작 변경

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: API 라우트 수정 + SQLite 쿼리 + merged 캐시 관리
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (T5 이후)
  - **Blocks**: Task 9, Task 11, Task 12
  - **Blocked By**: Task 5

  **References**:
  - `server/src/modules/enrichment/index.ts:49-84` — 현재 라우트 정의
  - `server/src/modules/enrichment/index.ts:162-234` — getMergedData() 메서드
  - `server/src/modules/enrichment/enrichment-cache-db.ts` — T2에서 생성한 SQLite 클래스

  **Acceptance Criteria**:
  - [ ] `curl .../merged/timeline?from=X&to=Y` → 필터링된 결과 (전체보다 적은 수)
  - [ ] `curl .../merged/timeline` (파라미터 없음) → 사전 계산된 merged 반환
  - [ ] 24h 범위 timeline payload < 50KB
  - [ ] `cd server && npm run build` → 빌드 성공

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 시간 윈도우 필터링 확인
    Tool: Bash (curl)
    Steps:
      1. NOW=$(date +%s)000; FROM=$((NOW - 86400000))
      2. `curl -s "http://localhost:3097/api/enrichment/merged/timeline?from=$FROM&to=$NOW" | python3 -c 'import sys,json; d=json.load(sys.stdin); filtered=len(d.get("data",[])); print("24h filtered:", filtered)'`
      3. `curl -s "http://localhost:3097/api/enrichment/merged/timeline" | python3 -c 'import sys,json; d=json.load(sys.stdin); total=len(d.get("data",[])); print("total:", total)'`
      4. Assert: filtered < total
    Expected Result: 24h 필터링 결과 < 전체 결과
    Evidence: .sisyphus/evidence/task-6-time-window.txt

  Scenario: 24h payload 크기 확인
    Tool: Bash (curl + wc)
    Steps:
      1. NOW=$(date +%s)000; FROM=$((NOW - 86400000))
      2. `curl -s "http://localhost:3097/api/enrichment/merged/timeline?from=$FROM&to=$NOW" | wc -c`
      3. Assert: < 51200 (50KB)
    Expected Result: 50KB 미만
    Evidence: .sisyphus/evidence/task-6-payload-size.txt
  ```

  **Commit**: YES (T7과 함께)
  - Message: `feat(server): add time-window filtering and pre-computed merged cache`

---

- [x] 7. SSE enrichment 알림 강화

  **What to do**:
  - `server/src/modules/enrichment/index.ts`의 SSE broadcast 수정:
    - 현재: `this.sseManager.broadcast('enrichment.update', { machineId, feature })` (메타데이터만)
    - 변경: `this.sseManager.broadcast('enrichment.updated', { machineId, feature, cachedAt: Date.now() })` (이벤트명 변경 + 타임스탬프 추가)
  - merged 데이터 갱신 시 추가 이벤트:
    - `this.sseManager.broadcast('enrichment.merged.updated', { feature, machineCount, cachedAt })`
  - SSE 초기 연결 시 현재 캐시 상태 전송 (hydration):
    - `/api/events` 핸들러에서 연결 직후 각 feature의 최신 상태를 이벤트로 전송

  **Must NOT do**:
  - SSE로 전체 데이터 payload 전송 (notification만)
  - 기존 SSE 연결 관리 로직 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: SSE 이벤트 타입 변경 + 추가 이벤트 발송
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T6, T8과 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 9
  - **Blocked By**: Task 5

  **References**:
  - `server/src/modules/enrichment/index.ts:143-146` — 현재 SSE broadcast 코드
  - `server/src/sse/event-stream.ts` — SSEManager 클래스
  - `server/src/server.ts:81` — `/api/events` 라우트

  **Acceptance Criteria**:
  - [ ] SSE 이벤트에 `enrichment.updated`, `enrichment.merged.updated` 이벤트 포함
  - [ ] 초기 연결 시 현재 캐시 상태 이벤트 전송

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: SSE 이벤트 수신 확인
    Tool: Bash (curl SSE)
    Steps:
      1. `timeout 15 curl -s -N http://localhost:3097/api/events 2>&1 | head -30`
      2. Assert: "enrichment.updated" 또는 "enrichment.merged.updated" 이벤트 수신
    Expected Result: SSE 스트림에 enrichment 이벤트 포함
    Evidence: .sisyphus/evidence/task-7-sse-events.txt
  ```

  **Commit**: YES (T6과 함께)

---

- [x] 8. 90일 데이터 retention cleanup

  **What to do**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts`에 cleanup 메서드 추가 (T2에서 시그니처만 정의한 경우):
    ```typescript
    deleteOldEntries(cutoffTimestamp: number, batchSize: number = 1000): number {
      // DELETE FROM timeline_entries WHERE start_time < :cutoff LIMIT :batchSize
      // 반복: changes < batchSize이면 종료
      // setImmediate로 이벤트 루프 양보
    }
    ```
  - `server/src/modules/enrichment/index.ts`의 `start()`에 cleanup 타이머 추가:
    - 매 6시간마다 90일 이전 데이터 삭제
    - `const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000`
    - 배치 삭제 (1000건씩, WAL explosion 방지)
  - `stop()`에서 cleanup 타이머 해제

  **Must NOT do**:
  - 한 번에 전체 삭제 (배치 삭제만)
  - 삭제 중 서비스 중단

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: cleanup 메서드 구현 + 타이머 설정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (T5, T6, T7과 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 12
  - **Blocked By**: Task 2

  **References**:
  - `server/src/modules/enrichment/enrichment-cache-db.ts` — T2에서 생성한 클래스

  **Acceptance Criteria**:
  - [ ] 90일 이전 데이터 삭제 동작 확인
  - [ ] 배치 삭제 (1000건씩) 구현
  - [ ] cleanup 타이머 등록/해제

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 배치 삭제 동작 확인
    Tool: Bash (unit test 또는 node script)
    Steps:
      1. 테스트 DB에 old entries 삽입 (start_time = 100일 전)
      2. deleteOldEntries(cutoff, 100) 호출
      3. Assert: old entries 삭제됨, recent entries 유지됨
    Expected Result: cutoff 이전 데이터만 삭제
    Evidence: .sisyphus/evidence/task-8-retention.txt
  ```

  **Commit**: YES
  - Message: `feat(server): add 90-day data retention cleanup`
  - Files: `server/src/modules/enrichment/enrichment-cache-db.ts`, `server/src/modules/enrichment/index.ts`

---

- [x] 9. Frontend SSE 클라이언트 + enrichment store 리팩터

  **What to do**:
  - **SSE 클라이언트** (`server/frontend/src/lib/sse-client.ts` 신규 생성):
    ```typescript
    // EventSource 구독, 자동 재연결, 이벤트 디스패치
    export function connectSSE(): void {
      const es = new EventSource('/api/events');
      es.addEventListener('enrichment.updated', (e) => { ... });
      es.addEventListener('enrichment.merged.updated', (e) => { ... });
      // 연결 끊어지면 자동 재연결 (EventSource 기본 동작)
    }
    export function disconnectSSE(): void { ... }
    ```
  - **enrichment store 리팩터** (`server/frontend/src/lib/stores/enrichment.ts`):
    1. SSE 이벤트 수신 시 해당 feature 데이터 자동 re-fetch:
       ```typescript
       // SSE 'enrichment.merged.updated' 이벤트 → fetchTimelineData() 호출
       export function handleEnrichmentUpdate(feature: string): void {
         switch(feature) {
           case 'timeline': fetchTimelineData(); break;
           case 'tokens': fetchTokenStats(); break;
           // ...
         }
       }
       ```
    2. 기존 `onMachineChange` 콜백은 유지 (머신 전환 시 fetch)
    3. **HTTP 타이머 폴링 제거**: 각 페이지의 `onMount`에서 `fetchXxxData()`는 초기 로드용으로 1회만 호출
    4. SSE 이벤트가 오면 자동 갱신 → 타이머 불필요
  - **App.svelte (또는 최상위 레이아웃)**에서 SSE 연결 시작:
    ```svelte
    onMount(() => {
      connectSSE();
      return () => disconnectSSE();
    });
    ```
  - `fetchTimelineData()`에서 현재 시간 윈도우(selectedPreset)의 from/to 파라미터를 서버에 전달:
    - 이미 구현되어 있음 (TimelinePage.svelte의 handlePresetChange)
    - 서버가 이제 이 파라미터를 사용하여 필터링된 결과 반환

  **Must NOT do**:
  - 기존 fetch 함수 제거 (SSE는 trigger 역할, 데이터는 HTTP fetch)
  - SSE로 대용량 데이터 수신 (notification만)
  - 다른 store 파일 수정 (machine.svelte, sessions.svelte 등)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SSE 클라이언트 신규 + enrichment store 리팩터 + App.svelte 통합
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 10, Task 11
  - **Blocked By**: Task 6, Task 7

  **References**:
  - `server/frontend/src/lib/stores/enrichment.ts` — 현재 enrichment store (fetch 함수들)
  - `server/frontend/src/lib/api.ts` — fetchJSON 유틸
  - `server/frontend/src/App.svelte` — 최상위 컴포넌트
  - `server/src/sse/event-stream.ts` — SSE 프로토콜 참고 (retry, event, data 형식)

  **Acceptance Criteria**:
  - [ ] `sse-client.ts` 파일 생성됨 (EventSource 구독)
  - [ ] enrichment store에 HTTP 타이머 폴링 코드 없음
  - [ ] SSE 이벤트 수신 시 자동 re-fetch 동작
  - [ ] `cd server/frontend && npm run build` → 빌드 성공

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: SSE 연결 + 자동 업데이트
    Tool: Playwright
    Steps:
      1. Navigate to http://localhost:3097
      2. Timeline 탭 클릭
      3. 데이터 표시 확인
      4. 10-15초 대기 (서버 poll cycle 완료 → SSE 이벤트 발송)
      5. 데이터가 자동 갱신되는지 확인 (또는 변화 없이 유지)
      6. 브라우저 콘솔에서 EventSource 연결 확인
    Expected Result: SSE 연결 활성, 데이터 자동 갱신
    Evidence: .sisyphus/evidence/task-9-sse-frontend.png

  Scenario: HTTP 타이머 폴링 제거 확인
    Tool: Bash (grep)
    Steps:
      1. `grep -n "setInterval\|setTimeout.*fetch" server/frontend/src/lib/stores/enrichment.ts`
      2. Assert: 결과 없음 (타이머 기반 폴링 제거됨)
    Expected Result: enrichment store에 setInterval/setTimeout 없음
    Evidence: .sisyphus/evidence/task-9-no-polling.txt
  ```

  **Commit**: YES (T10과 함께)
  - Message: `feat(frontend): add SSE-driven enrichment updates, remove HTTP polling`
  - Files: `server/frontend/src/lib/sse-client.ts`, `server/frontend/src/lib/stores/enrichment.ts`, `server/frontend/src/App.svelte`

---

- [x] 10. Frontend 5개 페이지 SSE 통합 검증

  **What to do**:
  - 5개 enrichment 페이지가 SSE 기반 업데이트와 올바르게 동작하는지 확인:
    - `TimelinePage.svelte` — 시간 윈도우 preset 변경 시 서버에 from/to 전달 확인
    - `TokenCostPage.svelte` — 데이터 로드 확인
    - `CodeImpactPage.svelte` — 데이터 로드 확인
    - `ProjectsPage.svelte` — 데이터 로드 확인
    - `ContextRecoveryPage.svelte` — 데이터 로드 확인
  - 각 페이지의 `onMount`에서 초기 fetch 1회 유지 확인
  - `onMachineChange` 콜백 정상 동작 확인 (머신 전환 시 fetch)
  - 필요 시 페이지별 미세 조정

  **Must NOT do**:
  - 페이지 레이아웃/디자인 변경
  - 새 UI 기능 추가

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 5개 페이지 UI 검증 + 미세 조정
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (T9 이후)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 12
  - **Blocked By**: Task 9

  **References**:
  - `server/frontend/src/components/pages/` — 5개 enrichment 페이지
  - `server/frontend/src/lib/stores/enrichment.ts` — T9에서 리팩터한 store

  **Acceptance Criteria**:
  - [ ] 5개 탭 모두 데이터 로드 성공
  - [ ] 머신 전환 시 데이터 갱신
  - [ ] 빌드 성공: `cd server/frontend && npm run build`

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 5개 탭 데이터 로드 확인
    Tool: Playwright
    Steps:
      1. Navigate to http://localhost:3097
      2. "전체" 모드 선택
      3. Timeline → 데이터 확인
      4. Tokens/Cost → 데이터 확인
      5. Code Impact → 데이터 확인
      6. Projects → 데이터 확인
      7. Context Recovery → 데이터 확인
    Expected Result: 5개 탭 모두 에러 없이 데이터 표시
    Evidence: .sisyphus/evidence/task-10-all-tabs.png
  ```

  **Commit**: YES (T9과 함께)

---

- [x] 11. 신규 테스트 작성 — SQLite, 필터링, SSE, retention

  **What to do**:
  - `server/src/__tests__/enrichment-cache-db.test.ts` 신규:
    - EnrichmentCacheDB 인스턴스 생성/삭제
    - saveFeatureData + loadAllCache 라운드트립
    - timeline_entries 시간 윈도우 쿼리
    - merged 데이터 사전 계산 저장/조회
    - 90일 retention deleteOldEntries
    - 빈 DB에서 loadAllCache → 빈 Map 반환
  - `server/src/__tests__/enrichment-module.test.ts` 업데이트:
    - 기존 Map 기반 테스트가 SQLite 리팩터와 호환되도록 수정
    - Mock DB 또는 in-memory SQLite 사용
  - `server/src/__tests__/enrichment-merge.test.ts` — 시간 윈도우 필터링 테스트 추가

  **Must NOT do**:
  - 기존 통과하는 테스트 삭제
  - 테스트에서 실제 프로덕션 DB 사용

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 다수 테스트 파일 작성/수정
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: Task 12
  - **Blocked By**: Task 5, Task 6, Task 9

  **References**:
  - `server/src/__tests__/enrichment-module.test.ts` — 기존 enrichment 테스트
  - `server/src/__tests__/enrichment-merge.test.ts` — 기존 merge 테스트

  **Acceptance Criteria**:
  - [ ] `cd server && npm test` → 모든 테스트 통과 (기존 + 신규)
  - [ ] enrichment-cache-db.test.ts 최소 6개 테스트
  - [ ] 시간 윈도우 필터링 테스트 포함

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 전체 테스트 통과
    Tool: Bash
    Steps:
      1. `cd server && npm test 2>&1`
      2. Assert: 모든 테스트 통과
    Expected Result: 0 failures
    Evidence: .sisyphus/evidence/task-11-tests.txt
  ```

  **Commit**: YES
  - Message: `test(server): add tests for SQLite persistence, time-window filtering, and retention`

---

- [x] 12. Build + Deploy + QA on 192.168.0.2

  **What to do**:
  - 로컬 빌드 확인: `cd server && npm run build && npm test`
  - 192.168.0.2 배포:
    ```bash
    ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && mkdir -p data && docker compose build --no-cache && docker compose up -d --force-recreate"
    ```
  - 배포 후 QA:
    1. Docker 컨테이너 Up + healthy 확인
    2. SQLite DB 파일 존재 확인: `/app/data/enrichment-cache.db`
    3. 시간 윈도우 필터링 확인: 24h timeline < 50KB
    4. Docker 재기동 후 데이터 유지 확인
    5. 5개 enrichment 탭 정상 확인
    6. MacBook Pro 선택 시 Timeline 정상 확인
    7. SSE 연결 확인 (curl /api/events)

  **Must NOT do**:
  - 소스 코드 수정 (빌드/배포/QA만)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 빌드 + 배포 + 종합 QA
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (마지막)
  - **Blocks**: F1-F4
  - **Blocked By**: All tasks

  **References**:
  - 배포 명령어: `ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard && git pull origin main && cd server && mkdir -p data && docker compose build --no-cache && docker compose up -d --force-recreate"`

  **Acceptance Criteria**:
  - [ ] 빌드 성공 + 테스트 통과
  - [ ] 192.168.0.2 배포 완료 (healthy)
  - [ ] SQLite DB 영속화 확인 (Docker 재기동 후 데이터 유지)
  - [ ] 24h timeline payload < 50KB
  - [ ] 5개 enrichment 탭 정상
  - [ ] SSE 이벤트 수신 확인

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Docker 재기동 후 데이터 유지
    Tool: Bash (SSH)
    Steps:
      1. `ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"before:\", len(d.get(\"data\",[])))'"` 
      2. `ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard/server && docker compose restart"`
      3. 15초 대기
      4. 같은 curl → 데이터 유지 확인
    Expected Result: 재기동 후 동일 데이터 수 반환
    Evidence: .sisyphus/evidence/task-12-restart-test.txt

  Scenario: 24h 시간 윈도우 payload 크기
    Tool: Bash (curl + wc)
    Steps:
      1. NOW=$(date +%s)000; FROM=$((NOW - 86400000))
      2. `ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline?from=$FROM&to=$NOW' | wc -c"`
      3. Assert: < 51200
    Expected Result: 50KB 미만
    Evidence: .sisyphus/evidence/task-12-payload.txt

  Scenario: 5개 탭 + SSE 확인
    Tool: Playwright
    Steps:
      1. Navigate to http://192.168.0.2:3097
      2. 5개 enrichment 탭 순회, 데이터 확인
      3. 콘솔에서 EventSource 연결 확인
    Expected Result: 모든 탭 정상, SSE 연결 활성
    Evidence: .sisyphus/evidence/task-12-final-qa.png
  ```

  **Commit**: NO (배포/QA만)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `npm test` in server/. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify: `INSERT OR REPLACE` NOT used (must be `ON CONFLICT DO UPDATE`).
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test: Docker 재기동 후 데이터 유지, 시간 윈도우 필터링, SSE 연결, 5개 탭 정상 동작, merged 응답 속도. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Commit 1** (T1): `chore(server): validate better-sqlite3 Docker build + add volume mount` — Dockerfile, docker-compose.yml
- **Commit 2** (T2+T3): `feat(server): add SQLite enrichment cache schema and persistence layer` — enrichment-cache-db.ts, types.ts
- **Commit 3** (T4): `feat(agent): add since parameter for incremental enrichment queries` — agent/src/server.ts
- **Commit 4** (T5): `feat(server): refactor EnrichmentModule to use SQLite persistence` — enrichment/index.ts
- **Commit 5** (T6+T7): `feat(server): add time-window filtering + merged pre-computation + SSE notifications` — enrichment/index.ts
- **Commit 6** (T8): `feat(server): add 90-day data retention cleanup` — enrichment-cache-db.ts
- **Commit 7** (T9+T10): `feat(frontend): add SSE-driven enrichment updates, remove HTTP polling` — sse-client.ts, enrichment.ts
- **Commit 8** (T11): `test(server): add tests for SQLite persistence, filtering, SSE, retention` — __tests__/

---

## Success Criteria

### Verification Commands
```bash
# SQLite DB 존재 확인 (Docker 내부)
ssh sbbae@192.168.0.2 "docker exec session-dashboard ls -la /app/data/enrichment-cache.db"

# 시간 윈도우 필터링 확인 (24h)
NOW=$(date +%s000); FROM=$((NOW - 86400000))
ssh sbbae@192.168.0.2 "curl -s 'http://localhost:3097/api/enrichment/merged/timeline?from=$FROM&to=$NOW' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"entries:\", len(d.get(\"data\",[])))'"
# Expected: < 200 (not 1000+)

# Docker 재기동 후 데이터 유지
ssh sbbae@192.168.0.2 "cd /home/sbbae/project/session-dashboard/server && docker compose restart && sleep 15 && curl -s 'http://localhost:3097/api/enrichment/merged/timeline' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"available:\", d.get(\"available\")); print(\"entries:\", len(d.get(\"data\",[])))'"
# Expected: available=True, entries > 0 (즉시, cold start 대기 없음)

# 테스트
cd server && npm test  # Expected: all pass

# 빌드
cd server && npm run build  # Expected: success
```

### Final Checklist
- [ ] 서버 재기동 후 0초 내 enrichment 데이터 제공
- [ ] 24h timeline payload < 50KB
- [ ] 프론트엔드 HTTP 타이머 폴링 제거됨
- [ ] SSE 알림으로 데이터 업데이트
- [ ] 5개 enrichment 탭 모두 정상
- [ ] Docker volume mount로 DB 영속화
- [ ] 90일 이상 데이터 자동 정리
- [ ] 기존 per-machine API 정상 작동
- [ ] 모든 테스트 통과
