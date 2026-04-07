# Project Status — session-dashboard

> GSD STATE format. Single source of truth for current position.

**Last Updated**: 2026-04-07
**Branch**: main

---

## Current Position

_프로젝트가 지금 어디에 있고, 무엇을 하고 있는지._

- **Agent**: Claude Code + OpenCode 이중 소스 모니터링 (port 3098). 최근 OpenCode DB 직접 모니터링(oc-serve 없이) 추가됨 (f7f764d).
- **Server**: Dashboard 서버 (port 3097, Docker on 192.168.0.2). 2초 폴링 + SSE 브로드캐스트.
- **Frontend**: Svelte 5 SPA. 세션 목록/필터/프롬프트 뷰어 + 단축키 cheatsheet.
- **거버넌스**: `.omc/` 초기화 완료 (GOVERNANCE.md, status/prd/known-failures, workflows 2개).

## Locked Decisions

_번복하지 않는 결정. ADR로 문서화됨._

- API Contract는 `server/src/shared/api-contract.ts` 단일 진실 원천 — 타입 변경 시 양쪽 빌드 파손으로 호환성 자동 감지
- Agent 재배포 시 **`pkill` / `kill -9` 금지** — LISTEN 소켓만 종료 (Claude Code 프로세스 보호)
- Claude Hook URL 포트 = **3098** (3101 사용 금지)
- Workstation Node = nvm v22 (system v18은 동작 안 함)
- hooks active 세션의 status 권한 = **hooks** (JSONL 파싱은 fallback) — F-003에서 확립
- (참조: `spec/decisions/ADR-001~006`)

## Learned

_이번 세션/최근에 배운 것._

- **Claude rename bug (F-001)**: `projectsWatcher` → `scanProjectsForActiveSessions` 경로에서 tracked 세션을 skip하면서 `custom-title` 업데이트가 다음 hook까지 미반영되는 구조적 문제. → `refreshSessionFromFile` 타깃 refresh로 해결 (commit 0a2b3a3).
- **fs.watch recursive의 `filename` 파라미터** 활용: full scan(O(N)) 대신 변경된 파일만 처리(O(1)) 가능. 기존 코드에서 `_filename`으로 무시되고 있었음.
- **OpenCode SSE에 rename 이벤트 없음** — `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `permission.updated`, `session.deleted` 6종만 emit. rename 감지는 polling 또는 DB 직접 읽기 필수.
- **`fullSync()`의 titleMissing 가드** (line 1026-1030): 기존 title 있으면 업데이트 안 함 — OpenCode rename 시에도 유사한 게이트 존재 (별도 이슈로 미처리).
- **hooks vs JSONL 권한 분리 원칙 (F-002, F-003)**: hooks active → hooks가 status/currentTool/waitingForInput 소유. JSONL 파싱은 hooks 미연결 시 fallback. `readHeartbeatFile`, `refreshSessionFromFile` 양쪽에 적용 필수. `refreshSessionFromFile` 확장 시 status 갱신 추가하면 hooks와 race condition 발생 — title/timestamps만 갱신하고 status는 hooks에 위임.
- **상태 뱃지 flash 구현 패턴**: prevStatusMap(Map<sessionId, cssClass>)으로 이전 상태 추적 → `$effect`에서 topLevelSessions 변경 시 비교 → 변경된 세션에 `status-flash` 클래스 부여 + setTimeout 1.2초 후 해제. CSS animation(brightness+scale 펄스)으로 구현, `prefers-reduced-motion` 존중.

## Next

_다음 세션에 할 것 (최대 3개)._

1. **Domain 문서 생성** — `.omc/knowledge/domains/` 비어있음. agent, server, frontend 도메인 문서 작성 필요.
2. **Pre-existing 19개 테스트 실패** 조사 — `claude-heartbeat.test.ts`의 eviction/PID liveness/parseConversationFile 계열. main 브랜치에서 이미 실패 중 (16→19개 증가 확인).
3. `auto-live-test.md` workflow 실제 실행해서 timing sleep 값 튜닝 + CI 통합 검토

---

## References

- PRD: `spec/prd.md`
- Decisions: `spec/decisions/`
- Known Failures: `knowledge/known-failures.md`
- Workflows: `workflows/deploy-dashboard.md`, `workflows/auto-live-test.md`
