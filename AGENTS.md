# Session Dashboard — Agent Guide

## Architecture

```
session-dashboard/
├── agent/           # 머신별 데이터 수집 에이전트 (Fastify, port 3098/3101)
├── server/          # 중앙 대시보드 서버 (Fastify + Svelte 5 SPA, port 3097)
│   ├── src/         # 백엔드 소스
│   │   └── shared/  # 백엔드-프론트엔드 공유 타입 (api-contract.ts)
│   └── frontend/    # Svelte 5 프론트엔드
├── tui/             # 터미널 UI (Bun + Ink)
└── install/         # 설치/관리 스크립트
```

## API Contract (백엔드 ↔ 프론트엔드)

**정의 파일**: `server/src/shared/api-contract.ts`

이 파일이 백엔드와 프론트엔드 간 데이터 교환의 **단일 진실 원천(Single Source of Truth)**입니다.

### 사용 규칙

1. **타입 추가/변경 시** `api-contract.ts`를 먼저 수정
2. **백엔드** (`server/src/`)에서 `import type { ... } from './shared/api-contract.js'`로 참조
3. **프론트엔드** (`server/frontend/src/types.ts`)에서 re-export하여 사용
4. 타입 변경 시 양쪽 빌드가 깨지므로 **호환성 파손이 즉시 감지**됨

### REST Endpoints

| Endpoint | Method | Response Type | 설명 |
|----------|--------|---------------|------|
| `/health` | GET | `HealthResponse` | 서버 상태 |
| `/api/sessions` | GET | `SessionsResponse` | 활성 세션 목록 |
| `/api/queries` | GET | `QueriesResponse` | 최근 프롬프트 |
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
agent/src/__tests__/      # 에이전트 유닛 테스트 (vitest, 328 tests)
server/src/__tests__/     # 서버 유닛 테스트 (vitest, 285 tests)
server/e2e/
  ├── api/                # 백엔드 API 계약 검증 (Playwright request)
  └── ui/                 # 프론트엔드 동작 검증 (Playwright page)
```

### 테스트 분리 원칙

- **API 테스트**: HTTP 요청만. 응답 스키마, 상태코드, 필드 존재 검증. 브라우저 불필요.
- **UI 테스트**: 브라우저 렌더링. 필터 클릭, 상태 뱃지, 네비게이션 검증.
- **유닛 테스트**: 개별 모듈 로직 (polling, caching, JSONL parsing 등).

## 빌드 & 실행

```bash
# 에이전트
cd agent && npm run build && bash ../install/agent.sh --restart

# 서버 프론트엔드
cd server/frontend && npm run build

# 서버 백엔드
cd server && npm run build

# 개발 모드
cd server && npm run dev      # 서버 (tsx hot-reload)
cd agent && npm run dev       # 에이전트 (tsx hot-reload)
```

## 주의사항

- Agent `.env`에 `HOST=0.0.0.0` 설정 필요 (외부 접근 허용 시)
- 서버는 Docker에서 실행 — 프론트엔드 변경 후 빌드+배포 필요
- `api-contract.ts`의 optional 필드(`?`)는 백엔드가 조건부로 포함하는 필드
- `api-contract.ts`의 필수 필드는 백엔드가 **항상 반환을 보장**
