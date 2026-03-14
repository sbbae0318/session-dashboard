# OpenCode 프롬프트 레이턴시 조사 프로젝트

## TL;DR

> **Quick Summary**: OpenCode CLI에서 프롬프트 제출 → 첫 LLM 토큰 수신까지의 레이턴시를 체계적으로 계측하여 병목 지점을 식별하고 분석 리포트를 생성한다. OpenCode 소스에 `Bun.nanoseconds()` 기반 타이밍 계측을 패치로 주입하고, 로그를 파싱/분석하는 도구를 개발한다.
>
> **Deliverables**:
> - `../investigate/` 프로젝트 디렉터리 (독립 프로젝트)
> - OpenCode 소스 계측 패치 파일 (git apply로 적용/제거 가능)
> - JSON Lines 로그 파싱 + 분석 스크립트
> - 병목 분석 리포트 (Phase Breakdown + Top Bottlenecks + 권고사항)
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 5 → Task 6 → Task 8 → Task 9

---

## Context

### Original Request
OpenCode 사용 중 프롬프트 날리고 진행 시작까지의 반응이 느림. 어느 단계에서 레이턴시가 발생하는지 조사하는 프로젝트를 `../investigate` 디렉터리에 생성. 디버그 로그 주입 방식 + 대안 접근법 함께 검토.

### Interview Summary
**Key Discussions**:
- OpenCode는 TypeScript/Bun 프로젝트 (Go 아님). Solid.js TUI + Vercel AI SDK
- 프롬프트 파이프라인 15+ 단계 매핑 완료: `SessionPrompt.prompt()` → `createUserMessage()` → `loop()` → `resolveTools()` → `MCP.tools()` → `LLM.stream()` → `streamText()`
- 사용자 환경: MCP 서버 4-8개, 세션 길이 20-100+ 메시지, 플러그인 사용 중
- 접근법: Fork + Patch (기존 `log.time()` 패턴 활용 + `Bun.nanoseconds()` 계측점 주입)
- 산출물: 계측 패치 + 분석 도구 + 분석 리포트 (개선 PR은 범위 밖)

**Research Findings**:
- 소스 위치: `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/`
- 기존 `log.time()` 패턴 7곳 존재 (resolveTools, tool init 등) — 확장 가능
- OpenCode에 experimental OpenTelemetry 지원 있음 (llm.ts:253)
- MCP 연결은 startup 시 처리되지만 `MCP.tools()`는 **캐시 없이 매번 `listTools()` 호출**
- `MessageV2.stream()`은 메시지×parts 만큼 파일 I/O 발생 (sequential + Lock)
- `clone(msgs)` (prompt.ts:625)에서 전체 메시지 deep copy 발생

### Metis Review
**Identified Gaps** (addressed):
- `Bun.nanoseconds()` 사용 (ms 정밀도 부족 → 나노초 정밀도 필요)
- JSON Lines 포맷 + 별도 파일 출력 (TUI stdout 오염 방지)
- loop 반복 번호(step) 포함하여 첫 반복 vs 후속 반복 구분
- `filterCompacted()` early-exit 빈도 측정 필요 (실제 로드 메시지 수)
- 각 MCP 서버별 개별 `listTools()` 지연 시간 기록
- `bun --cpu-prof-md`를 첫 단계로 실행하여 가정 검증
- 버전 일치 확인 필수 (`opencode --version` vs 소스 `package.json`)
- `clone(msgs)` 비용 계측 추가

---

## Work Objectives

### Core Objective
OpenCode CLI의 프롬프트 제출 → 첫 LLM 응답 토큰 수신까지의 레이턴시를 **정량적으로 계측**하여 상위 3개 병목 지점을 식별하고, 재현 가능한 분석 리포트를 생성한다.

### Concrete Deliverables
- `../investigate/` 프로젝트 디렉터리 (패키지 설정 포함)
- `patches/instrument.patch` — OpenCode 소스에 적용 가능한 계측 패치
- `scripts/analyze.ts` — JSON Lines 로그 → 마크다운 리포트 변환
- `scripts/run-measurement.sh` — 패치 적용 → 실행 → 데이터 수집 자동화
- `results/report.md` — 최종 분석 리포트

### Definition of Done
- [x] `git apply patches/instrument.patch` → exit code 0
- [x] `git apply -R patches/instrument.patch` → exit code 0 (깨끗한 제거)
- [x] 계측된 OpenCode 실행 시 15+ 계측점이 JSON Lines로 기록됨
- [x] 분석 스크립트가 로그를 파싱하여 마크다운 리포트 생성
- [x] 리포트에 Phase Breakdown, Top Bottlenecks, 권고사항 포함
- [x] 3회 반복 측정 데이터 수집 완료

### Must Have
- `Bun.nanoseconds()` 기반 나노초 정밀도 계측
- JSON Lines 포맷 로그 (별도 파일, 환경변수 `OPENCODE_PERF_LOG`로 경로 지정)
- 15+ 핵심 계측점 (prompt.total, session.get, createUserMessage, loop.iteration, message.stream, resolveTools, mcp.tools, mcp.listTools.[server], llm.stream 등)
- 각 MCP 서버별 개별 listTools() 지연 시간
- loop 반복 번호(step) 포함
- 실제 로드된 메시지 수 + parts 수 기록
- min/max/p50/p95/mean 통계
- 패치 적용/제거 가능 (git apply / git apply -R)

### Must NOT Have (Guardrails)
- ❌ 계측 과정에서 코드 동작 변경 (await 추가, 실행 순서 변경, 에러 핸들링 변경 금지)
- ❌ MCP 캐싱, Storage 최적화, 리팩토링 등 개선 작업 수행
- ❌ 벤치마크 프레임워크 (vitest bench, hyperfine) 도입
- ❌ 웹 대시보드, flame chart, OpenTelemetry/Jaeger 인프라 구축
- ❌ `../investigate/`에 OpenCode 소스 코드 복사
- ❌ 프로덕션 바이너리 빌드 (dev 모드로 충분)
- ❌ 과도한 계측 (25개 초과 계측점)
- ❌ 분석 스크립트 300줄 초과

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO (새 프로젝트)
- **Automated tests**: None (계측/분석 프로젝트이므로 QA 시나리오로 검증)
- **Framework**: N/A

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **패치 적용**: Bash — `git apply`, exit code 검증
- **빌드 확인**: Bash — `bun run dev -- --help`, exit code 검증
- **로그 출력**: Bash — `wc -l`, `jq` 파싱 검증
- **분석 스크립트**: Bash — 실행 + 출력 마크다운 검증

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation + 검증):
├── Task 1: 프로젝트 스캐폴딩 + 버전 검증 [quick]
├── Task 2: CPU 프로파일링으로 가정 검증 [deep]
└── Task 3: 계측 인프라 모듈 작성 [quick]

Wave 2 (After Wave 1 — 핵심 계측):
├── Task 4: 패치 파일 생성 (전체 파이프라인 계측) [deep]
├── Task 5: 분석 스크립트 작성 [unspecified-high]
└── Task 6: 실행/수집 자동화 스크립트 [quick]

Wave 3 (After Wave 2 — 데이터 수집 + 리포트):
├── Task 7: 데이터 수집 (3회 반복 측정) [unspecified-high]
├── Task 8: 분석 리포트 생성 [writing]
└── Task 9: 최종 검증 + 정리 [deep]

Wave FINAL (After ALL tasks):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 2 → Task 4 → Task 6 → Task 7 → Task 8 → Task 9
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 3 (Wave 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | 2, 3, 4, 5, 6 |
| 2 | 1 | 4 (계측점 우선순위 결정) |
| 3 | 1 | 4 |
| 4 | 2, 3 | 6, 7 |
| 5 | 1 | 7, 8 |
| 6 | 4 | 7 |
| 7 | 4, 5, 6 | 8 |
| 8 | 7 | 9 |
| 9 | 8 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 → `quick`, T2 → `deep`, T3 → `quick`
- **Wave 2**: 3 tasks — T4 → `deep`, T5 → `unspecified-high`, T6 → `quick`
- **Wave 3**: 3 tasks — T7 → `unspecified-high`, T8 → `writing`, T9 → `deep`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

### Wave 1: Foundation + 검증

- [x] 1. 프로젝트 스캐폴딩 + 버전 검증

  **What to do**:
  - `../investigate/` 디렉터리 생성 (session-dashboard 기준 상대경로 → `/Users/sbbae/project/investigate/`)
  - `package.json` 생성 (name: `opencode-latency-investigation`, type: `module`, Bun 런타임)
  - 디렉터리 구조 생성: `patches/`, `scripts/`, `results/`, `results/raw/`
  - `README.md` 작성 (프로젝트 목적, 사용법 간략 설명)
  - **버전 검증**: `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/package.json`의 version과 `opencode --version` 출력을 비교. 불일치 시 `README.md`에 경고 기록
  - OpenCode 소스 디렉터리 경로를 `scripts/config.ts`에 상수로 정의

  **Must NOT do**:
  - OpenCode 소스를 investigate 디렉터리에 복사하지 않음
  - 프레임워크나 라이브러리 설치하지 않음 (Bun 내장 기능만 사용)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단순 파일/디렉터리 생성 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (첫 번째 작업)
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 2, 3, 4, 5, 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/package.json` — 버전 확인 (line 3: version)

  **API/Type References**:
  - N/A

  **External References**:
  - Bun docs: `https://bun.sh/docs/runtime/bunfig` — bunfig.toml 설정 참조

  **WHY Each Reference Matters**:
  - package.json의 version 필드는 설치된 바이너리와 소스 일치 여부를 결정. 불일치 시 패치가 무효

  **Acceptance Criteria**:
  - [x] `/Users/sbbae/project/investigate/` 디렉토리 존재
  - [x] `package.json`, `README.md`, `scripts/config.ts` 존재
  - [x] `patches/`, `scripts/`, `results/`, `results/raw/` 디렉토리 존재
  - [x] 버전 비교 결과가 README.md 또는 스크립트 출력에 기록됨

  **QA Scenarios:**

  ```
  Scenario: 프로젝트 디렉터리 구조 확인
    Tool: Bash
    Preconditions: 이전에 ../investigate 없음
    Steps:
      1. ls -la /Users/sbbae/project/investigate/
      2. ls /Users/sbbae/project/investigate/patches/ /Users/sbbae/project/investigate/scripts/ /Users/sbbae/project/investigate/results/raw/
      3. cat /Users/sbbae/project/investigate/package.json | jq '.name'
    Expected Result: 모든 디렉터리 존재, package.json에 name="opencode-latency-investigation"
    Failure Indicators: ls exit code != 0, jq 파싱 실패
    Evidence: .sisyphus/evidence/task-1-project-structure.txt

  Scenario: 버전 검증
    Tool: Bash
    Preconditions: opencode 바이너리 설치됨, 소스 코드 존재
    Steps:
      1. /Users/sbbae/.opencode/bin/opencode version 2>&1 | head -5
      2. cat /Users/sbbae/project/research/_tmp/opencode/packages/opencode/package.json | jq -r '.version'
      3. 두 버전 비교
    Expected Result: 버전이 일치하거나, 불일치 시 README에 경고 기록
    Failure Indicators: opencode 바이너리 실행 불가
    Evidence: .sisyphus/evidence/task-1-version-check.txt
  ```

  **Evidence to Capture:**
  - [x] task-1-project-structure.txt
  - [x] task-1-version-check.txt

  **Commit**: YES
  - Message: `feat(investigate): scaffold project and version verification`
  - Files: `investigate/*`

---

- [x] 2. CPU 프로파일링으로 가정 검증 (bun --cpu-prof-md)

  **What to do**:
  - OpenCode 소스 디렉터리에서 `bun --cpu-prof-md run dev`로 CPU 프로파일 수집
  - 프로파일 결과를 `results/cpu-profile.md`에 저장
  - 핫 함수 Top 20 목록 추출
  - 사전 가정 검증:
    - A1: MCP.tools()가 주 병목인가?
    - A3: dev 모드 오버헤드가 측정에 영향을 주는가?
    - A5: client.listTools()가 실제로 느린가?
  - 결과 분석하여 `results/cpu-profile-analysis.md`에 가정 검증 결과 기록
  - **이 결과를 바탕으로 Task 4의 계측점 우선순위를 결정**

  **Must NOT do**:
  - 반복 프로파일링 (1회면 충분)
  - flame chart, 웹 UI 생성

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: OpenCode dev 모드 실행 + 프로파일 결과 분석 필요
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 3과 병렬 가능)
  - **Parallel Group**: Wave 1 (with Tasks 1→[2,3] parallel after 1)
  - **Blocks**: Task 4
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/package.json:11` — `"dev": "bun run --conditions=browser ./src/index.ts"` dev 스크립트

  **External References**:
  - Bun CPU profiling: `https://bun.sh/docs/runtime/debugging#bun---cpu-prof-md` — Bun 마크다운 CPU 프로파일 사용법

  **WHY Each Reference Matters**:
  - dev 스크립트를 알아야 프로파일링 시 올바른 진입점 사용 가능

  **Acceptance Criteria**:
  - [x] `results/cpu-profile.md` 파일 생성됨
  - [x] `results/cpu-profile-analysis.md`에 가정 검증 결과 기록
  - [x] 핸 함수 Top 20 목록 포함

  **QA Scenarios:**

  ```
  Scenario: CPU 프로파일 생성 확인
    Tool: Bash
    Preconditions: OpenCode 소스 존재, Bun 설치됨
    Steps:
      1. ls /Users/sbbae/project/investigate/results/cpu-profile.md
      2. wc -l /Users/sbbae/project/investigate/results/cpu-profile.md
      3. grep -c "function\|method\|ms" /Users/sbbae/project/investigate/results/cpu-profile.md
    Expected Result: 파일 존재, 10줄 이상, 함수명/시간 데이터 포함
    Failure Indicators: 파일 없음 또는 빈 파일
    Evidence: .sisyphus/evidence/task-2-cpu-profile.txt

  Scenario: 가정 검증 결과 확인
    Tool: Bash
    Preconditions: cpu-profile-analysis.md 생성됨
    Steps:
      1. cat /Users/sbbae/project/investigate/results/cpu-profile-analysis.md
      2. grep -c "A1\|A3\|A5" /Users/sbbae/project/investigate/results/cpu-profile-analysis.md
    Expected Result: A1, A3, A5 가정에 대한 검증 결과 포함
    Failure Indicators: 가정 언급 없음
    Evidence: .sisyphus/evidence/task-2-assumption-validation.txt
  ```

  **Evidence to Capture:**
  - [x] task-2-cpu-profile.txt
  - [x] task-2-assumption-validation.txt

  **Commit**: NO (groups with Task 3)

---

- [x] 3. 계측 인프라 모듈 작성

  **What to do**:
  - `scripts/perf-logger.ts` 작성 — 계측 로그 수집/출력 모듈:
    - `Bun.nanoseconds()` 기반 나노초 정밀도 타이머
    - JSON Lines 포맷 출력 (`{"phase": string, "startNs": number, "endNs": number, "durationMs": number, "step": number, "metadata": object}`)
    - 출력 대상: 환경변수 `OPENCODE_PERF_LOG` 경로의 파일 (미설정 시 stderr)
    - `using` 패턴 지원 (dispose): `using _ = perfLog.start("phase.name", {step: 1})`
    - `perfLog.count("phase.name", count, metadata)` — 카운트 기록 (메시지 수 등)
  - `scripts/config.ts` 업데이트 — OpenCode 소스 경로, 계측점 목록 상수 정의
  - 이 모듈은 **패치의 일부로 OpenCode 소스에 주입됨** (패치 파일이 이 모듈을 src/ 아래에 추가)

  **Must NOT do**:
  - 외부 라이브러리 의존 (순수 Bun/TypeScript만)
  - 300줄 초과
  - stdout 출력 (TUI 깨짐 방지)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 단일 모듈 작성, 명확한 API
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 2와 병렬)
  - **Parallel Group**: Wave 1 (after Task 1)
  - **Blocks**: Task 4
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/util/log.ts:155` — 기존 `log.time()` dispose 패턴. `using _ = log.time(label)` 스타일 참조
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/tool/registry.ts:151` — `using _ = log.time(t.id)` 사용 예시

  **External References**:
  - Bun.nanoseconds(): `https://bun.sh/docs/api/utils#bun-nanoseconds` — 나노초 타이머 API
  - TC39 Explicit Resource Management: `using` 키워드로 dispose 패턴

  **WHY Each Reference Matters**:
  - log.ts의 `time()` 메서드를 참조하여 동일한 `using` dispose 패턴으로 perf-logger 설계
  - registry.ts의 사용 예시를 통해 실제 적용 패턴 이해

  **Acceptance Criteria**:
  - [x] `scripts/perf-logger.ts` 존재, 300줄 미만
  - [x] `using _ = perfLog.start("test")` 패턴이 동작
  - [x] JSON Lines 포맷 출력 확인
  - [x] `OPENCODE_PERF_LOG` 환경변수로 출력 경로 지정 가능

  **QA Scenarios:**

  ```
  Scenario: perf-logger 모듈 동작 확인
    Tool: Bash
    Preconditions: scripts/perf-logger.ts 존재
    Steps:
      1. OPENCODE_PERF_LOG=/tmp/test-perf.jsonl bun run -e "import { PerfLog } from './scripts/perf-logger'; const p = new PerfLog(); { using _ = p.start('test.phase', {step: 1}); await Bun.sleep(50); } p.flush();"
      2. cat /tmp/test-perf.jsonl
      3. cat /tmp/test-perf.jsonl | jq '.phase, .durationMs'
    Expected Result: JSON line with phase="test.phase", durationMs ~50
    Failure Indicators: 파일 없음, JSON 파싱 실패, durationMs가 0 또는 음수
    Evidence: .sisyphus/evidence/task-3-perf-logger-test.txt

  Scenario: stderr fallback 확인
    Tool: Bash
    Preconditions: OPENCODE_PERF_LOG 미설정
    Steps:
      1. bun run -e "import { PerfLog } from './scripts/perf-logger'; const p = new PerfLog(); { using _ = p.start('test'); } p.flush();" 2>/tmp/stderr-test.txt
      2. cat /tmp/stderr-test.txt | jq '.phase'
    Expected Result: stderr에 JSON line 출력, phase="test"
    Failure Indicators: stderr 비어있음
    Evidence: .sisyphus/evidence/task-3-stderr-fallback.txt
  ```

  **Evidence to Capture:**
  - [x] task-3-perf-logger-test.txt
  - [x] task-3-stderr-fallback.txt

  **Commit**: YES
  - Message: `feat(investigate): add perf-logger instrumentation module`
  - Files: `investigate/scripts/perf-logger.ts`, `investigate/scripts/config.ts`

---

### Wave 2: 핵심 계측 + 분석 도구

- [x] 4. 패치 파일 생성 (전체 파이프라인 계측)

  **What to do**:
  - Task 2의 CPU 프로파일 결과를 반영하여 계측점 우선순위 결정
  - `patches/instrument.patch` 생성 — `git diff` 포맷의 패치 파일:
    - Task 3의 `perf-logger.ts`를 OpenCode `src/util/perf-logger.ts`로 추가
    - **필수 계측점 15개** (아래 목록):

  ```
  # SessionPrompt.prompt() — session/prompt.ts
  1. prompt.total          — 전체 prompt() 함수 (line ~159)
  2. session.get           — Session.get() 호출 (line ~160)
  3. createUserMessage     — createUserMessage() 전체 (line ~163)
  4. session.touch         — Session.touch() (line ~164)

  # loop() — session/prompt.ts
  5. loop.iteration        — while(true) 각 반복 (step 번호 포함) (line ~297)
  6. message.stream        — MessageV2.filterCompacted(stream()) (line ~301)
  7. message.count         — 로드된 메시지 수 + parts 수 (count 로그)
  8. provider.getModel     — Provider.getModel() (line ~339)
  9. resolveTools.total    — resolveTools() 전체 (line ~598)
  10. registry.tools       — ToolRegistry.tools() (line ~779)
  11. mcp.tools.total      — MCP.tools() 전체 (line ~816)
  12. mcp.listTools.[name] — 각 MCP 서버별 listTools() (개별 기록)
  13. system.prompt        — SystemPrompt.environment() (line ~649)
  14. clone.messages       — clone(msgs) deep copy (line ~625)

  # LLM.stream() — session/llm.ts
  15. llm.stream           — LLM.stream() 전체 (line ~46)
  16. llm.providers        — Promise.all(4개 프로바이더 호출) (line ~59)
  17. plugin.trigger.[hook]— 각 Plugin.trigger() 호출 (개별 기록)

  # processor.process() — session/processor.ts
  18. stream.firstToken    — 첫 번째 stream 이벤트 수신 (line ~55)
  ```

  - 패치 규칙:
    - `OPENCODE_PERF_LOG` 환경변수가 설정된 경우에만 계측 활성화
    - 기존 코드 동작 절대 변경 금지 (await 추가, 순서 변경, 에러 핸들링 변경 금지)
    - 성능 오버헤드 최소화 (Bun.nanoseconds()는 ~ns 수준의 오버헤드)

  **Must NOT do**:
  - 25개 초과 계측점
  - MCP 캐싱, Storage 최적화 등 코드 동작 변경
  - 새로운 의존성 추가

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 대형 파일(prompt.ts 1450+ 줄) 이해 필요, 정확한 행 번호 위치 중요
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (가정 검증 결과 반영 필요)
  - **Parallel Group**: Wave 2 (Task 5와 병렬 가능)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: Tasks 2, 3

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/prompt.ts:159` — `prompt()` 함수 시작점. 계측 삽입 위치
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/prompt.ts:277` — `loop()` 함수. while(true) 루프 시작
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/prompt.ts:598` — `resolveTools()`. 도구 해석 전체
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/prompt.ts:625` — `clone(msgs)`. 딥 카피 지점
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/prompt.ts:816` — MCP.tools() 호출 위치
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/llm.ts:46` — `LLM.stream()` 함수
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/llm.ts:59` — Promise.all 병렬 호출
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/session/processor.ts:55` — stream fullStream 첫 이벤트
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/mcp/index.ts:566` — `MCP.tools()` 함수
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/mcp/index.ts:580` — 각 서버별 listTools() Promise.all
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/tool/registry.ts:126` — `ToolRegistry.tools()` 함수
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/util/log.ts:155` — 기존 `log.time()` dispose 패턴 참조

  **WHY Each Reference Matters**:
  - 각 파일의 정확한 행 번호에 계측 코드를 삽입해야 하므로, 위치가 정확해야 함
  - log.ts의 `time()` 패턴을 참조하여 동일한 dispose 스타일 유지

  **Acceptance Criteria**:
  - [x] `patches/instrument.patch` 파일 존재
  - [x] `git apply patches/instrument.patch` → exit 0
  - [x] `git apply -R patches/instrument.patch` → exit 0
  - [x] 15개 이상 계측점 포함 (grep 으로 phase 목록 추출)
  - [x] 패치 적용 후 `bun run dev -- --help` 성공

  **QA Scenarios:**

  ```
  Scenario: 패치 적용/제거 순환
    Tool: Bash
    Preconditions: OpenCode 소스 clean state
    Steps:
      1. cd /Users/sbbae/project/research/_tmp/opencode/packages/opencode && git stash
      2. git apply /Users/sbbae/project/investigate/patches/instrument.patch
      3. grep -r "OPENCODE_PERF_LOG" src/ | wc -l
      4. git apply -R /Users/sbbae/project/investigate/patches/instrument.patch
      5. git stash pop 2>/dev/null; true
    Expected Result: apply exit 0, 15+ 계측점 존재, reverse apply exit 0
    Failure Indicators: apply 실패, conflict 발생
    Evidence: .sisyphus/evidence/task-4-patch-cycle.txt

  Scenario: 계측 로그 출력 확인
    Tool: Bash
    Preconditions: 패치 적용됨
    Steps:
      1. cd /Users/sbbae/project/research/_tmp/opencode/packages/opencode
      2. git apply /Users/sbbae/project/investigate/patches/instrument.patch
      3. OPENCODE_PERF_LOG=/tmp/perf-test.jsonl timeout 15 bun run dev 2>&1 || true
      4. cat /tmp/perf-test.jsonl | jq -r '.phase' | sort -u
      5. wc -l /tmp/perf-test.jsonl
      6. git apply -R /Users/sbbae/project/investigate/patches/instrument.patch
    Expected Result: 15+ unique phases, 10+ 로그 라인
    Failure Indicators: 로그 파일 없음, phase 수 < 15
    Evidence: .sisyphus/evidence/task-4-instrumented-output.txt
  ```

  **Evidence to Capture:**
  - [x] task-4-patch-cycle.txt
  - [x] task-4-instrumented-output.txt

  **Commit**: YES
  - Message: `feat(investigate): add OpenCode pipeline instrumentation patch`
  - Files: `investigate/patches/instrument.patch`

---

- [x] 5. 분석 스크립트 작성

  **What to do**:
  - `scripts/analyze.ts` 작성 (300줄 미만) — JSON Lines 로그 → 마크다운 리포트:
    - 입력: 1개 이상의 `.jsonl` 파일 경로
    - 출력: 마크다운 형식의 분석 리포트 (stdout)
    - **필수 섹션:**
      - `## 측정 환경` (OS, Bun 버전, OpenCode 버전, MCP 서버 수, 세션 메시지 수)
      - `## Phase Breakdown` (각 phase별 min/max/p50/p95/mean)
      - `## Top Bottlenecks` (상위 3개 병목, 점유율 %)
      - `## MCP 서버별 지연` (개별 서버 타이밍)
      - `## Loop 반복별 비교` (step=1 vs step=2+ 그룹 비교)
      - `## 권고 사항` (병목별 개선 방향 제안)
    - 통계: min, max, p50, p95, mean만 (히스토그램 등 불필요)
    - 여러 파일 입력 시 반복 측정 결과 통합

  **Must NOT do**:
  - 300줄 초과
  - 외부 라이브러리 (순수 Bun/TypeScript)
  - 웹 UI, 차트, 시각화 도구

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 데이터 파싱/통계 계산/마크다운 생성 복합 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Task 4와 병렬)
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - Task 3의 `perf-logger.ts` JSON Lines 포맷 — 입력 스키마 참조

  **WHY Each Reference Matters**:
  - perf-logger의 출력 포맷을 정확히 알아야 파싱 가능

  **Acceptance Criteria**:
  - [x] `scripts/analyze.ts` 존재, 300줄 미만
  - [x] 샘플 JSONL 입력으로 마크다운 출력 생성
  - [x] 필수 6개 섹션 모두 포함
  - [x] p50, p95 통계 계산 정확

  **QA Scenarios:**

  ```
  Scenario: 샘플 데이터로 분석 스크립트 검증
    Tool: Bash
    Preconditions: analyze.ts 존재
    Steps:
      1. 샘플 JSONL 데이터 생성 (5개 phase, 3회 반복)
      2. bun run /Users/sbbae/project/investigate/scripts/analyze.ts /tmp/sample.jsonl
      3. 출력에서 필수 섹션 확인
    Expected Result: 마크다운 출력, 6개 섹션 모두 존재
    Failure Indicators: 파싱 에러, 누락된 섹션
    Evidence: .sisyphus/evidence/task-5-analyze-output.md
  ```

  **Evidence to Capture:**
  - [x] task-5-analyze-output.md

  **Commit**: NO (groups with Task 6)

---

- [x] 6. 실행/수집 자동화 스크립트

  **What to do**:
  - `scripts/run-measurement.sh` 작성 — 원클릭 측정 자동화:
    1. OpenCode 소스에 패치 적용 (`git apply`)
    2. `OPENCODE_PERF_LOG` 설정하여 계측된 OpenCode 실행
    3. 사용자에게 테스트 프롬프트 안내 (하드코딩된 테스트 시나리오)
    4. 로그 파일을 `results/raw/run-{N}-{timestamp}.jsonl`로 복사
    5. 패치 제거 (`git apply -R`)
    6. 분석 스크립트 실행하여 리포트 생성
  - `scripts/run-measurement.sh --analyze-only` — 기존 데이터로 리포트만 재생성
  - 테스트 시나리오 정의: `scripts/test-scenarios.md`
    - 시나리오 A: 짧은 세션 (10메시지 이하) + 단순 프롬프트
    - 시나리오 B: 긴 세션 (50+ 메시지) + 단순 프롬프트
    - 시나리오 C: 첫 프롬프트 (빈 세션)

  **Must NOT do**:
  - 벤치마크 프레임워크 (hyperfine 등) 도입
  - 자동 프롬프트 제출 (API 호출 등) — 사용자가 수동 입력

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 셸 스크립트 + 마크다운 문서 작성
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (Task 4 패치 필요)
  - **Parallel Group**: Wave 2 (after Task 4)
  - **Blocks**: Task 7
  - **Blocked By**: Task 4

  **References**:

  **Pattern References**:
  - Task 4의 패치 파일 경로 — apply/remove 명령어 참조
  - `scripts/config.ts` — OpenCode 소스 경로 상수

  **Acceptance Criteria**:
  - [x] `scripts/run-measurement.sh` 실행 가능 (chmod +x)
  - [x] `scripts/test-scenarios.md` 존재
  - [x] `--analyze-only` 옵션 동작

  **QA Scenarios:**

  ```
  Scenario: 스크립트 기본 동작 확인
    Tool: Bash
    Preconditions: run-measurement.sh 존재
    Steps:
      1. bash /Users/sbbae/project/investigate/scripts/run-measurement.sh --help
      2. bash /Users/sbbae/project/investigate/scripts/run-measurement.sh --analyze-only 2>&1 | head -20
    Expected Result: 도움말 출력, analyze-only 모드 동작 (데이터 없으면 에러 메시지)
    Failure Indicators: permission denied, syntax error
    Evidence: .sisyphus/evidence/task-6-script-test.txt
  ```

  **Evidence to Capture:**
  - [x] task-6-script-test.txt

  **Commit**: YES
  - Message: `feat(investigate): add analysis and measurement scripts`
  - Files: `investigate/scripts/analyze.ts`, `investigate/scripts/run-measurement.sh`, `investigate/scripts/test-scenarios.md`

---

### Wave 3: 데이터 수집 + 리포트

- [x] 7. 데이터 수집 (3회 반복 측정)

  **What to do**:
  - `scripts/run-measurement.sh` 실행하여 3개 시나리오 각 1회 이상 측정:
    - 시나리오 A: 짧은 세션 (10 메시지 이하)
    - 시나리오 B: 긴 세션 (50+ 메시지)
    - 시나리오 C: 첫 프롬프트 (빈 세션)
  - 각 측정 마다 3회 반복 (분산 20% 미만 확인)
  - 로그를 `results/raw/run-{scenario}-{N}.jsonl`로 저장
  - 패치 적용/제거 자동화

  **Must NOT do**:
  - 데이터 조작/편집
  - 불필요한 반복 (3회면 충분)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: OpenCode 실행 + 데이터 수집 + 검증 복합 작업
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (순차 측정)
  - **Blocks**: Task 8
  - **Blocked By**: Tasks 4, 5, 6

  **References**:
  - Task 6의 `run-measurement.sh` — 실행 스크립트
  - Task 6의 `test-scenarios.md` — 시나리오 정의

  **Acceptance Criteria**:
  - [x] `results/raw/` 에 3개+ JSONL 파일 존재
  - [x] 각 파일에 15+ phase 기록
  - [x] 3회 반복 측정 데이터 존재

  **QA Scenarios:**

  ```
  Scenario: 수집 데이터 검증
    Tool: Bash
    Steps:
      1. ls /Users/sbbae/project/investigate/results/raw/*.jsonl | wc -l
      2. for f in /Users/sbbae/project/investigate/results/raw/*.jsonl; do echo "$f: $(wc -l < $f) lines, $(cat $f | jq -r '.phase' | sort -u | wc -l) phases"; done
    Expected Result: 3+ 파일, 각 15+ phases
    Evidence: .sisyphus/evidence/task-7-data-collection.txt
  ```

  **Commit**: NO (groups with Task 8)

---

- [x] 8. 분석 리포트 생성

  **What to do**:
  - `scripts/analyze.ts`로 수집된 데이터 분석 실행
  - 출력을 `results/report.md`로 저장
  - 리포트 검토 + 필요 시 수동 보강:
    - 상위 3개 병목에 대한 구체적 원인 분석 추가
    - 각 병목별 개선 방향 권고 (코드 예시 등)
    - 측정 환경 정보 자동 포함

  **Must NOT do**:
  - 실제 코드 수정/최적화

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 리포트 문서 작성 중심
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Task 9
  - **Blocked By**: Task 7

  **References**:
  - Task 5의 `analyze.ts` — 분석 스크립트
  - Task 7의 수집 데이터 — 입력 데이터

  **Acceptance Criteria**:
  - [x] `results/report.md` 존재
  - [x] 6개 필수 섹션 존재 (Phase Breakdown, Top Bottlenecks, MCP 서버별, Loop 반복별, 권고사항, 측정환경)
  - [x] 상위 3개 병목에 측정값 + 원인 분석 + 개선 권고 포함

  **QA Scenarios:**

  ```
  Scenario: 리포트 완성도 확인
    Tool: Bash
    Steps:
      1. wc -l /Users/sbbae/project/investigate/results/report.md
      2. grep -c "## Phase Breakdown" /Users/sbbae/project/investigate/results/report.md
      3. grep -c "## Top Bottlenecks" /Users/sbbae/project/investigate/results/report.md
      4. grep -c "p50\|p95" /Users/sbbae/project/investigate/results/report.md
      5. grep -c "### Bottleneck" /Users/sbbae/project/investigate/results/report.md
    Expected Result: 50+ 줄, 각 섹션 1+회, p50/p95 3+회, Bottleneck 3+회
    Evidence: .sisyphus/evidence/task-8-report-check.txt
  ```

  **Commit**: YES
  - Message: `docs(investigate): add latency analysis report`
  - Files: `investigate/results/report.md`, `investigate/results/raw/*.jsonl`

---

- [x] 9. 최종 검증 + 정리

  **What to do**:
  - OpenCode 소스의 clean state 확인 (패치 제거됨)
  - `../investigate/` 프로젝트 전체 검증:
    - 모든 스크립트 실행 가능
    - README.md에 사용법 완성
    - 불필요 파일 제거 (/tmp 로그 등)
  - 전체 Definition of Done 기준 검증

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 전체 프로젝트 검증 + edge case 확인
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: F1-F4
  - **Blocked By**: Task 8

  **Acceptance Criteria**:
  - [x] OpenCode 소스 clean state (git status clean)
  - [x] 모든 Definition of Done 항목 완료
  - [x] README.md에 완전한 사용법 기술

  **QA Scenarios:**

  ```
  Scenario: clean state 확인
    Tool: Bash
    Steps:
      1. cd /Users/sbbae/project/research/_tmp/opencode/packages/opencode && git status --porcelain
      2. ls /Users/sbbae/project/investigate/
    Expected Result: git status 빈 출력 (패치 완전 제거), investigate 프로젝트 정리됨
    Evidence: .sisyphus/evidence/task-9-clean-state.txt
  ```

  **Commit**: YES
  - Message: `chore(investigate): final cleanup and verification`
  - Files: `investigate/README.md`

---
## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Review all created files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, unused imports. Check patch file applies/removes cleanly. Verify JSON output parsing. Check scripts are < 300 lines.
  Output: `Patch [CLEAN/ISSUES] | Scripts [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Apply patch to OpenCode source. Run instrumented build. Execute a prompt. Verify logs are generated. Run analysis script. Verify report output. Save all evidence.
  Output: `Scenarios [N/N pass] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", verify actual output matches. Check no optimization code was written (measurement only). Check `../investigate/` doesn't contain OpenCode source copies. Verify patch doesn't change behavior.
  Output: `Tasks [N/N compliant] | Scope [CLEAN/CREEP] | VERDICT`

---

## Commit Strategy

- After Task 3: `feat(investigate): scaffold project and instrumentation infra`
- After Task 4: `feat(investigate): add OpenCode pipeline instrumentation patch`
- After Task 6: `feat(investigate): add analysis and measurement scripts`
- After Task 8: `docs(investigate): add latency analysis report`
- After Task 9: `chore(investigate): final cleanup and verification`

---

## Success Criteria

### Verification Commands
```bash
# 패치 적용 가능
cd /Users/sbbae/project/research/_tmp/opencode/packages/opencode && git apply /Users/sbbae/project/investigate/patches/instrument.patch
# Expected: exit 0

# 패치 제거 가능
git apply -R /Users/sbbae/project/investigate/patches/instrument.patch
# Expected: exit 0

# 분석 스크립트 실행 가능
bun run /Users/sbbae/project/investigate/scripts/analyze.ts /Users/sbbae/project/investigate/results/raw/*.jsonl
# Expected: 마크다운 출력

# 리포트에 필수 섹션 포함
grep -c "## Phase Breakdown" /Users/sbbae/project/investigate/results/report.md  # >= 1
grep -c "## Top Bottlenecks" /Users/sbbae/project/investigate/results/report.md  # >= 1
grep -c "p50" /Users/sbbae/project/investigate/results/report.md                 # >= 1
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] 15+ 계측점이 JSON Lines로 기록됨
- [x] 3회 반복 측정 데이터 수집 완료
- [x] 상위 3개 병목 식별 + 분석 리포트 생성
- [x] 패치가 깨끗하게 적용/제거 가능
