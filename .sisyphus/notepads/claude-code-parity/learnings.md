# Claude Code Parity — Learnings

## [2026-03-11] Session Start

### Architecture
- Agent runs on local machine (192.168.0.63), server runs on remote (192.168.0.2)
- Agent port: 3098, Server port: 3097
- Deploy: `ssh sbbae@192.168.0.2`, `cd /home/sbbae/project/session-dashboard`, `git pull`, `cd server && docker compose up -d --build`
- Agent restart: `npm run build` in main repo, then `./install/agent.sh --restart`

### Key Files
- `agent/src/claude-heartbeat.ts` — T1, T2, T3의 핵심 수정 대상 (495줄)
- `agent/src/claude-source.ts` — T2, T4 수정 대상 (68줄)
- `agent/src/server.ts` — T4 수정 대상 (283줄)
- `agent/src/prompt-extractor.ts` — T2에서 재사용: `extractUserPrompt()` 함수
- `agent/src/prompt-store.ts` — T4에서 통합 대상: PromptStore SQLite
- `agent/src/oc-query-collector.ts` — T4에서 타입 확장: QueryEntry.source
- `server/src/machines/machine-manager.ts` — T5 수정 대상 (476줄)

### Constants to Use
- `MAX_TITLE_LENGTH = 100`
- `MAX_PROMPT_LENGTH = 200`
- `STALE_TTL_MS = 4 * 60 * 60 * 1000` (4 hours)

### Worktree
- Branch: `feat/claude-code-parity`
- Path: `/Users/sbbae/project/session-dashboard-claude-parity`
- All work happens in this worktree

## T3: PID Liveness + Ghost Session Cleanup (2026-03-11)

- `vi.waitFor`는 vitest에서만 지원, bun test runner에서는 사용 불가 → `npm test` (vitest run) 사용 필수
- `process.kill(pid, 0)`: ESRCH = 프로세스 없음, EPERM = 다른 유저의 프로세스 (살아있음)
- `isProcessAlive(pid <= 0)` → false 반환: pid=0 세션(project scan)은 PID 체크 스킵, TTL만 적용
- `evictStale()`: `Math.max(lastHeartbeat, lastFileModified)` 사용 → JSONL mtime이 더 최신이면 그걸 기준으로 TTL 판단
- T1이 같은 파일을 대폭 수정 (506줄 → 642줄)했지만, evictStale()과 STALE_TTL_MS는 같은 위치에 있어서 line ID만 재확인하면 충돌 없이 수정 가능
- `active-directories.test.ts`에 pre-existing 실패 1건 있음 (배열 순서 이슈) — T3 scope 밖


## T1: Single-pass JSONL Extraction (2026-03-11)

- `parseConversationFile()`: single `readFile()` → forward scan (title) + reverse scan (status, timestamps, lastPrompt)
- `ConversationData` interface: `status`, `title`, `lastPrompt`, `lastPromptTime`, `lastResponseTime`
- `readHeartbeatFile()` 내 readFile 호출: heartbeat JSON 1회 + JSONL 1회 (parseConversationFile) + stat 1회 = 총 3회 (기존 5+회에서 축소)
- `scanProjectsForActiveSessions()` 내: stat 1회 + parseConversationFile 1회 = 총 2회 (기존 4+회에서 축소)
- 기존 메서드(detectSessionStatus, extractTitleFromFile 등)는 삭제하지 않음 — 하위 호환성 유지, 호출만 제거
- `MAX_TITLE_LENGTH=100`, `MAX_PROMPT_LENGTH=200` 상수로 하드코딩 제거
- T3 커밋과 동시 작업으로 인해 같은 커밋 `04992d3`에 포함됨 (working tree 변경사항이 T3의 `git add -A`에 의해 함께 커밋됨)
- 8개 신규 테스트: happy path, empty file, incomplete JSON line, user-only, assistant-only, tool_use, 200자 제한, array content

## T2: lastPrompt + System Prompt Filtering (2026-03-11)

- `ClaudeSessionInfo`에 `lastPrompt: string | null` 필드 추가
- `readHeartbeatFile()` + `scanProjectsForActiveSessions()`에서 `extractUserPrompt()` 적용: raw lastPrompt → filtered
- `ClaudeSource.getRecentQueries()`에도 `extractUserPrompt()` 적용: system-only → null 반환 → filter
- `claude-source.test.ts`가 이미 존재 (기존 테스트 12개) — 새 describe 블록으로 4개 추가
- `extractUserPrompt()` 순서: parseConversationFile (200자 truncate) → extractUserPrompt (system filter/strip)
- `isRealQuery()` (slash, XML, empty 필터) → `extractUserPrompt()` (system prompt 필터) — 이중 필터 구조

## T4: completedAt + Query SQLite Integration (2026-03-11)

- `ClaudeQueryEntry`에 `completedAt: number | null` 추가 — history.jsonl에서는 추출 불가하므로 항상 `null`
- `QueryEntry.source` 타입: `'opencode'` → `'opencode' | 'claude-code'`로 확장
- `prompt-store.ts` `rowToQueryEntry()`: `row.source as 'opencode'` → `row.source as QueryEntry['source']`로 수정 (claude-code 값도 올바르게 반환)
- `server.ts` `doCollection()`: `claudeEnabled && claudeSource` 조건 내에서 `claudeSource.getRecentQueries(200)` 호출 → `QueryEntry[]`로 변환 후 entries에 push
- `doCollection`은 `ocServeEnabled && ocQueryCollector` 블록 내에서만 정의됨 → `source='claude-code'`만인 경우 Claude 쿼리 미영속화 (별도 `/api/claude/queries` 엔드포인트로 제공)
- `source='both'`인 경우: `claudeSource`는 line 146에서 초기화, `doCollection` 첫 호출(line 133)은 `void` async이므로 실행 시점에 `claudeSource` 이미 설정됨
- 신규 테스트 2개: completedAt null 검증, full shape 검증 (toEqual)
- 기존 active-directories.test.ts 실패 1건은 배열 순서 이슈 (pre-existing, scope 밖)
## T5: Server-side Mapping Fix (2026-03-11)

### 버그 위치
`server/src/machines/machine-manager.ts` line ~407-408 (`pollSessionDetails()` 메서드)

### 수정 내용
- `lastPrompt: null` → `lastPrompt: (session.lastPrompt as string) ?? null`
- `lastPromptTime: (session.startTime as number) ?? Date.now()` → `lastPromptTime: (session.lastPromptTime as number) ?? null`

### 빌드 주의사항
- `npm install` 없이 `npm run build` 실행 시 node_modules 없어서 대량 에러 발생
- `npm install` 후 빌드하면 정상 통과

### 패턴
- Claude 세션 매핑에서 실제 필드명을 사용해야 함 (`lastPrompt`, `lastPromptTime`)
- `startTime`은 세션 시작 시간이지 마지막 프롬프트 시간이 아님
