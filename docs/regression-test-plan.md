# Claude Code 타임스탬프 리그레션 테스트 계획

## 1. 배경

### 발견된 버그
Claude Code 세션의 `lastActivityTime`이 실제 사용자 활동이 아닌 프로세스 heartbeat 값을 사용하여, idle 세션(예: "hi")이 항상 "0분 전"으로 표시되는 문제.

### 근본 원인
- Claude Code 프로세스가 `~/.opencode/history/heartbeats/<sessionId>.json`의 `lastHeartbeat` 값을 주기적으로 갱신
- `lastHeartbeat`는 프로세스 생존 확인용이지 사용자 활동 지표가 아님
- `buildSessionMap()`이 `lastHeartbeat`를 `lastActivityTime`으로 직접 매핑

### 적용된 수정
- `ClaudeSessionInfo`에 `lastFileModified: number` 필드 추가
- `readHeartbeatFile()`에서 JSONL 파일의 `stat.mtimeMs`를 `lastFileModified`로 설정
- `buildSessionMap()`에서 `lastActivityTime`에 `lastFileModified` 사용 (JSONL 없으면 `lastHeartbeat` 폴백)

## 2. 테스트 대상 컴포넌트

| 계층 | 파일 | 변경 사항 |
|------|------|-----------|
| Agent | `agent/src/claude-heartbeat.ts` | `lastFileModified` 필드 + JSONL mtime 추출 |
| Server | `server/src/modules/active-sessions/index.ts` | `lastActivityTime` 매핑 변경 |
| Frontend | `server/frontend/src/components/ActiveSessions.svelte` | 표시만 (이번 변경 없음) |

## 3. 단위 테스트 (이미 구현됨)

### Agent 테스트 (`agent/src/__tests__/claude-heartbeat.test.ts`)

| # | 테스트 | 검증 포인트 |
|---|--------|-------------|
| 1 | `lastFileModified from JSONL mtime when heartbeat file exists` | heartbeat 파일이 있을 때 JSONL mtime 사용, lastHeartbeat와 독립적 |
| 2 | `fallback lastFileModified to lastHeartbeat when JSONL is missing` | JSONL 파일 없으면 lastHeartbeat 폴백 |
| 3 | `detect active sessions from project JSONL` (기존) | `lastFileModified > 0` 검증 추가 |

### Server 테스트 (`server/src/__tests__/active-sessions-claude.test.ts`)

| # | 테스트 | 검증 포인트 |
|---|--------|-------------|
| 1 | `lastActivityTime from Claude session lastFileModified field` | `lastFileModified`가 있으면 `lastActivityTime`으로 사용 |
| 2 | `fallback to lastHeartbeat when lastFileModified is missing` | `lastFileModified` 없으면 `lastHeartbeat` 폴백 |
| 3 | `startTime from Claude session startTime field` (기존) | 기존 동작 유지 확인 |
| 4 | `lastPromptTime from Claude session lastPromptTime field` (기존) | 기존 동작 유지 확인 |

## 4. 수동 리그레션 테스트 시나리오

### 시나리오 A: Idle 세션 타임스탬프 정확성

**전제 조건**: Claude Code에서 세션 하나를 열고 메시지를 보낸 후 5분 이상 방치

**절차**:
1. Dashboard(`http://192.168.0.63:3097`)에 접속
2. 해당 Claude Code 세션 확인
3. `lastActivityTime`(→ 표시 시간)이 마지막 활동 시점을 반영하는지 확인
4. 5분 후 다시 확인 — 시간이 증가해야 함 (이전: 항상 "0분 전")

**예상 결과**: "5분 전", "10분 전" 등으로 표시 (heartbeat 갱신과 무관)

### 시나리오 B: 활성 세션 타임스탬프 갱신

**전제 조건**: Claude Code 세션에서 새 메시지 전송

**절차**:
1. Dashboard에서 세션의 현재 `lastActivityTime` 확인
2. Claude Code에서 새 메시지 전송
3. 2-4초 후 Dashboard에서 `lastActivityTime` 갱신 확인

**예상 결과**: 새 메시지 전송 후 `lastActivityTime`이 현재 시각 근처로 갱신됨

### 시나리오 C: lastPromptTime 표시

**절차**:
1. Dashboard에서 Claude Code 세션의 meta row 확인
2. `lastPromptTime → lastActivityTime (상대 시간)` 포맷 확인
3. 활성 작업 중(busy)이면 `→ ⏳` (dot-loader) 표시 확인

**예상 결과**: 형식이 `04:41:51 → 04:42:30 (3.6h ago)` 등으로 표시

### 시나리오 D: Heartbeat 없는 세션 (프로젝트 스캔)

**전제 조건**: heartbeat 파일 없이 JSONL만 존재하는 세션

**절차**:
1. heartbeat 파일을 수동 삭제 또는 heartbeat 없는 오래된 세션 확인
2. Dashboard에서 해당 세션이 `lastFileModified = JSONL mtime`으로 표시되는지 확인

**예상 결과**: JSONL mtime 기반으로 `lastActivityTime` 표시

### 시나리오 E: OpenCode 세션 비영향 확인

**절차**:
1. OpenCode 세션과 Claude Code 세션이 동시에 존재할 때 Dashboard 확인
2. OpenCode 세션의 `lastActivityTime`이 여전히 `time.updated` 기반인지 확인

**예상 결과**: OpenCode 세션은 이전과 동일하게 동작 (변경 없음)

### 시나리오 F: Docker 컨테이너 재시작

**절차**:
1. `docker compose restart` 실행
2. Dashboard가 정상 복구되는지 확인
3. 모든 세션 타임스탬프가 올바른지 확인

**예상 결과**: 재시작 후 정상 동작, PID 1 singleton 문제 없음

## 5. API 레벨 검증

### Agent API 확인

```bash
# 토큰 발급
TOKEN=$(curl -s -X POST http://localhost:3101/api/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"<YOUR_KEY>"}' | jq -r .token)

# Claude 세션 확인
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3101/api/claude/sessions | jq '.sessions[] | {
    sessionId: .sessionId[:12],
    lastHeartbeat,
    lastFileModified,
    lastPromptTime,
    title
  }'
```

**검증 포인트**:
- `lastFileModified` 필드가 존재하는지
- `lastFileModified`가 `lastHeartbeat`보다 오래된 값인지 (idle 세션의 경우)
- `lastPromptTime`이 `lastFileModified`와 유사한 값인지

### Dashboard API 확인

```bash
curl -s http://localhost:3097/api/sessions | jq '.sessions[] |
  select(.source == "claude-code") | {
    sessionId: .sessionId[:12],
    lastActivityTime,
    lastPromptTime,
    title
  }'
```

**검증 포인트**:
- `lastActivityTime`이 `lastFileModified` 값과 일치하는지
- 정렬 순서가 실제 활동 시간 기반인지

## 6. 비파괴 확인 체크리스트

수정으로 인해 기존 기능이 깨지지 않았는지 확인:

- [ ] Agent 테스트 전체 통과 (`cd agent && npm test`)
- [ ] Server 테스트 전체 통과 (`cd server && npm test`)
- [ ] Docker 빌드 성공 (빌드 내 테스트 포함)
- [ ] Dashboard UI 접속 가능 (`http://localhost:3097`)
- [ ] OpenCode 세션 정상 표시
- [ ] Claude Code 세션 정상 표시
- [ ] 세션 정렬 순서 정상 (최근 활동 → 오래된 활동)
- [ ] `lastPromptTime → lastActivityTime` 포맷 표시
- [ ] 세션 상태 표시 (busy/idle) 정상
- [ ] 세션 제목 표시 정상

## 7. 데이터 흐름 요약 (수정 후)

```
Claude Code 프로세스
    │
    ├─→ heartbeat JSON (lastHeartbeat = 프로세스 생존 시각, 주기적 갱신)
    │       └─ 용도: alive 판단, eviction 판단
    │
    └─→ JSONL 대화 파일 (실제 대화 기록)
            ├─ mtime = 마지막 파일 수정 시각 → lastFileModified → lastActivityTime ✅
            ├─ 마지막 user entry timestamp → lastPromptTime ✅
            └─ 첫 user entry content → title ✅

Agent (claude-heartbeat.ts)
    ├─ readHeartbeatFile()
    │   ├─ heartbeat JSON → lastHeartbeat (alive 판단)
    │   └─ JSONL stat.mtimeMs → lastFileModified (실제 활동)
    └─ scanProjectsForActiveSessions()
        └─ JSONL stat.mtimeMs → lastFileModified (실제 활동)

Server (active-sessions/index.ts)
    └─ buildSessionMap()
        └─ lastActivityTime = s.lastFileModified ?? s.lastHeartbeat
```

## 8. 관련 커밋 이력

| 커밋 | 설명 |
|------|------|
| `799e2cb` | 최초 Claude Code 타임스탬프 분기 (isClaudeCode → s.startTime/s.lastHeartbeat) |
| `4cffc26` | Task 1: lastPromptTime 추가 |
| `eda208d` | Task 2: 서버 파이프라인에 lastPromptTime 전파 |
| `625ec3d` | Task 3: Frontend UI 업데이트 |
| `cd9aebe` | Singleton PID 1 fix |
| (pending) | **lastFileModified 추가 — lastActivityTime 버그 수정** |
| `31f88ca` | **Bug 1: break → lastEntry 패턴 — 세션당 마지막 user 프롬프트 수집** |
| `697c063` | **Bug 2: multi-project session collection + lastPrompt 갱신 가드 제거** |

---

## 9. Prompt History Regression — Bug 1: 세션당 첫 번째 프롬프트만 수집

### 발견된 버그
- `oc-query-collector.ts`의 `collectFromSession()`에서 `break`문이 세션당 첫 번째 유효 user 메시지만 수집
- 장기 세션의 최신 프롬프트가 PROMPT HISTORY에 누락됨

### 근본 원인
- `for` 루프에서 첫 번째 유효 user 메시지 발견 시 `break` — 세션당 하나만 수집
- 장기 세션에서 여러 프롬프트를 보내도 첫 프롬프트만 표시

### 적용된 수정 (`31f88ca`)
- `break` 제거 → `lastEntry` 패턴으로 변경 (세션당 마지막 유효 user 메시지 수집)
- `extractUserPrompt()` 활용한 유효성 검증 추가

### 단위 테스트 (`agent/src/__tests__/oc-query-collector.test.ts`)

| # | 테스트 | 검증 포인트 |
|---|--------|-------------|
| 1 | `장기 세션에서 마지막 user message를 수집` | 여러 user 메시지 중 마지막 유효 메시지만 반환 |
| 2 | `시스템 프롬프트 skip → 실제 프롬프트만 수집` | extractUserPrompt 필터 동작 확인 |

### E2E 테스트 (`server/e2e/opencode-regression.spec.ts`)

| # | 시나리오 | 검증 포인트 |
|---|----------|-------------|
| Scenario 8 | Long session shows latest prompt | 3개 user 메시지 세션에서 마지막 프롬프트 표시 확인 |

### 수동 리그레션 시나리오

**절차**:
1. OpenCode에서 세션 열고 3개 이상 프롬프트 전송
2. Dashboard PROMPT HISTORY에서 해당 세션 확인
3. 가장 최근 프롬프트가 표시되는지 확인

**예상 결과**: 마지막 프롬프트가 PROMPT HISTORY에 표시

---

## 10. Prompt History Regression — Bug 2: Multi-Project Session Collection

### 발견된 버그 (3계층)

| # | 문제 | 위치 | 심각도 |
|---|------|------|--------|
| 1 | collector가 기본 프로젝트 세션만 조회 | `oc-query-collector.ts` — `/session?limit=100` directory 파라미터 없음 | Critical |
| 2 | SSE lastPrompt 한 번 설정되면 갱신 안 됨 | `session-cache.ts` — `if (existing?.lastPrompt) return;` guard | Medium |
| 3 | session.idle 시 prompt 갱신 안 함 | `session-cache.ts` handleSessionIdle에 fetch 없음 | Low |

### 근본 원인
- oc-serve의 `/session?limit=100`은 directory 파라미터 없이 호출 시 기본 프로젝트(bae-settings) 세션만 반환
- 다른 프로젝트(session-dashboard 등)의 세션은 수집 대상에서 제외됨
- SessionCache의 guard가 첫 번째 프롬프트 설정 후 갱신을 차단

### 적용된 수정 (`697c063`)

**oc-query-collector.ts**:
- `fetchProjectWorktrees()`: `/project` API로 모든 프로젝트 worktree 경로 수집
- `fetchSessionsFromAllProjects()`: 각 worktree별 `/session?directory=...&limit=20` 병렬 호출 + deduplicate
- Fallback: `/project` 실패 시 기존 동작 (directory 없이)
- parentID 필터 + timestamp 정렬 + `limit*2` 슬라이스로 성능 제한

**session-cache.ts**:
- `fetchFirstUserPrompt` → `fetchLatestUserPrompt` 리네임
- `if (existing?.lastPrompt) return;` guard 제거 — 매 이벤트마다 최신 프롬프트 갱신
- 역순 순회로 마지막 유효 user message 탐색 + `extractUserPrompt()` 활용
- `handleSessionIdle`에 `fetchLatestUserPrompt` 호출 추가 (turn 완료 시 갱신)

### 단위 테스트 (`agent/src/__tests__/oc-query-collector.test.ts`)

| # | 테스트 | 검증 포인트 |
|---|--------|-------------|
| 1 | `모든 프로젝트의 세션을 수집` | /project → worktree별 /session 호출 → 다른 프로젝트 세션 포함 |
| 2 | `/project 실패 시 기존 fallback 동작` | /project 에러 → /session?limit=100 fallback |
| 3 | `세션 ID 중복 제거` | 여러 프로젝트에서 같은 세션 반환 시 deduplicate |
| 4 | `worktree가 / 인 프로젝트는 건너뜀` | root worktree 필터링 |

### 단위 테스트 (`agent/src/__tests__/session-cache.test.ts`)

| # | 테스트 | 검증 포인트 |
|---|--------|-------------|
| 1 | `여러 user 메시지 중 마지막을 lastPrompt로 저장` | 역순 순회 + 마지막 유효 메시지 선택 |
| 2 | `lastPrompt가 저장된 세션도 message.updated 시 REST 재호출` | guard 제거 확인 |

### 수동 리그레션 시나리오

**시나리오 G: Multi-Project 세션 수집**

**전제 조건**: 2개 이상 프로젝트에서 OpenCode 세션이 활성 상태

**절차**:
1. 서로 다른 프로젝트(예: session-dashboard, bae-settings)에서 각각 OpenCode 세션 열기
2. 각 세션에서 프롬프트 전송
3. Dashboard PROMPT HISTORY에서 두 프로젝트의 프롬프트가 모두 보이는지 확인

**예상 결과**: 모든 프로젝트의 최신 프롬프트가 PROMPT HISTORY에 표시

**시나리오 H: 실시간 프롬프트 갱신**

**절차**:
1. OpenCode 세션에서 프롬프트 전송
2. 30초 대기 (수집 사이클)
3. Dashboard에서 방금 보낸 프롬프트가 표시되는지 확인
4. 같은 세션에서 새 프롬프트 전송
5. 30초 대기 후 새 프롬프트로 갱신되었는지 확인

**예상 결과**: 세션의 lastPrompt가 항상 최신 프롬프트로 갱신됨

### API 레벨 검증

```bash
# Multi-project 세션 수집 확인
curl -s http://127.0.0.1:3098/api/queries?limit=20 | python3 -c "
import json,sys
data = json.load(sys.stdin)
queries = data.get('queries', data) if isinstance(data, dict) else data
sessions = set()
for q in queries:
    sid = q.get('sessionId','')[:20]
    query = q.get('query','')[:60]
    if sid not in sessions:
        sessions.add(sid)
        print(f'{sid} | {query}')"
```

**검증 포인트**:
- 여러 프로젝트의 세션 ID가 결과에 포함되는지
- 각 세션의 query가 최신 프롬프트인지
