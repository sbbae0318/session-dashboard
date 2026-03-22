# Task 1 진단 요약 — MacBook Agent Timeline 문제

**진단 일시**: 2026-03-15  
**진단 결과**: **Case B 변형** — 연결 OK + 데이터 있음 + **NaN 버그로 빈 배열 반환**

---

## 증상
- 사용자가 "MacBook Pro" 선택 시 "타임라인 데이터 없음" 표시
- `timelineAvailable=true` + `data=[]`

---

## 진단 결과

### ✅ 연결 상태: 정상
- MacBook agent (192.168.0.63:3098) 정상 동작
- 서버(192.168.0.2)에서 직접 연결: HTTP 200
- Docker 컨테이너에서 연결: HTTP 200
- machines.yml 설정 올바름 (port: 3098)

### ✅ 데이터 존재: 795개 세션
- opencode.db: `/Users/sbbae/.local/share/opencode/opencode.db`
- 총 세션 수: 795개
- `from=0&to=<now>` 파라미터로 요청 시 795개 정상 반환

### ❌ 근본 원인: NaN 버그 (agent `server.ts`)

**버그 위치**: `agent/src/server.ts` line 360-361

```typescript
// 현재 코드 (버그 있음)
const from = parseInt(request.query.from ?? '0', 10);
const to = parseInt(request.query.to ?? String(Date.now()), 10);
```

**버그 메커니즘**:
1. 서버(`EnrichmentModule.pollFeature`)가 `/api/enrichment/timeline` 파라미터 없이 호출
2. Fastify는 query string 없을 때 `request.query.from = ''` (빈 문자열, undefined 아님)
3. `'' ?? '0'` → `''` (빈 문자열은 nullish가 아님, `??` 연산자 통과 안 됨)
4. `parseInt('', 10)` → `NaN`
5. SQLite에 NaN 전달 → `WHERE time_created >= NaN` → 0개 결과

**검증**:
```bash
# 파라미터 없이 → 빈 배열
curl http://localhost:3098/api/enrichment/timeline
# → {"data":[],"available":true}

# from=0 명시 → 795개
curl "http://localhost:3098/api/enrichment/timeline?from=0&to=<now>"
# → {"data":[...795개...],"available":true}

# NaN 직접 테스트
node -e "const db=require('better-sqlite3')('/path/opencode.db',{readonly:true}); console.log(db.prepare('SELECT COUNT(*) as c FROM session WHERE time_created >= ? AND time_created <= ?').get(NaN,NaN));"
# → { c: 0 }
```

---

## 수정 방법

### Option A: Agent 수정 (권장)
`agent/src/server.ts`에서 빈 문자열 처리 추가:

```typescript
// 수정 후
const from = parseInt(request.query.from || '0', 10);  // || 사용 (빈 문자열도 처리)
const to = parseInt(request.query.to || String(Date.now()), 10);
```

또는 더 안전하게:
```typescript
const fromRaw = request.query.from;
const toRaw = request.query.to;
const from = fromRaw ? parseInt(fromRaw, 10) : 0;
const to = toRaw ? parseInt(toRaw, 10) : Date.now();
```

### Option B: 서버 수정
`server/src/modules/enrichment/index.ts`에서 timeline 요청 시 from/to 파라미터 추가:

```typescript
// pollFeature에서 timeline 특별 처리
const url = feature === 'timeline' 
  ? `/api/enrichment/timeline?from=0&to=${Date.now()}`
  : `/api/enrichment/${feature}`;
```

---

## 추가 발견 사항

### LSP 에러 (프론트엔드 - 별도 수정 필요)
- `TimelinePage.svelte`: `timelineData`, `timelineAvailable`, `timelineLoading` export 없음
- `App.svelte`: ViewType 타입 불일치 (`'timeline'`, `'token-cost'` 등)
- `TokenCostPage.svelte`, `ContextRecoveryPage.svelte`: enrichment store export 없음
- `machine.svelte`: `onMachineChange` export 없음

이 에러들은 프론트엔드 리팩토링 중 발생한 것으로 보임 (worktree 브랜치 작업 중).

---

## 케이스 분류
**Case B 변형**: 연결 OK + 데이터 있음 + **코드 버그(NaN)로 빈 배열 반환**

원래 예상했던 Case B (데이터 없음)가 아니라, 데이터는 795개 존재하지만 NaN 버그로 인해 빈 배열이 반환되는 상황.
