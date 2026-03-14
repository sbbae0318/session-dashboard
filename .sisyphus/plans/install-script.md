# Session Dashboard 통합 설치 스크립트 + OpenCode E2E

## TL;DR

> **Quick Summary**: 단일 `install/install.sh`로 agent + server를 한 번에 설치하고, OpenCode/Claude 데이터 소스를 자동 감지·설정하며, 기존 Playwright E2E 인프라를 확장하여 OpenCode 파이프라인 regression 테스트를 추가한다.
> 
> **Deliverables**:
> - `install/install.sh` — 통합 설치 스크립트 (auto-detect + 기존 스크립트 위임)
> - OpenCode E2E 테스트 세트 — Playwright config, setup/teardown, helper, spec, fixture
> - `server/package.json` — `test:opencode-e2e` 스크립트 추가
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 4 → Task 8 → Task 9 → F1-F4

---

## Context

### Original Request
세션 대시보드 통합 설치 스크립트를 만들되, OpenCode와 Claude 모두 지원하고, requirements 및 처음부터 필요한 모든 구성요소(서버, 에이전트, 클라이언트, 훅)를 설치할 수 있으며, E2E 테스트까지 포함하는 계획.

### Interview Summary
**Key Discussions**:
- **설치 스크립트 형태**: 단일 `install.sh`. `--agent-only`, `--server-only` 플래그 지원
- **훅 = 데이터 소스 설정**: Agent `.env`의 `SOURCE` 자동 설정 + history 경로 자동 감지
- **E2E 범위**: 기존 Playwright E2E 확장. `claude-regression.spec.ts` 패턴으로 OpenCode pipeline 추가
- **TUI**: 설치 스크립트에서 제외
- **타겟 OS**: macOS + Linux 둘 다

**Research Findings**:
- 기존 `install/agent.sh` (308줄)과 `install/server.sh` (205줄)이 이미 잘 구현되어 있음
- E2E 인프라: `playwright.claude-regression.config.ts`, `global-setup.claude.ts`, `helpers/claude-data.ts` 등 완벽한 패턴 존재
- Agent의 OpenCode 파이프라인: `/api/cards`는 JSONL 직접 읽기 (oc-serve 불필요), `/api/queries`는 fallback chain 사용, `/api/sessions`는 oc-serve 프록시 (oc-serve 없으면 502)
- Claude 파이프라인: `~/.claude/` 파일 기반, oc-serve 불필요

### Metis Review
**Identified Gaps** (addressed):
- **oc-serve 의존성**: OpenCode E2E는 file-based(cards.jsonl, queries.jsonl) 파이프라인만 검증. oc-serve 의존 엔드포인트(/api/sessions)는 502 반환이 정상임을 assertion.
- **API_KEY 동기화**: install.sh에서 `openssl rand -hex 16`으로 자동 생성, agent `.env`와 server `machines.yml` 양쪽에 주입.
- **로직 중복 방지**: install.sh는 기존 agent.sh/server.sh를 **호출**하는 얇은 오케스트레이터. 자체 로직은 auto-detection + config 생성만.
- **포트 충돌**: OpenCode E2E는 agent:3198, server:3099로 Claude E2E(agent:3199, server:3098)와 분리.
- **auto-detect 오탐**: 디렉토리뿐 아니라 핵심 파일(`cards.jsonl`, `history.jsonl`) 존재까지 확인.
- **--dry-run 지원**: auto-detection 결과를 실행 없이 미리 확인 가능.

---

## Work Objectives

### Core Objective
단일 설치 스크립트로 session-dashboard의 모든 구성요소를 설치하고, 기존 E2E 인프라를 확장하여 OpenCode 파이프라인을 자동 검증한다.

### Concrete Deliverables
- `install/install.sh` (~150줄) — 통합 설치 오케스트레이터
- `server/playwright.opencode-regression.config.ts` (~27줄)
- `server/e2e/global-setup.opencode.ts` (~100줄)
- `server/e2e/global-teardown.opencode.ts` (~65줄)
- `server/e2e/helpers/opencode-data.ts` (~80줄)
- `server/e2e/opencode-regression.spec.ts` (~200줄)
- `server/e2e/fixtures/machines.opencode-test.yml` (~7줄)
- `server/package.json` 수정 — `test:opencode-e2e` 스크립트 추가

### Definition of Done
- [x] `bash install/install.sh --help` → exit 0, Usage 텍스트 출력
- [x] `bash install/install.sh --dry-run` → 데이터 소스 감지 결과 출력 (실제 설치 없음)
- [x] `cd server && npx playwright test --config playwright.opencode-regression.config.ts` → all tests pass
- [x] OpenCode E2E에서 cards.jsonl → agent API → server API → browser 파이프라인 검증 완료
- [x] install.sh에서 API_KEY 자동 생성 + agent `.env`와 server `machines.yml` 동기화

### Must Have
- 데이터 소스 auto-detection (OpenCode: `~/.opencode/history/cards.jsonl`, Claude: `~/.claude/projects/` 또는 `~/.claude/history.jsonl`)
- macOS + Linux 호환 (brew vs apt 분기는 불필요 — prerequisites check만)
- 기존 agent.sh/server.sh 위임 패턴 (로직 중복 금지)
- OpenCode E2E regression tests (Claude regression과 대칭 구조)
- E2E에서 file-based 파이프라인(cards, queries) 검증
- idempotent 설치 (재실행 시 기존 설정 보존)

### Must NOT Have (Guardrails)
- ❌ Node.js/Docker 자동 설치 (감지 + 안내만)
- ❌ oc-serve 설치/관리
- ❌ TUI 설치
- ❌ systemd/launchd 서비스 등록
- ❌ 기존 `agent.sh`, `server.sh` 수정 (additive only)
- ❌ install.sh에 lifecycle 관리 (stop/restart/logs)
- ❌ OpenCode E2E에서 oc-serve 의존 엔드포인트 성공 assertion
- ❌ SSL/TLS 설정
- ❌ 원격 머신 설정
- ❌ 과도한 inline 주석 / documentation bloat

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest + Playwright)
- **Automated tests**: Tests-after (E2E spec 작성 → 실행)
- **Framework**: Playwright (E2E), bash assertion (install.sh)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Install script**: Bash — 실행, exit code, stdout 검증
- **E2E tests**: Playwright — `npx playwright test` 실행, 결과 캡처
- **API**: curl — 엔드포인트 호출, JSON 응답 검증

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, MAX PARALLEL):
├── Task 1: install.sh 통합 설치 스크립트 [unspecified-high]
├── Task 2: OpenCode E2E helper + fixture [quick]
├── Task 3: OpenCode E2E global setup/teardown [unspecified-high]

Wave 2 (After Wave 1 — E2E config + specs):
├── Task 4: Playwright OpenCode regression config [quick]
├── Task 5: OpenCode regression spec (scenarios 1-4) [unspecified-high]
├── Task 6: OpenCode regression spec (scenarios 5-7) [unspecified-high]
├── Task 7: package.json 스크립트 추가 [quick]

Wave 3 (After Wave 2 — E2E 실행 검증):
├── Task 8: install.sh 셀프 테스트 (--help, --dry-run) [quick]
├── Task 9: OpenCode E2E 전체 실행 + 수정 [deep]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
├── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 4 → Task 9 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 8 | 1 |
| 2 | — | 5, 6 | 1 |
| 3 | — | 4, 5, 6 | 1 |
| 4 | 3 | 9 | 2 |
| 5 | 2, 3 | 9 | 2 |
| 6 | 2, 3 | 9 | 2 |
| 7 | — | 9 | 2 |
| 8 | 1 | F1 | 3 |
| 9 | 4, 5, 6, 7 | F1 | 3 |

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `unspecified-high`, T2 → `quick`, T3 → `unspecified-high`
- **Wave 2**: **4** — T4 → `quick`, T5 → `unspecified-high`, T6 → `unspecified-high`, T7 → `quick`
- **Wave 3**: **2** — T8 → `quick`, T9 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. install.sh 통합 설치 스크립트 작성

  **What to do**:
  - `install/install.sh` 작성 (~150줄). `set -euo pipefail` + `SCRIPT_DIR/REPO_ROOT` 패턴 (`install/agent.sh:1-5` 미러링)
  - Argument parsing: `(no args)` = full install, `--agent-only`, `--server-only`, `--dry-run`, `--help`
  - Prerequisites check: Node.js 18+, npm, Docker (server 필요 시), git
  - macOS/Linux 공통 명령어만 사용 (`lsof`, `curl`, `command -v`). OS별 패키지 관리자 호출 없음
  - **Data source auto-detection**:
    - OpenCode: `$HOME/.opencode/history/cards.jsonl` 또는 `queries.jsonl` 존재 확인
    - Claude Code: `$HOME/.claude/projects/` 또는 `$HOME/.claude/history.jsonl` 존재 확인
    - 둘 다 → `SOURCE=both`, OpenCode만 → `SOURCE=opencode`, Claude만 → `SOURCE=claude-code`, 없음 → `SOURCE=opencode` (기본값)
  - **API_KEY 자동 생성**: `openssl rand -hex 16`으로 생성, agent `.env`의 `API_KEY`와 server `machines.yml`의 `apiKey` 양쪽에 주입
  - **Agent 설치**: `"$SCRIPT_DIR/agent.sh"` 호출 (기존 스크립트 위임)
  - **Server 설치**: `"$SCRIPT_DIR/server.sh"` 호출 (기존 스크립트 위임)
  - **.env 생성**: agent `.env.example` → `.env` 복사 후 `PORT`, `API_KEY`, `SOURCE`, `HISTORY_DIR` sed 치환
  - **machines.yml 생성**: `machines.yml.example` → `machines.yml` 복사 후 `apiKey`, `host`, `port` sed 치환
  - `--dry-run` 모드: auto-detection 결과 출력만, 실제 설치 없음
  - Idempotent: `.env`, `machines.yml` 이미 존재하면 보존
  - 최종 summary 출력: 설치된 컴포넌트, 감지된 데이터소스, 접속 URL

  **Must NOT do**:
  - Node.js/Docker 자동 설치 (존재 여부 확인 + 설치 안내만)
  - 기존 agent.sh, server.sh 파일 수정
  - lifecycle 관리 (stop/restart/logs — 기존 스크립트에 위임 안내)
  - TUI 설치 / systemd/launchd 서비스 등록

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Bash 스크립트 작성 + 기존 패턴 정확히 따라야 함
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 8
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `install/agent.sh:1-5` — `set -euo pipefail`, `SCRIPT_DIR`, `REPO_ROOT` 패턴
  - `install/agent.sh:7-33` — Argument parsing 패턴 (ACTION 변수, case문)
  - `install/agent.sh:61-83` — `check_prerequisites()` Node.js 18+ 버전 체크
  - `install/agent.sh:131-192` — `do_install()` Step 1~4 플로우 (환경설정→의존성→빌드→시작)
  - `install/server.sh:80-115` — `do_install()` 서버 설치 (machines.yml, docker compose)
  - `install/agent.sh:47-57` — `get_port()` .env에서 PORT 읽는 패턴
  **API/Type References**:
  - `agent/.env.example` — 치환 대상: PORT, API_KEY, OC_SERVE_PORT, HISTORY_DIR, SOURCE
  - `server/machines.yml.example` — 치환 대상: id, alias, host, port, apiKey, source
  - `server/.env.example` — DASHBOARD_PORT, MACHINES_CONFIG
  **External References**:
  - `openssl rand -hex 16` — API_KEY 생성 (macOS/Linux 공통)

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: install.sh --help 정상 동작
    Tool: Bash
    Steps: bash install/install.sh --help → exit 0 + stdout에 'Usage' 포함
    Evidence: .sisyphus/evidence/task-1-help-flag.txt

  Scenario: --dry-run auto-detection (both 소스)
    Tool: Bash
    Steps: mkdir -p /tmp/sd-test-both/.opencode/history && touch cards.jsonl;
           mkdir -p /tmp/sd-test-both/.claude/projects;
           HOME=/tmp/sd-test-both bash install/install.sh --dry-run → 'SOURCE=both' 포함
    Evidence: .sisyphus/evidence/task-1-dry-run-both.txt

  Scenario: --dry-run 소스 없음 (기본값 opencode)
    Tool: Bash
    Steps: HOME=/tmp/sd-test-empty bash install/install.sh --dry-run → 'SOURCE=opencode'
    Evidence: .sisyphus/evidence/task-1-dry-run-empty.txt
  ```

  **Commit**: YES
  - Message: `feat(install): add unified install.sh with auto-detection`
  - Files: `install/install.sh`


- [x] 2. OpenCode E2E helper + fixture 파일 작성

  **What to do**:
  - `server/e2e/helpers/opencode-data.ts` 작성 (~80줄), `claude-data.ts` 대칭 구조
    - `TEST_AGENT_HOME = '/tmp/sd-e2e-oc-agent-home'`
    - `TEST_SERVER_HOME = '/tmp/sd-e2e-oc-server-home'`
    - `writeCards(agentHome, entries)`: HISTORY_DIR에 `cards.jsonl` 작성
    - `writeQueries(agentHome, entries)`: HISTORY_DIR에 `queries.jsonl` 작성
    - `cleanAgentHome(agentHome)`: HISTORY_DIR 내용물 삭제 (디렉토리 유지, FS watcher 안전)
  - `server/e2e/fixtures/machines.opencode-test.yml` (~7줄)
    - id=test-opencode-agent, host=127.0.0.1, port=3198, apiKey=e2e-oc-test-key-12345, source=opencode

  **Must NOT do**: oc-serve 관련 helper, `#XX|` prefix 형식

  **Recommended Agent Profile**:
  - **Category**: `quick` — 기존 claude-data.ts 미러링
  - **Skills**: []

  **Parallelization**: Wave 1 (with 1, 3) | Blocks: 5, 6 | Blocked By: None

  **References**:
  - `server/e2e/helpers/claude-data.ts` — 전체 파일. writeProjectSession(), writeHistory(), cleanAgentHome() 패턴 미러링
  - `server/e2e/fixtures/machines.claude-test.yml` — 전체 파일(7줄). port, apiKey, source만 변경
  - `agent/src/jsonl-reader.ts` — tailLines()가 JSONL 파싱. prefix 없는 순수 JSON 줄 작성
  - `agent/src/server.ts:26-42` — cards/queries 라우트 등록, HISTORY_DIR 경로 확인

  **QA Scenarios:**
  ```
  Scenario: opencode-data.ts TypeScript 컴파일
    Tool: Bash
    Steps: cd server && npx tsc --noEmit → exit 0
    Evidence: .sisyphus/evidence/task-2-typecheck.txt

  Scenario: machines.opencode-test.yml YAML 파싱
    Tool: Bash
    Steps: node -e "파싱 후 source==='opencode' 확인" → exit 0
    Evidence: .sisyphus/evidence/task-2-yml-parse.txt
  ```

  **Commit**: YES (groups with 3, 4, 5, 6, 7)
  - Message: `test(e2e): add OpenCode regression test infrastructure`

- [x] 3. OpenCode E2E global setup/teardown 작성

  **What to do**:
  - `server/e2e/global-setup.opencode.ts` (~100줄), `global-setup.claude.ts` 대칭
    - AGENT_PORT=3198, SERVER_PORT=3099, AGENT_KEY='e2e-oc-test-key-12345'
    - Agent spawn: SOURCE=opencode, HISTORY_DIR=TEST_AGENT_HOME/.opencode/history
    - Server spawn: MACHINES_CONFIG=fixtures/machines.opencode-test.yml
    - Health check: agent+server /health 대기 (timeout 20s)
    - PID persist: TEST_SERVER_HOME/.e2e-oc-pids.json
  - `server/e2e/global-teardown.opencode.ts` (~65줄), `global-teardown.claude.ts` 대칭
    - PID에서 SIGTERM → SIGKILL, temp dir cleanup

  **Must NOT do**: oc-serve spawn, Claude E2E 포트(3098/3199) 사용

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — 포트/경로 차이로 세심한 작업 필요
  - **Skills**: []

  **Parallelization**: Wave 1 (with 1, 2) | Blocks: 4, 5, 6 | Blocked By: None

  **References**:
  - `server/e2e/global-setup.claude.ts` — 전체 파일(114줄). Line 15-17 포트/키, Line 22-34 waitForHealth(), Line 51-65 Agent spawn, Line 71-84 Server spawn, Line 89-94 PID persist
  - `server/e2e/global-teardown.claude.ts` — 전체 파일(65줄). PID 파일명만 변경
  - `server/e2e/helpers/opencode-data.ts` (Task 2) — TEST_AGENT_HOME, TEST_SERVER_HOME import

  **QA Scenarios:**
  ```
  Scenario: TypeScript 컴파일
    Tool: Bash
    Steps: cd server && npx tsc --noEmit → exit 0
    Evidence: .sisyphus/evidence/task-3-typecheck.txt

  Scenario: Claude E2E와 포트 충돌 없음
    Tool: Bash (grep)
    Steps: opencode setup에서 3198/3099, claude setup에서 3199/3098 확인
    Evidence: .sisyphus/evidence/task-3-port-check.txt
  ```

  **Commit**: YES (groups with 2, 4, 5, 6, 7)


- [x] 4. Playwright OpenCode regression config 작성

  **What to do**:
  - `server/playwright.opencode-regression.config.ts` (~27줄)
    - `playwright.claude-regression.config.ts` 정확히 미러링
    - testMatch: `**/opencode-regression.spec.ts`
    - timeout: 60_000, expect.timeout: 20_000
    - baseURL: `http://127.0.0.1:3099`
    - globalSetup: `./e2e/global-setup.opencode.ts`
    - globalTeardown: `./e2e/global-teardown.opencode.ts`
    - workers: 1, fullyParallel: false, retries: 1

  **Recommended Agent Profile**: `quick` | Skills: []
  **Parallelization**: Wave 2 | Blocks: 9 | Blocked By: 3

  **References**:
  - `server/playwright.claude-regression.config.ts` — 전체 파일(27줄). 대칭 구조로 복사하고 port/path만 변경

  **QA Scenarios:**
  ```
  Scenario: Config 파일 TypeScript 컴파일 + baseURL 확인
    Tool: Bash
    Steps: cd server && npx tsc --noEmit; grep 'baseURL.*3099' playwright.opencode-regression.config.ts
    Evidence: .sisyphus/evidence/task-4-config-check.txt
  ```

  **Commit**: YES (groups with 2, 3, 5, 6, 7)

- [x] 5. OpenCode regression spec (Scenarios 1-4) 작성

  **What to do**:
  - `server/e2e/opencode-regression.spec.ts` 앞부분 (~120줄)
  - `claude-regression.spec.ts` 패턴을 OpenCode 데이터 소스에 맞게 적용
  - **Scenario 1: Cards in API** — writeCards() → agent /api/cards → server /api/history → 브라우저 session-cards 패널
  - **Scenario 2: Queries in Recent Prompts** — writeQueries() → agent /api/queries → server /api/queries → recent-prompts 패널
  - **Scenario 3: oc-serve 다운 시 graceful degradation** — /api/sessions 502 확인 (oc-serve 없이 정상)
  - **Scenario 4: Source filter OpenCode** — OpenCode 필터 클릭 시 opencode 데이터만 표시
  - 각 시나리오는 claude-regression의 expect.poll() 패턴 사용 (500ms intervals, 15s timeout)
  - agent URL: http://127.0.0.1:3198, server URL: http://127.0.0.1:3099, key: e2e-oc-test-key-12345

  **Must NOT do**: oc-serve 의존 엔드포인트 성공 assertion

  **Recommended Agent Profile**: `unspecified-high` | Skills: []
  **Parallelization**: Wave 2 (with 4, 6, 7) | Blocks: 9 | Blocked By: 2, 3

  **References**:
  - `server/e2e/claude-regression.spec.ts` — 전체 파일(355줄). Scenario 1-5 패턴 미러링:
    - Line 44-82: Scenario 1 (prompts → API → browser) — OpenCode는 cards/queries로 변경
    - Line 88-134: Scenario 2 (slash filter) — OpenCode에서는 해당없음, queries 검증으로 대체
    - Line 140-187: Scenario 3 (busy session) — oc-serve 없으면 502, graceful degradation 확인
    - Line 239-288: Scenario 5 (source filter) — OpenCode 필터로 변경
  - `server/e2e/helpers/opencode-data.ts` (Task 2) — writeCards(), writeQueries(), cleanAgentHome()
  - `server/e2e/helpers/claude-data.ts` — agentGet() helper 함수 패턴 (Bearer auth)

  **QA Scenarios:**
  ```
  Scenario: Scenarios 1-4 TypeScript 컴파일
    Tool: Bash
    Steps: cd server && npx tsc --noEmit → exit 0
    Evidence: .sisyphus/evidence/task-5-typecheck.txt

  Scenario: Spec 파일에 4개 시나리오 test.describe 존재
    Tool: Bash (grep)
    Steps: grep -c 'test.describe' server/e2e/opencode-regression.spec.ts ≥ 4
    Evidence: .sisyphus/evidence/task-5-scenario-count.txt
  ```

  **Commit**: YES (groups with 2, 3, 4, 6, 7)

- [x] 6. OpenCode regression spec (Scenarios 5-7) 작성

  **What to do**:
  - `server/e2e/opencode-regression.spec.ts` 후반부 추가 (~80줄)
  - **Scenario 5: Real-time update** — JSONL 파일 작성 후 브라우저에 데이터 반영 확인
  - **Scenario 6: Empty state** — JSONL 없을 때 cards/queries 빈 배열 반환
  - **Scenario 7: Large file handling** — 500개 엔트리 cards.jsonl 작성, limit=50으로 요청 시 50개만 반환
  - beforeEach에서 cleanAgentHome() 호출 (claude-regression.spec.ts:34-38 패턴)

  **Must NOT do**: oc-serve 의존 테스트, 기존 claude-regression.spec.ts 수정

  **Recommended Agent Profile**: `unspecified-high` | Skills: []
  **Parallelization**: Wave 2 (with 4, 5, 7) | Blocks: 9 | Blocked By: 2, 3

  **References**:
  - `server/e2e/claude-regression.spec.ts:294-355` — Scenario 6-7 (realtime, stale) 패턴
  - `server/e2e/helpers/opencode-data.ts` (Task 2) — writeCards(), cleanAgentHome()

  **QA Scenarios:**
  ```
  Scenario: Scenarios 5-7 TypeScript 컴파일 + test.describe 3개 추가 존재
    Tool: Bash
    Steps: cd server && npx tsc --noEmit; grep -c 'test.describe' opencode-regression.spec.ts ≥ 7
    Evidence: .sisyphus/evidence/task-6-typecheck.txt
  ```

  **Commit**: YES (groups with 2, 3, 4, 5, 7)

- [x] 7. package.json에 test:opencode-e2e 스크립트 추가

  **What to do**:
  - `server/package.json`의 scripts에 추가:
    - `"test:opencode-e2e": "playwright test --config playwright.opencode-regression.config.ts --reporter=list"`
  - 기존 `test:claude-e2e` 스크립트 패턴과 동일하게

  **Recommended Agent Profile**: `quick` | Skills: []
  **Parallelization**: Wave 2 | Blocks: 9 | Blocked By: None

  **References**:
  - `server/package.json:18` — `test:claude-e2e` 스크립트 패턴. 동일 구조로 config 파일만 변경

  **QA Scenarios:**
  ```
  Scenario: npm script 등록 확인
    Tool: Bash
    Steps: cd server && node -e "const p=require('./package.json'); process.exit(p.scripts['test:opencode-e2e'] ? 0 : 1)"
    Evidence: .sisyphus/evidence/task-7-script-check.txt
  ```

  **Commit**: YES (groups with 2, 3, 4, 5, 6)


- [x] 8. install.sh 셀프 테스트 (--help, --dry-run)

  **What to do**:
  - install.sh의 모든 QA 시나리오 실행:
    - `--help` 플래그 → exit 0 + Usage 텍스트
    - `--dry-run` 양쪽 소스 → SOURCE=both
    - `--dry-run` OpenCode만 → SOURCE=opencode
    - `--dry-run` Claude만 → SOURCE=claude-code
    - `--dry-run` 소스 없음 → SOURCE=opencode (기본값)
  - /tmp/sd-test-* 디렉토리에 각 케이스 생성 후 테스트
  - 모든 evidence 파일 저장
  - 실패 시 install.sh 수정 후 재실행

  **Recommended Agent Profile**: `quick` | Skills: []
  **Parallelization**: Wave 3 | Blocks: F1 | Blocked By: 1

  **References**:
  - Task 1의 QA Scenarios — 정확히 이 시나리오들을 실행

  **QA Scenarios:**
  ```
  Scenario: 5가지 --dry-run 케이스 전부 PASS
    Tool: Bash
    Steps:
      1. --help → exit 0, 'Usage' 포함
      2. HOME=/tmp/sd-test-both (opencode+claude) → SOURCE=both
      3. HOME=/tmp/sd-test-oc (opencode만) → SOURCE=opencode
      4. HOME=/tmp/sd-test-claude (claude만) → SOURCE=claude-code
      5. HOME=/tmp/sd-test-empty (없음) → SOURCE=opencode
    Expected Result: 5/5 PASS
    Evidence: .sisyphus/evidence/task-8-all-dry-run.txt
  ```

  **Commit**: NO (수정 필요 시 Task 1 파일 수정 후 커밋)

- [x] 9. OpenCode E2E 전체 실행 + 수정

  **What to do**:
  - Agent 빌드 확인: `cd agent && npm run build` (이미 빌드되어 있으면 skip)
  - Server 빌드 확인: `cd server && npm run build` (이미 빌드되어 있으면 skip)
  - OpenCode E2E 실행: `cd server && npx playwright test --config playwright.opencode-regression.config.ts`
  - 실패 시:
    1. 에러 메시지 분석
    2. 해당 spec/helper/setup 파일 수정
    3. 재실행
    4. 모든 테스트 PASS될 때까지 반복
  - 테스트 결과 스크린샷/로그 저장

  **Must NOT do**: 기존 claude-regression 테스트 수정, 기존 agent/server 소스 코드 수정

  **Recommended Agent Profile**: `deep` — 디버깅+수정 루프 필요
  - **Skills**: []
  **Parallelization**: Wave 3 | Blocks: F1 | Blocked By: 4, 5, 6, 7

  **References**:
  - `server/playwright.opencode-regression.config.ts` (Task 4) — E2E config
  - `server/e2e/opencode-regression.spec.ts` (Tasks 5, 6) — 테스트 spec
  - `server/e2e/global-setup.opencode.ts` (Task 3) — setup 로직
  - `server/e2e/helpers/opencode-data.ts` (Task 2) — fixture helper
  - `server/e2e/claude-regression.spec.ts` — 성공 사례 참고

  **QA Scenarios:**
  ```
  Scenario: OpenCode E2E 전체 PASS
    Tool: Bash
    Steps: cd server && npx playwright test --config playwright.opencode-regression.config.ts --reporter=list
    Expected Result: All tests pass, exit 0
    Failure Indicators: 어떤 test라도 FAIL
    Evidence: .sisyphus/evidence/task-9-e2e-result.txt

  Scenario: 테스트 실행 중 포트 충돌 없음
    Tool: Bash
    Steps: Claude E2E와 동시 실행하지 않음 확인 (config에서 포트 확인만)
    Evidence: .sisyphus/evidence/task-9-port-verify.txt
  ```

  **Commit**: YES (if fixes needed)
  - Message: `fix(e2e): address OpenCode regression test failures`
  - Files: server/e2e/* (수정된 파일들)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` in server/. Lint check. Review all new/changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify install.sh follows `set -euo pipefail` + shellcheck clean.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Test edge cases: empty state, invalid input, missing dirs. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `feat(install): add unified install.sh with auto-detection` — install/install.sh
- **Wave 1+2**: `test(e2e): add OpenCode regression test infrastructure` — server/e2e/*, server/playwright.opencode-regression.config.ts, server/package.json
- **Wave 3**: `fix(e2e): address test failures from E2E run` — (if needed)

---

## Success Criteria

### Verification Commands
```bash
bash install/install.sh --help          # Expected: exit 0, Usage text
bash install/install.sh --dry-run       # Expected: exit 0, detected sources output
cd server && npx playwright test --config playwright.opencode-regression.config.ts  # Expected: all pass
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] install.sh callable from repo root
- [x] OpenCode E2E tests pass independently
- [x] No port conflicts with Claude E2E
- [x] API_KEY auto-generated and synced
