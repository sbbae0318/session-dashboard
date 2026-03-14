# Learnings — install-script

## 2026-03-08 Session Start

### Project Structure
- Worktree: /Users/sbbae/project/session-dashboard-install-script (branch: feat/install-script)
- Main repo: /Users/sbbae/project/session-dashboard
- Agent: /agent/ (Node.js Fastify, nohup, port 3098 default)
- Server: /server/ (Docker Compose, port 3097 default)

### Key Patterns
- install/agent.sh:1-5 — `set -euo pipefail`, SCRIPT_DIR, REPO_ROOT 패턴
- install/agent.sh:7-33 — Argument parsing (ACTION 변수, case문)
- install/agent.sh:61-83 — check_prerequisites() Node.js 18+ 체크
- install/agent.sh:131-192 — do_install() Step 1-4 플로우
- server/e2e/global-setup.claude.ts — E2E setup 패턴 (spawn, health check, PID persist)
- server/e2e/helpers/claude-data.ts — JSONL fixture helper 패턴

### Config Files
- agent/.env.example: PORT=3098, API_KEY, OC_SERVE_PORT=4096, HISTORY_DIR=~/.opencode/history, SOURCE=opencode
- server/machines.yml.example: id, alias, host, port, apiKey, source 필드
- server/.env.example: DASHBOARD_PORT=3097, MACHINES_CONFIG

### E2E Port Allocation
- Claude E2E: agent=3199, server=3098
- OpenCode E2E: agent=3198, server=3099 (no conflict)
- Claude API key: 'e2e-test-key-12345'
- OpenCode API key: 'e2e-oc-test-key-12345'

### Data Sources
- OpenCode: ~/.opencode/history/cards.jsonl, queries.jsonl (no oc-serve needed for read)
- Claude Code: ~/.claude/projects/{encoded-path}/{session}.jsonl, history.jsonl
- Agent SOURCE: opencode | claude-code | both

### Critical Gotchas
- /api/sessions requires oc-serve proxy → 502 when oc-serve is down (EXPECTED in OpenCode E2E)
- cleanAgentHome() must NOT delete the .opencode/history directory itself (FS watcher)
- JSONL files: NO #XX| prefix in E2E fixtures (pure JSON lines)
- install.sh must call existing agent.sh/server.sh (delegation pattern, no logic duplication)
- API_KEY must be same in agent .env AND server machines.yml

## 2026-03-09 Task 1: install/install.sh

### Implementation
- install/install.sh: 191줄 unified installer (detect + configure + delegate)
- Delegation pattern: agent.sh/server.sh를 bash로 호출, 내부 로직 중복 없음
- detect_source(): HOME 내 .opencode/history/*.jsonl + .claude/projects|history.jsonl 체크
- generate_api_key(): openssl rand -hex 16
- prepare_agent_config(): sed -i.bak로 .env 치환 (macOS/Linux 호환)
- prepare_server_config(): machines.yml heredoc 생성

### Key Patterns
- sed -i.bak "s|pattern|replacement|" file && rm -f file.bak — macOS/Linux 호환 sed 인플레이스
- `[[ "$source" == "claude-code" ]] && history_dir="~/.claude"` — set -e 안전 (단일 명령 && 할당)
- `if [[ "$ACTION" != "server-only" ]]; then ... fi` — set -e 안전 분기 (&&로 체이닝하면 set -e 위반 가능)
- HOME 오버라이드로 detect_source 테스트: `HOME="$TMPDIR" bash install.sh --dry-run`
- SOURCE 변수가 .env.example에서 주석 처리 → `sed 's|^# SOURCE=.*|SOURCE=$val|'`로 uncomment

### Gotchas
- `set -e` + `[[ cond ]] && action` 조합 주의: cond이 false면 스크립트 종료됨 → if문 사용 필수
- .env.example의 SOURCE는 `# SOURCE=opencode` (주석)이므로 uncomment 로직 필요
- agent.sh 호출 시 .env가 이미 있으면 agent.sh의 do_install()이 보존함 (conflict 없음)

## Task 2: opencode-data.ts + machines.opencode-test.yml (2026-03-09)

### 파일 구조
- `opencode-data.ts`: `claude-data.ts` 미러링. 경로만 `.opencode/history/` 로 변경
- `writeCards()`: `agentHome/.opencode/history/cards.jsonl` 에 순수 JSON 줄 작성
- `writeQueries()`: `agentHome/.opencode/history/queries.jsonl` 에 순수 JSON 줄 작성
- `cleanAgentHome()`: `.opencode/history/` 내 파일만 삭제 (디렉토리 유지 - FS watcher 안전)

### 검증
- `npx tsc --noEmit` → 에러 없음 (node_modules 설치 필요했음)
- YAML fixture: source=opencode, port=3198, apiKey=e2e-oc-test-key-12345 모두 확인

### 주의사항
- server/node_modules 없으면 tsc 에러 다수 발생 → npm install 먼저 필요
- JSONL: `#XX|` prefix 절대 금지, 순수 JSON 줄만

## Task 9: E2E OpenCode Regression Test Fix

- 7/7 tests PASS after prior commit `17ddf04` fixed:
  - `body.sessions` → `body.cards` (Scenario 1)
  - `OC_SERVE_PORT=59999` isolation in global-setup
  - `cwd: TEST_AGENT_HOME` for PromptStore DB isolation
  - PromptStore SQLite write helpers for Scenario 2/4
- Cascade failure pattern: Scenario 1 failure → teardown kills agent/server → all subsequent tests ECONNREFUSED
- UI selectors `.source-filter-btn:has-text("OpenCode")` and `[data-testid="recent-prompts"]` are correct (match App.svelte and RecentPrompts.svelte)
- Server serves frontend from `dist/public/` (built by Vite into dist/public)
- `poll failed (N/3): HTTP 502: Bad Gateway` logs are expected (oc-serve is intentionally on dead port 59999)

### Deep Dive: Agent Query Pipeline
- Agent `/api/queries` priority: SQLite PromptStore → OcQueryCollector → JSONL fallback
- When SOURCE='opencode', JSONL fallback is NEVER reached (ocQueryCollector always created)
- Must write to PromptStore SQLite DB (`./data/session-cache.db` relative to agent CWD)
- `sqlite3` CLI on macOS can inject test data without `better-sqlite3` npm dependency
- `better-sqlite3` is in agent/node_modules but NOT in server/node_modules

### Process Death Root Cause
- TypeError in `expect.poll` callback caused Playwright to immediately fail test
- Rapid test failure → Playwright restarted worker → SIGTERM sent to process group
- Solution: safe property access (`body.cards?.filter(...)` or `if (!body.cards) return 0`)
- Server `/api/history` returns `{ cards: [...] }` not `{ sessions: [...] }` — original test had wrong key
