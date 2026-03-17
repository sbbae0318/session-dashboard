# Session Dashboard — Regression Test Inventory

> 최종 업데이트: 2026-03-18
> 조사 기반: Production QA (192.168.0.2:3097) + 코드베이스 전수 분석

---

## 1. Production QA에서 발견된 Insight

### 1.1 Dashboard vs Prompt History 세션 불일치

| 항목 | 값 |
|------|-----|
| Dashboard 세션 수 | 32 (top-level only) |
| Sessions API 총 세션 수 | 500 (32 top-level + 468 child) |
| Prompt History unique 세션 수 | 21 |
| Prompt History에 있지만 Dashboard에 없는 세션 | **17개** |

**누락된 세션 예시:**
- `Session count display issue in Dashboard` — Sessions API 500개에도 없음
- `NanoClaw 아키텍처 분석 및 문서화` — Sessions API에는 있지만 Dashboard 미표시
- `Test-TSLoader`, `Harness`, `Epstein: Homepage` — Sessions API에 없음
- `Workstation 대시보드 세션 상태 감지 버그` — Workstation 기기 세션 (0개 반환)
- `tmux resurrect 설정 설치 및 적용`, `bae-settings tmux.conf 적용` — 오래된 세션

### 1.2 근본 원인 분석

#### A. Dashboard 세션 필터링 체인

```
opencode.db (전체 세션)
  → Agent SessionCache (oc-serve SSE 기반, 메모리/SQLite)
    → Server ActiveSessionsModule (2초 폴링)
      → 필터: title !== null || apiStatus !== null
        → Frontend ActiveSessions.svelte
          → 필터: parentSessionId === null (top-level만)
          → 필터: dismissed 세션 제외
```

#### B. Prompt History 데이터 체인

```
opencode.db message 테이블 / oc-serve API
  → Agent OcQueryCollector (30초 수집 사이클)
    → Agent PromptStore (SQLite 영구 저장)
      → Server RecentPromptsModule (2초 폴링)
        → SSE broadcast → Frontend 누적 저장
```

#### C. 불일치 원인 (5가지)

| # | 원인 | 영향 | 심각도 |
|---|------|------|--------|
| 1 | **Frontend SSE 누적 vs API 스냅샷** | Prompt History는 SSE로 누적된 데이터를 보여주지만, Dashboard 세션 목록은 현재 API 응답의 스냅샷만 표시 | High |
| 2 | **SessionCache 한계** | oc-serve 재시작 시 캐시 초기화, 24시간 eviction으로 오래된 세션 소실 | High |
| 3 | **Workstation 세션 0개** | health check는 2/2 connected이지만 Sessions API에서 Workstation 세션 0개 반환 | Medium |
| 4 | **parent_id 필터링** | 468/500 세션이 subagent (child) 세션 → Dashboard에서 제외 (의도된 동작) | Info |
| 5 | **Sessions API 500개 제한** | 오래된 세션이 limit 밖으로 밀려날 수 있음 | Low |

### 1.3 Project Name Display 수정 검증

| 페이지 | 드롭다운 표시 | 결과 |
|--------|-------------|------|
| Timeline | `project/System`, `project/session-dashboard` | ✅ Human-readable |
| CodeImpact | `project/System`, `project/session-dashboard`, `research/r_nanoclaw`, `project/sbsync` | ✅ Human-readable |
| CodeImpact (orphaned) | `8a6027a...`, `b9bef0a...`, `global` | ⚠️ worktree 없는 프로젝트 (COALESCE fallback 정상 동작) |
| Console 에러 | 0개 | ✅ |

---

## 2. 기존 테스트 현황

### 2.1 테스트 러너 및 구조

| 계층 | 러너 | 테스트 디렉토리 | 테스트 수 |
|------|------|----------------|----------|
| Agent | Vitest | `agent/src/__tests__/` | 13개 파일, ~170개 테스트 |
| Server | Vitest | `server/src/__tests__/` | 17개 파일, ~190개 테스트 |
| Server E2E | Playwright | `server/e2e/` | 10개 spec 파일, ~55개 테스트 |
| Frontend | Vitest | `server/frontend/src/lib/__tests__/` | 1개 파일 (utils) |
| **합계** | | | **~415개 이상** |

### 2.2 Agent 단위 테스트 (`agent/src/__tests__/`)

| 파일 | 테스트 수 | 커버리지 영역 |
|------|----------|-------------|
| `active-directories.test.ts` | 14 | `ps` output 파싱, 캐시, 디렉토리 중복 제거 |
| `auth.test.ts` | 17 | Bearer/JWT 인증, dev mode bypass, 라우트 skip |
| `claude-heartbeat.test.ts` | 18 | Heartbeat 감지, busy/idle 판정, title 추출, stale eviction |
| `claude-source.test.ts` | 18 | history.jsonl 파싱, slash command 필터, system prompt 필터 |
| `jsonl-reader.test.ts` | 8 | JSONL 파싱, prefix 처리, malformed JSON 건너뛰기 |
| `oc-query-collector.test.ts` | 18 | multi-project 수집, fallback, background 세션, timestamp |
| `oc-serve-proxy.test.ts` | 12 | oc-serve 프록시 라우트, 502 처리, JWT 인증 |
| `opencode-db-reader.test.ts` | 19+ | SQLite 쿼리, 토큰 비용, code impact, directory→worktree 매핑 |
| `prompt-extractor.test.ts` | 15 | system prompt 필터, mode prefix strip, background 감지 |
| `prompt-store.test.ts` | 19 | SQLite CRUD, eviction, batch insert, isBackground 변환 |
| `server-claude.test.ts` | 8 | Claude 라우트 등록/미등록, health 응답 |
| `server-queries.test.ts` | 5 | /api/queries 라우트, limit 파싱, 빈 응답 |
| `session-cache.test.ts` | 19 | SSE 이벤트, waitingForInput, bootstrap, lastPrompt 갱신 |
| `session-store.test.ts` | 12 | SessionStore CRUD, eviction, null 필드 보존 |

### 2.3 Server 단위 테스트 (`server/src/__tests__/`)

| 파일 | 테스트 수 | 커버리지 영역 |
|------|----------|-------------|
| `active-sessions.test.ts` | 16 | orphan synthesis, ghost filter, previousSessionMap 보존 |
| `active-sessions-claude.test.ts` | 13 | Claude 세션 매핑, source 필드, timestamp 필드 |
| `aggregation.test.ts` | 7 | 다중 머신 데이터 병합, 정렬, 실패 머신 처리 |
| `enrichment-cache-db.test.ts` | 12 | SQLite 캐시, timeline 저장/조회, background 필터 |
| `enrichment-merge.test.ts` | 12 | 다중 머신 timeline 병합, 시간 윈도우 필터, HTTP 라우트 |
| `enrichment-module.test.ts` | 7 | 폴링, SSE broadcast, 라우트 등록 |
| `event-stream.test.ts` | 8 | SSE client 관리, heartbeat, broadcast |
| `jsonl-reader.test.ts` | 11 | JSONL 파싱, watchFile, 빈 파일 |
| `machine-manager.test.ts` | 9 | 머신 초기화, pollAll, 콜백 |
| `machine-manager-active-dirs.test.ts` | 10 | active-directories 병합, 중복 제거, global project |
| `machine-manager-source.test.ts` | 14 | source별 폴링, mixed machines |
| `machines-config.test.ts` | 16 | YAML 파싱, 유효성 검증, timeout |
| `memo-db.test.ts` | 12 | 메모 CRUD, 필터, migration |
| `memo-fs.test.ts` | 7 | 파일 경로, MD 파일 쓰기/읽기 |
| `memo-module.test.ts` | ~15 | HTTP 라우트, CRUD, 필터 |
| `queries-reader.test.ts` | 5 | 쿼리 파싱, limit, background |
| `recent-prompts-source.test.ts` | 11 | source 필드, Claude/OpenCode 혼합, sessionTitle null 보존 |
| `server.test.ts` | 4 | health, 기본 API 라우트, 404 |

### 2.4 E2E 테스트 (`server/e2e/`)

| 파일 | 시나리오 수 | 커버리지 영역 |
|------|-----------|-------------|
| `api.spec.ts` | 3 | health, queries, sessions 기본 API |
| `claude-code.spec.ts` | 4 | Claude 쿼리 source, slash command 필터, 세션 필드 |
| `claude-real-pipeline.spec.ts` | 6 | JSONL → Agent → Server → Browser 전체 파이프라인 |
| `claude-regression.spec.ts` | 8 | Prompt, slash filter, busy/idle, source filter, stale, timestamp |
| `dashboard.spec.ts` | 4 | 페이지 로드, 패널 렌더링, connection status |
| `dashboard-features.spec.ts` | 10 | 프롬프트 클릭 필터, 전문 모달, background 토글, 커맨드 복사 |
| `enrichment.spec.ts` | 14 | 6개 탭 네비게이션, URL 라우팅, 컨텐츠 렌더링 |
| `machine-api.spec.ts` | 4 | /api/machines, apiKey 미노출 |
| `machine-filter.spec.ts` | 3 | 머신 필터 UI, active 상태 |
| `machine-status.spec.ts` | 4 | 상태 dot, 머신 태그, 스크린샷 |
| `opencode-regression.spec.ts` | 5 | OpenCode 쿼리 파이프라인, source 필터, empty state, long session |

### 2.5 기존 Regression Test 문서

| 문서 | 위치 | 내용 |
|------|------|------|
| `docs/regression-test-plan.md` | 프로젝트 루트 | Claude Code 타임스탬프 버그 (11개 섹션), Prompt History 버그 3건의 수동 + 자동 테스트 시나리오 |

---

## 3. 커버리지 Gap 분석

### 3.1 테스트 없음 (Critical)

| # | 영역 | 설명 | 위험도 |
|---|------|------|--------|
| **G1** | Dashboard ↔ Prompt History 세션 일관성 | Prompt History에 보이는 세션이 Dashboard에도 보이는지 검증 없음 | 🔴 High |
| **G2** | Workstation 세션 반환 | 다중 머신 환경에서 Workstation이 0개 세션을 반환하는 상황 미검증 | 🔴 High |
| **G3** | Frontend SSE 누적 데이터 정합성 | SSE로 누적된 프론트엔드 데이터가 API 데이터와 일치하는지 검증 없음 | 🔴 High |
| **G4** | Project name display (directory→worktree) | Timeline/CodeImpact 드롭다운에서 worktree 경로 표시 검증 없음 | 🟡 Medium |
| **G5** | SessionCache eviction 후 세션 소실 | 24시간 eviction 후 세션이 올바르게 처리되는지 검증 없음 | 🟡 Medium |
| **G6** | parent_id 필터링 정확성 | child 세션이 Dashboard에서 정확히 숨겨지고 Timeline에서는 보이는지 교차 검증 없음 | 🟡 Medium |
| **G7** | 프론트엔드 컴포넌트 단위 테스트 | ActiveSessions.svelte, RecentPrompts.svelte 등 핵심 컴포넌트 테스트 없음 | 🟡 Medium |
| **G8** | Enrichment 드롭다운 필터 기능 | Timeline/CodeImpact 프로젝트 드롭다운 선택 시 올바른 필터링 검증 없음 | 🟡 Medium |
| **G9** | Docker 재시작 후 데이터 복구 | 컨테이너 재생성 후 SQLite 캐시 데이터 보존 검증 없음 | 🟢 Low |
| **G10** | Memo CRUD E2E | 메모 생성/수정/삭제 전체 파이프라인 E2E 테스트 없음 | 🟢 Low |

### 3.2 테스트 있지만 불충분

| # | 영역 | 현재 상태 | 보강 필요 |
|---|------|----------|----------|
| **P1** | Claude timestamp regression | 단위 테스트 + E2E 있음 | lastResponseTime 기반 정렬 E2E 추가 필요 |
| **P2** | Multi-project session collection | 단위 테스트 있음 | E2E 파이프라인 테스트 없음 |
| **P3** | Background session 필터링 | enrichment-cache-db 테스트 있음 | Dashboard에서 background 세션 미표시 E2E 없음 |
| **P4** | Session title backfill | 수동 시나리오만 문서화 | 자동화된 E2E 없음 |

---

## 4. 신규 Regression Test 제안

### 4.1 🔴 Critical — 즉시 추가 권장

#### RT-01: Dashboard ↔ Prompt History 세션 가시성 일관성
**Gap**: G1
**유형**: E2E (Playwright)
**파일**: `server/e2e/session-visibility-regression.spec.ts`

```
시나리오: 모든 Prompt History 세션이 Dashboard에 존재하는지 검증
  1. Agent에 3개 top-level 세션 (서로 다른 프로젝트) 생성
  2. 각 세션에 프롬프트 기록
  3. /api/queries에서 세션 목록 수집
  4. /api/sessions에서 세션 목록 수집
  5. queries의 모든 sessionId가 sessions에도 존재하는지 검증
  6. Browser에서 Dashboard 세션 목록과 Prompt History 비교
```

#### RT-02: 다중 머신 세션 반환 검증
**Gap**: G2
**유형**: E2E (Playwright)
**파일**: `server/e2e/multi-machine-regression.spec.ts`

```
시나리오: 각 머신이 최소 1개 이상 세션을 반환하는지 검증
  1. /api/sessions 호출
  2. 응답에서 machineAlias별 세션 수 집계
  3. /health의 connectedMachines 수와 비교
  4. connected 상태인 머신이 0개 세션을 반환하면 WARNING 기록
  5. Browser에서 "전체" 머신 필터 시 모든 머신 세션 표시 검증
```

#### RT-03: SSE 누적 데이터 vs API 스냅샷 정합성
**Gap**: G3
**유형**: E2E (Playwright)
**파일**: `server/e2e/sse-data-consistency.spec.ts`

```
시나리오: SSE로 수신한 프론트엔드 데이터가 API와 일치하는지 검증
  1. Browser에서 Dashboard 로드
  2. 10초 대기 (SSE 데이터 축적)
  3. Browser의 세션 수 캡처 (JavaScript evaluate)
  4. /api/sessions에서 top-level 세션 수 조회
  5. Browser 세션 수 ≤ API 세션 수 검증 (dismissed 제외)
  6. Prompt History 세션 수 ≤ /api/queries 고유 세션 수 검증
```

### 4.2 🟡 Medium — 다음 스프린트 추가 권장

#### RT-04: Project Name Display (directory→worktree 매핑)
**Gap**: G4
**유형**: E2E (Playwright)
**파일**: `server/e2e/project-name-regression.spec.ts`

```
시나리오 A: Timeline 드롭다운에 human-readable 프로젝트명 표시
  1. Timeline 페이지 네비게이션
  2. 프로젝트 드롭다운 option 텍스트 수집
  3. SHA-1 해시 패턴 ([a-f0-9]{40}) 매칭 검증
  4. 정상 경로 (예: project/xxx, sbbae/xxx)가 표시되는지 검증

시나리오 B: CodeImpact 드롭다운 동일 검증

시나리오 C: 프로젝트 선택 시 필터 기능 정상 동작 검증
  1. 특정 프로젝트 선택
  2. 표시된 항목이 모두 선택 프로젝트에 속하는지 검증
  3. "All Projects" 재선택 시 전체 표시 복원 검증
```

#### RT-05: SessionCache Eviction 후 세션 처리
**Gap**: G5
**유형**: 단위 테스트 (Vitest)
**파일**: `agent/src/__tests__/session-cache.test.ts` (추가)

```
시나리오: 24시간 eviction 후 세션 상태
  1. 25시간 전 timestamp의 세션 캐시 생성
  2. evict() 호출
  3. 해당 세션이 getSessionDetails()에서 제거 확인
  4. 같은 세션의 프롬프트가 PromptStore에는 남아있는지 확인
```

#### RT-06: parent_id 필터링 교차 검증
**Gap**: G6
**유형**: E2E (Playwright)
**파일**: `server/e2e/parent-filter-regression.spec.ts`

```
시나리오: child 세션의 Dashboard 미표시 + Timeline 표시
  1. parent + child 세션 쌍 생성
  2. Dashboard에서 child 세션 미표시 검증
  3. Timeline에서 child 세션 표시 검증 (or 필터에 따라)
  4. CodeImpact에서 child 세션 데이터 표시 검증
```

#### RT-07: Enrichment 드롭다운 필터 기능
**Gap**: G8
**유형**: E2E (Playwright)
**파일**: `server/e2e/enrichment-filter-regression.spec.ts`

```
시나리오 A: Timeline 프로젝트 필터
  1. Timeline 페이지 로드
  2. 프로젝트 선택
  3. SVG의 세션 레인이 선택 프로젝트에만 해당하는지 검증

시나리오 B: CodeImpact 프로젝트 필터
  1. CodeImpact 페이지 로드
  2. 프로젝트 선택
  3. impact-item의 project-path가 선택 프로젝트에만 해당하는지 검증
```

### 4.3 🟢 Low — 여유 있을 때 추가

#### RT-08: Memo CRUD E2E 파이프라인
**Gap**: G10
**유형**: E2E (Playwright)
**파일**: `server/e2e/memo-regression.spec.ts`

```
시나리오: 메모 생성 → 조회 → 수정 → 삭제
  1. Memos 탭 네비게이션
  2. 프로젝트 선택 + "새 메모" 클릭
  3. 제목/내용 입력 → 저장 검증
  4. 사이드바에 메모 항목 표시 검증
  5. 메모 수정 → 내용 변경 검증
  6. 메모 삭제 → 목록에서 제거 검증
```

#### RT-09: Docker 재시작 후 데이터 복구
**Gap**: G9
**유형**: 수동 또는 스크립트
**파일**: `docs/regression-test-plan.md` (섹션 추가)

```
시나리오: Docker 컨테이너 재생성 후 상태 복구
  1. docker compose up -d --force-recreate
  2. 10초 대기 후 /health 확인
  3. /api/sessions에서 세션 목록 비어있지 않은지 확인
  4. enrichment 캐시 (timeline, impact) 재구축 확인
  5. 메모 데이터 보존 확인 (volume mount)
```

#### RT-10: Frontend 컴포넌트 단위 테스트
**Gap**: G7
**유형**: Vitest + @testing-library/svelte
**파일**: `server/frontend/src/components/__tests__/`

```
대상 컴포넌트:
  - ActiveSessions.svelte: dismiss 기능, parent 필터, 머신 필터
  - RecentPrompts.svelte: background 토글, session 필터링, 세션 이름 fallback
  - TimelinePage.svelte: projectDirectoryMap 매핑, shortPath 표시
  - CodeImpactPage.svelte: projectDirectoryMap 매핑, 필터 기능
```

---

## 5. 우선순위 실행 로드맵

| 순위 | ID | 테스트 | 예상 공수 | 의존성 |
|------|-----|--------|----------|--------|
| 1 | RT-01 | Dashboard ↔ Prompt History 일관성 | 4h | 없음 |
| 2 | RT-04 | Project Name Display 드롭다운 | 2h | 없음 |
| 3 | RT-02 | 다중 머신 세션 반환 | 3h | 다중 머신 E2E 환경 |
| 4 | RT-07 | Enrichment 드롭다운 필터 | 2h | 없음 |
| 5 | RT-05 | SessionCache eviction | 1h | 없음 |
| 6 | RT-06 | parent_id 교차 검증 | 3h | 없음 |
| 7 | RT-03 | SSE 정합성 | 4h | 없음 |
| 8 | RT-08 | Memo CRUD E2E | 3h | 없음 |
| 9 | RT-09 | Docker 복구 | 1h (수동) | 프로덕션 접근 |
| 10 | RT-10 | Frontend 컴포넌트 | 8h | @testing-library/svelte 도입 |

---

## 6. 테스트 실행 가이드

### Agent 테스트
```bash
cd agent && npm test
# 결과: ~170 tests, 13 files
```

### Server 단위 테스트
```bash
cd server && npm test
# 결과: ~190 tests, 17 files
```

### E2E 테스트 (OpenCode)
```bash
cd server && npx playwright test --config=playwright.opencode.config.ts
# 전제: test agent (3198) + test server (3099) 실행 중
```

### E2E 테스트 (Claude Code)
```bash
cd server && npx playwright test --config=playwright.claude.config.ts
# 전제: test agent (3199) + test server (3098) 실행 중
```

### Frontend 빌드 검증
```bash
cd server/frontend && npm run build
# vite build — 에러 0개 확인
```

---

## 7. 참고 문서

| 문서 | 경로 | 내용 |
|------|------|------|
| Claude 타임스탬프 Regression Plan | `docs/regression-test-plan.md` | Bug 1~3 수동/자동 테스트 시나리오 |
| Architecture 문서 | `docs/architecture.md` | 전체 시스템 구조 |
| E2E Helper (OpenCode) | `server/e2e/helpers/opencode-data.ts` | PromptStore 직접 쓰기 유틸리티 |
| E2E Helper (Claude) | `server/e2e/helpers/claude-data.ts` | JSONL/heartbeat 파일 쓰기 유틸리티 |
| E2E Fixtures | `server/e2e/fixtures/` | 테스트 데이터 파일 |
