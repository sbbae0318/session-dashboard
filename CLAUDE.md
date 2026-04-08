# Session Dashboard — Claude/Agent Guide

## Architecture

```
session-dashboard/
├── agent/           # 머신별 데이터 수집 에이전트 (Fastify, port 3098)
├── server/          # 중앙 대시보드 서버 (Fastify + Svelte 5 SPA, port 3097)
│   ├── src/         # 백엔드 소스
│   │   └── shared/  # 백엔드-프론트엔드 공유 타입 (api-contract.ts)
│   └── frontend/    # Svelte 5 프론트엔드
├── tui/             # 터미널 UI (Bun + Ink)
└── install/         # 설치/관리 스크립트
```

## API Contract (백엔드 ↔ 프론트엔드)

**정의 파일**: `server/src/shared/api-contract.ts` — 단일 진실 원천(Single Source of Truth).

### 사용 규칙

1. 타입 추가/변경 시 `api-contract.ts`를 먼저 수정
2. 백엔드(`server/src/`)에서 `import type { ... } from './shared/api-contract.js'`로 참조
3. 프론트엔드(`server/frontend/src/types.ts`)에서 re-export하여 사용
4. 타입 변경 시 양쪽 빌드가 깨지므로 **호환성 파손이 즉시 감지**됨

### REST Endpoints

| Endpoint | Method | Response Type | 설명 |
|----------|--------|---------------|------|
| `/health` | GET | `HealthResponse` | 서버 상태 |
| `/api/sessions` | GET | `SessionsResponse` | 활성 세션 목록 |
| `/api/queries` | GET | `QueriesResponse` | 최근 프롬프트 (`?sessionId=X` 세션별 조회) |
| `/api/machines` | GET | `MachinesResponse` | 머신 연결 상태 |
| `/api/search` | POST | `SearchResponse` | 프롬프트 검색 |
| `/api/enrichment` | GET | (enrichment 전용) | enrichment 캐시 |
| `/api/memos` | GET | (memo 전용) | 메모 목록 |
| `/api/events` | GET | SSE stream | 실시간 이벤트 |

### SSE Events (`/api/events`)

| Event | Data Type | 트리거 |
|-------|-----------|--------|
| `session.update` | `DashboardSession[]` | 2초마다 폴링 |
| `query.new` | `QueryEntry` | 새 프롬프트 감지 |
| `machine.status` | `MachineInfo[]` | 머신 연결 변경 |
| `enrichment.updated` | `{ machineId, feature, cachedAt }` | enrichment 갱신 |

### 핵심 타입

```typescript
// 세션 상태 결정 (프론트엔드)
// WORKING: (apiStatus === 'busy'|'retry' || currentTool) AND !waitingForInput
// WAITING: waitingForInput === true
// IDLE: 그 외
```

- `DashboardSession.source`: `'opencode' | 'claude-code'` — 필수
- `DashboardSession.waitingForInput`: `boolean` — 필수 (항상 반환)
- `DashboardSession.hooksActive`: `boolean | undefined` — Claude 전용, OpenCode에는 없음

## Data Flow

```
Claude Code hooks / oc-serve SSE
        ↓
   Agent (per machine)
   - ClaudeHeartbeat: JSONL 파싱 + hooks 이벤트
   - SessionCache: oc-serve SSE 구독
        ↓  GET /proxy/sessions-all, /api/claude/sessions
   Server (MachineManager)
   - 2초 폴링으로 전체 머신 수집
   - ActiveSessionsModule: DashboardSession 변환
        ↓  GET /api/sessions, SSE session.update
   Frontend (Svelte 5)
   - sessions.svelte.ts → ActiveSessions.svelte
```

## 테스트 구조

```
agent/src/__tests__/      # 에이전트 유닛 테스트 (vitest)
server/src/__tests__/     # 서버 유닛 테스트 (vitest)
server/e2e/
  ├── api/                # 백엔드 API 계약 검증 (Playwright request)
  └── ui/                 # 프론트엔드 동작 검증 (Playwright page)
```

**분리 원칙**:
- **API 테스트**: HTTP 요청만. 응답 스키마/상태코드/필드 검증. 브라우저 불필요.
- **UI 테스트**: 브라우저 렌더링. 필터 클릭/상태 뱃지/네비게이션 검증.
- **유닛 테스트**: 개별 모듈 로직 (polling, caching, JSONL parsing 등).

## 빌드 & 실행

```bash
# 에이전트
cd agent && npm run build && bash ../install/agent.sh --restart

# 서버 프론트엔드
cd server/frontend && npm run build

# 서버 백엔드
cd server && npm run build

# 개발 모드 (tsx hot-reload)
cd server && npm run dev
cd agent && npm run dev
```

## 표준 포트 & 환경변수

| 서비스 | 포트 | 바인딩 | 필수 환경변수 |
|--------|------|--------|---------------|
| Agent | 3098 | `HOST=0.0.0.0` | MacBook: `SOURCE=both` |
| Dashboard | 3097 | `HOST=0.0.0.0` | Docker로 실행 (192.168.0.2) |
| oc-serve | 4096 | 127.0.0.1 | opencode 내장 (변경 불가) |

**Claude Hook**: `~/.claude/settings.json`에서 URL은 **포트 3098** 사용:
```json
"url": "http://localhost:3098/hooks/event"
```

## 주의사항 (필수 규칙)

- ⚠️ **Agent 재배포 시 `pkill` / `kill -9` 금지** — 현재 작업 중인 Claude Code 프로세스에 영향. `lsof -i :3098 -sTCP:LISTEN -t` 로 LISTEN 소켓만 종료할 것.
- Agent `.env`에 `HOST=0.0.0.0` 설정 필요 (외부 접근 허용 시). 빠뜨리면 127.0.0.1에만 바인딩.
- MacBook agent는 `SOURCE=both` 필수 (누락시 `/api/claude/sessions` 404).
- 서버는 Docker에서 실행 — 프론트엔드 변경 후 빌드+배포 필요.
- Workstation(`192.168.0.2`)은 nvm v22 사용 — ssh 실행 시 `bash -lc`로 감싸야 Node가 로드됨.
- `api-contract.ts`의 optional 필드(`?`)는 백엔드 조건부 포함 / 필수 필드는 **항상 반환 보장**.
- Docker 빌드에 `npm test` 포함 — 테스트 실패 시 빌드 중단.
- `machines.yml`, `.env`는 192.168.0.2 서버 로컬에만 존재 (git 미포함).

## Commands

### 배포 (Deploy)

- `/deploy-dashboard` — 전체 배포 스킬 (agent 빌드+재시작 → git push → SSH docker rebuild → 헬스체크)
- 상세 절차 및 롤백: `.omc/workflows/deploy-dashboard.md`

## CC Infrastructure (Agent Protocol)

이 프로젝트는 `.omc/` 거버넌스 시스템을 사용한다.
세부 규칙: `.omc/GOVERNANCE.md` 참조.

### 에이전트 행동 규칙 (필수)

다음 Triggers 감지 시 **즉시** 사용자에게 기록 제안:

| Trigger | 자동 Action | Draft 추출 |
|---------|-----------|----------|
| 버그 수정 후 테스트 통과 | /cc-new-failure 제안 | 증상/원인/수정/심각도/파일 |
| "A vs B", "~할까" 결정 대화 | /cc-new-adr 제안 | Context/Options/Decision |
| 같은 파일 2+회 편집 | /cc-new-domain 제안 | 파일/패턴/함수 |
| "Phase 시작" 선언 | /cc-new-ac 제안 | Verify/Done criteria |
| "매번 이렇게" 반복 패턴 | /cc-new-workflow 제안 | Trigger/Steps/Rollback |
| drift-check 새 위반 | /cc-new-failure 제안 | P 원칙/파일:라인 |

### Interaction (BMAD HALT/WAIT)

1. Trigger 감지 → draft 자동 생성
2. 사용자에게 구조화 블록 제시
3. **HALT AND WAIT** 사용자 입력 대기
4. Y: 커맨드 자동 실행 / n: 무시 / edit: 수정 후 실행

### 제시 포맷

```
🎯 감지: [Trigger 이름]
📝 제안: [Action 명]
📋 Draft:
  - Field 1: [자동 추출]
  - Field 2: [자동 추출]
기록할까요? [Y/n/edit]
```

### 사용자 수동 호출 커맨드 (4개만)

- `/cc-start` — 세션 시작, status 로드
- `/cc-end` — 세션 종료, 일괄 회고
- `/cc-drift` — 정합성 검증
- `/cc-scaffold` — 프로젝트 초기화 (1회)

나머지 `/cc-new-*` 는 에이전트가 Agent Protocol로 자동 호출.
