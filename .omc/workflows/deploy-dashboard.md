# Workflow: Deploy Session Dashboard

**Status:** Active
**Date:** 2026-04-09
**Frequency:** 매 배포 (agent 또는 server 변경 후)

---

## Trigger

**언제 이 workflow를 실행하는가**:
- `agent/src/`, `agent/python/`, 또는 `server/` 코드가 변경되어 원격에 반영해야 할 때
- `/deploy-dashboard` 커맨드 호출 시

## Preconditions

- [ ] 로컬 변경사항이 테스트 통과
- [ ] `git status` clean하거나 커밋 준비됨
- [ ] SSH 접근 가능: `192.168.0.2`
- [ ] MacBook local 포트 3098 사용 가능

## 표준 포트 & 설정

| 컴포넌트 | 호스트 | 포트 | 실행 방식 | 필수 환경변수 |
|---------|--------|------|----------|-------------|
| MacBook Agent | 192.168.0.63 (로컬) | **3098** | `install/agent.sh --restart` | `.env`: `HOST=0.0.0.0 SOURCE=both PORT=3098` |
| Workstation Agent | 192.168.0.2 (SSH) | **3098** | `install/agent.sh --restart` | `.env`: `HOST=0.0.0.0 PORT=3098` |
| Dashboard Server | 192.168.0.2 (Docker) | **3097** | Docker Compose | `HOST=0.0.0.0` (docker-compose.yml) |
| oc-serve | 각 머신 로컬 | **4096** | opencode 내장 (변경 불가) | — |
| Claude Hook | MacBook 로컬 | **3098** | `~/.claude/settings.json` | `"url": "http://localhost:3098/hooks/event"` |

> **포트 동기화 필수**: `agent/.env`의 `PORT`는 production `server/machines.yml`의 port와 반드시 일치해야 함.
> machines.yml 위치: `192.168.0.2:/home/sbbae/project/session-dashboard/server/machines.yml` (git 미포함)

### machines.yml 참조

```yaml
machines:
  - id: macbook
    alias: MacBook Pro
    host: 192.168.0.63
    port: 3098
    apiKey: test-local-key
    source: both
  - id: workstation-local
    alias: Workstation
    host: host.docker.internal
    port: 3098
    apiKey: <workstation-key>
    source: opencode
```

## Steps

### Step 1: 로컬 변경사항 확인 & 푸시

```bash
git status
git diff --stat
git add <files>
git commit -m "feat(...): ..."
git push
```
**예상 결과**: `main` 브랜치가 원격과 동기화됨
**실패시**: 커밋 메시지 재작성, 충돌 해결

### Step 2: MacBook Agent 빌드 & 재시작 (agent 변경 시만)

```bash
cd agent
npm run build                        # tsc 컴파일 (dist/ 생성)

# LISTEN 소켓만 종료 후 agent.sh로 재시작
lsof -i :3098 -sTCP:LISTEN -t | xargs kill 2>/dev/null
bash ../install/agent.sh --restart

# 검증
curl -s http://localhost:3098/health
```

> **주의사항**:
> - `pkill` / `kill -9` 금지 — Claude Code 프로세스에 영향.
> - `HOST=0.0.0.0` 누락 → 127.0.0.1에만 바인딩 → 원격 연결 불가.
> - `SOURCE=both` 누락 → `/api/claude/sessions` 404.
> - `.env`의 `PORT=3098` 확인 — 다른 포트면 production 서버에서 연결 불가.

**예상 결과**: `{"status":"ok","claudeSourceConnected":true,...}`
**실패시**: `install/agent.sh --logs` 또는 dev 모드 `npm run dev`로 확인

### Step 3: Workstation Agent 재시작 (agent 변경 시만)

```bash
# git pull로 변경 반영
ssh 192.168.0.2 "bash -lc 'cd ~/project/session-dashboard && git pull'"

# 빌드 & 재시작
ssh 192.168.0.2 "bash -lc 'cd ~/project/session-dashboard/agent && npm run build && bash ../install/agent.sh --restart'"

# 검증
sleep 5 && ssh 192.168.0.2 "curl -s http://127.0.0.1:3098/health"
```

> **주의**: 워크스테이션 nvm v22 필요 — `bash -lc`로 감싸야 Node 로드됨.

**예상 결과**: `{"status":"ok",...}`
**실패시**: `ssh 192.168.0.2 "bash -lc 'cd ~/project/session-dashboard/agent && npm run dev'"` 로 로그 확인

### Step 4: Dashboard Server Docker 재빌드

```bash
ssh 192.168.0.2 "bash -lc 'cd ~/project/session-dashboard && git pull && cd server && docker compose up -d --build'"
```

**예상 결과**: Docker 컨테이너 재시작, 새 이미지 빌드 완료
**실패시**: 빌드 로그 확인 (Dockerfile에 `npm test` 포함 — 테스트 실패 시 중단)

### Step 5: 전체 헬스체크

```bash
curl -s http://localhost:3098/health                                    # MacBook agent
ssh 192.168.0.2 "curl -s http://127.0.0.1:3098/health"                # Workstation agent
ssh 192.168.0.2 "curl -s http://127.0.0.1:3097/health"                # Dashboard server
curl -s http://192.168.0.2:3097/api/machines                           # 머신 연결 확인
```

**예상 응답**:
- agent health: `{"status":"ok",...}`
- python health: `{"status":"ok","model":"anthropic/claude-haiku-4-5-20251001",...}`
- machines: 2개 모두 `"status":"connected"`

## Verification

- [ ] MacBook agent `/health` 200 OK, `claudeSourceConnected: true`

- [ ] Workstation agent `/health` 200 OK
- [ ] Dashboard `/health` 200 OK
- [ ] `/api/machines` — 2개 connected
- [ ] 브라우저에서 http://192.168.0.2:3097 접속 시 세션 목록 정상 표시

## Rollback

1. `git revert <commit>` 후 `git push`
2. 동일한 배포 절차 재실행 (Step 2~4)
3. 또는 Docker 이전 이미지로: `ssh 192.168.0.2 "cd ~/project/session-dashboard/server && git reset --hard HEAD~1 && docker compose up -d --build"`

## Related

- **Config**: `server/machines.yml` (git 미포함, 192.168.0.2 로컬)
- **Claude Hook**: `~/.claude/settings.json` → `"url": "http://localhost:3098/hooks/event"`
- **Agent .env**: `agent/.env` (git 미포함) — `PORT`, `HOST`, `SOURCE`, `API_KEY`
- **Python venv**: `agent/python/.venv/` (git 미포함) — `pip install -e .`로 설치. Node agent가 spawn으로 호출.
- **ADR-008**: Python DSPy 요약 아키텍처 결정
- **Skill**: `/deploy-dashboard` (동일 절차를 스킬로 호출 가능)
