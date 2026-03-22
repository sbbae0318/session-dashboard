# Draft: Enrichment Pipeline Optimization

## Requirements (confirmed)
- 서버에서 일정 주기로 집계하고 상황을 영속 저장 (재기동 시 즉시 로드)
- 프론트에서는 렌더링만 담당 (HTTP 폴링 제거)
- 영속 저장소: SQLite (사용자 선택)
- 프론트엔드 업데이트: SSE push (사용자 선택)

## Research Findings

### 현재 데이터 크기 (192.168.0.2 기준)
| Feature | Payload | Entries |
|---------|---------|---------|
| timeline | **390KB** | 1,063 |
| tokens | **386KB** | ? (sessions array) |
| impact | 33KB | ? |
| recovery | 21KB | ? |
| projects | 4.7KB | 18 |

### Timeline 시간 분포 (1,063개 중)
| Window | Entries | % |
|--------|---------|---|
| 1h | 23 | 2.2% |
| 6h | 34 | 3.2% |
| 24h | 114 | 10.7% |
| 7d | 178 | 16.7% |
| **older** | **885** | **83.3%** |

→ **기본 뷰(24h)에서 필요한 데이터는 전체의 10.7%뿐인데, 390KB 전부를 매번 전송**

### Timeline entry 구조 (~200 bytes/entry)
```json
{
  "sessionId": "ses_41b5ef9efffe2nRAg5mlcrX8LH",
  "sessionTitle": "oh_my_opencode.json 성능 최적화",
  "projectId": "global",
  "directory": "global",
  "startTime": 1769067316753,
  "endTime": 1769067378835,
  "status": "completed",
  "parentId": null,
  "machineId": "macbook",
  "machineAlias": "MacBook Pro"
}
```

### SSE 인프라 상태
- **서버**: SSEManager 존재 (`server/src/sse/event-stream.ts`), `GET /api/events` 라우트 등록됨
- **서버 broadcast**: `enrichment.update` 이벤트 발송 중 (pollFeature 완료 시)
- **프론트엔드**: SSE 미사용! EventSource 코드 없음. 순수 HTTP 폴링만 사용
- **기존 SSE는 notification용으로만 설계됨** — 데이터 payload 없이 `{ machineId, feature }` 메타데이터만 전송

### Docker 볼륨
- 현재: `machines.yml:ro`만 마운트
- SQLite DB를 위한 새 볼륨 마운트 필요

### 서버 재기동 시 동작
- `EnrichmentModule.cache` = `new Map()` → 메모리 전용, 재기동 시 완전 초기화
- 재기동 후 첫 poll까지 10-60초 동안 빈 캐시 → 프론트에서 "데이터 없음" 표시

## Technical Decisions
- 영속 저장소: SQLite (better-sqlite3, agent에서 이미 사용 중)
- 프론트엔드: SSE push로 데이터 수신, HTTP 폴링 제거
- Docker: volume mount 추가 (./data:/app/data)

## Decisions (confirmed)
- 데이터 보존 기간: **90일** (사용자 확정)
- 5개 feature 전부 최적화 (사용자 확정)
- 테스트: tests-after (사용자 확정)
- 영속 저장소: SQLite (사용자 확정)
- 프론트엔드: SSE 기반 (사용자 확정)

## Metis Findings
1. **Docker + better-sqlite3**: Alpine에서 python3/make/g++ 필요 — Docker 빌드 검증이 FIRST TASK
2. **WAL mode**: PRAGMA journal_mode=WAL, synchronous=NORMAL (캐시라서 FULL 불필요)
3. **UPSERT**: ON CONFLICT DO UPDATE 사용, INSERT OR REPLACE 금지
4. **Batch delete**: 90일 정리 시 1000건씩 배치 삭제 (WAL explosion 방지)
5. **SSE 패턴**: notification + HTTP fetch 방식 권장 (390KB SSE push 비효율)
6. **Docker 권한**: non-root user (nodejs:1001)가 /app/data/ 소유해야 함
7. **기존 테스트**: enrichment-module.test.ts가 Map 기반 캐시 테스트 → SQLite 변경 시 업데이트 필요

## SSE 접근 방식 (Metis 기반 결정)
- 사용자 선택: "SSE push"
- Metis 권고: "notification + HTTP fetch" (대용량 payload SSE 비효율)
- **타협안**: 서버에서 시간 윈도우 필터링 적용 후 SSE push
  - 24h 뷰: ~23KB (충분히 SSE로 전송 가능)
  - 7d 뷰: ~36KB (가능)
  - 전체: ~213KB (borderline)
- **실제 구현**: SSE notification → 프론트 HTTP fetch (현재 시간 윈도우 파라미터 포함)
  - 프론트는 타이머 폴링 없음 → 서버 SSE 알림 시에만 fetch
  - 서버 응답은 사전 계산 + 시간 윈도우 필터 적용 → 즉시 응답

## Scope Boundaries
- INCLUDE: Server SQLite 영속화, 시간 윈도우 필터링, merged 사전 계산, SSE 알림, Frontend SSE 구독, enrichment store 리팩터, Docker volume, Agent since 파라미터, 90일 데이터 정리
- EXCLUDE: 기존 per-machine API 제거 안 함, Timeline SVG 리렌더 최적화 아님, Agent 독립 배포 자동화 아님
