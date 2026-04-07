# Session Dashboard — Frontend PRD

**Date:** 2026-04-07 (코드 역분석 기반 작성)
**Branch:** main
**Tech Stack:** Svelte 5 SPA + Vite 5 + TypeScript

---

## Prompt 0: Planning Phase

**Project Overview**:
다수의 머신에서 실행 중인 Claude Code / OpenCode 세션을 실시간 모니터링하고,
프롬프트 이력 조회, 토큰 비용 분석, 코드 임팩트 추적, 타임라인 시각화, 세션 복구를
단일 웹 대시보드에서 제공하는 개발자 도구.

**핵심 기능**:
1. 실시간 세션 상태 모니터링 (Working / Waiting / Idle)
2. 프롬프트 이력 조회 및 응답 확장
3. 멀티머신 통합 뷰 (단일/merged 자동 분기)
4. Enrichment 분석 (토큰, 코드 임팩트, 타임라인, 프로젝트, 복구, 요약)
5. 메모 CRUD (프로젝트 스코프)
6. Vim 스타일 키보드 네비게이션
7. 실시간 업데이트 (Agent hook SSE push + Server SSE + 폴링 삼중 전략)

**기술 스택**:
- Svelte 5 (runes) + Vite 5 (빌드/프록시)
- TypeScript (strict)
- CSS Variables (다크 테마 단일)
- Native EventSource (SSE)
- Custom SPA Router (URL query params)

**아키텍처**:
```
Browser
├── App.svelte (SSE 연결, 글로벌 단축키, 라우팅)
├── Stores (sessions, queries, filter, machine, dismissed, navigation, enrichment, memos)
├── Components
│   ├── Dashboard (Monitor): ActiveSessions + RecentPrompts + PromptDetailModal
│   ├── Sessions: SessionCards (카드 그리드 뷰) → session-prompts (RecentPrompts full-width)
│   ├── Navigation: TopNav + CommandPalette + ShortcutCheatsheet + MachineSelector
│   └── Pages: TokenCost, CodeImpact, Timeline, Projects, ContextRecovery, Summaries, Memos
└── Lib: api.ts, sse-client.ts, markdown.ts, utils.ts, timeline-utils.ts
```

**Key Decisions** (ADR 인덱스):
- ADR-001: Custom SPA Router (SvelteKit 대신) → 경량, SSR 불필요
- ADR-002: Dark-only 테마 → 개발 도구 특성, 유지보수 최소화
- ADR-003: SSE + hook push + 폴링 삼중 전략 → 실시간성 + 안정성
- ADR-007: Agent hook-event SSE push (B') → 상태 전환 즉시 반영
- ADR-004: Zero-dep Markdown 렌더러 → 번들 최소화, code block folding 커스텀
- ADR-005: Svelte 5 runes + Svelte 4 store 혼용 → .ts 파일 runes 미지원 제약
- ADR-006: Session dismiss auto-revive → 재활성 세션 자동 복귀 UX

---

## Feature 1: Dashboard — 세션 모니터링 [IMPLEMENTED]

**[OBJECTIVE]**: 활성 세션 목록과 프롬프트 이력을 2-column 레이아웃으로 실시간 표시

**[REQUIREMENTS]**:

### F1.1 세션 목록 (ActiveSessions.svelte)

- 세션 카드에 표시할 정보:
  - **Status badge**: Working (파란), Waiting (보라), Idle (초록), Rename (주황, 3초 TTL)
  - **Title**: 세션 제목 또는 lastPrompt 첫 60자 또는 sessionId 첫 8자 (fallback 순서)
  - **Subagent badge**: childSessionIds.length > 0 일 때 숫자 표시
  - **시간**: lastActivityTime 상대 시간 (방금 전, N분 전, N시간 전, N일 전)
  - **머신**: machineAlias (멀티머신 모드에서만)
  - **소스**: OpenCode (초록) / Claude (보라)
  - **프로세스 메트릭**: CPU%, RSS (processMetrics 존재 시)
  - **현재 도구**: currentTool (Working 상태에서)
  - **프로젝트 경로**: projectCwd 마지막 2 세그먼트
  - **마지막 프롬프트**: lastPrompt 미리보기
  - **No hooks 표시**: Claude 세션에서 hooksActive=false일 때 경고 아이콘

- **Status 판별 로직** (프론트엔드):
  ```
  RENAME:  recentlyRenamed = true (최우선, 3초 후 자동 해제)
  WORKING: (apiStatus ∈ {busy, retry} ∨ currentTool ≠ null) ∧ ¬waitingForInput
  WAITING: waitingForInput = true
  IDLE:    그 외
  ```

- **정렬 우선순위**: 세션 목록은 `lastActivityTime` 내림차순 정렬. 시간차 60초 이내 세션 간에는 상태 우선순위 적용 (WORKING > WAITING > IDLE).

- **상태 변경 flash 효과**: 세션 상태가 전환될 때 (예: Idle→Working) 뱃지가 1.2초간 brightness+scale 펄스로 반짝임. 이전 상태를 Map으로 추적하여 변경 감지. `prefers-reduced-motion` 존중.

- **필터링 파이프라인** (순서 고정):
  1. dismissed 세션 제외
  2. 선택된 머신 필터
  3. 소스 필터 (all / opencode / claude-code)
  4. 시간 범위 필터 (active 세션은 시간 필터 우회)
  5. 부모 세션만 (parentSessionId가 있는 세션 제외)
  6. 프로젝트 필터

- **세션 클릭 동작**:
  1. 선택 토글 (이미 선택된 세션 재클릭 → 해제)
  2. resume 명령 클립보드 복사:
     - Claude: `cd {cwd} && claude --resume {sessionId}`
     - OpenCode: `opencode attach http://{host}:4096 --session {sessionId}`
  3. 세션 디테일 뷰로 전환 (pushSessionDetail)
  4. 하단 toast 알림 ("Copied!" 2초 표시)

- **프로젝트 필터 드롭다운**: 유니크 프로젝트 > 1일 때 표시, 경로 마지막 2 세그먼트

- **Dismiss/Restore**:
  - 디테일 뷰에서 X 버튼으로 dismiss
  - 하단 "N개 숨김 — 복원" 버튼으로 일괄 복원
  - Auto-revive: lastActivityTime 변경 감지 시 자동 복원 (ADR-006)

### F1.2 프롬프트 목록 (RecentPrompts.svelte)

- **표시 정보**:
  - 세션 제목 + 상대 시간
  - 프롬프트 텍스트 (잘림 없음)
  - 결과 뱃지: completed (✓ 초록), user_exit (↩ 노란), error (⚠), idle (○), active (↻ 회전)
  - 소스 뱃지: Claude (보라) / OpenCode (초록)
  - 머신 뱃지 (멀티머신 모드)

- **확장/축소**:
  - 개별 클릭으로 확장 → `/api/prompt-response` fetch → Markdown 렌더링
  - 전체 확장/축소 버튼 (동시 요청 3개 제한)
  - 코드 블록 8줄 초과 시 자동 접힘 (`<details>`)

- **정렬**: busy 세션의 최신 프롬프트 최상단 고정, 나머지 timestamp 역순

- **Background 쿼리**:
  - 기본 숨김, 토글 버튼으로 표시
  - 판별: isBackground 플래그 / parentSessionId 존재 / title 패턴 (Background:, Task:, @)
  - 표시 시 부모 세션으로 재귀속

- **필터링 파이프라인**: background → 머신 → 소스 → 세션 선택

### F1.3 프롬프트 상세 모달 (PromptDetailModal.svelte)

- 풀스크린 모달, 2탭 (Prompt / Response)
- Prompt 탭: 원본 `<pre>` 표시
- Response 탭: lazy fetch + Markdown 렌더링
- 헤더: 세션 제목 + 타임스탬프
- 푸터: resume 명령 복사 버튼
- Escape / backdrop 클릭으로 닫기

### F1.4 세션 카드 그리드 (SessionCards.svelte)

- **레이아웃**: `auto-fill, minmax(280px, 1fr)` 그리드 — 화면 폭에 따라 2~4열 자동 배치
- **카드 정보**: Status badge, 소스, subagent 수, 타이틀, 현재 도구, 시간/머신/프로세스 메트릭, 프로젝트 경로, 마지막 프롬프트 (2줄 clamp)
- **카드 클릭**: `session-prompts` 뷰로 전환 (full-width RecentPrompts + back 버튼, Escape로 복귀)
- **필터링 파이프라인**: dismissed → machine → source → time (active 우회) → parent → project (F1.1과 동일)
- **상태 flash**: F1.1과 동일한 prevStatusMap + 1.2초 animation 패턴
- **Dismiss/Restore**: F1.1과 동일
- **키보드**: F7.4 참조

---

## Feature 2: Navigation & Routing [IMPLEMENTED]

**[OBJECTIVE]**: SPA 내 11개 뷰를 URL-based로 라우팅하며 브라우저 히스토리 지원

**[REQUIREMENTS]**:

### F2.1 뷰 라우팅 (navigation.svelte.ts)

- **뷰 목록**:
  | View | URL | 컴포넌트 |
  |------|-----|---------|
  | sessions | `?view=sessions` | SessionCards 카드 그리드 |
  | session-prompts | `?view=session-prompts&session={id}` | 세션별 프롬프트 리스트 (full-width) |
  | overview | `?` (파라미터 없음) | Monitor 2-column |
  | session-detail | `?session={id}` | Monitor + 세션 필터 |
  | token-cost | `?view=token-cost` | TokenCostPage |
  | code-impact | `?view=code-impact` | CodeImpactPage |
  | timeline | `?view=timeline` | TimelinePage |
  | projects | `?view=projects` | ProjectsPage |
  | context-recovery | `?view=context-recovery` | ContextRecoveryPage |
  | summaries | `?view=summaries` | SummariesPage |
  | memos | `?view=memos` | MemosPage |

- URL search params 기반 (hash 아님)
- 브라우저 뒤로가기 (`popstate`) 지원
- `.main-content` 스크롤 위치 저장/복원 (세션 디테일 진입/이탈 시)
- ENRICHMENT_VIEWS: token-cost, code-impact, timeline, projects, context-recovery, summaries

### F2.2 탑 네비게이션 (TopNav.svelte)

- 탭: Sessions, Monitor, Summaries, Tokens, Impact, Timeline, Projects, Recovery, Memos
- 활성 탭 하단 보더 표시
- `aria-current="page"` 접근성
- Sessions 탭: sessions + session-prompts 양쪽에서 active
- Monitor 탭: overview + session-detail 양쪽에서 active

---

## Feature 3: Filtering & Search [IMPLEMENTED]

**[OBJECTIVE]**: 세션/프롬프트를 다차원으로 필터링하고 빠르게 검색

**[REQUIREMENTS]**:

### F3.1 필터 (filter.svelte.ts)

- **소스 필터**: All / OpenCode / Claude Code (localStorage 영속)
- **시간 범위**: 1h / 6h / 1d / 7d / All (localStorage 영속)
- **머신 필터**: 전체 / 개별 머신 (MachineSelector)
- **프로젝트 필터**: 드롭다운 (ActiveSessions 내장)
- **세션 선택**: 특정 세션 선택 시 프롬프트 필터링

### F3.2 Command Palette (CommandPalette.svelte)

- **호출**: Cmd/Ctrl + K
- **검색 대상**: 세션 (제목/ID/머신) + 프롬프트 (텍스트/세션 제목/ID)
- **매칭**: case-insensitive 다중 텀 substring 매칭
- **결과 제한**: 세션 5개, 프롬프트 10개
- **하이라이트**: `<mark>` 태그로 매칭 텀 강조
- **키보드**: 화살표 이동, Enter 선택, Escape 닫기
- **Background 세션 제외**: parentSessionId / "Background:"/"Task:"/"@" 타이틀 패턴

### F3.3 Session Dismiss (dismissed.svelte.ts)

- localStorage 영속 (`session-dashboard:dismissed`)
- Map<sessionId, lastActivityTime> 구조
- **Auto-revive**: SSE/폴링으로 세션 목록 갱신 시 lastActivityTime 변경 감지 → 자동 복원
- 일괄 복원 버튼

---

## Feature 4: Enrichment 페이지 [IMPLEMENTED]

**[OBJECTIVE]**: 세션 데이터에 대한 분석/시각화 뷰 제공

**[REQUIREMENTS]**:

### F4.1 Token & Cost (TokenCostPage.svelte)

- **Summary 카드 6개**: Input Tokens, Output Tokens, Reasoning, Total Cost, Cache Read, Cache Write
- **프로젝트별 테이블**: 프로젝트, 세션 수, input/output/cache, 비용 (비용 내림차순)
- **세션별 테이블**: 세션 제목, 모델, 에이전트, input/output, 비용 (비용 내림차순)
- **토큰 포맷**: K/M 접미사

### F4.2 Code Impact (CodeImpactPage.svelte)

- **프로젝트 필터** 드롭다운
- **세션별 카드**: 제목, 시간, 프로젝트, additions(+초록)/deletions(-빨강), 파일 수
- **비례 바 차트**: 최대 변경량 대비 비율

### F4.3 Timeline (TimelinePage.svelte)

- **시간 범위 프리셋**: 1h, 6h, 24h, 7d
- **프로젝트 필터**
- **SVG 렌더링**: 900px 폭, 40px 레인 높이
  - 세로 점선 시간축
  - 교대 행 배경
  - 세션 블록 (accent=busy, green=completed, gray=idle)
  - Activity segments (세부 작업 구간)
  - 빨간 "Now" 라인
- **호버 툴팁**: 시간 범위 + 지속 시간
- **고정 레인 라벨** (180px) + 수평 스크롤 SVG 영역

### F4.4 Projects (ProjectsPage.svelte)

- **정렬**: 최근 활동 / 세션 수 / 토큰 수
- **접이식 프로젝트 카드**: 경로, 세션 수, 토큰 수, 비용, 마지막 활동
- **중첩 세션 목록**: 클릭 시 세션 디테일로 이동

### F4.5 Context Recovery (ContextRecoveryPage.svelte)

- **대상**: idle 세션만
- **카드 정보**: 제목, 디렉토리, 마지막 활동
  - 최근 프롬프트 (최대 5개)
  - 마지막 도구 체인 (tool1 → tool2 → tool3)
  - 코드 임팩트 요약 (additions, deletions, files)
  - Todo 목록 (완료/미완료 시각적 구분)
- **Resume 버튼**: 클립보드 복사
- **Summary 버튼**: POST `/api/enrichment/{machineId}/recovery/{sessionId}/summarize`
- **View 버튼**: 세션 디테일 이동

### F4.6 Summaries (SummariesPage.svelte)

- **프로젝트별 그룹**: projectCwd 기준, 최근 활동 순
- **최근 프로젝트 자동 확장**
- **세션 카드**: 제목, status badge, 시간, 소스, subagent 수
- **요약 생성**: POST `/api/session-summary/{sessionId}`
- **요약 표시**: 생성 시각 + 새로고침 버튼
- **그리드 레이아웃**: auto-fill, minmax 320px

### F4.7 Enrichment 데이터 라우팅 (enrichment.ts)

- **단일 머신 모드**: `/api/enrichment/{machineId}/{feature}`
- **전체 머신 모드**: `/api/enrichment/merged/{feature}`
- **SSE 연동**: `enrichment.updated` → 단일 머신 re-fetch, `enrichment.merged.updated` → merged re-fetch
- **머신 변경 observer**: `onMachineChange(cb)` 패턴으로 re-fetch 트리거

---

## Feature 5: Memos [IMPLEMENTED]

**[OBJECTIVE]**: 프로젝트 스코프의 메모를 CRUD 관리

**[REQUIREMENTS]**:

### F5.1 MemosPage.svelte

- **3-column 레이아웃**: 프로젝트 사이드바 / 메모 목록 / 에디터
- **프로젝트 드롭다운**: 메모 프로젝트 + enrichment 프로젝트 병합, 메모 수 기준 정렬
- **피드 뷰** (프로젝트 미선택): 전체 프로젝트 최근 메모, 프로젝트/머신/시간 메타데이터
- **메모 목록**: 날짜별 그룹 (한국어 포맷: "YYYY년 M월 D일")
- **에디터**: 제목 입력 + 내용 textarea
- **CRUD**: 생성, 읽기, 수정, 삭제
- **삭제 확인**: 2단계 (첫 클릭 "삭제" → 재클릭 "삭제 확인")
- **단축키**: Cmd+N (새 메모), Cmd+S (저장)

### F5.2 API 엔드포인트

| Method | Endpoint | 용도 |
|--------|----------|------|
| GET | `/api/memos` | 목록 |
| GET | `/api/memos/:id` | 단건 조회 |
| POST | `/api/memos` | 생성 |
| PUT | `/api/memos/:id` | 수정 |
| DELETE | `/api/memos/:id` | 삭제 |
| GET | `/api/memos/feed` | 크로스 프로젝트 피드 |
| GET | `/api/memos/projects` | 프로젝트 목록 |

---

## Feature 6: Real-time Updates [IMPLEMENTED]

**[OBJECTIVE]**: 3-tier 실시간 업데이트 (Agent hook push → Server SSE → Frontend)

**[REQUIREMENTS]**:

### F6.1 Agent Hook-Event SSE Push (B')

- **엔드포인트**: Agent `GET /api/claude/events` (text/event-stream)
- **트리거**: Claude Code hook 이벤트 발생 시 (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, SessionStart)
- **데이터**: 세션 full snapshot (ClaudeSessionInfo) — Server가 hook 해석 불필요
- **이벤트**: `hook.sessionUpdate` + 30초 heartbeat
- **Server 구독**: MachineManager가 claude 소스 머신에 자동 SSE 연결, exponential backoff 재연결 (2초~30초)
- **캐시 병합**: hookCachedDetails → pollAll 결과에 병합 (updatedAt 기준 최신 우선)
- **poll 트리거**: hook 이벤트 수신 → 100ms debounce → 즉시 poll → SSE 브로드캐스트

### F6.2 Server→Frontend SSE (sse-client.ts)

- **연결**: `/api/events` (Native EventSource, 자동 재연결)
- **Heartbeat**: 40초 타임아웃 (서버 heartbeat 주기 초과)
- **연결 상태**: green/red dot 시각 표시
- **Builder 패턴**: `createSSEClient({ url }).on(event, handler).onConnectionChange(cb).start()`

### F6.3 이벤트 종류

| Event | Payload | 핸들러 |
|-------|---------|--------|
| `session.update` | `DashboardSession[]` | 세션 목록 교체 + dismissed 자동 복원 |
| `query.new` | `QueryEntry` | 쿼리 추가 (중복 제거, 최대 200개) |
| `machine.status` | `MachineInfo[]` | 머신 목록 교체 |
| `enrichment.updated` | `{ machineId, feature, cachedAt }` | 단일 머신 enrichment re-fetch |
| `enrichment.merged.updated` | `{ feature, machineCount, cachedAt }` | merged enrichment re-fetch (머신 미선택 시만) |
| `enrichment.cache` | `{ machineId, feature, cachedAt }` | No-op (hydration 이벤트) |

### F6.4 폴링 Fallback

- **Server→Agent**: 1초 간격 (hook SSE push의 fallback)
- **Frontend**: 30초 간격 세션/쿼리/머신 재조회
- `visibilitychange`: 탭 복귀 시 즉시 refresh

### F6.5 데이터 흐름

```
Hook → Agent(즉시) ── SSE push(즉시) ──→ Server(100ms debounce) ── SSE ──→ Frontend
                    └── 1초 폴링 (fallback) ──┘
```

---

## Feature 7: Keyboard UX [IMPLEMENTED]

**[OBJECTIVE]**: Vim 스타일 키보드 네비게이션으로 마우스 없이 전체 조작

**[REQUIREMENTS]**:

### F7.1 글로벌 단축키

| 키 | 동작 |
|----|------|
| `Cmd/Ctrl+K` | Command Palette 토글 |
| `?` | 단축키 치트시트 |
| `h` | 세션 패인 포커스 (Monitor 뷰에서만) |
| `l` | 프롬프트 패인 포커스 (Monitor 뷰에서만) |
| `Escape` | 디테일/프롬프트 뷰 → 상위 복귀 |

### F7.2 세션 패인

| 키 | 동작 |
|----|------|
| `j` / `↓` | 다음 세션 |
| `k` / `↑` | 이전 세션 |
| `e` / `Enter` | 세션 선택/디테일 토글 |

### F7.3 프롬프트 패인

| 키 | 동작 |
|----|------|
| `j` / `↓` | 다음 프롬프트 |
| `k` / `↑` | 이전 프롬프트 |
| `Enter` / `e` / `Space` | 확장/축소 |
| `a` | 전체 확장/축소 토글 |
| `c` | 포커스된 프롬프트 resume 명령 복사 |
| `gg` | 맨 위로 (300ms 내 더블탭) |
| `G` (Shift+G) | 맨 아래로 |
| `Escape` | 전체 축소 + 포커스 해제 |
| `Ctrl+Shift+A` | 전체 확장/축소 (modifier 버전) |

### F7.4 세션 카드 그리드 (Sessions 뷰)

| 키 | 동작 |
|----|------|
| `j` / `↓` | 아래 행 이동 (열 수 런타임 감지) |
| `k` / `↑` | 위 행 이동 |
| `h` / `←` | 왼쪽 카드 |
| `l` / `→` | 오른쪽 카드 |
| `e` / `Enter` | 선택 카드 → 프롬프트 리스트 진입 |
| `c` | resume 명령어 클립보드 복사 |
| `Escape` | session-prompts → sessions 복귀 |

### F7.5 치트시트 (ShortcutCheatsheet.svelte)

- 4개 섹션: Global, Session, Prompt, Command Palette
- 플랫폼 감지: Mac → Cmd 심볼 / 기타 → Ctrl 텍스트

---

## Feature 8: Multi-machine & Responsive [IMPLEMENTED]

**[OBJECTIVE]**: 복수 머신 통합 모니터링 + 모바일/태블릿 지원

**[REQUIREMENTS]**:

### F8.1 Multi-machine (machine.svelte.ts, MachineSelector.svelte)

- **MachineSelector**: 머신 > 1일 때만 표시, "전체" + 개별 머신 버튼
- **연결 상태**: 초록 dot (connected)
- **Observer 패턴**: `onMachineChange(cb)` → 머신 변경 시 enrichment re-fetch
- **Enrichment 라우팅**: 머신 선택 → 단일 엔드포인트, 전체 → merged 엔드포인트

### F8.2 Responsive Design

| 브레이크포인트 | 레이아웃 |
|-------------|---------|
| < 600px (모바일) | 단일 컬럼, 사이드바 40vh 제한, 가로 스크롤 헤더 |
| 600-767px (태블릿) | 220px + 1fr 그리드 |
| ≥ 768px (데스크톱) | 260-300px + 1fr 그리드 |

- **터치**: `@media (pointer: coarse)` → 버튼 최소 44px
- **모션 감소**: `prefers-reduced-motion: reduce` → 모든 애니메이션 비활성화

### F8.3 클립보드

- 1순위: Clipboard API (`navigator.clipboard.writeText`)
- 2순위: `document.execCommand('copy')` fallback (LAN IP 비보안 컨텍스트 대응)

### F8.4 한국어 로컬라이제이션

- UI 텍스트 대부분 한국어 (버튼, 빈 상태, 타임스탬프)
- 일부 제목/기술 용어는 영어
- 시간 포맷: "방금 전", "N분 전", "N시간 전", "N일 전"
- 날짜 포맷: "YYYY년 M월 D일" (메모 그룹핑)

---

## Type Contract

**정의**: `server/src/shared/api-contract.ts` (단일 진실 원천)
**프론트엔드 참조**: `server/frontend/src/types.ts`에서 re-export

### 핵심 타입

- `DashboardSession`: 20+ 필드 (sessionId, title, status, apiStatus, currentTool, waitingForInput, source, hooksActive, processMetrics, recentlyRenamed, machineId/Host/Alias 등)
- `DisplayStatusLabel`: `'Working' | 'Retry' | 'Waiting' | 'Idle' | 'Rename'`
- `QueryEntry`: sessionId, sessionTitle, timestamp, query, isBackground, source, completedAt, machineId/Host/Alias
- `MachineInfo`: id, alias, host, status, lastSeen, error, source
- `SSEEventMap`: 6개 이벤트 타입 매핑

### 프론트엔드 전용 타입

- `Memo`, `MemoWithContent`, `MemoWithSnippet`, `MemoProject`
- Enrichment 타입: `SessionTokenStats`, `TokensData`, `SessionCodeImpact`, `TimelineEntry`, `ProjectSummary`, `RecoveryContext`, `ActivitySegment`
