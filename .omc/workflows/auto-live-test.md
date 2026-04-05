# Workflow: Auto Live Test (Dashboard E2E via tmux Claude + agent-browser)

**Status:** Active
**Date:** 2026-04-05
**Frequency:** 신규 기능 개발/수정 후 프로덕션 배포 전후 실사용 검증

---

## Trigger

**언제 이 workflow를 실행하는가**:
- session-dashboard의 세션 감지/title/상태 관련 변경 사항을 실사용 환경에서 검증해야 할 때
- 배포 후 실제 Claude Code 흐름에서 대시보드가 정확히 반영하는지 확인할 때
- 새 기능(rename 감지, 세션 필터, enrichment 등)의 end-to-end 동작 검증이 필요할 때

**패턴**: **Actor A**(별도 tmux Claude)가 테스트 데이터를 만들고, **Actor B**(agent-browser)가 대시보드에서 확인.

## Preconditions

- [ ] `agent-browser` CLI 설치됨 (`which agent-browser`)
- [ ] `tmux` 설치됨 (`tmux -V`)
- [ ] session-dashboard 서비스 실행 중 (agent:3098, dashboard:3097)
- [ ] `claude` CLI 실행 가능 (Claude Code CLI)
- [ ] 테스트용 디렉토리 준비 (실 프로젝트 건드리지 않도록 `/tmp/cc-live-test` 등)

## 핵심 아이디어

```
┌─────────────────────────────────┐         ┌─────────────────────────────┐
│ Actor A: tmux 세션              │         │ Actor B: 현재 agent/session │
│  - claude CLI 실행              │──────▶  │  - agent-browser으로 확인   │
│  - 프롬프트/커맨드 자동 입력    │  data   │  - 스크린샷 + eval 검증     │
│  - rename, slash command 실행   │         │  - JSONL/API 스냅샷         │
└─────────────────────────────────┘         └─────────────────────────────┘
         tmux send-keys                          agent-browser commands
              │                                              │
              └──────▶ session-dashboard(3097/3098) ◀────────┘
```

## Steps

### Step 1: 테스트 환경 세팅

```bash
# 별도 테스트 디렉토리 (실 프로젝트 오염 방지)
TEST_DIR="/tmp/cc-live-test-$(date +%s)"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# 간단한 파일 하나 생성 (Claude가 컨텍스트로 사용할 것)
echo "# Test Project\n\nAuto live test for session-dashboard." > README.md
```

**예상 결과**: 빈 테스트 디렉토리 생성
**실패시**: tmp 쓰기 권한 확인

---

### Step 2: 별도 tmux 세션에서 Claude Code 기동

```bash
TMUX_SESSION="live-test-$(date +%s)"
tmux new-session -d -s "$TMUX_SESSION" -c "$TEST_DIR" -x 200 -y 50
tmux send-keys -t "$TMUX_SESSION" "claude" Enter

# Claude 부팅 대기 (banner + prompt 준비)
sleep 4
```

**예상 결과**: `tmux list-sessions`에 `live-test-*` 존재
**실패시**: `tmux capture-pane -t $TMUX_SESSION -p | tail -20` 으로 에러 확인

---

### Step 3: Actor A — Claude에 테스트 입력 전송

```bash
# 고유 식별자 포함 prompt (나중에 대시보드에서 검색용)
TEST_MARKER="auto-live-$(date +%s)"
tmux send-keys -t "$TMUX_SESSION" "write a one-line comment marker: $TEST_MARKER" Enter

# Claude 응답 대기 (실제 LLM 왕복)
sleep 15
```

**예상 결과**: tmux pane에 Claude 응답 존재, JSONL에 user entry 기록됨
**실패시**: `tmux capture-pane -t $TMUX_SESSION -p | tail -40`

---

### Step 4: Actor B — Dashboard에서 새 세션 감지 확인 (agent-browser)

```bash
DASHBOARD_URL="http://192.168.0.2:3097"
SCREENSHOT_DIR="/tmp/auto-live-test"
mkdir -p "$SCREENSHOT_DIR"

agent-browser open "$DASHBOARD_URL" && \
  agent-browser wait --load networkidle && \
  agent-browser screenshot "$SCREENSHOT_DIR/01-sessions-list.png"

# 새 세션이 API에 등장했는지 확인
curl -s "$DASHBOARD_URL/api/sessions" | python3 -c "
import json, sys
data = json.load(sys.stdin)
matches = [s for s in data.get('sessions', []) if s.get('lastPrompt') and '$TEST_MARKER' in s['lastPrompt']]
print(f'matched sessions: {len(matches)}')
for s in matches:
    print(f'  sid={s[\"sessionId\"][:12]}... title={s.get(\"title\")[:50]}')
"
```

**예상 결과**: `matched sessions: 1` 이상, sessionId/title 표시됨
**실패시**: agent가 heartbeatsDir/claudeProjectsDir 모니터링 중인지 확인 (`curl /health`)

---

### Step 5: Actor A — Rename 실행 (검증 대상 기능)

```bash
RENAME_TO="live-test-$TEST_MARKER"
tmux send-keys -t "$TMUX_SESSION" "/rename $RENAME_TO" Enter
sleep 2
```

**예상 결과**: tmux pane에 `Session renamed to: $RENAME_TO` 출력
**실패시**: `tmux capture-pane -t $TMUX_SESSION -p | grep -i rename`

---

### Step 6: Actor B — Rename 즉시 반영 확인

```bash
# 2초 이내에 API 반영되어야 함 (새 refresh 로직)
sleep 2
curl -s "$DASHBOARD_URL/api/sessions" | python3 -c "
import json, sys
data = json.load(sys.stdin)
matches = [s for s in data.get('sessions', []) if s.get('title') == '$RENAME_TO']
if matches:
    print(f'✅ rename reflected: sid={matches[0][\"sessionId\"][:12]}...')
else:
    print(f'❌ rename NOT reflected within 2s')
    sys.exit(1)
"

# 브라우저에서도 시각적 확인
agent-browser reload && \
  agent-browser wait --load networkidle && \
  agent-browser screenshot "$SCREENSHOT_DIR/02-after-rename.png"

# UI에 새 title 노출되는지
agent-browser eval "document.body.innerText.includes('$RENAME_TO')"
```

**예상 결과**: API에 새 title 반영 (`✅ rename reflected`) + UI eval `true`
**실패시**: 
- `true`가 아니면 agent refresh 로직 미동작
- 에이전트 로그: `tail -30 /tmp/agent-macbook.log`

---

### Step 7: 추가 검증 시나리오 (선택)

필요 시 확장:

```bash
# (a) 세션에 tool_use 실행 → dashboard에 working 상태 노출 확인
tmux send-keys -t "$TMUX_SESSION" "read README.md and summarize" Enter
sleep 5
curl -s "$DASHBOARD_URL/api/sessions" | python3 -c "..."

# (b) /title 없이 더 긴 프롬프트 → firstUserTitle 동작 확인
# (c) 세션 종료(Ctrl+D 또는 /exit) → dashboard에서 idle 전환 확인
tmux send-keys -t "$TMUX_SESSION" "/exit" Enter
sleep 3
```

---

## Verification

실행 성공 기준:

- [ ] Step 4: 새 Claude 세션이 dashboard API에서 2초 이내 감지됨
- [ ] Step 6: rename이 2초 이내 반영됨 (title 값 변경)
- [ ] Step 6: 브라우저 UI에도 새 title 노출 (eval `true`)
- [ ] 스크린샷 `01-sessions-list.png` + `02-after-rename.png` 확보

## Rollback / Cleanup

실패 또는 완료 후 정리 필수:

```bash
# 1. tmux 세션 종료
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null

# 2. 테스트 디렉토리 정리
rm -rf "$TEST_DIR"

# 3. agent-browser 닫기 (optional, 브라우저 데몬 종료)
agent-browser close 2>/dev/null

# 4. 스크린샷은 디버깅용으로 유지 (수동 삭제)
ls -la "$SCREENSHOT_DIR"
```

## 주의사항

- **프로덕션 데이터 오염 금지** — 테스트는 반드시 `/tmp/cc-live-test-*` 등 별도 디렉토리에서 수행 (실 프로젝트 `.claude/projects/` 스캔 방지 X, 하지만 컨텍스트 분리는 됨)
- **tmux 세션 이름 고유성** — timestamp 포함 (`live-test-$(date +%s)`)
- **sleep 시간은 환경별 조정** — LLM 응답 속도 따라 Step 3의 `sleep 15` 조정
- **병렬 실행 금지** — 여러 테스트 동시 실행 시 대시보드에 겹쳐 보임
- **CI 통합 전 수동 검증** — 각 단계 sleep timing이 환경-민감 (macOS/Linux, 네트워크)

## Related

- **Skills**: `~/.claude/commands/browser.md` (agent-browser 사용법)
- **E2E infrastructure**: `server/e2e/` (Playwright 기반 대안)
- **Deploy workflow**: `.omc/workflows/deploy-dashboard.md` (배포 후 이 테스트 실행 권장)
- **Known failures**: `.omc/knowledge/known-failures.md`
