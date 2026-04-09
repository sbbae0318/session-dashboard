# Project Status — session-dashboard

> GSD STATE format. Single source of truth for current position.

**Last Updated**: 2026-04-10
**Branch**: main

---

## Current Position

_프로젝트가 지금 어디에 있고, 무엇을 하고 있는지._

- **Agent**: Claude Code + OpenCode 이중 소스 모니터링 (port 3098). 최근 OpenCode DB 직접 모니터링(oc-serve 없이) 추가됨 (f7f764d).
- **Server**: Dashboard 서버 (port 3097, Docker on 192.168.0.2). 1초 폴링 + hook SSE push (B') + SSE 브로드캐스트.
- **Frontend**: Svelte 5 SPA. Sessions 카드 그리드 뷰 + Monitor(split-pane) + 프롬프트 뷰어 + 단축키.
- **거버넌스**: `.omc/` 초기화 완료 (GOVERNANCE.md, status/prd/known-failures, workflows 2개).

## Locked Decisions

_번복하지 않는 결정. ADR로 문서화됨._

- API Contract는 `server/src/shared/api-contract.ts` 단일 진실 원천 — 타입 변경 시 양쪽 빌드 파손으로 호환성 자동 감지
- Agent 재배포 시 **`pkill` / `kill -9` 금지** — LISTEN 소켓만 종료 (Claude Code 프로세스 보호)
- Claude Hook URL 포트 = **3098** (3101 사용 금지)
- Workstation Node = nvm v22 (system v18은 동작 안 함)
- hooks active 세션의 status 권한 = **hooks** (JSONL 파싱은 fallback) — F-003에서 확립
- (참조: `spec/decisions/ADR-001~007`)

## Learned

_이번 세션/최근에 배운 것._

- **Claude rename bug (F-001)**: `projectsWatcher` → `scanProjectsForActiveSessions` 경로에서 tracked 세션을 skip하면서 `custom-title` 업데이트가 다음 hook까지 미반영되는 구조적 문제. → `refreshSessionFromFile` 타깃 refresh로 해결 (commit 0a2b3a3).
- **fs.watch recursive의 `filename` 파라미터** 활용: full scan(O(N)) 대신 변경된 파일만 처리(O(1)) 가능. 기존 코드에서 `_filename`으로 무시되고 있었음.
- **OpenCode SSE에 rename 이벤트 없음** — `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `permission.updated`, `session.deleted` 6종만 emit. rename 감지는 polling 또는 DB 직접 읽기 필수.
- **`fullSync()`의 titleMissing 가드** (line 1026-1030): 기존 title 있으면 업데이트 안 함 — OpenCode rename 시에도 유사한 게이트 존재 (별도 이슈로 미처리).
- **hooks vs JSONL 권한 분리 원칙 (F-002, F-003)**: hooks active → hooks가 status/currentTool/waitingForInput 소유. JSONL 파싱은 hooks 미연결 시 fallback. `readHeartbeatFile`, `refreshSessionFromFile` 양쪽에 적용 필수. `refreshSessionFromFile` 확장 시 status 갱신 추가하면 hooks와 race condition 발생 — title/timestamps만 갱신하고 status는 hooks에 위임.
- **상태 뱃지 flash 구현 패턴**: prevStatusMap(Map<sessionId, cssClass>)으로 이전 상태 추적 → `$effect`에서 topLevelSessions 변경 시 비교 → 변경된 세션에 `status-flash` 클래스 부여 + setTimeout 1.2초 후 해제. CSS animation(brightness+scale 펄스)으로 구현, `prefers-reduced-motion` 존중.
- **recentlyRenamed 플래그 패턴**: agent의 `refreshSessionFromFile()`에서 title 변경 감지 → `recentlyRenamed: true` 설정 + `setTimeout` 3초 후 `false`로 해제. 프론트엔드 `getDisplayStatus()`에서 최우선 체크하여 "Rename" 배지(주황) 표시. `renameTimers` Map으로 세션별 타이머 관리, `stop()` 시 정리.
- **Hook SSE push (B')**: agent가 `/api/claude/events` SSE 엔드포인트를 제공, hook 이벤트 발생 시 세션 full snapshot을 구독자에게 즉시 브로드캐스트. server가 머신별 SSE 구독 + `cachedDetails` 실시간 병합 + 100ms debounce poll 트리거.
- **정렬 우선순위 로직**: 시간 무관 상태 우선순위 항상 적용 (WAITING=0 > WORKING=1 > RENAME=2 > IDLE=3). 같은 우선순위 내에서만 `lastActivityTime` 순. 활성 세션이 항상 IDLE 위에 표시되도록 보장.
- **Svelte 5 `document.addEventListener` vs `svelte:window`**: `document.addEventListener`로 등록한 핸들러에서 `$state`/`$derived` 변수 접근 시 reactive 업데이트가 동작하지 않을 수 있음. `svelte:window onkeydown`으로 전환하면 Svelte reactive context 내에서 실행되어 정상 동작. (`de44c26`에서 발견)
- **프롬프트 스피너 busy 조건 불일치 (F-004)**: `getDisplayStatus`는 `currentTool` 존재만으로 Working 판정하지만, `getQueryResult`/`busySessions`/`isSessionBusy`는 `apiStatus==='busy'`만 체크했음. Hook이 `currentTool`을 먼저 세팅하는 타이밍에 스피너 미표시. 세 곳 모두 `(apiStatus∈{busy,retry} ∨ currentTool) ∧ ¬waitingForInput`으로 정렬하여 해결. **교훈: "is working?" 판정은 반드시 getDisplayStatus와 동일 조건 사용.**
- **SummaryEngine incremental 패턴**: configurable threshold(default 5) 도달 시 Python DSPy CLI spawn으로 요약 생성. InitialSummary(첫 요약) + IncrementalUpdate(delta만 처리, O(delta)) 2개 Signature 분리. 기존 bullets는 DB 누적, LLM에 재전송 안 함. Python 실패 시 Haiku CLI fallback. sidecar(port 3099) → spawn 방식으로 최종 단순화 (ADR-008 v2).
- **Agent TTL ↔ Frontend 필터 정합 원칙**: Agent eviction/scan TTL은 프론트엔드 최대 필터 범위 이상이어야 함. `STALE_TTL_MS=4h`로 7d 필터 세션이 소실되는 regression 발생 (F-006). Agent `.env` PORT도 `machines.yml`과 반드시 동기화 — 불일치 시 production 서버에서 agent 연결 불가.
- **Svelte 5 CSS 애니메이션 2중 함정 (F-007)**: (1) scoped `@keyframes` 해시가 실제 브라우저에서 미적용 (2) `@media(prefers-reduced-motion:reduce)` 규칙이 실제 브라우저에서 매칭 → `animation:none` 덮어씀. Playwright headless는 기본 `no-preference`라 `getComputedStyle`이 "running" 보고 → 진단 혼란 유발. **결론: headless 브라우저의 CSS 애니메이션 검증은 신뢰 불가. 실제 브라우저 DevTools console에서 `getComputedStyle(el).animationName` 확인 필수.** Docker 배포 시 `docker compose down + up --build --force-recreate` 필수 (`--no-cache`만으론 stale 이미지 서빙됨).
- **프롬프트 캐시 아키텍처 재설계**: collectFromSession 세션당 1개→전체 반환. 서버 cachedQueries[] 전체 교체→queryMap(Map<sessionId, QueryEntry[]>) 누적. sessionId 조회 시 항상 agent fetch+merge (전역 폴링이 세션당 1개만 유입하는 구조적 한계). query.new는 세션별 lastTimestamp 비교로 효율화.
- **Docker OOM 원인**: `NODE_OPTIONS=--max-old-space-size=384` 하드캡이 1200+ 세션 + queryMap 누적 + enrichment 캐시 합계를 감당 못 함. 2048MB로 상향 해소.
- **머신 disconnected 세션 표시**: `DashboardSession.machineConnected: boolean` 필드 추가. 서버 poll()에서 머신 연결 상태 태깅, getDisplayStatus()에서 RENAME 다음 우선순위로 판정. 정렬: DISCONNECTED=4 (IDLE=3 뒤). 회색 뱃지.

## Next

_다음 세션에 할 것 (최대 3개)._

1. **DSPy BootstrapFewShot 최적화** — labeled examples 10개 수집 + optimizer 실행.
2. **프롬프트 검색 통합** — PromptStore FTS5 검색 + Claude 프롬프트 포함.
3. **Pre-existing 19개 테스트 실패 조사** — claude-heartbeat.test.ts eviction/PID/parse 계열.
3. **Pre-existing 19개 테스트 실패** 조사 — `claude-heartbeat.test.ts`의 eviction/PID liveness/parseConversationFile 계열.

---

## References

- PRD: `spec/prd.md`
- Decisions: `spec/decisions/`
- Known Failures: `knowledge/known-failures.md`
- Workflows: `workflows/deploy-dashboard.md`, `workflows/auto-live-test.md`, `workflows/status-transition-regression.md`
- Plans: `plans/hook-event-sse-push.md` (B' 설계 — 구현 완료), `plans/dspy-summary-sidecar.md` (DSPy 요약 — Phase 1+2 완료)
