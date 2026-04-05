# Workflow: Deploy Session Dashboard

**Status:** Active
**Date:** 2026-04-05
**Frequency:** 매 배포 (agent 또는 server 변경 후)

---

## Trigger

**언제 이 workflow를 실행하는가**:
- `agent/src/` 또는 `server/` 코드가 변경되어 원격에 반영해야 할 때
- `/deploy-dashboard` 커맨드 호출 시

## Preconditions

- [ ] 로컬 변경사항이 테스트 통과
- [ ] `git status` clean하거나 커밋 준비됨
- [ ] SSH 접근 가능: `192.168.0.2`
- [ ] MacBook local 포트 3098 사용 가능

## 배포 대상

| 컴포넌트 | 위치 | 포트 | 실행 방식 | 환경변수 |
|---------|------|------|----------|---------|
| MacBook Agent | 192.168.0.63 (로컬) | 3098 | `npx tsx src/index.ts` (nohup) | `HOST=0.0.0.0 SOURCE=both` |
| Workstation Agent | 192.168.0.2 (SSH) | 3098 | `npx tsx src/index.ts` (nohup) | `HOST=0.0.0.0` |
| Dashboard Server | 192.168.0.2 (SSH) | 3097 | Docker Compose | `HOST=0.0.0.0` (docker-compose.yml) |

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

### Step 2: MacBook Agent 재시작 (agent 변경 시만)

```bash
# LISTEN 소켓만 종료 (클라이언트 연결 보존 — Claude Code 세션 유지)
lsof -i :3098 -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null

cd agent
HOST=0.0.0.0 SOURCE=both nohup npx tsx src/index.ts > /tmp/agent-macbook.log 2>&1 &

sleep 3 && curl -s http://localhost:3098/health
```

> ⚠️ **주의**: `pkill` / `kill -9` 금지 — Claude Code 프로세스까지 영향을 줄 수 있음.
> ⚠️ **주의**: `HOST=0.0.0.0` 누락 → 127.0.0.1에만 바인딩 → 원격 연결 불가.
> ⚠️ **주의**: `SOURCE=both` 누락 → `/api/claude/sessions` 404.

**예상 결과**: `{"status":"ok",...}` 응답
**실패시**: `/tmp/agent-macbook.log` 확인

### Step 3: Workstation Agent 재시작 (agent 변경 시만)

```bash
# 변경 파일만 복사
scp agent/src/<changed-files> 192.168.0.2:~/project/session-dashboard/agent/src/

# 재시작 (nvm v22 로드를 위해 bash -lc 필수)
ssh 192.168.0.2 "bash -lc 'fuser -k 3098/tcp 2>/dev/null; sleep 2; HOST=0.0.0.0 nohup bash -lc \"cd ~/project/session-dashboard/agent && npx tsx src/index.ts\" > /tmp/agent.log 2>&1 &'"

sleep 5 && ssh 192.168.0.2 "curl -s http://127.0.0.1:3098/health"
```

> ⚠️ **주의**: 워크스테이션 Node 기본은 v18 (동작 안 함) — `bash -lc`로 감싸야 v22 로드.

**예상 결과**: `{"status":"ok",...}`
**실패시**: `ssh 192.168.0.2 "tail /tmp/agent.log"`

### Step 4: Dashboard Server Docker 재빌드

```bash
ssh 192.168.0.2 "cd ~/project/session-dashboard/server && git pull && docker compose up -d --build"
```

**예상 결과**: Docker 컨테이너 재시작, 새 이미지 빌드 완료
**실패시**: 빌드 로그 확인 (테스트 실패시 중단됨 — Dockerfile에 `npm test` 포함)

### Step 5: 전체 헬스체크

```bash
curl -s http://localhost:3098/health
ssh 192.168.0.2 "curl -s http://127.0.0.1:3098/health"
ssh 192.168.0.2 "curl -s http://127.0.0.1:3097/health"
```

**예상 응답**:
```json
{"status":"ok","uptime":...,"connectedMachines":2,"totalMachines":2}
```

## Verification

- [ ] MacBook agent `/health` 200 OK
- [ ] Workstation agent `/health` 200 OK
- [ ] Dashboard `/health` 200 OK, `connectedMachines:2`
- [ ] 브라우저에서 http://192.168.0.2:3097 접속 시 세션 목록 정상 표시

## Rollback

1. `git revert <commit>` 후 `git push`
2. 동일한 배포 절차 재실행 (Step 2~4)
3. 또는 Docker 이전 이미지로: `ssh 192.168.0.2 "cd ~/project/session-dashboard/server && git reset --hard HEAD~1 && docker compose up -d --build"`

## Related

- **Config**: `server/machines.yml` (git 미포함, 192.168.0.2 로컬)
- **Claude Hook**: `~/.claude/settings.json` → `"url": "http://localhost:3098/hooks/event"` (포트 **3098**)
- **Logs**: MacBook `/tmp/agent-macbook.log`, Workstation `/tmp/agent.log`
- **Skill**: `~/.claude/commands/deploy-dashboard.md` (동일 절차를 스킬로 호출 가능)
