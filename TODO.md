# TODO — Session Dashboard 로드맵

## 경쟁 분석: claude-control (sverrirsig/claude-control)

> 분석일: 2026-03-22
> 대상: macOS Electron 데스크탑 앱, Next.js 16 + React 19, 완전 stateless (DB 없음)

### 우리가 이기는 영역 (유지·강화)

- [x] 멀티머신 모니터링 (agent → server 아키텍처)
- [x] OpenCode + Claude Code 통합 지원
- [x] 토큰/비용 분석 (세션별·프로젝트별)
- [x] 코드 Impact 추적 (additions/deletions/files)
- [x] 타임라인 시각화 (SVG 인터랙티브)
- [x] 프로젝트 분석 (집계·정렬)
- [x] 메모 시스템 (프로젝트별 CRUD)
- [x] Recovery 컨텍스트 (프롬프트/툴/변경사항 요약)
- [x] 풀텍스트 분산 검색
- [x] TUI (Ink 기반 터미널 UI)
- [x] 웹 접근성 (브라우저, 크로스 플랫폼)

### 도입 필요 — HIGH

- [ ] **프로세스 테이블 기반 세션 감지**
  - `ps -eo pid,ppid,%cpu,comm` → claude/opencode 프로세스 발견
  - `lsof -p <pids> -Fpn -d cwd` → 작업 디렉토리 매핑
  - Heartbeat/Hook 없이도 실행 중인 세션 감지 가능
  - CPU% 기반 활동 상태 추정 (fallback)
  - OpenCode에도 동일 적용 가능
  - 기존 `process.kill(pid, 0)` PID alive 체크와 자연스럽게 통합

- [ ] **대시보드에서 Approve/Reject**
  - `waitingForInput` 상태일 때 카드에 Approve/Reject 버튼 표시
  - tmux `send-keys`로 `y`/`n` 전송 — 터미널 전환 없이 승인
  - 멀티머신: SSH + tmux 조합으로 원격 지원 가능
  - claude-control의 킬러 피처 — 도입 시 핵심 차별점 제거

### 도입 필요 — MEDIUM

- [ ] **Hybrid 상태 분류 (Hook + 휴리스틱 fallback)**
  - 현재: Hook 이벤트 or SSE만 의존
  - 추가: CPU% + JSONL mtime 기반 fallback
  - `APPROVAL_SETTLE_MS` (3초 debounce) — tool_use 직후 false "waiting" 방지
  - Hook 미설정 환경에서도 정확한 상태 표시

- [ ] **위험 명령 경고**
  - `currentTool` 이벤트에 tool arguments 포함 시 파싱
  - 패턴 감지: `sudo`, `rm -rf`, `eval`, `--force`, `$()`, pipe to shell
  - 카드에 경고 아이콘 표시
  - Approve/Reject 기능과 연계 시 시너지

- [ ] **PR 상태 통합**
  - `gh pr status` 파싱 또는 GitHub API 연동
  - CI 체크 상태, 리뷰 결정, 머지 충돌, 미해결 스레드
  - 세션 카드에 PR 배지 표시

- [ ] **Git 브랜치/변경사항 표시**
  - 세션별 현재 브랜치명
  - 변경 파일 수, additions/deletions (Impact 탭과 중복 아닌 카드 레벨 요약)

### 도입 필요 — LOW

- [ ] **Linear/외부 이슈 트래커 연동**
  - MCP tool_result에서 Linear 티켓 데이터 파싱
  - 세션의 작업 컨텍스트로 표시

- [ ] **세션 생성**
  - 레포 브라우징 + 초기 프롬프트로 새 세션 시작
  - 멀티머신에서 어느 머신에 생성할지 선택

- [ ] **워크트리 관리**
  - 세션 종료 + 브랜치 삭제 + 워크트리 정리 (2단계 확인)

- [ ] **키보드 단축키 강화**
  - 숫자키 세션 선택, A/X approve/reject
  - 현재 Cmd+K만 있음

---

## 아키텍처 차이점 요약

| | claude-control | session-dashboard |
|---|---|---|
| 플랫폼 | macOS Electron | 웹 (서버 + Svelte) |
| DB | 없음 (stateless) | SQLite (캐시/메모/enrichment) |
| 멀티머신 | 불가 | 지원 |
| 세션 감지 | `ps` + `lsof` + Hook | Heartbeat + Hook + SSE |
| 실시간 | SWR 1초 폴링 | SSE + 2초 폴링 |
| 터미널 제어 | AppleScript/tmux 키스트로크 | 없음 |
| 대상 도구 | Claude Code만 | OpenCode + Claude Code |

## 전략

프로세스 테이블 모니터링 + Approve/Reject를 도입하면 claude-control의 핵심 차별점을 흡수하면서, 멀티머신 + 분석 + 검색 + 메모로 상위 호환 유지.
