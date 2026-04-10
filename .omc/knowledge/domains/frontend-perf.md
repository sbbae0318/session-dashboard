# Domain: Frontend Performance Patterns

**Scope**: session-dashboard 프론트엔드 (Svelte 5)에서 반복 발생한 성능 문제와 해결 패턴.

---

## 안티패턴 1: `{#each}` 안에서 `array.find()`

**증상**: 큰 리스트 렌더링/필터링이 느림. 데이터 증가 시 quadratic 폭발.

**원인**: `Array.find()`는 O(n). `{#each items as item}` 안에서 호출하면 렌더링이 O(n²).

**잘못된 예**:
```svelte
{#each queries as q}
  {@const session = sessions.find(s => s.sessionId === q.sessionId)}  <!-- O(n) per item -->
{/each}
```

500 쿼리 × 57 세션 = **28,500 선형 탐색** per 렌더.

**해결**: `$derived`로 Map을 미리 만들고 `Map.get()` O(1) 사용.

```svelte
<script>
  // O(1) 세션 lookup용 Map — 매 렌더 시 sessions.find() O(n) 호출 방지
  let sessionMap = $derived(new Map(sessions.map(s => [s.sessionId, s])));
</script>

{#each queries as q}
  {@const session = sessionMap.get(q.sessionId)}  <!-- O(1) -->
{/each}
```

**유틸 함수도 동일**: `isBackgroundQuery(q, sessionMap)` — sessions Array 대신 Map을 받도록 시그니처 통일.

**적용 위치**: `RecentPrompts.svelte`, `CommandPalette.svelte`, `utils.isBackgroundQuery`.

---

## 안티패턴 2: SSE 활성 중에도 polling 무조건 실행

**증상**: SSE delta가 정상 동작 중인데 30초마다 전체 REST 재조회 → 일일 8,640 불필요 요청.

**원인**: polling fallback을 무조건 실행하도록 작성. SSE 도입 후에도 코드 잔존.

**잘못된 예**:
```typescript
refetchTimer = setInterval(async () => {
  await Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
}, 30_000);
```

**해결**: SSE 연결 상태(`connected`) 확인 후 fallback만 실행.

```typescript
refetchTimer = setInterval(async () => {
  if (connected) return; // SSE 정상 → fallback 불필요
  await Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
}, 30_000);
```

**visibility change도 동일 + debounce**:
```typescript
let lastVisibilityFetchAt = 0;

function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (connected && Date.now() - lastVisibilityFetchAt < 5000) return;
  lastVisibilityFetchAt = Date.now();
  Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
}
```

---

## 안티패턴 3: `Math.max(...spread)` on 배열

**증상**: 큰 배열에서 `RangeError: Maximum call stack size exceeded` 위험. 또는 O(n) 2회 순회.

**원인**: spread 연산자는 인자를 stack에 펼침. ~100K 요소 이상에서 stack overflow. 또한 `.map().Math.max(...)`는 중간 배열 생성 + 2회 순회.

**잘못된 예**:
```typescript
const maxChange = $derived(
  Math.max(...filteredImpact.map(i => i.additions + i.deletions), 1)
);
```

**해결**: `$derived.by` + 단일 reduce 루프.

```typescript
const maxChange = $derived.by(() => {
  let max = 1;
  for (const i of filteredImpact) {
    const v = i.additions + i.deletions;
    if (v > max) max = v;
  }
  return max;
});
```

**적용 위치**: `CodeImpactPage.svelte`. 다른 페이지의 `Math.max(...)` / `Math.min(...)` 패턴도 점검 필요.

---

## 안티패턴 4: 검색 input 매 키 입력마다 expensive 재계산

**증상**: 빠른 타이핑 시 input 응답 지연 또는 메인 스레드 점유.

**원인**: `query` state가 input과 즉시 binding되어, 키 입력마다 전체 fuzzyMatch × 데이터셋 재계산.

**잘못된 예**:
```svelte
<input bind:value={query} />

<script>
  let filteredSessions = $derived(
    allSessions.filter(s => fuzzyMatch(s.title, query))  // 매 키 입력마다
  );
</script>
```

**해결**: `query` (input binding) + `debouncedQuery` (expensive 계산용) 분리.

```svelte
<script>
  let query = $state("");
  let debouncedQuery = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const current = query;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = current;
    }, 100);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  let filteredSessions = $derived(
    allSessions.filter(s => fuzzyMatch(s.title, debouncedQuery))  // 100ms 안정화 후
  );
</script>

<input bind:value={query} />  <!-- query는 즉시 반영 (UI 반응성) -->
```

**핵심**: `bind:value`, `query = ""` (reset), 표시용은 `query` 유지. 무거운 계산만 `debouncedQuery` 사용.

---

## 안티패턴 5: 페이지별 인덱싱 누락 (O(N×M) filter)

**증상**: 페이지 렌더링 시 부모-자식 그룹화 함수가 매번 전체 데이터 filter.

**원인**: `{#each parents as p}{getChildren(p)}{/each}` 패턴에서 `getChildren`이 매 호출마다 전체 children filter.

**잘못된 예**:
```typescript
function getProjectSessions(project: ProjectSummary): DashboardSession[] {
  const sessions = getSessions();
  return sessions.filter(s => s.projectCwd === project.worktree || ...);
}
```

프로젝트 N × 세션 M = O(N×M).

**해결**: `$derived` Map으로 사전 인덱싱.

```typescript
let sessionsByProject = $derived.by(() => {
  const map = new Map<string, DashboardSession[]>();
  for (const s of sessions) {
    if (!s.projectCwd) continue;
    const cwd = s.projectCwd.replace(/\\/g, '/');
    if (!map.has(cwd)) map.set(cwd, []);
    map.get(cwd)!.push(s);
  }
  return map;
});

function getProjectSessions(project: ProjectSummary): DashboardSession[] {
  const worktree = project.worktree.replace(/\\/g, '/');
  const result: DashboardSession[] = [];
  for (const [cwd, list] of sessionsByProject) {
    if (cwd === worktree || cwd.startsWith(worktree + '/')) {
      result.push(...list);
    }
  }
  return result;
}
```

O(M) 1회 인덱싱 + 프로젝트당 O(K) 조회 (K = 고유 cwd 수, 일반적으로 K ≪ M).

**적용 위치**: `ProjectsPage.svelte`. 비슷한 부모-자식 그룹화가 있는 다른 페이지(`SummariesPage`, `TimelinePage`)도 점검.

---

## 진단 도구

### 1. API 응답 시간 + 페이로드 크기

```bash
for endpoint in "/api/sessions" "/api/queries?limit=500" "/api/machines"; do
  curl -s -o /dev/null -w "$endpoint → %{time_total}s %{size_download}B\n" \
    "http://192.168.0.2:3097$endpoint"
done
```

### 2. SSE 페이로드 측정

```bash
curl -s -N --max-time 8 http://192.168.0.2:3097/api/events 2>/dev/null | python3 -c "
import sys
delta = 0
total = 0
buf = ''
for line in sys.stdin:
    buf += line
    if line.strip() == '':
        if 'session.delta' in buf:
            delta += 1
            total += len(buf)
        buf = ''
print(f'session.delta: {delta} events, {total}B')
"
```

### 3. Svelte 컴포넌트에서 anti-pattern grep

```bash
# {#each} 안의 array.find() 찾기
grep -A 5 "{#each" server/frontend/src/components/**/*.svelte | grep "\.find("

# Math.max spread 찾기
grep -n "Math\.\(max\|min\)(\.\.\." server/frontend/src/**/*.{ts,svelte}

# bind:value + filter 패턴 (debounce 누락 가능성)
grep -B 2 -A 5 "bind:value" server/frontend/src/components/**/*.svelte | grep "\$derived"
```

---

## 정량 지표

| 측정 | Before (특정 시점) | After (수정 후) |
|------|------------------|---------------|
| `/api/sessions` payload | 875KB (1384 세션) | 47KB (57 세션, 7d 필터) |
| 세션 클릭 fetch | 500 prompts, 276KB | 100 prompts, 81KB |
| SSE `session.update` | 219KB/event 매초 | `session.delta` ~700B/event 변경 시만 |
| 30초 polling 요청 | 8,640/일 | SSE 연결 시 0 |
| `isBackgroundQuery` 호출 | 28,500 find/render | 500 Map.get/render |

---

## 관련 파일

- `server/frontend/src/lib/utils.ts` — `isBackgroundQuery`
- `server/frontend/src/components/RecentPrompts.svelte` — sessionMap 패턴 원본
- `server/frontend/src/components/CommandPalette.svelte` — debounce + sessionMap
- `server/frontend/src/components/pages/ProjectsPage.svelte` — sessionsByProject 인덱싱
- `server/frontend/src/components/pages/CodeImpactPage.svelte` — reduce 루프
- `server/frontend/src/App.svelte` — SSE-aware refetch
- `server/frontend/src/lib/sse-client.ts` — `connected` 상태
- `server/src/cli.ts` — `session.delta` broadcast (delta + hash)
- `server/src/modules/active-sessions/index.ts` — `/api/sessions` 7d 필터
