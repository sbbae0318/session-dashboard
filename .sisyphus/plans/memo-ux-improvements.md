# 메모 기능 UX 개선: 머신 구분 + 랜딩 피드 + 프로젝트 독립성

## TL;DR

> **Quick Summary**: 메모 기능에 머신(장비)별 구분을 추가하고, 첫 진입 시 최신 메모 20개 피드를 표시하며, enrichment 없이도 프로젝트 선택이 가능하도록 개선. 사이드바 본문 미리보기와 키보드 단축키도 추가.
> 
> **Deliverables**:
> - DB 스키마에 `machine_id` 컬럼 추가 + 자동 마이그레이션
> - 파일 경로 구조 변경: `{machineId}/{slug}/date.md`
> - API: `machineId` 필터, `snippet` 필드, `/feed` 엔드포인트, `/projects` 엔드포인트
> - 프론트엔드: 랜딩 피드, 프로젝트 목록 독립성, 사이드바 미리보기, 키보드 단축키
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 7 → Task 8 → Task 10

---

## Context

### Original Request
메모 디렉토리를 장비별로 표시해야 함 (현재는 장비 구분 없음). Memos 처음 들어갔을 때 최신 메모 X개 표시. UX 관련 개선사항 제안.

### Interview Summary
**Key Discussions**:
- 개선 범위: 머신 구분 + 최신 피드 + 프로젝트 독립성 + 미리보기 + 단축키 (5개 모두)
- 최신 메모 개수: 20개
- 마이그레이션: 자동 (기존 메모에 첫 번째 머신 ID 할당)
- 검색 기능: 이번 범위에서 제외
- 테스트: TDD

**Research Findings**:
- MemoModule 생성자에 MachineManager 접근 없음 → `defaultMachineId` 파라미터 추가 필요
- `MEMO_DB_PATH`는 기본적으로 enrichment DB와 같은 파일 사용 (안전, 테이블명 다름)
- App.svelte의 글로벌 키보드 핸들러는 INPUT/TEXTAREA에서 early return → Cmd+S는 이 가드 이전에 처리해야 함
- enrichment.ts는 writable() 패턴 사용 (Svelte 4), memo는 $state 사용 (Svelte 5) — 혼재 유지
- ProjectSummary: `{ id, worktree, sessionCount, totalCost, lastActivity }` — enrichment에서 옴

### Metis Review
**Identified Gaps** (addressed):
- MemoModule에 machineId 접근 필요 → 생성자에 `defaultMachineId` 추가, 프론트엔드 요청에 `machineId` 포함
- "전체 머신" 선택 시 메모 생성 → 머신 선택 필수로 강제 (multi-machine 환경에서만)
- 기존 file_path 건드리지 않음 → 새 메모만 `{machineId}/{slug}/date.md` 구조 사용
- frontmatter에 machine 필드 추가 → Obsidian 호환성 유지
- 랜딩 피드가 머신 필터 존중해야 함 → 글로벌 머신 선택에 연동
- Cmd+S는 INPUT/TEXTAREA 가드 이전에 체크해야 함 → 가드 로직 수정

---

## Work Objectives

### Core Objective
메모 기능을 다중 머신 환경에 적합하도록 업그레이드하고, 빈 랜딩 페이지 대신 최신 메모 피드를 제공하여 사용자 경험 개선.

### Concrete Deliverables
- `memos` 테이블에 `machine_id` 컬럼 + 인덱스
- `MemoFS.resolveFilePath(machineId, slug, date)` — 머신 접두사 경로
- `GET /api/memos` — `machineId` 필터 파라미터 + `snippet` 필드
- `GET /api/memos/feed?limit=20&machineId=X` — 전체 최신 메모 피드
- `GET /api/memos/projects?machineId=X` — 메모 기반 프로젝트 목록
- `POST /api/memos` — `machineId` 필수 필드
- 프론트엔드 `Memo` 타입에 `machineId`, `machineAlias` 추가
- MemosPage: 프로젝트 미선택 시 피드 표시, 프로젝트 드롭다운 독립, 사이드바 snippet
- 키보드 단축키: Cmd+N (새 메모), Cmd+S (저장)

### Definition of Done
- [ ] `bun test` — 전체 테스트 통과 (기존 27개 + 신규)
- [ ] `curl /api/memos?machineId=macbook` — 머신별 필터 작동
- [ ] `curl /api/memos/feed?limit=5` — 최신 메모 피드 반환 (snippet 포함)
- [ ] `curl /api/memos/projects` — 메모 기반 프로젝트 목록 반환
- [ ] 기존 메모 machine_id 마이그레이션 완료 (`SELECT COUNT(*) FROM memos WHERE machine_id = ''` → 0)

### Must Have
- DB machine_id 컬럼 + 자동 마이그레이션
- 새 메모 생성 시 machineId 필수
- 랜딩 피드 (프로젝트 미선택 시)
- enrichment 없이도 프로젝트 선택 가능
- 사이드바 snippet 미리보기
- Cmd+N, Cmd+S 단축키

### Must NOT Have (Guardrails)
- 검색/필터-by-content 기능 (명시적 제외)
- 기존 메모 파일 이동 (마이그레이션 시 file_path 유지, 파일 위치 변경 없음)
- enrichment.ts writable→$state 리팩토링
- MemosPage.svelte 구조 리팩토링 (기존 패턴에 추가)
- 무한 스크롤/페이지네이션 컨트롤
- 메모 태그/카테고리
- 머신 간 메모 공유
- Cmd+N, Cmd+S 외 추가 단축키
- 'unsaved changes' 경고

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun test, vitest)
- **Automated tests**: TDD
- **Framework**: bun test (vitest)
- **Each task follows RED → GREEN → REFACTOR**

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Frontend/UI**: Use Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — DB + types foundation):
├── Task 1: DB schema migration (machine_id) + MemoDB methods [deep]
├── Task 2: MemoFS machine-prefixed paths [quick]
└── Task 3: Backend types update (machine_id in all interfaces) [quick]

Wave 2 (After Wave 1 — API endpoints, MAX PARALLEL):
├── Task 4: MemoModule API updates (machineId filter + snippet) [deep]
├── Task 5: Feed endpoint (/api/memos/feed) [unspecified-high]
├── Task 6: Projects endpoint (/api/memos/projects) [quick]
└── Task 7: cli.ts wiring (defaultMachineId, MemoModule constructor) [quick]

Wave 3 (After Wave 2 — Frontend):
├── Task 8: Frontend types + store updates [quick]
├── Task 9: MemosPage landing feed component [visual-engineering]
├── Task 10: Project dropdown independence [unspecified-high]
└── Task 11: Sidebar snippet preview [quick]

Wave 4 (After Wave 3 — Polish + Integration):
├── Task 12: Keyboard shortcuts (Cmd+N, Cmd+S) [quick]
└── Task 13: Integration test + Docker rebuild [deep]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 4 → Task 7 → Task 8 → Task 9 → Task 13 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 4 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 4, 5, 6, 7 | 1 |
| 2 | — | 4, 7 | 1 |
| 3 | — | 4, 5, 6, 8 | 1 |
| 4 | 1, 2, 3 | 7, 8 | 2 |
| 5 | 1, 3 | 8, 9 | 2 |
| 6 | 1, 3 | 8, 10 | 2 |
| 7 | 1, 2, 4 | 13 | 2 |
| 8 | 3, 4, 5, 6 | 9, 10, 11, 12 | 3 |
| 9 | 8 | 13 | 3 |
| 10 | 8 | 13 | 3 |
| 11 | 8 | 13 | 3 |
| 12 | 8 | 13 | 4 |
| 13 | 7, 9, 10, 11, 12 | F1-F4 | 4 |

### Agent Dispatch Summary

- **Wave 1**: **3 tasks** — T1 → `deep`, T2 → `quick`, T3 → `quick`
- **Wave 2**: **4 tasks** — T4 → `deep`, T5 → `unspecified-high`, T6 → `quick`, T7 → `quick`
- **Wave 3**: **4 tasks** — T8 → `quick`, T9 → `visual-engineering`, T10 → `unspecified-high`, T11 → `quick`
- **Wave 4**: **2 tasks** — T12 → `quick`, T13 → `deep`
- **FINAL**: **4 tasks** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. DB 스키마 마이그레이션: machine_id 컬럼 추가 + MemoDB 메서드 업데이트

  **What to do**:
  - `MemoDB.initSchema()`에 마이그레이션 추가: `ALTER TABLE memos ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''` (try-catch로 이미 존재 시 무시)
  - 인덱스 추가: `CREATE INDEX IF NOT EXISTS idx_memos_machine ON memos(machine_id, date DESC)`
  - 기존 인덱스 `idx_memos_project`를 `(machine_id, project_id, date DESC)`로 업데이트
  - `MemoDB.insert()` — `machine_id` 바인딩 추가
  - `MemoDB.list()` — `machineId` 필터 파라미터 지원 (`WHERE machine_id = :machineId`)
  - `MemoDB.listProjects(machineId?)` 메서드 추가 — `SELECT DISTINCT project_id, project_slug, machine_id FROM memos`
  - `MemoDB.listFeed(limit, machineId?)` 메서드 추가 — 전체 최신 메모 조회 (projectId 필터 없이, `ORDER BY updated_at DESC LIMIT :limit`)
  - 마이그레이션 함수: `migrateExistingMemos(defaultMachineId)` — `UPDATE memos SET machine_id = :machineId WHERE machine_id = ''`
  - TDD: 테스트 먼저 작성
    - `memo-db.test.ts`에 새 테스트 그룹 추가: "machine_id migration", "list with machineId filter", "listProjects", "listFeed"
    - 마이그레이션 테스트: in-memory DB에 machine_id 없는 레코드 삽입 → migrateExistingMemos 호출 → SELECT로 machine_id 확인
    - list 필터 테스트: 서로 다른 machineId 메모 3개 삽입 → `list({machineId: 'a'})` → 해당 머신 메모만 반환 확인

  **Must NOT do**:
  - 기존 file_path 값 변경
  - DROP TABLE 또는 기존 데이터 삭제
  - ORM 도입

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: DB 스키마 마이그레이션 + 여러 메서드 추가 + TDD 사이클이 필요한 복합 작업
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `mcp-context7`: better-sqlite3 docs는 이미 알려진 API

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5, 6, 7
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/memo-db.ts:12-28` — 현재 initSchema() 패턴. ALTER TABLE은 try-catch로 감싸서 이미 추가된 경우 무시
  - `server/src/modules/memos/memo-db.ts:55-77` — 현재 list() 메서드. 여기에 machineId 필터 조건 추가
  - `server/src/modules/memos/memo-db.ts:31-46` — insert() 메서드. machine_id 바인딩 추가

  **API/Type References**:
  - `server/src/modules/memos/types.ts:1-10` — Memo 인터페이스. machineId 필드 추가
  - `server/src/modules/memos/types.ts:28-33` — MemoListQuery. machineId 필터 추가
  - `server/src/modules/memos/types.ts:35-44` — MemoRow. machine_id 컬럼 매핑 추가

  **Test References**:
  - `server/src/__tests__/memo-db.test.ts` — 기존 15개 테스트. 같은 패턴으로 신규 테스트 추가

  **Acceptance Criteria**:

  - [ ] `ALTER TABLE` 마이그레이션이 idempotent (두 번 실행해도 에러 없음)
  - [ ] `bun test server/src/__tests__/memo-db.test.ts` → PASS (기존 15 + 신규 ~8개)
  - [ ] `migrateExistingMemos('macbook')` 후 `SELECT COUNT(*) FROM memos WHERE machine_id = ''` → 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: machine_id 마이그레이션 후 필터링
    Tool: Bash (bun test)
    Preconditions: clean in-memory DB
    Steps:
      1. MemoDB 생성 (새 DB) → memos 테이블에 machine_id 컬럼 확인
      2. machine_id='machineA' 메모 2개, 'machineB' 메모 1개 삽입
      3. list({machineId: 'machineA'}) 호출
    Expected Result: machineA 메모 2개만 반환
    Failure Indicators: 3개 반환 또는 에러
    Evidence: .sisyphus/evidence/task-1-machine-filter.txt

  Scenario: 마이그레이션 idempotency
    Tool: Bash (bun test)
    Preconditions: machine_id 컬럼이 이미 존재하는 DB
    Steps:
      1. initSchema() 두 번 호출
    Expected Result: 에러 없이 완료
    Failure Indicators: "duplicate column name" 에러
    Evidence: .sisyphus/evidence/task-1-migration-idempotent.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): add machine_id to schema with auto-migration`
  - Files: `server/src/modules/memos/memo-db.ts`, `server/src/modules/memos/types.ts`, `server/src/__tests__/memo-db.test.ts`
  - Pre-commit: `bun test server/src/__tests__/memo-db.test.ts`

- [x] 2. MemoFS 머신 접두사 경로 지원

  **What to do**:
  - `MemoFS.resolveFilePath(projectSlug, date)` → `resolveFilePath(machineId, projectSlug, date)` 시그니처 변경
  - 반환 경로: `{machineId}/{projectSlug}/{date}.md` (기존: `{projectSlug}/{date}.md`)
  - 충돌 감지도 머신 접두사 경로에서 수행
  - `MemoFS.write()` opts에 `machineId` 추가 → frontmatter에 `machine: {machineId}` 필드 추가
  - `MemoFS.read(filePath)` — 변경 없음 (DB의 file_path 사용)
  - TDD: 테스트 먼저
    - resolveFilePath('macbook', 'my-project', '2024-01-15') → 'macbook/my-project/2024-01-15.md'
    - 충돌 시 'macbook/my-project/2024-01-15-2.md'
    - frontmatter에 machine 필드 포함 확인

  **Must NOT do**:
  - 기존 파일 이동/복사
  - read() 함수 시그니처 변경

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 파일 경로 로직 변경만 필요. 단순한 문자열 조작
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 4, 7
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/memo-fs.ts:58-68` — 현재 resolveFilePath. machineId 접두사 추가
  - `server/src/modules/memos/memo-fs.ts:27-36` — 현재 frontmatter 생성. machine 필드 추가 위치

  **Acceptance Criteria**:

  - [ ] `resolveFilePath('macbook', 'session-dashboard', '2024-01-15')` → `'macbook/session-dashboard/2024-01-15.md'`
  - [ ] 작성된 MD 파일 frontmatter에 `machine: macbook` 포함
  - [ ] `bun test` — 관련 테스트 PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 머신 접두사 경로 생성
    Tool: Bash (bun test)
    Preconditions: 임시 디렉토리
    Steps:
      1. MemoFS 인스턴스 생성 (tmpDir)
      2. resolveFilePath('macbook', 'my-project', '2024-01-15') 호출
    Expected Result: 'macbook/my-project/2024-01-15.md' 반환
    Evidence: .sisyphus/evidence/task-2-path-prefix.txt

  Scenario: frontmatter에 machine 필드 포함
    Tool: Bash (bun test)
    Preconditions: 임시 디렉토리
    Steps:
      1. MemoFS.write({..., machineId: 'macbook'}) 호출
      2. 생성된 파일 읽기
    Expected Result: frontmatter에 'machine: macbook' 줄 존재
    Evidence: .sisyphus/evidence/task-2-frontmatter-machine.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): support machine-prefixed file paths in MemoFS`
  - Files: `server/src/modules/memos/memo-fs.ts`
  - Pre-commit: `bun test`

- [x] 3. 백엔드 타입 업데이트 (machine_id 전체 반영)

  **What to do**:
  - `server/src/modules/memos/types.ts`:
    - `Memo` 인터페이스에 `machineId: string` 추가
    - `MemoRow`에 `machine_id: string` 추가
    - `MemoListQuery`에 `machineId?: string` 추가
    - `CreateMemoRequest`에 `machineId: string` 추가 (필수)
    - 새 인터페이스: `MemoFeedQuery { limit?: number; machineId?: string }`
    - 새 인터페이스: `MemoProject { projectId: string; projectSlug: string; machineId: string; memoCount: number }`
    - 새 인터페이스: `MemoWithSnippet extends Memo { snippet: string }`
  - `memo-db.ts`의 `rowToMemo()` — machineId 매핑 추가
  - TDD: 타입은 컴파일 타임 검증. `tsc --noEmit`으로 타입 에러 없음 확인

  **Must NOT do**:
  - 프론트엔드 types.ts 수정 (Task 8에서 별도 처리)
  - 런타임 로직 변경 (타입만)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 정의 추가만. 로직 변경 없음
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5, 6, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/types.ts` — 전체 파일. 기존 인터페이스에 필드 추가 + 신규 인터페이스

  **API/Type References**:
  - `server/src/modules/memos/memo-db.ts:111-122` — rowToMemo() 매핑 함수. machineId 추가

  **Acceptance Criteria**:

  - [ ] `tsc --noEmit` 에러 없음
  - [ ] Memo 인터페이스에 machineId 존재
  - [ ] MemoWithSnippet 인터페이스 존재

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 타입 컴파일 검증
    Tool: Bash
    Steps:
      1. cd server && npx tsc --noEmit
    Expected Result: 에러 없이 완료 (exit code 0)
    Failure Indicators: TS2322 또는 TS2339 에러
    Evidence: .sisyphus/evidence/task-3-tsc-check.txt

  Scenario: rowToMemo에 machineId 포함
    Tool: Bash (bun test)
    Steps:
      1. memo-db.test.ts에서 insert 후 getById
      2. 반환된 Memo 객체에 machineId 필드 존재 확인
    Expected Result: machineId 값이 삽입한 값과 일치
    Evidence: .sisyphus/evidence/task-3-row-mapping.txt
  ```

  **Commit**: YES (Task 1과 합쳐서 커밋 가능)
  - Message: `feat(memo): add machineId to all backend types`
  - Files: `server/src/modules/memos/types.ts`, `server/src/modules/memos/memo-db.ts`
  - Pre-commit: `bun test`

- [x] 4. MemoModule API 업데이트: machineId 필터 + snippet

  **What to do**:
  - `POST /api/memos` — `body.machineId` 필수 (없으면 400 에러). MemoFS.resolveFilePath에 machineId 전달
  - `GET /api/memos` — query에 `machineId` 파라미터 추가, MemoDB.list()에 전달
  - `GET /api/memos` — 응답에 `snippet` 필드 추가. 각 메모의 filePath로 MemoFS.read() 후 첫 100자 추출 (또는 read 부담 시 DB에 snippet 컬럼 추가 고려 → **DB에서 하지 않고 API 레벨에서 처리**)
  - snippet 생성 로직: `MemoFS.readSnippet(filePath, maxChars=100)` — frontmatter 제거 후 첫 100자 + `…` truncation
  - `GET /api/memos/:id` — 응답에 machineId 포함 확인
  - `PUT /api/memos/:id` — machineId는 수정 불가 (원본 유지)
  - MemoModule 생성자 시그니처: `MemoModule(db, memoDir)` → `MemoModule(db, memoDir, defaultMachineId)` — defaultMachineId는 마이그레이션용
  - 생성자에서 `this.memoDB.migrateExistingMemos(defaultMachineId)` 호출
  - TDD: memo-module.test.ts 업데이트
    - POST 시 machineId 필수 테스트
    - GET 리스트에 machineId 필터 테스트
    - GET 리스트에 snippet 포함 확인
    - machineId 없이 POST → 400 에러

  **Must NOT do**:
  - PUT으로 machineId 변경 허용
  - snippet을 DB에 저장 (파일에서 동적 추출)
  - 기존 12개 테스트 삭제 (업데이트만)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: API 엔드포인트 수정 + TDD + 통합 테스트 업데이트가 복합적
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7 — but 4 is complex and touches shared files)
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/index.ts:23-136` — 현재 registerRoutes 전체. 각 라우트에 machineId 로직 추가
  - `server/src/modules/memos/index.ts:52-89` — POST 핸들러. machineId 파라미터 추가
  - `server/src/modules/memos/index.ts:24-38` — GET 리스트 핸들러. machineId 필터 + snippet

  **Test References**:
  - `server/src/__tests__/memo-module.test.ts` — 기존 12개 통합 테스트. Fastify inject 패턴

  **Acceptance Criteria**:

  - [ ] `POST /api/memos` 에 machineId 없으면 400
  - [ ] `GET /api/memos?machineId=macbook` — 해당 머신 메모만 반환
  - [ ] `GET /api/memos` 응답 각 항목에 `snippet` 필드 (string, ≤103자)
  - [ ] `bun test server/src/__tests__/memo-module.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: machineId 없이 메모 생성 시 400
    Tool: Bash (curl)
    Steps:
      1. curl -s -X POST http://localhost:3097/api/memos -H 'Content-Type: application/json' -d '{"projectId":"/test","content":"test"}'
    Expected Result: HTTP 400, body contains "machineId"
    Evidence: .sisyphus/evidence/task-4-missing-machineid.txt

  Scenario: machineId 필터링
    Tool: Bash (curl)
    Steps:
      1. 머신 A, B에 각각 메모 생성
      2. GET /api/memos?machineId=A
    Expected Result: 머신 A 메모만 반환
    Evidence: .sisyphus/evidence/task-4-machine-filter.txt

  Scenario: snippet 포함 확인
    Tool: Bash (curl)
    Steps:
      1. 200자 이상 본문으로 메모 생성
      2. GET /api/memos
    Expected Result: 각 메모에 snippet 필드, 100자+… 로 truncated
    Evidence: .sisyphus/evidence/task-4-snippet.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): add machineId filter and snippet to API`
  - Files: `server/src/modules/memos/index.ts`, `server/src/__tests__/memo-module.test.ts`
  - Pre-commit: `bun test`

- [x] 5. Feed 엔드포인트: `/api/memos/feed`

  **What to do**:
  - `GET /api/memos/feed` — query: `limit` (default 20, max 50), `machineId` (optional)
  - MemoDB.listFeed() 호출 — 프로젝트 무관, `ORDER BY updated_at DESC`
  - 응답에 snippet 포함 (Task 4의 MemoFS.readSnippet 재사용)
  - 응답 형태: `{ memos: MemoWithSnippet[] }`
  - TDD: 테스트 작성 → 구현
    - feed가 프로젝트 무관하게 최신 순 반환
    - limit 파라미터 동작 확인
    - machineId 필터 동작 확인

  **Must NOT do**:
  - 무한 스크롤/페이지네이션 (offset 파라미터 없음)
  - 정렬 옵션 제공

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 새 엔드포인트 + DB 메서드 + TDD
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6, 7)
  - **Blocks**: Tasks 8, 9
  - **Blocked By**: Tasks 1, 3

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/index.ts:24-38` — GET /api/memos 패턴 참고. 유사한 구조로 /feed 구현
  - `server/src/modules/memos/memo-db.ts:55-77` — list() 쿼리 패턴. listFeed()는 projectId 조건 없이 유사

  **Acceptance Criteria**:

  - [ ] `GET /api/memos/feed` → 최신 20개 메모 반환 (snippet 포함)
  - [ ] `GET /api/memos/feed?limit=5` → 5개만
  - [ ] `GET /api/memos/feed?machineId=macbook` → 해당 머신만
  - [ ] `bun test` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 피드 기본 동작
    Tool: Bash (curl)
    Steps:
      1. 서로 다른 프로젝트에 메모 3개 생성
      2. GET /api/memos/feed
    Expected Result: 3개 메모 반환, updated_at 내림차순, 각각 snippet 포함
    Evidence: .sisyphus/evidence/task-5-feed-basic.txt

  Scenario: 피드 limit 파라미터
    Tool: Bash (curl)
    Steps:
      1. 메모 5개 생성
      2. GET /api/memos/feed?limit=2
    Expected Result: 2개만 반환
    Evidence: .sisyphus/evidence/task-5-feed-limit.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): add /api/memos/feed endpoint`
  - Files: `server/src/modules/memos/index.ts`, `server/src/modules/memos/memo-db.ts`, `server/src/__tests__/memo-module.test.ts`
  - Pre-commit: `bun test`

- [x] 6. Projects 엔드포인트: `/api/memos/projects`

  **What to do**:
  - `GET /api/memos/projects` — query: `machineId` (optional)
  - MemoDB.listProjects(machineId?) 호출 — `SELECT DISTINCT project_id, project_slug, machine_id, COUNT(*) as memo_count FROM memos GROUP BY project_id, machine_id`
  - 응답 형태: `{ projects: MemoProject[] }`
  - TDD: 테스트 작성 → 구현

  **Must NOT do**:
  - enrichment 프로젝트와 서버사이드 병합 (프론트엔드에서 처리)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단순 SELECT DISTINCT 쿼리 + 엔드포인트 1개
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5, 7)
  - **Blocks**: Tasks 8, 10
  - **Blocked By**: Tasks 1, 3

  **References**:

  **Pattern References**:
  - `server/src/modules/memos/memo-db.ts:99-108` — count() 메서드. 유사한 집계 쿼리 패턴

  **Acceptance Criteria**:

  - [ ] `GET /api/memos/projects` → 메모가 존재하는 프로젝트 목록 반환
  - [ ] 각 프로젝트에 `projectId`, `projectSlug`, `machineId`, `memoCount` 포함
  - [ ] `bun test` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 프로젝트 목록 조회
    Tool: Bash (curl)
    Steps:
      1. 프로젝트 A에 2개, 프로젝트 B에 1개 메모 생성
      2. GET /api/memos/projects
    Expected Result: [{projectSlug: 'A', memoCount: 2}, {projectSlug: 'B', memoCount: 1}]
    Evidence: .sisyphus/evidence/task-6-projects-list.txt

  Scenario: machineId 필터
    Tool: Bash (curl)
    Steps:
      1. 머신 X의 프로젝트 A, 머신 Y의 프로젝트 B에 메모 생성
      2. GET /api/memos/projects?machineId=X
    Expected Result: 프로젝트 A만 반환
    Evidence: .sisyphus/evidence/task-6-projects-machine-filter.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): add /api/memos/projects endpoint`
  - Files: `server/src/modules/memos/index.ts`, `server/src/modules/memos/memo-db.ts`, `server/src/__tests__/memo-module.test.ts`
  - Pre-commit: `bun test`

- [x] 7. cli.ts 와이어링: defaultMachineId 전달

  **What to do**:
  - `cli.ts`에서 MemoModule 생성 시 `defaultMachineId` 전달
  - `defaultMachineId` = `machinesConfig.machines[0]?.id ?? 'default'` (machines.yml의 첫 번째 머신 ID)
  - MemoModule 생성자: `new MemoModule(memoDb, memoDir, defaultMachineId)`
  - 생성자 내부에서 `this.memoDB.migrateExistingMemos(defaultMachineId)` 호출 → 기존 빈 machine_id 레코드 업데이트
  - **중요**: machines.yml에서 첫 번째 머신 id를 결정적으로 사용. 연결 상태 무관

  **Must NOT do**:
  - MachineManager를 MemoModule에 주입 (과도한 결합)
  - machinesConfig 전체를 전달

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: cli.ts에 2-3줄 추가, MemoModule 생성자에 파라미터 1개 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2에서 4, 5, 6과 병렬 가능하나, Task 4의 MemoModule 생성자 변경에 의존)
  - **Parallel Group**: Wave 2 (with Tasks 4, 5, 6)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 1, 2, 4

  **References**:

  **Pattern References**:
  - `server/src/cli.ts:49-54` — 현재 MemoModule 생성 코드. defaultMachineId 파라미터 추가
  - `server/src/cli.ts:37-39` — machinesConfig 로드. 여기서 machines[0].id 추출

  **Acceptance Criteria**:

  - [ ] MemoModule 생성자에 3번째 인자 defaultMachineId 전달
  - [ ] 서버 시작 시 기존 machine_id='' 레코드 자동 마이그레이션
  - [ ] `bun test` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 서버 시작 시 마이그레이션 실행
    Tool: Bash
    Steps:
      1. DB에 machine_id='' 레코드 삽입 (수동)
      2. 서버 재시작
      3. SELECT COUNT(*) FROM memos WHERE machine_id = ''
    Expected Result: 0 (모두 마이그레이션됨)
    Evidence: .sisyphus/evidence/task-7-auto-migration.txt
  ```

  **Commit**: YES
  - Message: `feat(memo): wire defaultMachineId in cli.ts`
  - Files: `server/src/cli.ts`
  - Pre-commit: `bun test`

- [x] 8. 프론트엔드 타입 + 스토어 업데이트

  **What to do**:
  - `server/frontend/src/types.ts`:
    - `Memo` 인터페이스에 `machineId: string` 추가
    - `MemoWithContent`에 `machineId` 포함 확인 (extends Memo이므로 자동)
    - 새 인터페이스: `MemoWithSnippet extends Memo { snippet: string }`
    - 새 인터페이스: `MemoProject { projectId: string; projectSlug: string; machineId: string; memoCount: number }`
  - `server/frontend/src/lib/stores/memos.svelte.ts`:
    - `fetchMemos(projectId?, date?, machineId?)` — machineId 쿼리 파라미터 추가
    - `createMemo(projectId, content, title?, date?, machineId?)` — machineId body 필드 추가. **machineId 필수로 변경**
    - 새 함수: `fetchFeed(limit?: number, machineId?: string)` — `GET /api/memos/feed`
    - 새 상태: `feedMemos = $state<MemoWithSnippet[]>([])`
    - 새 함수: `getFeedMemos(): MemoWithSnippet[]`
    - 새 함수: `fetchMemoProjects(machineId?: string)` — `GET /api/memos/projects`
    - 새 상태: `memoProjects = $state<MemoProject[]>([])`
    - 새 함수: `getMemoProjects(): MemoProject[]`
  - 글로벌 머신 선택 연동: `machine.svelte.ts`의 `getSelectedMachineId()` 임포트

  **Must NOT do**:
  - enrichment.ts 수정
  - 기존 store 함수 시그니처 breaking change (optional 파라미터만 추가)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 타입 추가 + store 함수 확장. 패턴이 이미 존재
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (Wave 2 완료 후)
  - **Parallel Group**: Wave 3 (with Tasks 9, 10, 11)
  - **Blocks**: Tasks 9, 10, 11, 12
  - **Blocked By**: Tasks 3, 4, 5, 6

  **References**:

  **Pattern References**:
  - `server/frontend/src/lib/stores/memos.svelte.ts:27-42` — fetchMemos 패턴. machineId 파라미터 추가
  - `server/frontend/src/lib/stores/memos.svelte.ts:55-74` — createMemo 패턴. machineId body 필드 추가
  - `server/frontend/src/lib/stores/machine.svelte.ts:19-21` — getSelectedMachineId() API

  **API/Type References**:
  - `server/frontend/src/types.ts:51-63` — 현재 Memo, MemoWithContent 인터페이스

  **Acceptance Criteria**:

  - [ ] `Memo` 타입에 `machineId` 존재
  - [ ] `fetchFeed()` 함수가 /api/memos/feed 호출
  - [ ] `fetchMemoProjects()` 함수가 /api/memos/projects 호출
  - [ ] `createMemo()` 에 machineId 파라미터 추가

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 타입 컴파일 검증
    Tool: Bash
    Steps:
      1. cd server/frontend && npx tsc --noEmit (또는 vite build)
    Expected Result: 타입 에러 없음
    Evidence: .sisyphus/evidence/task-8-frontend-types.txt
  ```

  **Commit**: YES
  - Message: `feat(memo-ui): update frontend types and store`
  - Files: `server/frontend/src/types.ts`, `server/frontend/src/lib/stores/memos.svelte.ts`
  - Pre-commit: `bun test`

- [x] 9. MemosPage 랜딩 피드 컴포넌트

  **What to do**:
  - MemosPage.svelte에서 **프로젝트 미선택 시** (`selectedProjectId === null`) 빈 화면 대신 최신 메모 20개 피드 표시
  - `onMount`에서 `fetchFeed(20, selectedMachineId)` 호출
  - 글로벌 머신 선택 변경 시 피드 re-fetch
  - 피드 항목 UI:
    ```
    ┌──────────────────────────────────────┐
    │ [프로젝트명] · [머신명] · [날짜]     │
    │ 제목 (또는 "(제목 없음)")             │
    │ 본문 미리보기 첫 2줄 (snippet)...    │
    └──────────────────────────────────────┘
    ```
  - 피드 항목 클릭 → `selectedProjectId` 설정 + `fetchMemo(memo.id)` 호출 (해당 프로젝트 메모 목록 + 메모 에디터 오픈)
  - 빈 피드 상태: "아직 작성된 메모가 없습니다. 프로젝트를 선택하고 새 메모를 작성하세요."
  - **기존 `main-empty` div 교체**: `selectedProjectId`가 null일 때 "프로젝트를 선택하세요" 대신 피드 표시
  - **사이드바도 변경**: 프로젝트 미선택 시 "프로젝트를 선택하세요" 대신 최근 프로젝트 요약 or 빈 상태 유지

  **Must NOT do**:
  - 무한 스크롤 추가
  - 피드 아이템에 에디터 인라인 표시 (클릭 시 프로젝트 선택 + 기존 에디터 사용)
  - MemosPage 구조 대규모 리팩토링

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI 컴포넌트 설계 + 인터랙션 흐름
  - **Skills**: [`ui-ux-pro-max`]
    - `ui-ux-pro-max`: 다크 모드 대시보드 UI 디자인 가이드

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8, 10, 11 — but depends on 8)
  - **Blocks**: Task 13
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/MemosPage.svelte:207-215` — 현재 프로젝트 미선택 시 빈 화면. 여기를 피드로 교체
  - `server/frontend/src/components/pages/MemosPage.svelte:42-44` — onMount 패턴. fetchFeed 호출 추가
  - `server/frontend/src/components/pages/MemosPage.svelte:333-711` — 기존 CSS 스타일. 피드 아이템 스타일 추가

  **External References**:
  - 대시보드 CSS 변수: `--bg-secondary`, `--bg-tertiary`, `--border`, `--text-primary`, `--text-secondary`, `--accent`, `--radius`, `--radius-sm`

  **Acceptance Criteria**:

  - [ ] 프로젝트 미선택 시 최신 메모 20개 피드 표시
  - [ ] 피드 항목에 프로젝트명, 머신명, 날짜, 제목, snippet 표시
  - [ ] 피드 항목 클릭 → 프로젝트 선택 + 메모 에디터 오픈
  - [ ] 빈 피드 시 안내 메시지 표시

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 랜딩 피드 표시
    Tool: Playwright
    Steps:
      1. 메모 3개 생성 (다른 프로젝트)
      2. Memos 탭 클릭
      3. 프로젝트 드롭다운 "프로젝트 선택" 상태 확인
    Expected Result: 메인 영역에 최신 메모 3개 피드 표시. 각 항목에 프로젝트명, snippet 포함
    Evidence: .sisyphus/evidence/task-9-landing-feed.png

  Scenario: 피드 항목 클릭 → 프로젝트 선택
    Tool: Playwright
    Steps:
      1. 피드에서 첫 번째 메모 클릭
    Expected Result: 프로젝트 드롭다운이 해당 프로젝트로 변경, 메모 에디터에 내용 표시
    Evidence: .sisyphus/evidence/task-9-feed-click.png

  Scenario: 빈 피드 상태
    Tool: Playwright
    Steps:
      1. 모든 메모 삭제 후 Memos 탭 진입
    Expected Result: "아직 작성된 메모가 없습니다" 안내 메시지
    Evidence: .sisyphus/evidence/task-9-empty-feed.png
  ```

  **Commit**: YES
  - Message: `feat(memo-ui): add landing page feed`
  - Files: `server/frontend/src/components/pages/MemosPage.svelte`
  - Pre-commit: `bun test`

- [x] 10. 프로젝트 드롭다운 독립성 (enrichment 비의존)

  **What to do**:
  - MemosPage의 프로젝트 드롭다운을 enrichment `$projectsData`에서 **메모 프로젝트 + enrichment 프로젝트 병합**으로 변경
  - `onMount`에서 `fetchMemoProjects(selectedMachineId)` 호출
  - 병합 로직 (Svelte `$derived`):
    - 메모 프로젝트: `getMemoProjects()` → `MemoProject[]`
    - enrichment 프로젝트: `$projectsData` → `ProjectSummary[]` (null 가능)
    - 합집합: `projectId` 기준 deduplicate. enrichment에만 있는 프로젝트도 포함
    - 정렬: 메모 개수 내림차순 → 이름순
  - 드롭다운 옵션 표시: `[머신명] project-slug (메모 N개)` (멀티 머신 시) 또는 `project-slug (메모 N개)` (단일 머신)
  - 글로벌 머신 선택 변경 시 re-fetch

  **Must NOT do**:
  - enrichment.ts 수정
  - enrichment fetchProjectsData 호출 제거 (여전히 병합에 사용)
  - 서버사이드 병합 엔드포인트 추가

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 두 데이터 소스 병합 로직 + Svelte 반응성 처리
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 11)
  - **Blocks**: Task 13
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/MemosPage.svelte:146-156` — 현재 프로젝트 드롭다운. enrichment 의존
  - `server/frontend/src/components/pages/MemosPage.svelte:6-7` — enrichment store 임포트

  **API/Type References**:
  - `server/frontend/src/lib/stores/enrichment.ts:67-75` — ProjectSummary 인터페이스 (enrichment)
  - `server/frontend/src/lib/stores/enrichment.ts:129-132` — MergedProjectSummary (machineId 포함)

  **Acceptance Criteria**:

  - [ ] enrichment 데이터 없어도 메모가 있는 프로젝트가 드롭다운에 표시
  - [ ] enrichment + 메모 프로젝트 합집합 표시
  - [ ] 머신 필터 변경 시 프로젝트 목록 갱신

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: enrichment 없이 프로젝트 표시
    Tool: Playwright
    Steps:
      1. enrichment 캐시 비어있는 상태에서 메모 2개 생성 (프로젝트 A, B)
      2. Memos 탭 진입
      3. 프로젝트 드롭다운 열기
    Expected Result: 프로젝트 A, B가 드롭다운에 표시 (enrichment 없이)
    Evidence: .sisyphus/evidence/task-10-no-enrichment.png

  Scenario: enrichment + 메모 프로젝트 병합
    Tool: Playwright
    Steps:
      1. enrichment에 프로젝트 C 존재, 메모에 프로젝트 A, B 존재
      2. 드롭다운 열기
    Expected Result: A, B, C 모두 표시
    Evidence: .sisyphus/evidence/task-10-merged-projects.png
  ```

  **Commit**: YES
  - Message: `feat(memo-ui): project list independence from enrichment`
  - Files: `server/frontend/src/components/pages/MemosPage.svelte`, `server/frontend/src/lib/stores/memos.svelte.ts`
  - Pre-commit: `bun test`

- [x] 11. 사이드바 snippet 미리보기

  **What to do**:
  - 사이드바의 `.memo-item`에 제목 아래 snippet 표시
  - `GET /api/memos` 응답에 포함된 `snippet` 필드 사용
  - UI 변경:
    ```
    현재:  [제목]                    [시간]
    변경:  [제목]                    [시간]
           [snippet 첫 줄, 회색, 작은 폰트...]
    ```
  - snippet이 빈 문자열이면 미리보기 숨김
  - `.memo-item` 높이 약간 증가 (2줄 → 3줄)
  - `memos.svelte.ts`의 `fetchMemos` 응답에서 snippet 파싱 (MemoWithSnippet 타입)

  **Must NOT do**:
  - Markdown 파싱/렌더링
  - snippet 클라이언트 사이드 생성

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: CSS 스타일링 + HTML 한 줄 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 10)
  - **Blocks**: Task 13
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `server/frontend/src/components/pages/MemosPage.svelte:187-200` — 현재 memo-item. snippet span 추가
  - `server/frontend/src/components/pages/MemosPage.svelte:471-517` — memo-item CSS. snippet 스타일 추가

  **Acceptance Criteria**:

  - [ ] 사이드바 메모 항목에 제목 아래 snippet 표시
  - [ ] snippet 폰트 크기 0.72rem, 색상 --text-secondary
  - [ ] 빈 snippet은 미리보기 숨김

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 사이드바 snippet 표시
    Tool: Playwright
    Steps:
      1. "Hello World 테스트 메모입니다" 본문으로 메모 생성
      2. 사이드바 memo-item 확인
    Expected Result: 제목 아래 "Hello World 테스트 메모입니다" snippet 표시
    Evidence: .sisyphus/evidence/task-11-snippet-preview.png

  Scenario: 빈 본문 메모
    Tool: Playwright
    Steps:
      1. 빈 본문으로 메모 생성 (제목만)
      2. 사이드바 확인
    Expected Result: snippet 영역 숨겨짐, 제목만 표시
    Evidence: .sisyphus/evidence/task-11-empty-snippet.png
  ```

  **Commit**: YES
  - Message: `feat(memo-ui): add snippet preview in sidebar`
  - Files: `server/frontend/src/components/pages/MemosPage.svelte`
  - Pre-commit: `bun test`

- [x] 12. 키보드 단축키: Cmd+N, Cmd+S

  **What to do**:
  - `MemosPage.svelte` (또는 `App.svelte`)에 키보드 이벤트 핸들러 추가
  - **Cmd+N (새 메모)**:
    - 메모 페이지에서만 동작
    - 프로젝트가 선택되어 있어야 동작 (미선택 시 무시)
    - `handleNewMemo()` 호출
    - `e.preventDefault()` 필수 (브라우저 새 창 방지)
  - **Cmd+S (저장)**:
    - 메모 페이지에서만 동작
    - INPUT/TEXTAREA 포커스 상태에서도 동작해야 함 (⚠️ App.svelte의 기존 가드 우회 필요)
    - 새 메모 작성 중 → `handleSaveNew()` 호출
    - 기존 메모 편집 중 → `handleSaveEdit()` 호출
    - `isSaving()` 중이면 무시 (debounce)
    - `e.preventDefault()` 필수 (브라우저 "Save Page" 방지)
  - **구현 방식**: MemosPage 내에서 `<svelte:window onkeydown>` — 메모 페이지에서만 동작하므로 App.svelte보다 적절
  - **App.svelte 가드 수정**: `handleGlobalKeydown`에서 Cmd+S를 INPUT/TEXTAREA 가드 이전에 체크하지 않아도 됨 — MemosPage의 핸들러가 먼저 실행되고 `e.preventDefault()`로 전파 차단

  **Must NOT do**:
  - Cmd+N, Cmd+S 외 추가 단축키
  - 단축키 설정 UI
  - 다른 페이지에서 동작

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 이벤트 핸들러 함수 1개 추가
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (Wave 3 완료 후)
  - **Parallel Group**: Wave 4 (with Task 13)
  - **Blocks**: Task 13
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `server/frontend/src/App.svelte:94-127` — 기존 글로벌 키보드 핸들러 패턴. 참고하되 MemosPage 내부에 별도 구현
  - `server/frontend/src/components/pages/MemosPage.svelte:79-84` — handleNewMemo 함수. Cmd+N이 호출
  - `server/frontend/src/components/pages/MemosPage.svelte:114-118` — handleSaveEdit 함수. Cmd+S가 호출

  **Acceptance Criteria**:

  - [ ] Cmd+N → 새 메모 에디터 표시 (프로젝트 선택 시)
  - [ ] Cmd+S → 현재 메모 저장 (textarea 포커스 상태에서도)
  - [ ] 다른 탭에서 Cmd+N/S → 동작 안 함
  - [ ] `e.preventDefault()` → 브라우저 기본 동작 차단

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Cmd+N 새 메모 생성
    Tool: Playwright
    Steps:
      1. 프로젝트 선택
      2. Cmd+N (Mac) 또는 Ctrl+N (기타) 키 입력
    Expected Result: 새 메모 에디터 표시 (isCreating = true)
    Evidence: .sisyphus/evidence/task-12-cmd-n.png

  Scenario: Cmd+S textarea 포커스 저장
    Tool: Playwright
    Steps:
      1. 메모 에디터에서 텍스트 수정
      2. textarea에 포커스 유지한 채 Cmd+S 키 입력
    Expected Result: 메모 저장됨, "Save page" 브라우저 대화상자 안 뜸
    Evidence: .sisyphus/evidence/task-12-cmd-s-textarea.png

  Scenario: 다른 탭에서 Cmd+N 무시
    Tool: Playwright
    Steps:
      1. Dashboard 탭으로 이동
      2. Cmd+N 키 입력
    Expected Result: 아무 동작 없음 (새 메모 안 열림)
    Evidence: .sisyphus/evidence/task-12-other-tab-ignore.png
  ```

  **Commit**: YES
  - Message: `feat(memo-ui): add Cmd+N and Cmd+S keyboard shortcuts`
  - Files: `server/frontend/src/components/pages/MemosPage.svelte`
  - Pre-commit: `bun test`

- [x] 13. 통합 테스트 + Docker 빌드 + 배포

  **What to do**:
  - 전체 테스트 스위트 실행: `bun test` (서버 전체)
  - Docker 빌드: `docker compose build`
  - Docker 컨테이너 재시작: `docker compose up -d`
  - 배포 후 헬스체크: `curl localhost:3097/health`
  - 배포 후 API 검증:
    - `curl localhost:3097/api/memos` → machineId 포함 응답
    - `curl localhost:3097/api/memos/feed?limit=5` → snippet 포함 피드
    - `curl localhost:3097/api/memos/projects` → 프로젝트 목록
  - **호스트 프로세스 확인**: `lsof -i :3097` — 이전처럼 네이티브 node 프로세스가 포트를 점유하고 있지 않은지 확인
  - docker-compose.yml 변경 필요 시 업데이트 (없을 가능성 높음 — MEMO_DIR은 이미 설정됨)
  - Git 커밋 + push

  **Must NOT do**:
  - E2E 테스트 프레임워크 추가
  - CI/CD 파이프라인 변경

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 통합 검증 + Docker 빌드 + 배포까지 전체 사이클
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (sequential after all tasks)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 7, 9, 10, 11, 12

  **References**:

  **Pattern References**:
  - `server/docker-compose.yml` — Docker 설정. MEMO_DIR, MEMO_DB_PATH 환경변수
  - `install/server.sh` — 배포 스크립트. Docker build + start

  **Acceptance Criteria**:

  - [ ] `bun test` → ALL PASS
  - [ ] Docker 빌드 성공
  - [ ] `curl localhost:3097/health` → `{"status":"ok"}`
  - [ ] `curl localhost:3097/api/memos/feed` → 200 응답

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Docker 배포 후 전체 API 작동
    Tool: Bash (curl)
    Steps:
      1. lsof -i :3097 → OrbStack만 있는지 확인
      2. curl localhost:3097/health
      3. curl -X POST localhost:3097/api/memos -H 'Content-Type: application/json' -d '{"projectId":"/test/integration","content":"integration test","machineId":"macbook","title":"Integration"}'
      4. curl localhost:3097/api/memos/feed?limit=5
      5. curl localhost:3097/api/memos/projects
      6. 테스트 메모 삭제
    Expected Result: 모든 API 200 응답, feed에 snippet 포함, projects에 항목 포함
    Evidence: .sisyphus/evidence/task-13-docker-integration.txt
  ```

  **Commit**: YES
  - Message: `chore(memo): integration tests + Docker rebuild`
  - Files: 변경 있을 시
  - Pre-commit: `bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill if UI)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (features working together, not isolation). Test edge cases: empty state, invalid input, rapid actions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| # | Message | Files | Pre-commit |
|---|---------|-------|------------|
| 1 | `feat(memo): add machine_id to schema with auto-migration` | memo-db.ts, types.ts, memo-db.test.ts | bun test |
| 2 | `feat(memo): support machine-prefixed file paths in MemoFS` | memo-fs.ts | bun test |
| 3 | `feat(memo): add machineId to all backend types` | types.ts (server) | bun test |
| 4 | `feat(memo): add machineId filter and snippet to API` | index.ts, memo-module.test.ts | bun test |
| 5 | `feat(memo): add /api/memos/feed endpoint` | index.ts, memo-db.ts | bun test |
| 6 | `feat(memo): add /api/memos/projects endpoint` | index.ts, memo-db.ts | bun test |
| 7 | `feat(memo): wire defaultMachineId in cli.ts` | cli.ts | bun test |
| 8 | `feat(memo-ui): update frontend types and store` | types.ts (frontend), memos.svelte.ts | bun test |
| 9 | `feat(memo-ui): add landing page feed` | MemosPage.svelte | bun test |
| 10 | `feat(memo-ui): project list independence from enrichment` | MemosPage.svelte, memos.svelte.ts | bun test |
| 11 | `feat(memo-ui): add snippet preview in sidebar` | MemosPage.svelte | bun test |
| 12 | `feat(memo-ui): add Cmd+N and Cmd+S keyboard shortcuts` | MemosPage.svelte or App.svelte | bun test |
| 13 | `test(memo): integration tests + Docker rebuild` | docker-compose.yml | bun test && Docker build |

---

## Success Criteria

### Verification Commands
```bash
bun test                                    # Expected: ALL PASS
curl -s localhost:3097/api/memos            # Expected: {"memos":[...]} with machineId fields
curl -s localhost:3097/api/memos/feed?limit=5  # Expected: {"memos":[...]} with snippet
curl -s localhost:3097/api/memos/projects   # Expected: {"projects":[...]}
curl -s -X POST localhost:3097/api/memos -H 'Content-Type: application/json' -d '{"projectId":"/test","content":"test","machineId":"macbook"}' # Expected: 201 with machineId
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass (existing 27 + new)
- [x] Docker build + deploy succeeds
- [x] 기존 메모 machine_id 마이그레이션 완료
