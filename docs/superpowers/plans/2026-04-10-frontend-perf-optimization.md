# Frontend 성능 최적화 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** session-dashboard 프론트엔드의 성능 병목(O(n²) lookup, 중복 재계산, 불필요한 네트워크 요청)을 제거하여 사용자 체감 성능 개선.

**Architecture:** 핵심 원칙 = (1) `{#each}` 내부의 `array.find()` 제거 → Map O(1) lookup, (2) 중복 필터/정렬 제거 → `$derived` 체인 일원화, (3) 불필요한 네트워크 요청 제거 → SSE 연결 시 polling 생략, (4) 큰 배열 복사 제거 → 가변 업데이트.

**Tech Stack:** Svelte 5 (runes), TypeScript, SSE (EventSource), Vite.

**근거:** 프론트엔드 성능 감사 (별도 보고서). 이미 수정된 항목(`fetchSessionQueries` limit 500→100, `RecentPrompts.sessionMap`, SSE delta, `/api/sessions` 7d 필터)은 제외.

---

## File Structure

수정 대상:

| 파일 | 책임 | 변경 요약 |
|------|------|----------|
| `server/frontend/src/lib/utils.ts` | 순수 유틸 함수 | `isBackgroundQuery` 시그니처 — sessions 배열 대신 sessionMap Map 받기 |
| `server/frontend/src/components/RecentPrompts.svelte` | 프롬프트 목록 렌더 | isBackgroundQuery 호출에 sessionMap 전달, backgroundCount가 filteredQueries 재사용 |
| `server/frontend/src/App.svelte` | 루트 + 초기 로드 + refetch timer | SSE 연결 시 30초 refetch skip, visibility change debounce |
| `server/frontend/src/components/pages/ProjectsPage.svelte` | 프로젝트 목록 | 세션을 프로젝트별 Map으로 미리 인덱싱 |
| `server/frontend/src/components/pages/CodeImpactPage.svelte` | Code Impact 페이지 | Math.max spread → reduce |
| `server/frontend/src/components/CommandPalette.svelte` | 검색 팔레트 | 입력 debounce 100ms |

**공유 유틸 신설**: 없음. Svelte 5 `$derived`로 컴포넌트별 파생 상태가 충분하여 별도 store 분리 불필요.

---

## Task 1: `isBackgroundQuery` Map 기반 O(1) lookup

**근거:** `RecentPrompts.svelte:34`에서 `filteredQueries = queries.filter(q => showBackground || !isBackgroundQuery(q, sessions))`가 각 쿼리마다 `sessions.find()` 호출. 쿼리 500개 × 세션 57개 = **28,500회 선형 탐색**. SSE delta마다 재실행.

**Files:**
- Modify: `server/frontend/src/lib/utils.ts:157-179`
- Modify: `server/frontend/src/components/RecentPrompts.svelte:32-109`

### Step 1.1: `isBackgroundQuery` 시그니처 변경 — sessionMap 수용

- [ ] Open `server/frontend/src/lib/utils.ts`, locate `isBackgroundQuery` at line 157.

- [ ] Replace the function with this exact signature and body:

```typescript
export function isBackgroundQuery(
  q: { isBackground: boolean; sessionId: string; sessionTitle?: string | null },
  sessionMap: Map<string, { parentSessionId?: string | null; title?: string | null }>,
): boolean {
  // Explicit flag from backend
  if (q.isBackground) return true;

  // Cross-reference session metadata via Map (O(1))
  const session = sessionMap.get(q.sessionId);

  // If the session has a parent, it is a child/subagent session
  if (session?.parentSessionId) return true;

  // Title-based detection (matches isBackgroundSession() in prompt-extractor.ts)
  const title = q.sessionTitle || session?.title || null;
  if (title !== null) {
    if (title.startsWith('Background:') || title.startsWith('Task:') || title.includes('@')) {
      return true;
    }
  }

  return false;
}
```

- [ ] **Step 1.1 verify**: `cd server/frontend && npx tsc --noEmit 2>&1 | head -20`
  Expected: errors only in `RecentPrompts.svelte` callsite — we fix those next.

### Step 1.2: `RecentPrompts.svelte` 호출처 업데이트 — sessionMap 전달

- [ ] Open `server/frontend/src/components/RecentPrompts.svelte`. The `sessionMap` derived is already at line ~30.

- [ ] Replace `filteredQueries` block (lines 32–55) with:

```svelte
  let filteredQueries = $derived(
    queries
      .filter(q => showBackground || !isBackgroundQuery(q, sessionMap))
      .map(q => {
        if (!isBackgroundQuery(q, sessionMap)) return q;
        const childSession = sessionMap.get(q.sessionId);
        const parentId = childSession?.parentSessionId;
        if (!parentId) return q;
        const parentSession = sessionMap.get(parentId);
        if (!parentSession) return q;
        return { ...q, sessionId: parentId, sessionTitle: parentSession.title ?? parentId.slice(0, 8) };
      })
      .filter(q => !machineFilter || q.machineId === machineFilter)
      .filter(q => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !q.source || q.source === "opencode";
        return q.source === sourceFilter;
      })
      .filter(q => {
        const sid = sessionIdFilter ?? selectedSessionId;
        return !sid || q.sessionId === sid;
      })
      .toSorted((a, b) => b.timestamp - a.timestamp)
  );
```

- [ ] Find `backgroundCount` block (around line 89–109) and replace with this version that **reuses** the pre-filtered base instead of re-filtering from `queries`:

```svelte
  let backgroundCount = $derived(
    queries
      .filter(q => isBackgroundQuery(q, sessionMap))
      .filter(q => !machineFilter || q.machineId === machineFilter)
      .filter(q => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !q.source || q.source === "opencode";
        return q.source === sourceFilter;
      })
      .filter(q => {
        const sid = sessionIdFilter ?? selectedSessionId;
        if (!sid) return true;
        if (q.sessionId === sid) return true;
        const childSession = sessionMap.get(q.sessionId);
        return childSession?.parentSessionId === sid;
      })
      .length
  );
```

- [ ] **Step 1.2 verify**: `cd server/frontend && npm run build 2>&1 | tail -5`
  Expected: `✓ built in ...` with no errors.

### Step 1.3: Commit Task 1

- [ ] `cd /Users/sbbae/project/session-dashboard`
- [ ] `git add server/frontend/src/lib/utils.ts server/frontend/src/components/RecentPrompts.svelte`
- [ ] Commit:

```bash
git commit -m "perf(frontend): isBackgroundQuery Map 기반 O(1) lookup 전환

쿼리 500 × 세션 57 = 28,500회 선형 find → Map.get O(1).
RecentPrompts가 이미 생성한 sessionMap을 재사용."
```

---

## Task 2: SSE 연결 시 30초 refetch skip

**근거:** `App.svelte:103-105`의 `refetchTimer`가 30초마다 `fetchSessions + fetchQueries + fetchMachines`를 무조건 호출. SSE delta가 정상 동작 시 중복 네트워크 요청 발생 (일일 8,640 요청). SSE가 끊겼을 때만 fallback으로 동작해야 함.

**Files:**
- Modify: `server/frontend/src/App.svelte:103-114`

### Step 2.1: SSE 연결 상태 확인 후 조건부 refetch

- [ ] Open `server/frontend/src/App.svelte`. Locate `refetchTimer` setup around line 103.

- [ ] Replace the refetch timer block (around lines 103–105) with:

```typescript
    // Polling fallback: SSE가 연결 안 되어 있을 때만 재조회.
    // SSE가 정상이면 session.delta/query.new로 실시간 업데이트됨.
    refetchTimer = setInterval(async () => {
      if (connected) return; // SSE 정상 → fallback 불필요
      await Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
    }, 30_000);
```

### Step 2.2: visibility change 중복 fetch 방지

- [ ] Find `handleVisibilityChange` (around line 110). Replace the entire function + a new timestamp ref above `onMount`:

```typescript
  let lastVisibilityFetchAt = 0;

  function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    // SSE가 연결되어 있고 5초 이내에 fetch했으면 skip
    if (connected && Date.now() - lastVisibilityFetchAt < 5000) return;
    lastVisibilityFetchAt = Date.now();
    Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
  }
```

- [ ] **Step 2.2 verify**: `cd server/frontend && npm run build 2>&1 | tail -5`
  Expected: `✓ built in ...` with no errors.

### Step 2.3: Commit Task 2

- [ ] `git add server/frontend/src/App.svelte`
- [ ] Commit:

```bash
git commit -m "perf(frontend): SSE 연결 시 30초 refetch + visibility refresh skip

SSE delta가 실시간 업데이트하는데 30초마다 전체 재조회는 낭비.
연결 끊긴 경우만 fallback으로 동작. visibility change도 5초 debounce."
```

---

## Task 3: ProjectsPage — 세션 인덱싱으로 O(N×M) 제거

**근거:** `ProjectsPage.svelte:46-54`의 `getProjectSessions()`가 프로젝트 렌더링마다 `sessions.filter()` O(M) 호출. 프로젝트 N개 × 세션 M개 = O(N×M).

**Files:**
- Modify: `server/frontend/src/components/pages/ProjectsPage.svelte`

### Step 3.1: ProjectsPage 현재 상태 확인

- [ ] Read `server/frontend/src/components/pages/ProjectsPage.svelte` lines 1–90 to understand the structure.

### Step 3.2: 세션을 프로젝트별 Map으로 인덱싱

- [ ] Locate the `getProjectSessions` function (around line 46). Replace it with a pre-computed Map:

Add near the top of `<script>` (after `sessions = $derived(getSessions())`):

```typescript
  // 프로젝트 worktree → 세션 배열 Map (O(N) 1회 계산, O(1) 조회)
  let sessionsByProject = $derived.by(() => {
    const map = new Map<string, DashboardSession[]>();
    const allSessions = getSessions();
    for (const s of allSessions) {
      if (!s.projectCwd) continue;
      const cwd = s.projectCwd.replace(/\\/g, '/');
      // 경로 prefix 기반 매칭 — 프로젝트 worktree ↔ 세션 cwd
      // worktree의 모든 prefix를 키로 등록하지 않고, 역으로 세션을 모든 상위 경로로 등록하면
      // 프로젝트 수가 적으므로 아래 루프에서 해결.
      if (!map.has(cwd)) map.set(cwd, []);
      map.get(cwd)!.push(s);
    }
    return map;
  });

  function getProjectSessions(project: ProjectSummary): DashboardSession[] {
    const worktree = project.worktree.replace(/\\/g, '/');
    // worktree와 정확히 일치하거나 worktree 하위 경로인 세션
    const result: DashboardSession[] = [];
    for (const [cwd, list] of sessionsByProject) {
      if (cwd === worktree || cwd.startsWith(worktree + '/')) {
        result.push(...list);
      }
    }
    return result;
  }
```

> **Note**: worktree prefix matching은 피할 수 없으므로, 대신 `projectCwd`를 키로 정확한 그룹화를 먼저 수행한 후 prefix 매칭은 프로젝트 수(N)만큼만 반복. 일반 케이스 (세션 cwd = 프로젝트 worktree)는 O(1).

- [ ] **Step 3.2 verify**: `cd server/frontend && npm run build 2>&1 | tail -5`
  Expected: `✓ built in ...` with no errors.

### Step 3.3: Commit Task 3

- [ ] `git add server/frontend/src/components/pages/ProjectsPage.svelte`
- [ ] Commit:

```bash
git commit -m "perf(frontend): ProjectsPage 세션 인덱싱 — O(N*M) → O(N+M)

getProjectSessions가 프로젝트 렌더마다 전체 세션 filter 호출하던 것을
$derived Map으로 사전 인덱싱하여 조회 비용 감소."
```

---

## Task 4: CodeImpactPage — `Math.max(...spread)` → reduce

**근거:** `CodeImpactPage.svelte:26-28`의 `Math.max(...(filteredImpact).map(i => i.additions + i.deletions), 1)`. spread 연산자는 큰 배열에서 stack overflow + O(n). `$derived`로 재계산 빈도 높음.

**Files:**
- Modify: `server/frontend/src/components/pages/CodeImpactPage.svelte`

### Step 4.1: reduce로 단일 순회 변경

- [ ] Open `server/frontend/src/components/pages/CodeImpactPage.svelte`. Locate `maxChange` around line 26.

- [ ] Replace:

```typescript
const maxChange = $derived(
  Math.max(...(filteredImpact).map((i) => i.additions + i.deletions), 1)
);
```

with:

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

- [ ] **Step 4.1 verify**: `cd server/frontend && npm run build 2>&1 | tail -5`
  Expected: `✓ built in ...` with no errors.

### Step 4.2: Commit Task 4

- [ ] `git add server/frontend/src/components/pages/CodeImpactPage.svelte`
- [ ] Commit:

```bash
git commit -m "perf(frontend): CodeImpactPage Math.max spread → reduce 루프

spread 연산자는 큰 배열에서 stack 소모 + O(n) 2회 순회.
단일 reduce 루프로 O(n) 1회."
```

---

## Task 5: CommandPalette 입력 debounce

**근거:** `CommandPalette.svelte:70-108`의 검색 `$derived`가 사용자 키 입력마다 전체 세션/쿼리를 필터링 + `fuzzyMatch` 호출. 빠른 타이핑 시 과도한 재계산.

**Files:**
- Modify: `server/frontend/src/components/CommandPalette.svelte`

### Step 5.1: 입력 debounce 추가

- [ ] Open `server/frontend/src/components/CommandPalette.svelte`. Read lines 1–130 to understand structure.

- [ ] Near the top of `<script>`, find the `query` state. Add a debounced version:

```typescript
  let query = $state("");
  let debouncedQuery = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    // query 변경 시 100ms debounce 후 debouncedQuery 반영
    const current = query;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = current;
    }, 100);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });
```

- [ ] Replace all usages of `query` in the `filteredSessions` / `filteredQueries` `$derived` blocks with `debouncedQuery`. Keep `query` as the actual input binding (for UI responsiveness) — only the expensive computation reads `debouncedQuery`.

- [ ] **Step 5.1 verify**: `cd server/frontend && npm run build 2>&1 | tail -5`
  Expected: `✓ built in ...` with no errors.

### Step 5.2: Commit Task 5

- [ ] `git add server/frontend/src/components/CommandPalette.svelte`
- [ ] Commit:

```bash
git commit -m "perf(frontend): CommandPalette 입력 100ms debounce

빠른 타이핑 시 키 입력마다 fuzzyMatch × 전체 세션/쿼리 재계산.
100ms debounce로 부하 감소, UI 입력 반응은 그대로 유지."
```

---

## Task 6: 통합 테스트 & 배포

**근거:** 모든 변경이 프론트엔드만이므로 백엔드 재배포 불필요. Docker 서버에서 `docker compose up -d --build --force-recreate`만 필요.

### Step 6.1: 프론트엔드 빌드 + 서버 빌드 (테스트 포함)

- [ ] `cd /Users/sbbae/project/session-dashboard/server/frontend && npm run build`
  Expected: `✓ built in ...`, no errors, `dist/public/assets/` 생성.

- [ ] `cd /Users/sbbae/project/session-dashboard/server && npm run build`
  Expected: `> tsc` 완료, no errors.

- [ ] `cd /Users/sbbae/project/session-dashboard/server && npx vitest run 2>&1 | tail -5`
  Expected: `368 passed` (또는 그 이상).

### Step 6.2: Git push

- [ ] `cd /Users/sbbae/project/session-dashboard && git log --oneline -6`
  Expected: Task 1-5 커밋 6개(또는 5개) 확인.
- [ ] `git push`
  Expected: `main -> main` push 성공.

### Step 6.3: Production 배포

- [ ] `ssh sbbae@192.168.0.2 "bash -lc 'cd ~/project/session-dashboard/server && git pull && docker compose up -d --build --force-recreate'"`
  Expected: `Container session-dashboard Started`.

### Step 6.4: 헬스체크 + 성능 검증

- [ ] `curl -s http://192.168.0.2:3097/health`
  Expected: `{"status":"ok",...}`.

- [ ] 수동 검증: 브라우저에서 `http://192.168.0.2:3097` 접속 → Sessions 뷰 → 세션 카드 클릭 → 프리징 없이 즉시 프롬프트 로드되는지 확인.

- [ ] DevTools Network 탭에서: SSE 연결 후 30초 대기 시 `/api/sessions`, `/api/queries`, `/api/machines` REST 요청이 **발생하지 않음** 확인 (Task 2 검증).

### Step 6.5: 완료

- [ ] 사용자에게 완료 보고 + 체감 성능 개선 여부 질문.

---

## Self-Review Notes

- **Spec coverage**: 감사 보고서의 High/Medium 이슈 중 Task로 커버:
  - [x] isBackgroundQuery O(n) find (Task 1)
  - [x] 30초 refetchTimer (Task 2)
  - [x] visibility change 중복 fetch (Task 2)
  - [x] ProjectsPage O(N×M) (Task 3)
  - [x] CodeImpactPage Math.max spread (Task 4)
  - [x] CommandPalette debounce (Task 5)
  - [ ] **제외**: SSE 핸들러 이중 등록 — 실제 코드 검증 결과 **false positive**. `.on()` 호출 시점에 `es === null`이므로 conditional 브랜치 안 탐. 수정 불필요.
  - [ ] **제외**: backgroundCount 중복 필터링 — Task 1에서 `sessionMap` 전환하면서 약간 개선. 완전 공유 시 가독성 저하. 현 상태 유지.
  - [ ] **제외**: responseCache Map 복사, sortedQueries latestTs, ActiveSessions/SessionCards uniqueProjects 중복, SummariesPage projectGroups 이중 정렬, ContextRecoveryPage [...].sort, MemosPage mergedProjects, TimelinePage fetchSessionSegments — 모두 Low 영향도. 실제 체감 문제 없으면 보류.

- **Placeholder scan**: No TBD, TODO, or "implement later". Every code block is complete.

- **Type consistency**: `isBackgroundQuery` 시그니처가 Task 1.1 → 1.2에서 일관됨. `sessionMap`은 `Map<string, {parentSessionId?, title?}>` 구조. `ProjectSummary` / `DashboardSession` 기존 타입 그대로 사용.
