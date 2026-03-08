# Session Dashboard

[English](README.md) | **한국어**

OpenCode 및 Claude Code를 위한 멀티 머신 세션 모니터링 대시보드.

## 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                   클라이언트 (브라우저 / TUI)                │
│                                                         │
│  Svelte SPA (:3097)          Terminal UI (Ink/React)    │
│       │                            │                    │
│       └────── SSE /api/events ─────┘                    │
│               + REST API 폴링                            │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │   Dashboard Server        │
         │   (Docker, Fastify :3097) │
         │                           │
         │  ┌─ ActiveSessions ────┐  │
         │  ├─ SessionCards ──────┤  │  ← 백엔드 모듈 (2초 간격 폴링)
         │  └─ RecentPrompts ─────┘  │
         │                           │
         └─────┬──────────┬──────────┘
               │          │
      HTTP 폴링 │          │ HTTP 폴링
    (Bearer 인증) │          │ (Bearer 인증)
               │          │
        ┌──────┴──┐  ┌────┴─────┐
        │ Agent A │  │ Agent B  │    ← 각 머신에 하나씩 실행
        │ (:3098) │  │ (:3098)  │
        └────┬────┘  └────┬─────┘
             │             │
     ┌───────┴───────┐    │
     │               │    │
  OpenCode        Claude Code
  ├─ cards.jsonl     └─ history.jsonl
  ├─ queries.jsonl
  └─ oc-serve (:4096)
     ├─ REST API 프록시
     └─ SSE 이벤트 구독
```

**Server**는 각 **Agent**를 주기적으로 폴링하여 세션 데이터를 수집하고, 통합된 웹 UI를 제공합니다.
**Agent**는 각 머신에서 실행되며, 로컬 세션 히스토리를 인증된 HTTP API로 노출합니다.
**TUI**는 터미널에서 대시보드 서버에 접속하여 세션 정보를 실시간으로 표시합니다.

### 주요 데이터 흐름

1. **Server → Agent**: 2초 간격으로 HTTP 폴링 (Bearer 토큰 인증)
2. **Agent → OpenCode**: `cards.jsonl`, `queries.jsonl` 파일 읽기 + oc-serve REST/SSE 프록시
3. **Agent → Claude Code**: `history.jsonl` 파일 읽기
4. **Server → Client**: SSE(`/api/events`)로 실시간 업데이트 스트리밍
5. **Agent 내부 캐시**: oc-serve SSE 구독 → SQLite 캐시로 세션 상태 저장

## 사전 요구사항

| 컴포넌트 | 요구사항 |
|---------|---------|
| Node.js | 18+ |
| npm | (Node.js 번들) |
| Docker | 서버 전용 (Agent는 불필요) |
| Bun | TUI 전용 (선택) |

## 빠른 시작

### 옵션 A: 통합 설치 (권장)

```bash
./install/install.sh
```

설치 스크립트가 데이터 소스(`~/.opencode/history` 또는 `~/.claude/projects`)를 자동 감지하고,
API 키를 생성하며, `agent/.env`와 `server/machines.yml`을 설정한 후 Agent와 Server를
한 번에 설치합니다. 재실행 시 기존 API 키는 유지됩니다.

```bash
./install/install.sh --agent-only    # Agent만 설치 (Docker 서버 제외)
./install/install.sh --server-only   # Server만 설치 (Agent 제외)
./install/install.sh --dry-run       # 감지 결과만 미리 보기, 변경 없음
```

설치 후 접속: `http://localhost:3097`

원격 머신은 `server/machines.yml`을 수동으로 편집하여 Agent를 추가하세요.

### 옵션 B: 수동 설치

[고급 설정](#고급-설정) 참조.

## 저장소 구조

```
session-dashboard/
├── server/          # 대시보드 웹 서버 (Docker, Svelte 5 + Fastify)
├── agent/           # 데이터 수집 에이전트 (Fastify + SQLite)
├── tui/             # 터미널 UI 클라이언트 (Bun, Ink 5 + React)
├── install/
│   ├── install.sh   # 통합 설치 스크립트 (자동 감지 + 설정 + 설치)
│   ├── server.sh    # 서버 설치/관리 (Docker Compose)
│   └── agent.sh     # Agent 설치/관리 (nohup)
├── docs/            # 아키텍처 및 운영 문서
└── README.md
```

## 설정

### machines.yml

`server/machines.yml`에 각 Agent를 등록합니다:

```yaml
machines:
  - id: macbook
    alias: MacBook Pro
    host: 192.168.0.63        # Agent의 IP 또는 호스트명
    port: 3101                # Agent의 PORT
    apiKey: your-key          # Agent의 API_KEY와 동일해야 함
    source: both              # opencode | claude-code | both
```

> **참고**: 같은 호스트에서 Docker로 서버를 실행하는 경우, `host`를 `host.docker.internal`로 설정하세요.

### Agent .env

| 변수 | 기본값 | 설명 |
|------|-------|------|
| `PORT` | `3098` | Agent HTTP 포트 |
| `API_KEY` | (필수) | Bearer 인증용 공유 시크릿 |
| `OC_SERVE_PORT` | `4096` | 로컬 oc-serve 포트 |
| `HISTORY_DIR` | `~/.opencode/history` | OpenCode 히스토리 경로 |
| `CLAUDE_HISTORY_DIR` | `~/.claude` | Claude Code 히스토리 경로 |
| `SOURCE` | `opencode` | 데이터 소스: `opencode` \| `claude-code` \| `both` |

### Server .env

| 변수 | 기본값 | 설명 |
|------|-------|------|
| `DASHBOARD_PORT` | `3097` | 대시보드 웹 UI 포트 |
| `MACHINES_CONFIG` | `/app/machines.yml` | machines 설정 파일 경로 (Docker 내부) |

## 관리

### Server

```bash
./install/server.sh              # 설치 (빌드 + 시작)
./install/server.sh --status     # 상태 확인
./install/server.sh --test       # 헬스 체크 + 머신 연결 테스트
./install/server.sh --start      # 컨테이너 시작
./install/server.sh --logs       # 로그 보기
./install/server.sh --restart    # 재시작
./install/server.sh --stop       # 중지
./install/server.sh --uninstall  # 제거
```

### Agent

```bash
./install/agent.sh               # 설치 (npm install + 빌드 + 시작)
./install/agent.sh --status      # 상태 확인
./install/agent.sh --start       # Agent 시작
./install/agent.sh --logs        # 로그 정보
./install/agent.sh --restart     # 재시작
./install/agent.sh --stop        # 중지
./install/agent.sh --uninstall   # 제거
```

## 고급 설정

컴포넌트별 수동 설정 (저장소 루트에서 실행):

### Agent (각 머신에서)

```bash
cp agent/.env.example agent/.env
# agent/.env 편집: API_KEY, SOURCE, HISTORY_DIR 설정

./install/agent.sh
```

### Server (모니터링 호스트에서)

```bash
cp server/.env.example server/.env
cp server/machines.yml.example server/machines.yml
# server/machines.yml 편집: 머신 구성

./install/server.sh
```

## 개발

### Server

```bash
cd server
npm install
npm run dev     # 백엔드 개발 모드
cd frontend && npm run dev   # 프론트엔드 개발 모드 (Vite)
npm test        # 테스트 실행
```

### Agent

```bash
cd agent
npm install
npm run dev     # 개발 모드 (tsx watch)
npm test        # 테스트 실행
```

### TUI

```bash
cd tui
bun install
bun run src/index.tsx -- --url http://localhost:3097
bun test
```

## Docker 참고사항

서버는 Docker에서 실행됩니다. Linux(네이티브 Docker)에서는 컨테이너가 호스트 네트워크에
직접 접근할 수 있습니다. `docker-compose.yml`에 `extra_hosts`로 `host.docker.internal`이
설정되어 있어, 같은 호스트에서 실행 중인 Agent에도 접근할 수 있습니다.

원격 머신의 Agent는 `machines.yml`에 LAN IP를 직접 입력하세요.

## 라이선스

Private repository.
