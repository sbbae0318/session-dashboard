---
name: deploy-workflow
description: |
  session-dashboard 프로젝트의 필수 배포 워크플로우. 모든 버그 수정 및 기능 추가는
  반드시 테스트 장비(192.168.0.63:3097) 검증 후 운영 장비(192.168.0.2:3097)에 반영해야 한다.
  Triggers: commit, deploy, 배포, 반영, 운영, release, ship, merge to main,
  "테스트 서버", "운영 서버", PR 생성, 기능 완료 선언 시 자동 활성화.
---

# Deploy Workflow: 테스트 → 운영

모든 변경사항은 **테스트 장비 검증 → 운영 장비 반영** 순서를 따른다.

## 환경 정보

| 환경 | 호스트 | 대시보드 URL | 용도 |
|------|--------|-------------|------|
| **테스트** | 192.168.0.63 | http://192.168.0.63:3097 | 개발/검증 (MacBook) |
| **운영** | 192.168.0.2 | http://192.168.0.2:3097 | 프로덕션 (Workstation) |

## 워크플로우 개요

```
코드 변경 → 로컬 테스트 → 테스트 장비 빌드/배포 → 테스트 장비 검증 → git push → 운영 장비 배포 → 운영 장비 검증
```

## Phase 1: 로컬 테스트

변경된 컴포넌트에 맞춰 테스트를 실행한다.

### server 변경 시

```bash
cd server
npm test                    # vitest 유닛 테스트
npm run typecheck           # TypeScript 타입 체크
```

### agent 변경 시

```bash
cd agent
npm test                    # vitest 유닛 테스트
```

### 둘 다 변경 시 (병렬 실행)

```bash
(cd server && npm test) & (cd agent && npm test) & wait
```

**게이트**: 유닛 테스트 전체 통과 필수. 실패 시 다음 단계 진행 금지.

## Phase 2: 테스트 장비 빌드 및 배포 (192.168.0.63)

### server 배포 (Docker)

```bash
cd server
docker compose up -d --build
```

> Dockerfile Stage 2에서 `npm test`가 빌드 게이트로 실행됨. 테스트 실패 시 빌드 자체가 실패한다.

### agent 배포

```bash
./install/agent.sh --restart
# 또는 수동:
cd agent && npm run build && npm start
```

### 헬스 체크

```bash
# server 헬스
curl -sf http://192.168.0.63:3097/health

# agent 헬스
curl -sf http://192.168.0.63:3101/health
```

## Phase 3: 테스트 장비 검증 (192.168.0.63:3097)

### 3-1. E2E 테스트

```bash
cd server
npm run test:e2e                # 전체 Playwright E2E
npm run test:claude-e2e         # Claude Code 리그레션
npm run test:opencode-e2e       # OpenCode 리그레션
```

### 3-2. 수동 브라우저 검증

http://192.168.0.63:3097 접속 후 확인:

- [ ] 대시보드 로드 정상
- [ ] 세션 목록 표시
- [ ] 세션 상태 배지 (Working/Waiting/Done 등)
- [ ] 변경된 기능 정상 동작
- [ ] 콘솔 에러 없음

상세 체크리스트: [references/checklist.md](references/checklist.md)

**게이트**: E2E 테스트 통과 + 수동 검증 완료 필수. 실패 시 운영 배포 금지.

## Phase 4: Git Push

```bash
git add -A
git commit -m "feat/fix: 변경사항 설명"
git push origin <branch>
```

> main 브랜치 직접 push 대신 feature branch + PR 권장.

## Phase 5: 운영 장비 배포 (192.168.0.2)

### 5-1. 운영 서버 접속

```bash
ssh sbbae@192.168.0.2
cd /home/sbbae/project/session-dashboard
```

### 5-2. 코드 업데이트

```bash
git pull origin <branch>
```

### 5-3. server 배포

```bash
cd server
docker compose up -d --build
```

### 5-4. agent 배포 (변경 시)

```bash
./install/agent.sh --restart
```

### 5-5. 헬스 체크

```bash
curl -sf http://192.168.0.2:3097/health
curl -sf http://localhost:3098/health   # agent (운영 서버 로컬)
```

## Phase 6: 운영 장비 검증 (192.168.0.2:3097)

http://192.168.0.2:3097 접속 후 확인:

- [ ] 대시보드 로드 정상
- [ ] 테스트 장비에서 확인한 기능 동일 동작
- [ ] 세션 데이터 정상 수집

상세 체크리스트: [references/checklist.md](references/checklist.md)

## 롤백

운영 배포 후 문제 발견 시:

```bash
# 운영 서버에서
git log --oneline -5              # 이전 커밋 확인
git checkout <이전-커밋-해시>
docker compose up -d --build      # 이전 버전으로 재빌드
./install/agent.sh --restart      # agent도 롤백 필요 시
```

## 금지 사항

- 테스트 장비 검증 없이 운영 배포 **절대 금지**
- 유닛 테스트 실패 상태에서 배포 진행 금지
- E2E 테스트 스킵 금지 (변경 범위와 무관하게 전체 실행)
- 운영 서버에서 직접 코드 수정 금지 (반드시 git을 통해)
