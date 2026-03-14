# MCP-to-Skill 전환: On-Demand MCP 아키텍처

## TL;DR

> **Quick Summary**: 항상 연결된 MCP 서버를 OpenCode 스킬 시스템으로 래핑하여, 필요할 때만 on-demand로 MCP 도구를 호출하는 아키텍처로 전환한다. 자동 변환 도구(mcp-to-skill generator)를 개발하여 모든 MCP 서버를 스킬로 변환 가능하게 하고, Dehydrator 접근법과의 상세 비교 분석 문서를 작성한다.
> 
> **Deliverables**:
> - Dehydrator vs Skill-Wrapped MCP 상세 비교 분석 문서
> - `mcp-to-skill` CLI 자동 변환 도구 (TypeScript/Bun)
> - 5개 기존 MCP 서버에 대한 스킬 래퍼 (grep_app, websearch, context7, deepwiki, obsidian)
> - 하이브리드 전략 권고 문서
> - 통합 테스트 및 성능 비교 측정
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Tasks 6-10 → Task 11 → Task 13

---

## Context

### Original Request
OpenCode에서 MCP 서버가 매 프롬프트마다 ~250ms 레이턴시와 ~3,000 토큰을 낭비하는 문제를 해결하기 위해, MCP 서버를 OpenCode 스킬로 전환하는 방법론을 설계. "매번 스킬로 변환해야 하나?" 질문에 답하기 위한 자동화 도구 개발. Dehydrator(BM25 기반 도구 검색)와의 상세 비교 분석 포함.

### Interview Summary
**Key Discussions**:
- MCP 레이턴시 조사 완료: cold start ~4,100ms, warm ~250ms/prompt, ~3,000 토큰 낭비/prompt
- OpenCode에 listTools() 캐싱 없음, `listChanged` 미지원
- 스킬 시스템: SKILL.md(프론트매터 + 마크다운) → LLM이 `skill("name")` 호출 → 컨텍스트 주입
- 스킬에 번들 스크립트 포함 가능 → LLM이 bash로 호출
- OpenCode 소스코드 수정 없이, 스킬 파일 + CLI 스크립트만으로 해결 원함
- Dehydrator: BM25 기반 클라이언트 사이드 도구 검색, 98% 토큰 절감, 하지만 MCP 연결 유지

**Research Findings**:
- MCP TypeScript SDK: `client.connect(transport)` / `client.close()` 동적 지원
- MCP Python SDK: `ClientSession` + `stdio_client` CLI 클라이언트 확인
- `mcp-proxy` npm: transport proxy만, 캐싱 없음
- OpenCode 스킬 경로: `~/.opencode/skills/`, `.claude/skills/`, `.agents/skills/`, `config.skills.paths`
- 기존 스킬 패턴: `SKILL.md` + `scripts/` 디렉터리 (예: obsidian-mcp-setup)
- oh-my-opencode 플러그인이 16개 스킬 관리 중 (`~/.config/opencode/skills/`)
- 현재 MCP 설정: deepwiki 1개만 남아있음 (나머지는 이전 조사 시 5개)

### Metis Review (Self-Conducted — Metis timeout)
**Identified Gaps** (addressed):
- MCP 서버별 인증/API 키 전달 메커니즘 → 스킬 래퍼 스크립트에서 환경변수 참조
- stdio vs remote(SSE/streamable-HTTP) 전송 타입별 래퍼 차이 → 두 패턴 모두 지원
- 스킬 로드 시 토큰 비용 (SKILL.md 내용이 컨텍스트에 주입됨) → 최소한의 설명만 포함
- `mcp-to-skill` 도구의 MCP 서버 연결 방식 → `npx @modelcontextprotocol/inspector` 참고
- 멀티 도구 MCP 서버 처리 (하나의 서버에 여러 도구) → 하나의 스킬이 모든 도구 래핑
- 에러 핸들링: MCP 서버 스폰 실패, 타임아웃 → 스크립트에서 처리
- 보안: 사용자 환경의 API 키가 스킬 파일에 하드코딩되면 안 됨

---

## Work Objectives

### Core Objective
MCP 서버의 always-on 오버헤드(레이턴시 + 토큰 낭비)를 제거하면서도, 필요 시 MCP 도구를 on-demand로 사용할 수 있는 스킬 기반 아키텍처를 구축한다. 자동 변환 도구로 "매번 수동 변환" 문제를 해결한다.

### Concrete Deliverables
1. `investigate/analysis/dehydrator-comparison.md` — Dehydrator vs Skill-Wrapped MCP 상세 비교
2. `investigate/mcp-to-skill/` — CLI 자동 변환 도구 프로젝트
3. `investigate/mcp-to-skill/generated-skills/` — 5개 MCP 서버의 생성된 스킬 래퍼
4. `investigate/analysis/hybrid-strategy.md` — 하이브리드 전략 권고
5. `investigate/analysis/performance-comparison.md` — 성능 비교 측정 결과

### Definition of Done
- [ ] Dehydrator 비교 문서가 토큰, 레이턴시, API 콜, 구현 복잡도, 장단점 포함
- [ ] `mcp-to-skill` CLI가 MCP 서버 config를 입력받아 스킬 디렉터리 생성
- [ ] 생성된 스킬이 OpenCode에서 `skill("name")` → `bash` → MCP 도구 호출 가능
- [ ] 성능 비교: always-on MCP vs 스킬 래퍼의 레이턴시/토큰 차이 정량화
- [ ] 하이브리드 전략 문서에 "어떤 MCP는 always-on, 어떤 것은 스킬" 기준 제시

### Must Have
- OpenCode 소스코드 수정 없이 동작 (스킬 파일 + 스크립트만)
- 환경변수를 통한 API 키/인증 정보 전달 (하드코딩 금지)
- stdio 타입과 remote(SSE) 타입 MCP 서버 모두 지원
- 에러 핸들링: 서버 스폰 실패, 타임아웃, 잘못된 응답 처리
- 생성된 스킬의 SKILL.md가 토큰 효율적 (불필요한 긴 설명 제거)
- `mcp-to-skill` 도구가 `opencode.json`의 MCP 설정을 직접 읽어서 변환 가능

### Must NOT Have (Guardrails)
- ❌ OpenCode 소스코드 수정 또는 패치
- ❌ MCP 프로토콜 자체의 변경이나 커스텀 프로토콜
- ❌ Dehydrator 라이브러리의 직접 통합 (비교 분석만)
- ❌ MCP 서버의 영구 데몬화 (on-demand 원칙 위반)
- ❌ API 키를 스킬 파일이나 스크립트에 하드코딩
- ❌ 300줄 초과 스크립트 (mcp-client 스크립트는 200줄 이내)
- ❌ 웹 UI, 대시보드, 모니터링 인프라

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO (새 프로젝트)
- **Automated tests**: YES (Tests-after) — `mcp-to-skill` CLI에 대한 단위 테스트
- **Framework**: `bun test`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI 도구**: Use Bash — 실행, 출력 검증, 생성 파일 확인
- **스킬 래퍼**: Use Bash — `mcp_skill_mcp` 또는 직접 스크립트 실행으로 MCP 도구 호출 검증
- **문서**: Use Bash (wc, grep) — 문서 구조, 필수 섹션 존재 확인

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — 분석 + 기반):
├── Task 1: Dehydrator vs Skill-Wrapped MCP 비교 분석 문서 [writing]
├── Task 2: MCP 클라이언트 CLI 스크립트 (mcp-client.ts) [deep]
└── Task 3: 프로젝트 scaffolding + 타입 정의 [quick]

Wave 2 (After Task 2, 3 — 자동 변환 도구 + 스킬 템플릿):
├── Task 4: mcp-to-skill CLI 핵심 로직 [deep]
├── Task 5: SKILL.md 템플릿 엔진 [quick]
└── Task 6: stdio 타입 MCP 래퍼 패턴 [unspecified-high]

Wave 3 (After Task 4 — 5개 MCP 스킬 생성 + 테스트):
├── Task 7: grep_app 스킬 생성 + 검증 [quick]
├── Task 8: websearch 스킬 생성 + 검증 [quick]
├── Task 9: context7 스킬 생성 + 검증 [quick]
├── Task 10: deepwiki 스킬 생성 + 검증 [quick]
├── Task 11: obsidian(local stdio) 스킬 생성 + 검증 [quick]
└── Task 12: mcp-to-skill CLI 단위 테스트 [unspecified-high]

Wave 4 (After Wave 3 — 통합 + 문서):
├── Task 13: 성능 비교 측정 (always-on vs skill-wrapped) [deep]
├── Task 14: 하이브리드 전략 권고 문서 [writing]
└── Task 15: 사용자 가이드 + README [writing]

Wave FINAL (After ALL tasks — 독립 검증, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 3 → Task 2 → Task 4 → Tasks 7-11 → Task 13 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 6 (Wave 3)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1    | —         | 14     | 1    |
| 2    | —         | 4, 6   | 1    |
| 3    | —         | 2, 4, 5| 1    |
| 4    | 2, 3      | 7-12   | 2    |
| 5    | 3         | 4      | 2    |
| 6    | 2         | 7-11   | 2    |
| 7    | 4, 6      | 13     | 3    |
| 8    | 4, 6      | 13     | 3    |
| 9    | 4, 6      | 13     | 3    |
| 10   | 4, 6      | 13     | 3    |
| 11   | 4, 6      | 13     | 3    |
| 12   | 4         | F2     | 3    |
| 13   | 7-11      | 14     | 4    |
| 14   | 1, 13     | F1     | 4    |
| 15   | 4         | F1     | 4    |

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `writing`, T2 → `deep`, T3 → `quick`
- **Wave 2**: **3** — T4 → `deep`, T5 → `quick`, T6 → `unspecified-high`
- **Wave 3**: **6** — T7-T11 → `quick`, T12 → `unspecified-high`
- **Wave 4**: **3** — T13 → `deep`, T14 → `writing`, T15 → `writing`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

---

- [ ] 1. Dehydrator vs Skill-Wrapped MCP 비교 분석 문서 작성

  **What to do**:
  - Dehydrator(https://github.com/Arrmlet/dehydrator)의 아키텍처 상세 분석
  - Skill-Wrapped MCP 아키텍처 설계 (아래 컨텍스트 기반)
  - 6가지 축에서 비교: (1) 토큰 비용, (2) 레이턴시, (3) API 콜 수, (4) 구현 복잡도, (5) 유지보수, (6) OpenCode 호환성
  - 비교 표 작성: always-on MCP vs Dehydrator vs Skill-Wrapped
  - 각 접근법의 적합한 사용 시나리오 정리
  - 실측 데이터 인용: cold start 4,100ms, warm 250ms, 토큰 ~3,000/prompt
  - 결론: "언제 어떤 접근법을 써야 하는가" 권고
  - 출력: `investigate/analysis/dehydrator-comparison.md` (100줄 이상)

  **Must NOT do**:
  - Dehydrator 코드 직접 실행이나 설치
  - 추측 기반 벤치마크 (실측 데이터만 인용)

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 기술 비교 분석 문서 작성이 핵심
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: UI 관련 아님

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 14 (하이브리드 전략 문서)
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/investigate/results/report.md` — 실측 데이터 (MCP cold start 4,100ms, warm 250ms, 서버별 지연 시간)

  **API/Type References**:
  - Dehydrator GitHub: https://github.com/Arrmlet/dehydrator — README의 아키텍처 설명, BM25 기반 tool_search, 98% 토큰 절감 수치

  **External References**:
  - Dehydrator README 핵심 정보:
    - Python 라이브러리, `pip install dehydrator`
    - `dehydrate(client)` → tool list를 `tool_search` 메타 도구로 대체
    - LLM이 `tool_search("send email")` 호출 → BM25 로컬 매칭 → 매칭된 도구만으로 재호출
    - 200 tools: 18,159 → 349 tokens (98% reduction)
    - Anthropic, OpenAI, MCP 네이티브 지원
    - 단점: 모든 MCP 서버 연결 유지, listTools() 인덱스 빌드 필요, API 콜 2배
  - OpenCode 스킬 아키텍처:
    - `skill("name")` → SKILL.md 컨텐츠 주입 → LLM이 bash로 스크립트 호출
    - 토큰 비용: SKILL.md 내용 크기만큼 (보통 500-1000 토큰)
    - MCP 서버 idle 시 연결 없음 → 0 토큰, 0 레이턴시

  **WHY Each Reference Matters**:
  - report.md: 실측 데이터 기반 비교를 위한 수치 소스 (추측 방지)
  - Dehydrator README: 토큰 절감 수치, 아키텍처 제한사항 정확한 인용 필요

  **Acceptance Criteria**:

  - [ ] `investigate/analysis/dehydrator-comparison.md` 생성됨
  - [ ] 문서가 100줄 이상
  - [ ] 6가지 비교 축 모두 포함 (토큰, 레이턴시, API콜, 복잡도, 유지보수, 호환성)
  - [ ] 3-way 비교 표 포함 (always-on vs Dehydrator vs Skill-Wrapped)
  - [ ] 실측 데이터 인용 (4,100ms, 250ms, 3,000 토큰)

  **QA Scenarios:**

  ```
  Scenario: 비교 분석 문서 구조 검증
    Tool: Bash
    Preconditions: Task 1 완료
    Steps:
      1. wc -l investigate/analysis/dehydrator-comparison.md → 100줄 이상
      2. grep -c '|' investigate/analysis/dehydrator-comparison.md → 10 이상 (비교 표)
      3. grep 'Dehydrator' investigate/analysis/dehydrator-comparison.md → 5회 이상 언급
      4. grep '4,100\|4100' investigate/analysis/dehydrator-comparison.md → 실측 데이터 인용
      5. grep 'Skill-Wrapped\|Skill.Wrapped' investigate/analysis/dehydrator-comparison.md → 존재
    Expected Result: 모든 grep이 매치, wc가 100 이상
    Failure Indicators: 비교 표 없음, 실측 데이터 미인용
    Evidence: .sisyphus/evidence/task-1-doc-structure.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-doc-structure.txt

  **Commit**: YES (groups with 1)
  - Message: `docs(analysis): add Dehydrator vs Skill-Wrapped MCP comparison`
  - Files: `investigate/analysis/dehydrator-comparison.md`
  - Pre-commit: `wc -l investigate/analysis/dehydrator-comparison.md`

- [ ] 2. MCP 클라이언트 CLI 스크립트 개발 (mcp-client.ts)

  **What to do**:
  - MCP 서버에 연결하여 도구를 호출하는 범용 CLI 스크립트 개발
  - 지원 전송 타입: stdio (command+args), remote (SSE/streamable-HTTP url)
  - MCP SDK(`@modelcontextprotocol/sdk`)의 `Client`, `StdioClientTransport`, `SSEClientTransport` 사용
  - CLI 인터페이스: `bun run mcp-client.ts --type stdio --command npx --args '-y @anthropic-ai/dehydrator' --tool tool_name --input '{"key":"value"}'`
  - 또는 remote: `bun run mcp-client.ts --type remote --url https://mcp.deepwiki.com/mcp --tool ask_question --input '{...}'`
  - 추가 기능: `--list-tools` 플래그로 사용 가능한 도구 목록 출력
  - 타임아웃: 30초 기본, `--timeout` 옵션
  - 에러 처리: 서버 스폰 실패, 연결 타임아웃, 잘못된 응답 → 명확한 에러 메시지 + exit code 1
  - 출력: JSON (stdout), 에러는 stderr
  - 파일 위치: `investigate/mcp-to-skill/src/mcp-client.ts` (200줄 이내)

  **Must NOT do**:
  - MCP 프로토콜 커스텀 구현 (SDK만 사용)
  - 서버를 백그라운드 데몬으로 유지
  - API 키 하드코딩

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: MCP SDK 통합, 에러 핸들링, 복수 전송 타입 지원 등 깊은 이해 필요
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: 브라우저 관련 아님

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 4, 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/mcp/index.ts` — OpenCode의 MCP 클라이언트 구현 참고 (Client, StdioClientTransport 사용 패턴)

  **API/Type References**:
  - MCP TypeScript SDK: `@modelcontextprotocol/sdk` — `Client`, `StdioClientTransport`, `SSEClientTransport` 클래스
  - `Client.connect(transport)` / `Client.close()` — 동적 연결/해제
  - `client.listTools()` → `{ tools: Tool[] }` — 도구 목록
  - `client.callTool({ name, arguments })` → `{ content: Content[] }` — 도구 호출

  **External References**:
  - MCP TypeScript SDK GitHub: https://github.com/modelcontextprotocol/typescript-sdk
  - DeepWiki 확인: MCP SDK는 stdio_client와 ClientSession을 통한 동적 연결 지원

  **WHY Each Reference Matters**:
  - OpenCode mcp/index.ts: 실제 작동하는 MCP 클라이언트 패턴 (stdio transport 생성, connect, listTools)
  - MCP SDK: 정확한 API 시그니처와 타입 정보

  **Acceptance Criteria**:

  - [ ] `investigate/mcp-to-skill/src/mcp-client.ts` 생성됨 (200줄 이내)
  - [ ] `--list-tools` 플래그로 deepwiki 서버의 도구 목록 출력 가능
  - [ ] `--tool` + `--input`으로 deepwiki의 `ask_question` 도구 호출 가능
  - [ ] 30초 타임아웃 후 깔끔한 종료
  - [ ] 서버 연결 후 자동 종료 (데몬화 없음)

  **QA Scenarios:**

  ```
  Scenario: deepwiki MCP 도구 목록 조회
    Tool: Bash
    Preconditions: @modelcontextprotocol/sdk 설치됨, deepwiki MCP 서버 접근 가능
    Steps:
      1. cd investigate/mcp-to-skill
      2. bun run src/mcp-client.ts --type remote --url https://mcp.deepwiki.com/mcp --list-tools
      3. stdout JSON 파싱 → tools 배열 확인
    Expected Result: JSON 출력에 `read_wiki_structure`, `read_wiki_contents`, `ask_question` 도구 포함
    Failure Indicators: 연결 실패, 빈 도구 목록, 타임아웃
    Evidence: .sisyphus/evidence/task-2-list-tools.txt

  Scenario: deepwiki 도구 호출 실패 (잘못된 URL)
    Tool: Bash
    Preconditions: 동일
    Steps:
      1. bun run src/mcp-client.ts --type remote --url https://invalid.example.com/mcp --list-tools
    Expected Result: exit code 1, stderr에 에러 메시지
    Failure Indicators: 무한 대기, 크래시 (uncaught exception)
    Evidence: .sisyphus/evidence/task-2-error-handling.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-list-tools.txt
  - [ ] task-2-error-handling.txt

  **Commit**: YES (groups with 3)
  - Message: `feat(mcp-to-skill): add MCP client CLI script`
  - Files: `investigate/mcp-to-skill/src/mcp-client.ts`
  - Pre-commit: `bun run src/mcp-client.ts --type remote --url https://mcp.deepwiki.com/mcp --list-tools`

- [ ] 3. 프로젝트 scaffolding + 타입 정의

  **What to do**:
  - `investigate/mcp-to-skill/` 디렉터리 생성
  - `package.json` 생성: name `mcp-to-skill`, bun runtime, dependencies: `@modelcontextprotocol/sdk`, `zod`
  - `tsconfig.json` 생성: strict mode, ESNext target, Bun types
  - `src/types.ts`: MCP 서버 설정 타입, 스킬 메타데이터 타입, 생성 옵션 타입
  - `investigate/analysis/` 디렉터리 생성 (분석 문서 출력)
  - `bun install` 실행

  **Must NOT do**:
  - 불필요한 의존성 추가
  - vitest/jest 등 테스트 프레임워크 (bun test 사용)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: boilerplate 생성, 단순 scaffolding
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 2, 4, 5
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `/Users/sbbae/project/investigate/package.json` — 기존 investigate 프로젝트 구조 참고
  - `/Users/sbbae/.config/opencode/opencode.json:3-8` — MCP 서버 설정 JSON 구조 (타입 정의 시 참고)

  **API/Type References**:
  - OpenCode MCP config 타입: `{ [name: string]: { type: 'stdio' | 'remote', command?: string, args?: string[], url?: string, env?: Record<string, string> } }`

  **WHY Each Reference Matters**:
  - investigate/package.json: 일관된 프로젝트 구조
  - opencode.json: MCP 설정 파싱을 위한 정확한 타입 정의

  **Acceptance Criteria**:

  - [ ] `investigate/mcp-to-skill/package.json` 존재
  - [ ] `investigate/mcp-to-skill/tsconfig.json` 존재
  - [ ] `investigate/mcp-to-skill/src/types.ts` 존재
  - [ ] `bun install` → exit code 0
  - [ ] `investigate/analysis/` 디렉터리 존재

  **QA Scenarios:**

  ```
  Scenario: 프로젝트 빌드 확인
    Tool: Bash
    Preconditions: bun 설치됨
    Steps:
      1. cd investigate/mcp-to-skill && ls package.json tsconfig.json src/types.ts
      2. bun install → exit code 0
      3. bunx tsc --noEmit → exit code 0 (타입 체크 통과)
    Expected Result: 모든 파일 존재, bun install 성공, tsc 통과
    Failure Indicators: 파일 누락, 의존성 설치 실패, 타입 에러
    Evidence: .sisyphus/evidence/task-3-scaffolding.txt
  ```

  **Evidence to Capture:**
  - [ ] task-3-scaffolding.txt

  **Commit**: YES (groups with 2)
  - Message: `feat(mcp-to-skill): project scaffolding and type definitions`
  - Files: `investigate/mcp-to-skill/package.json`, `investigate/mcp-to-skill/tsconfig.json`, `investigate/mcp-to-skill/src/types.ts`
  - Pre-commit: `cd investigate/mcp-to-skill && bunx tsc --noEmit`

- [ ] 4. mcp-to-skill CLI 핵심 로직 개발

  **What to do**:
  - `investigate/mcp-to-skill/src/generator.ts` — 핵심 변환 로직 (200줄 이내)
  - `investigate/mcp-to-skill/cli.ts` — CLI 엔트리포인트 (50줄 이내)
  - OpenCode의 `opencode.json` (MCP 설정 섬션) 파싱
  - 각 MCP 서버에 대해:
    1. MCP 서버에 연결하여 `listTools()` 호출 → 사용 가능한 도구 목록 획득
    2. 각 도구의 이름, 설명, inputSchema를 파싱
    3. SKILL.md 생성 (frontmatter + 도구 사용법 설명)
    4. mcp-caller.sh 생성 (도구별 호출 스크립트)
    5. 출력 디렉터리: `generated-skills/{server-name}/SKILL.md` + `scripts/mcp-caller.sh`
  - CLI 사용법:
    - `bun run cli.ts generate --config ~/.config/opencode/opencode.json` → 모든 MCP 서버 변환
    - `bun run cli.ts generate --config ~/.config/opencode/opencode.json --server deepwiki` → 특정 서버만
    - `bun run cli.ts generate --config ~/.config/opencode/opencode.json --output ~/.config/opencode/skills/` → 직접 설치
  - generator.ts 핵심 함수:
    - `parseOpenCodeConfig(configPath: string): McpServerConfig[]`
    - `introspectServer(config: McpServerConfig): ToolInfo[]`
    - `generateSkill(serverName: string, tools: ToolInfo[], outputDir: string): void`

  **Must NOT do**:
  - MCP 서버를 영구 프로세스로 유지 (도구 목록 획득 후 즉시 종료)
  - API 키 하드코딩 (환경변수 사용)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: MCP SDK 통합, 파일 생성 로직, CLI 파싱 등 복잡한 로직
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (Task 2, 3 의존)
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Tasks 7-12
  - **Blocked By**: Tasks 2, 3

  **References**:

  **Pattern References**:
  - `investigate/mcp-to-skill/src/mcp-client.ts` (Task 2에서 생성) — MCP SDK 사용 패턴, transport 생성, connect/listTools/callTool 패턴
  - `investigate/mcp-to-skill/src/types.ts` (Task 3에서 생성) — MCP 서버 설정 타입, 스킬 메타데이터 타입
  - `/Users/sbbae/.config/opencode/skills/mule-test/SKILL.md` — 기존 스킬 SKILL.md 패턴 (frontmatter 구조, description 형식)
  - `/Users/sbbae/.config/opencode/skills/obsidian-mcp-setup/` — 스킬 + scripts/ 번들 패턴 참고

  **API/Type References**:
  - `investigate/mcp-to-skill/src/types.ts` — `McpServerConfig`, `ToolInfo`, `SkillMetadata` 타입
  - `/Users/sbbae/.config/opencode/opencode.json` — 실제 MCP 설정 JSON 구조

  **External References**:
  - OpenCode 스킬 시스템 (`/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/skill/skill.ts`) — SKILL.md 파싱 규칙: frontmatter에 `name`, `description` 필수. content는 마크다운 본문.
  - OpenCode SkillTool (`/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/tool/skill.ts`) — LLM이 skill 로드 시 SKILL.md content + 디렉터리 파일 목록이 주입됨

  **WHY Each Reference Matters**:
  - mcp-client.ts: MCP SDK 사용 패턴 재사용 (connect, listTools, callTool)
  - mule-test/SKILL.md: 생성할 SKILL.md의 frontmatter 형식 확인
  - obsidian-mcp-setup/: scripts/ 번들링 패턴 확인 (스킬이 스크립트를 참조하는 방식)
  - skill.ts: SKILL.md의 정확한 파싱 규칙 (name, description frontmatter 필수)

  **Acceptance Criteria**:

  - [ ] `investigate/mcp-to-skill/src/generator.ts` 생성됨 (200줄 이내)
  - [ ] `investigate/mcp-to-skill/cli.ts` 생성됨 (50줄 이내)
  - [ ] `bun run cli.ts generate --config ~/.config/opencode/opencode.json` → deepwiki 스킬 생성
  - [ ] 생성된 `generated-skills/deepwiki/SKILL.md`에 frontmatter (name, description) 존재
  - [ ] 생성된 `generated-skills/deepwiki/scripts/mcp-caller.sh` 실행 가능

  **QA Scenarios:**

  ```
  Scenario: deepwiki MCP 서버 스킬 자동 생성
    Tool: Bash
    Preconditions: Task 2, 3 완료, deepwiki MCP 서버 접근 가능
    Steps:
      1. cd investigate/mcp-to-skill
      2. bun run cli.ts generate --config ~/.config/opencode/opencode.json --server deepwiki
      3. ls generated-skills/deepwiki/SKILL.md → 존재
      4. head -5 generated-skills/deepwiki/SKILL.md → frontmatter (---) 확인
      5. grep 'name: deepwiki' generated-skills/deepwiki/SKILL.md → 존재
      6. ls generated-skills/deepwiki/scripts/mcp-caller.sh → 존재
      7. file generated-skills/deepwiki/scripts/mcp-caller.sh → 실행 가능
    Expected Result: SKILL.md와 mcp-caller.sh 모두 생성됨, frontmatter 올바름
    Failure Indicators: 파일 미생성, frontmatter 누락, 도구 설명 누락
    Evidence: .sisyphus/evidence/task-4-generate-deepwiki.txt

  Scenario: 존재하지 않는 MCP 서버 지정 시 에러
    Tool: Bash
    Preconditions: 동일
    Steps:
      1. bun run cli.ts generate --config ~/.config/opencode/opencode.json --server nonexistent
    Expected Result: exit code 1, 에러 메시지 출력
    Failure Indicators: 크래시, 빈 출력
    Evidence: .sisyphus/evidence/task-4-error-nonexistent.txt
  ```

  **Evidence to Capture:**
  - [ ] task-4-generate-deepwiki.txt
  - [ ] task-4-error-nonexistent.txt

  **Commit**: YES
  - Message: `feat(mcp-to-skill): add skill generator core logic and CLI`
  - Files: `investigate/mcp-to-skill/src/generator.ts`, `investigate/mcp-to-skill/cli.ts`
  - Pre-commit: `cd investigate/mcp-to-skill && bunx tsc --noEmit`

- [ ] 5. SKILL.md 템플릿 엔진

  **What to do**:
  - `investigate/mcp-to-skill/src/templates.ts` — SKILL.md 생성 템플릿 (100줄 이내)
  - Frontmatter 생성: `name` (서버명), `description` (도구 목록 요약)
  - 마크다운 본문 생성:
    - "이 스킬은 {server-name} MCP 서버의 도구를 on-demand로 호출합니다" 도입부
    - 각 도구별: 이름, 설명, 파라미터 JSON Schema (간결하게)
    - 호출 방법: `bash <skill-dir>/scripts/mcp-caller.sh {tool_name} '{json_args}'`
    - 예시 호출 제공
  - 토큰 효율성: SKILL.md 총 토큰 수가 1,000 이하가 되도록 간결하게 작성
  - mcp-caller.sh 생성 템플릿:
    - `#!/bin/bash`
    - mcp-client.ts를 호출하는 래퍼 스크립트
    - 서버 타입에 따른 적절한 인수 전달
    - 에러 처리: 연결 실패 시 명확한 메시지

  **Must NOT do**:
  - SKILL.md에 불필요한 긴 설명 (토큰 낭비)
  - API 키를 템플릿에 하드코딩

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 템플릿 문자열 생성, 단순 로직
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6)
  - **Blocks**: Task 4
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `/Users/sbbae/.config/opencode/skills/mule-test/SKILL.md` — 실제 동작하는 SKILL.md 구조 (frontmatter: name, description. content: 마크다운)
  - `/Users/sbbae/.config/opencode/skills/obsidian-mcp-setup/SKILL.md` — scripts/ 참조 패턴 (`python3 <skill-dir>/scripts/setup.py`)

  **API/Type References**:
  - OpenCode 스킬 파싱 (`/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/skill/skill.ts:68`) — `Info.pick({ name: true, description: true }).safeParse(md.data)` — frontmatter에 name과 description 필수
  - OpenCode SkillTool (`/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/tool/skill.ts:76-97`) — 스킬 로드 시 `path.dirname(skill.location)` 기준 파일 탐색, `<skill-dir>` 개념

  **WHY Each Reference Matters**:
  - mule-test SKILL.md: 생성할 SKILL.md가 OpenCode에서 정상 로드되려면 이 구조를 따라야 함
  - obsidian-mcp-setup: scripts/ 번들링 시 `<skill-dir>` 경로가 어떻게 작동하는지 확인
  - skill.ts:68: frontmatter 필수 필드 (name, description) 누락 시 스킬 로드 실패

  **Acceptance Criteria**:

  - [ ] `investigate/mcp-to-skill/src/templates.ts` 생성됨 (100줄 이내)
  - [ ] 생성된 SKILL.md에 `---` frontmatter, `name:`, `description:` 포함
  - [ ] 생성된 SKILL.md 토큰 수 1,000 이하 (대략 4KB 이하)
  - [ ] 생성된 mcp-caller.sh에 shebang, 에러 처리 포함

  **QA Scenarios:**

  ```
  Scenario: 템플릿으로 생성된 SKILL.md 검증
    Tool: Bash
    Preconditions: Task 3 완료
    Steps:
      1. 템플릿 함수를 테스트 입력으로 호출 (bun eval)
      2. 생성된 SKILL.md 내용 확인: grep 'name:' → 존재
      3. 생성된 SKILL.md 내용 확인: grep 'description:' → 존재
      4. wc -c SKILL.md → 4096 bytes 이하
    Expected Result: 모든 필수 필드 존재, 크기 제한 준수
    Failure Indicators: frontmatter 누락, 크기 초과
    Evidence: .sisyphus/evidence/task-5-template-output.txt
  ```

  **Evidence to Capture:**
  - [ ] task-5-template-output.txt

  **Commit**: YES (groups with 4)
  - Message: `feat(mcp-to-skill): add SKILL.md and mcp-caller.sh templates`
  - Files: `investigate/mcp-to-skill/src/templates.ts`
  - Pre-commit: `cd investigate/mcp-to-skill && bunx tsc --noEmit`

- [ ] 6. stdio 타입 MCP 래퍼 패턴 검증

  **What to do**:
  - mcp-client.ts의 stdio 전송 지원이 실제로 작동하는지 검증
  - 테스트 대상: `@anthropic-ai/tokenizer` 또는 유사한 npx로 실행 가능한 MCP 서버
  - 또는 `@modelcontextprotocol/server-filesystem` 같은 공식 예제 MCP 서버로 테스트
  - stdio 타입 스킬 래퍼의 mcp-caller.sh가 command + args 형식으로 MCP 서버를 스폰하고 도구 호출 후 종료하는지 확인
  - 프로세스 종료 확인: mcp-caller.sh 실행 후 MCP 서버 프로세스가 남아있지 않은지 확인
  - env 전달 검증: MCP config의 `env` 필드가 스크립트로 전달되는지

  **Must NOT do**:
  - MCP 서버를 백그라운드로 남김 (반드시 종료 확인)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: MCP 프로토콜 상호작용 검증, 에지케이스 처리
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: Tasks 7-11
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `investigate/mcp-to-skill/src/mcp-client.ts` (Task 2) — stdio transport 생성 코드
  - `/Users/sbbae/project/research/_tmp/opencode/packages/opencode/src/mcp/index.ts` — OpenCode의 StdioClientTransport 생성 패턴 (command, args, env 전달 방식)

  **External References**:
  - `@modelcontextprotocol/server-filesystem` — 공식 MCP stdio 서버 예제 (테스트 대상)

  **WHY Each Reference Matters**:
  - mcp-client.ts: stdio 전송의 실제 구현 검증
  - mcp/index.ts: env 전달 패턴 확인 (특히 API_KEY 등이 환경변수로 전달되는 방식)

  **Acceptance Criteria**:

  - [ ] stdio 타입 MCP 서버에 연결하여 listTools() 성공
  - [ ] 도구 호출 후 MCP 서버 프로세스 자동 종료 확인
  - [ ] env 전달이 작동하는지 확인

  **QA Scenarios:**

  ```
  Scenario: stdio MCP 서버 연결 + 도구 목록 조회
    Tool: Bash
    Preconditions: npx 사용 가능, @modelcontextprotocol/server-filesystem 설치 가능
    Steps:
      1. cd investigate/mcp-to-skill
      2. bun run src/mcp-client.ts --type stdio --command npx --args '-y @modelcontextprotocol/server-filesystem /tmp' --list-tools
      3. stdout JSON 파싱 → tools 배열 확인
    Expected Result: filesystem 도구들 (read_file, write_file 등) 목록 출력
    Failure Indicators: 프로세스 스폰 실패, 타임아웃
    Evidence: .sisyphus/evidence/task-6-stdio-list-tools.txt

  Scenario: stdio MCP 서버 호출 후 프로세스 종료 확인
    Tool: Bash
    Preconditions: 동일
    Steps:
      1. bun run src/mcp-client.ts --type stdio --command npx --args '-y @modelcontextprotocol/server-filesystem /tmp' --list-tools
      2. sleep 1
      3. ps aux | grep 'server-filesystem' | grep -v grep → 결과 없음
    Expected Result: MCP 서버 프로세스가 종료됨 (남아있지 않음)
    Failure Indicators: MCP 서버 프로세스 잔존 (zombie)
    Evidence: .sisyphus/evidence/task-6-process-cleanup.txt
  ```

  **Evidence to Capture:**
  - [ ] task-6-stdio-list-tools.txt
  - [ ] task-6-process-cleanup.txt

  **Commit**: NO (검증 태스크, 별도 코드 변경 없음)

- [ ] 7. grep_app 스킬 래퍼 생성 + 검증

  **What to do**:
  - `bun run cli.ts generate --config <config-with-grep_app> --server grep_app` 실행
  - grep_app MCP 서버는 stdio 타입 (npx 실행)
  - 이전 측정 데이터: grep_app는 264ms avg 레이턴시, remote(stdio→HTTP)
  - 생성된 스킬로 MCP 도구(`searchGitHub`) 실제 호출 검증
  - 이전 측정 시의 MCP 설정을 보존한 테스트용 config 파일 작성 필요
  - grep_app config 예시: `{ "grep_app": { "type": "stdio", "command": "npx", "args": ["-y", "@anthropic-ai/grep-app-mcp"] } }`
  - 생성 후: `generated-skills/grep_app/SKILL.md` + `scripts/mcp-caller.sh`

  **Must NOT do**:
  - API 키 하드코딩

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: CLI 실행 + 결과 검증
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8-12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 6

  **References**:

  **Pattern References**:
  - `investigate/mcp-to-skill/generated-skills/deepwiki/` (Task 4에서 생성) — 스킬 래퍼 구조 참고
  - `/Users/sbbae/project/investigate/results/report.md:65` — grep_app: 264ms avg, remote(stdio→HTTP)

  **WHY Each Reference Matters**:
  - deepwiki 스킬: 이미 생성된 스킬 패턴 따름
  - report.md: grep_app의 성능 특성 이해

  **Acceptance Criteria**:
  - [ ] `generated-skills/grep_app/SKILL.md` 생성됨
  - [ ] `generated-skills/grep_app/scripts/mcp-caller.sh` 생성됨
  - [ ] mcp-caller.sh로 `searchGitHub` 도구 호출 시 JSON 응답 수신

  **QA Scenarios:**
  ```
  Scenario: grep_app 스킬로 searchGitHub 호출
    Tool: Bash
    Preconditions: Tasks 4, 6 완료
    Steps:
      1. cd investigate/mcp-to-skill
      2. bash generated-skills/grep_app/scripts/mcp-caller.sh searchGitHub '{"query": "useState(", "language": ["TypeScript"]}'
      3. stdout JSON 파싱 → 검색 결과 확인
    Expected Result: GitHub 코드 검색 결과 JSON 반환
    Failure Indicators: 연결 실패, 빈 응답, 타임아웃
    Evidence: .sisyphus/evidence/task-7-grep-app.txt
  ```

  **Evidence to Capture:**
  - [ ] task-7-grep-app.txt

  **Commit**: YES (groups with 8-11)
  - Message: `feat(mcp-to-skill): generate skill wrappers for 5 MCP servers`
  - Files: `investigate/mcp-to-skill/generated-skills/`

- [ ] 8. websearch 스킬 래퍼 생성 + 검증

  **What to do**:
  - websearch MCP 서버 스킬 생성 (테스트용 config 작성 필요)
  - websearch는 stdio 타입 (npx 실행)
  - 이전 측정: 212ms avg
  - 생성된 스킬로 웹 검색 도구 실제 호출 검증
  - config 예시: `{ "websearch": { "type": "stdio", "command": "npx", "args": ["-y", "@anthropic-ai/websearch-mcp"] } }`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 9-12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `investigate/mcp-to-skill/generated-skills/deepwiki/` — 스킬 패턴
  - `/Users/sbbae/project/investigate/results/report.md:66` — websearch: 212ms avg

  **Acceptance Criteria**:
  - [ ] `generated-skills/websearch/SKILL.md` 생성됨
  - [ ] `generated-skills/websearch/scripts/mcp-caller.sh` 생성됨
  - [ ] mcp-caller.sh로 웹 검색 도구 호출 시 JSON 응답 수신

  **QA Scenarios:**
  ```
  Scenario: websearch 스킬 웹 검색 호출
    Tool: Bash
    Steps:
      1. bash generated-skills/websearch/scripts/mcp-caller.sh web_search_exa '{"query": "OpenCode CLI"}'
      2. stdout JSON 파싱
    Expected Result: 검색 결과 JSON
    Evidence: .sisyphus/evidence/task-8-websearch.txt
  ```

  **Evidence to Capture:**
  - [ ] task-8-websearch.txt

  **Commit**: YES (groups with 7, 9-11)

- [ ] 9. context7 스킬 래퍼 생성 + 검증

  **What to do**:
  - context7 MCP 서버 스킬 생성
  - context7는 stdio 타입
  - 이전 측정: 199ms avg
  - 생성된 스킬로 `resolve-library-id` + `query-docs` 도구 호출 검증

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7-8, 10-12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `investigate/mcp-to-skill/generated-skills/deepwiki/` — 스킬 패턴

  **Acceptance Criteria**:
  - [ ] `generated-skills/context7/SKILL.md` 생성됨
  - [ ] mcp-caller.sh로 `resolve-library-id` 도구 호출 시 JSON 응답

  **QA Scenarios:**
  ```
  Scenario: context7 라이브러리 ID 조회
    Tool: Bash
    Steps:
      1. bash generated-skills/context7/scripts/mcp-caller.sh resolve-library-id '{"libraryName": "react", "query": "hooks"}'
      2. stdout JSON 파싱 → libraryId 확인
    Expected Result: react 라이브러리 ID JSON
    Evidence: .sisyphus/evidence/task-9-context7.txt
  ```

  **Evidence to Capture:**
  - [ ] task-9-context7.txt

  **Commit**: YES (groups with 7-8, 10-11)

- [ ] 10. deepwiki 스킬 래퍼 검증 (이미 Task 4에서 생성됨)

  **What to do**:
  - Task 4에서 생성된 deepwiki 스킬이 실제로 동작하는지 end-to-end 검증
  - deepwiki는 remote 타입 (URL: https://mcp.deepwiki.com/mcp)
  - 도구 `ask_question`, `read_wiki_structure`, `read_wiki_contents` 호출 검증
  - SKILL.md 내용이 정확한지 (도구 이름, 파라미터 설명) 확인

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7-9, 11-12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `investigate/mcp-to-skill/generated-skills/deepwiki/` — Task 4에서 생성된 스킬
  - `https://mcp.deepwiki.com/mcp` — deepwiki MCP 서버 URL

  **Acceptance Criteria**:
  - [ ] mcp-caller.sh로 `ask_question` 호출 시 JSON 응답 수신
  - [ ] SKILL.md에 3개 도구 설명 포함 (ask_question, read_wiki_structure, read_wiki_contents)

  **QA Scenarios:**
  ```
  Scenario: deepwiki ask_question 호출
    Tool: Bash
    Steps:
      1. cd investigate/mcp-to-skill
      2. bash generated-skills/deepwiki/scripts/mcp-caller.sh ask_question '{"repoName": "facebook/react", "question": "What is React?"}'
      3. stdout 확인 → React 설명 포함
    Expected Result: React에 대한 응답 JSON
    Failure Indicators: 연결 실패, 빈 응답
    Evidence: .sisyphus/evidence/task-10-deepwiki-e2e.txt
  ```

  **Evidence to Capture:**
  - [ ] task-10-deepwiki-e2e.txt

  **Commit**: YES (groups with 7-9, 11)

- [ ] 11. obsidian(local stdio) 스킬 래퍼 생성 + 검증

  **What to do**:
  - obsidian MCP 서버 스킬 생성 (로컬 stdio, 1ms avg — 최소 레이턴시)
  - obsidian MCP는 로컬이므로 cold start도 빠름
  - 스킬 래퍼의 오버헤드와 always-on MCP 비교 시, 이 서버는 always-on이 더 효율할 수 있음 (→ 하이브리드 전략 입력 데이터)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7-10, 12)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `/Users/sbbae/project/investigate/results/report.md:69` — obsidian: 1ms avg (local stdio)

  **Acceptance Criteria**:
  - [ ] `generated-skills/obsidian/SKILL.md` 생성됨
  - [ ] 스킬 래퍼를 통한 MCP 도구 호출 가능

  **QA Scenarios:**
  ```
  Scenario: obsidian 스킬 로컬 MCP 호출
    Tool: Bash
    Steps:
      1. bash generated-skills/obsidian/scripts/mcp-caller.sh list_tools '{}'
    Expected Result: obsidian MCP 도구 목록 JSON
    Evidence: .sisyphus/evidence/task-11-obsidian.txt
  ```

  **Evidence to Capture:**
  - [ ] task-11-obsidian.txt

  **Commit**: YES (groups with 7-10)

- [ ] 12. mcp-to-skill CLI 단위 테스트

  **What to do**:
  - `investigate/mcp-to-skill/src/generator.test.ts` — generator 함수 테스트
  - `investigate/mcp-to-skill/src/templates.test.ts` — 템플릿 생성 테스트
  - 테스트 케이스:
    1. `parseOpenCodeConfig` — 유효한 config 파싱, 빈 config, 잘못된 config
    2. `generateSkillMd` — frontmatter 구조, 토큰 효율성, 필수 필드
    3. `generateMcpCallerSh` — shebang, 에러 처리, 환경변수 전달
  - `bun test` 실행으로 모든 테스트 통과 확인

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 테스트 코드 작성, 에지케이스 커버리지
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7-11)
  - **Blocks**: F2
  - **Blocked By**: Task 4

  **References**:
  - `investigate/mcp-to-skill/src/generator.ts` (Task 4) — 테스트 대상 함수들
  - `investigate/mcp-to-skill/src/templates.ts` (Task 5) — 테스트 대상 함수들

  **Acceptance Criteria**:
  - [ ] `src/generator.test.ts` 생성됨
  - [ ] `src/templates.test.ts` 생성됨
  - [ ] `bun test` → 모든 테스트 PASS

  **QA Scenarios:**
  ```
  Scenario: 모든 단위 테스트 통과
    Tool: Bash
    Steps:
      1. cd investigate/mcp-to-skill && bun test
    Expected Result: 모든 테스트 PASS, 0 failures
    Evidence: .sisyphus/evidence/task-12-unit-tests.txt
  ```

  **Evidence to Capture:**
  - [ ] task-12-unit-tests.txt

  **Commit**: YES
  - Message: `test(mcp-to-skill): add unit tests for generator and templates`
  - Files: `investigate/mcp-to-skill/src/*.test.ts`
  - Pre-commit: `cd investigate/mcp-to-skill && bun test`

- [ ] 13. 성능 비교 측정 (always-on MCP vs skill-wrapped)

  **What to do**:
  - 두 방식의 성능을 정량적으로 비교 측정
  - **측정 항목**:
    1. **스킬 래퍼 호출 레이턴시**: skill load 시간 + mcp-caller.sh 실행 시간 (MCP 서버 스폰 + listTools + callTool + 종료)
    2. **always-on MCP 레이턴시**: 기존 측정 데이터 인용 (warm: ~250ms/prompt)
    3. **토큰 비용 비교**: SKILL.md 토큰 수 vs always-on MCP 토큰 수 (~3,000)
    4. **idle 시 오버헤드**: skill = 0, always-on = ~250ms + ~3,000 tokens
    5. **cold start 비교**: always-on MCP cold start (4,100ms) vs skill-wrapped cold start
  - **측정 방법**:
    - `time bash generated-skills/deepwiki/scripts/mcp-caller.sh ask_question '{...}'` → 스킬 래퍼 호출 시간
    - 각 MCP 서버별 3회 반복 측정
    - SKILL.md 파일 크기로 토큰 수 추정 (1 token ≈ 4 chars)
  - **출력**: `investigate/analysis/performance-comparison.md`
  - 비교 표 + 결론 (언제 어떤 접근법이 유리한가)

  **Must NOT do**:
  - 합성 데이터 사용 (실측 측정만)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 성능 측정, 데이터 분석, 결론 도출
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 7-11

  **References**:
  - `investigate/mcp-to-skill/generated-skills/*/scripts/mcp-caller.sh` — 측정 대상 스크립트
  - `/Users/sbbae/project/investigate/results/report.md` — always-on MCP 측정 데이터 (cold: 4,100ms, warm: 250ms, 서버별 지연)

  **WHY Each Reference Matters**:
  - generated-skills: 실제 측정할 스크립트
  - report.md: 비교 기준점 (always-on MCP 성능 데이터)

  **Acceptance Criteria**:
  - [ ] `investigate/analysis/performance-comparison.md` 생성됨
  - [ ] 5개 MCP 서버별 skill-wrapped 레이턴시 측정 데이터 포함
  - [ ] always-on vs skill-wrapped 비교 표 포함
  - [ ] 토큰 비용 비교 포함

  **QA Scenarios:**
  ```
  Scenario: 성능 비교 문서 검증
    Tool: Bash
    Steps:
      1. wc -l investigate/analysis/performance-comparison.md → 50줄 이상
      2. grep -c '|' investigate/analysis/performance-comparison.md → 10 이상 (비교 표)
      3. grep 'skill-wrapped\|Skill.Wrapped' investigate/analysis/performance-comparison.md → 존재
      4. grep 'always-on\|Always.On' investigate/analysis/performance-comparison.md → 존재
    Expected Result: 비교 표와 두 접근법 모두 언급
    Evidence: .sisyphus/evidence/task-13-perf-comparison.txt
  ```

  **Evidence to Capture:**
  - [ ] task-13-perf-comparison.txt

  **Commit**: YES
  - Message: `docs(analysis): add performance comparison between always-on MCP and skill-wrapped`
  - Files: `investigate/analysis/performance-comparison.md`

- [ ] 14. 하이브리드 전략 권고 문서

  **What to do**:
  - `investigate/analysis/hybrid-strategy.md` 작성
  - **핵심 내용**:
    1. **"어떤 MCP는 always-on, 어떤 것은 스킬" 기준 제시**:
       - 로컬 stdio, <5ms 레이턴시 → always-on 유지 (예: obsidian)
       - 리모트, >100ms 레이턴시 → 스킬 래퍼 (예: grep_app, websearch)
       - 자주 사용 (>50% 프롬프트) → always-on 고려
       - 드문 사용 (<10% 프롬프트) → 스킬 래퍼
    2. **Dehydrator vs Skill-Wrapped 사용 시나리오**:
       - Dehydrator: 도구가 50개 이상이고 Python 기반 클라이언트일 때
       - Skill-Wrapped: OpenCode 사용자, 토큰+레이턴시 모두 줄이고 싶을 때
       - 하이브리드: Dehydrator + Skill-Wrapped 조합 가능성
    3. **"\ub9e4\ubc88 \uc2a4\ud0ac\ub85c \ubcc0\ud658\ud574\uc57c \ud558\ub098?" 질\ubb38 \ub2f5\ubcc0**:
       - `mcp-to-skill` CLI로 자동화 → 1번 설정, opencode.json 변경 시 재실행
       - 신규 MCP 서버 추가 시: `bun run cli.ts generate --config ... --server new-server`
    4. **권고 구성** (사용자의 현재 5개 MCP 기준):
       - always-on 유지: obsidian (1ms, 로컬)
       - 스킬 전환: grep_app, websearch, context7, deepwiki (리모트, 140-264ms)
    5. **예상 효과**:
       - 토큰: ~3,000/prompt → ~100/prompt (obsidian만 always-on)
       - 레이턴시: ~250ms/prompt → ~1ms/prompt (idle 시)
       - cold start: 4,100ms → 0ms (MCP 스폰 없음)

  **Must NOT do**:
  - Dehydrator 설치/실행 (비교만)

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 권고 문서 작성
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (하지만 Task 1, 13 의존)
  - **Parallel Group**: Wave 4 (with Tasks 13, 15)
  - **Blocks**: F1
  - **Blocked By**: Tasks 1, 13

  **References**:
  - `investigate/analysis/dehydrator-comparison.md` (Task 1) — Dehydrator 비교 데이터
  - `investigate/analysis/performance-comparison.md` (Task 13) — 성능 측정 데이터
  - `/Users/sbbae/project/investigate/results/report.md` — 실측 MCP 측정 데이터

  **WHY Each Reference Matters**:
  - dehydrator-comparison.md: 하이브리드 전략에 Dehydrator 옵션 포함 여부 판단 근거
  - performance-comparison.md: 수치 기반 권고를 위한 성능 데이터
  - report.md: always-on MCP 기준점 데이터

  **Acceptance Criteria**:
  - [ ] `investigate/analysis/hybrid-strategy.md` 생성됨 (50줄 이상)
  - [ ] "always-on vs 스킬" 판단 기준 포함
  - [ ] "매번 변환해야 하나" 질문에 대한 답변 포함
  - [ ] 권고 구성 (5개 MCP 서버 각각에 대해) 포함

  **QA Scenarios:**
  ```
  Scenario: 하이브리드 전략 문서 검증
    Tool: Bash
    Steps:
      1. wc -l investigate/analysis/hybrid-strategy.md → 50줄 이상
      2. grep '매번\|자동' investigate/analysis/hybrid-strategy.md → 존재
      3. grep 'obsidian' investigate/analysis/hybrid-strategy.md → always-on 권고 언급
      4. grep 'grep_app\|websearch' investigate/analysis/hybrid-strategy.md → 스킬 전환 권고 언급
    Expected Result: 모든 필수 요소 존재
    Evidence: .sisyphus/evidence/task-14-hybrid-strategy.txt
  ```

  **Evidence to Capture:**
  - [ ] task-14-hybrid-strategy.txt

  **Commit**: YES
  - Message: `docs(analysis): add hybrid strategy recommendation`
  - Files: `investigate/analysis/hybrid-strategy.md`

- [ ] 15. 사용자 가이드 + README

  **What to do**:
  - `investigate/mcp-to-skill/README.md` 작성
  - **포함 내용**:
    1. 프로젝트 개요 (문제 + 해결책)
    2. 설치 방법 (`bun install`)
    3. 사용법:
       - 전체 변환: `bun run cli.ts generate --config ~/.config/opencode/opencode.json`
       - 부분 변환: `--server deepwiki`
       - 직접 설치: `--output ~/.config/opencode/skills/`
    4. 생성된 스킬 사용법
    5. MCP 클라이언트 직접 사용법
    6. 트러블슈팅

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 문서 작성
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13, 14)
  - **Blocks**: F1
  - **Blocked By**: Task 4

  **References**:
  - `investigate/mcp-to-skill/cli.ts` (Task 4) — CLI 사용법 문서화 대상
  - `investigate/README.md` — 기존 investigate 프로젝트 README 패턴

  **Acceptance Criteria**:
  - [ ] `investigate/mcp-to-skill/README.md` 생성됨
  - [ ] 설치, 사용법, 트러블슈팅 섹션 포함
  - [ ] CLI 사용 예제 포함

  **QA Scenarios:**
  ```
  Scenario: README 문서 검증
    Tool: Bash
    Steps:
      1. wc -l investigate/mcp-to-skill/README.md → 30줄 이상
      2. grep 'install\|Install' investigate/mcp-to-skill/README.md → 존재
      3. grep 'bun run cli.ts' investigate/mcp-to-skill/README.md → CLI 예제 존재
    Expected Result: 필수 섹션 모두 존재
    Evidence: .sisyphus/evidence/task-15-readme.txt
  ```

  **Evidence to Capture:**
  - [ ] task-15-readme.txt

  **Commit**: YES
  - Message: `docs(mcp-to-skill): add README and user guide`
  - Files: `investigate/mcp-to-skill/README.md`
## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test` in mcp-to-skill project. Review all .ts files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify no API keys hardcoded. Verify scripts under 300 lines.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Install one generated skill to `~/.config/opencode/skills/`. Start OpenCode serve mode. Call `skill("name")` via API. Verify skill loads. Execute the MCP tool via bash script. Verify MCP tool response. Capture evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", verify actual output matches spec. Check "Must NOT do" compliance: no OpenCode source mods, no hardcoded keys, no scripts over 300 lines. Flag unaccounted files.
  Output: `Tasks [N/N compliant] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `docs(analysis): add Dehydrator vs Skill-Wrapped MCP comparison` — analysis/dehydrator-comparison.md
- **Wave 1-2**: `feat(mcp-to-skill): add MCP client CLI and conversion tool` — mcp-to-skill/
- **Wave 3**: `feat(mcp-to-skill): generate skill wrappers for 5 MCP servers` — generated-skills/
- **Wave 4**: `docs(analysis): add performance comparison and hybrid strategy` — analysis/

---

## Success Criteria

### Verification Commands
```bash
# mcp-to-skill CLI works
cd investigate/mcp-to-skill && bun run cli.ts --help  # Expected: usage info

# Generated skill has SKILL.md
ls investigate/mcp-to-skill/generated-skills/deepwiki/SKILL.md  # Expected: exists

# MCP client script runs
bun run investigate/mcp-to-skill/src/mcp-client.ts --server deepwiki --tool ask_question --args '{"repoName":"facebook/react","question":"What is React?"}' # Expected: JSON response

# Analysis docs exist
wc -l investigate/analysis/dehydrator-comparison.md  # Expected: 100+ lines
wc -l investigate/analysis/hybrid-strategy.md  # Expected: 50+ lines

# bun test passes
cd investigate/mcp-to-skill && bun test  # Expected: all pass
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] 5 MCP 서버 스킬 래퍼 생성 완료
- [ ] Dehydrator 비교 분석 완료
- [ ] 하이브리드 전략 문서 완료
- [ ] 성능 비교 데이터 수집 완료
