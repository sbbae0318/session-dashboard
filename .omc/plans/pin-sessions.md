# Plan: Session Pin (Favorite) 기능

> Monitor / Sessions 메뉴에서 세션을 Pin하여 같은 Status 내 상위에 고정하고, 해제 전까지 localStorage에 영속 보존.

**Date:** 2026-04-11
**Status:** Design approved → implementation pending
**Scope:** Frontend only (백엔드/agent 변경 없음)
**Related:** F-008 (정렬 드리프트 수정 — 본 기능의 정렬 훅 지점)

---

## Goal

사용자가 관심 세션을 Pin하여 반복 추적 부담을 줄인다. Pin된 세션은:
1. 시각적으로 하이라이트된다 (좌측 2px primary 보더, 📌 아이콘 상시 표시).
2. 같은 Status 그룹 내에서 상위로 정렬된다 (Status 우선순위는 유지).
3. 브라우저 localStorage에 영속 저장되어, 사용자가 명시적으로 Unpin할 때까지 유지된다.

## Non-goals (YAGNI)

- ❌ Pin 개수 제한
- ❌ Pin 순서 수동 재배열 (Status > Pin > lastActivity 고정)
- ❌ 백엔드 DB 동기화 (다기기 sync 미요구)
- ❌ 다른 페이지(Projects/Timeline/TokenCost 등)로 하이라이트 전파 — 사양은 Monitor + Sessions만
- ❌ "Pinned only" 필터 버튼
- ❌ Pinned 세션 auto-cleanup (`dismissed` 도 안 함; 명시 해제까지 영속)

---

## Architecture

```
localStorage ('session-dashboard:pinned')
      ↕ load / save
┌─────────────────────────────┐
│ pinned.svelte.ts (store)    │  ← dismissed.svelte.ts 패턴 복제
│   Set<sessionId>            │
│   togglePin / isPinned      │
│   getPinnedIds / clearAll   │
└─────────────────────────────┘
      ↓ isPinned(id) (reactive)
┌─────────────────────────────┐
│ ActiveSessions.svelte       │
│   topLevelSessions derived  │   sort: status → pin → lastActivity
│ SessionCards.svelte         │
│   filteredSessions derived  │   sort: status → pin → lastActivity
└─────────────────────────────┘
```

**Why localStorage (not backend DB):**
- 기존 `dismissed.svelte.ts`와 대칭 패턴 → 학습 비용 0.
- 사용자가 다기기 sync를 요구하지 않음 (YAGNI).
- 구현 범위가 프론트엔드로 한정 → 배포 리스크 최소.
- 추후 backend로 이전 필요 시 store 인터페이스만 유지하면 컴포넌트 변경 없음.

## Data model

```typescript
// server/frontend/src/lib/stores/pinned.svelte.ts
const STORAGE_KEY = 'session-dashboard:pinned';

let pinned = $state<Set<string>>(loadFromStorage());

export function togglePin(sessionId: string): void;
export function isPinned(sessionId: string): boolean;
export function getPinnedIds(): Set<string>;   // reactive getter
export function getPinnedCount(): number;
export function clearAllPins(): void;
```

- **타입**: `Set<string>` — Pin은 boolean 상태만 필요 (Map<k,v>의 v 불필요).
- **직렬화**: `JSON.stringify([...set])` ↔ `new Set(JSON.parse(raw))`.
- **Reactivity**: 변경 시 불변 패턴 `pinned = new Set(pinned)` — Svelte 5 runes가 referential change 감지.
- **Error handling**: localStorage 실패(quota/unavailable)는 `dismissed`와 동일하게 silent catch.

## Sort integration

기존 `ActiveSessions.svelte:topLevelSessions`와 `SessionCards.svelte:filteredSessions`의 정렬 비교자에 pin 차수를 한 층 삽입한다. `utils.ts:statusSortPriority`는 store를 import하지 않는다 (순환/테스트 복잡도 방지).

```typescript
.sort((a, b) => {
  // 1차: status 우선순위 (Waiting > Working > Rename > Idle > Disconnected)
  const sp = statusSortPriority(a) - statusSortPriority(b);
  if (sp !== 0) return sp;

  // 2차: 같은 status 내 pin 우선 (pinned=0, unpinned=1)
  const pa = isPinned(a.sessionId) ? 0 : 1;
  const pb = isPinned(b.sessionId) ? 0 : 1;
  if (pa !== pb) return pa - pb;

  // 3차: 최근 활동 순
  return b.lastActivityTime - a.lastActivityTime;
})
```

**Invariant**: Status 우선순위는 절대 깨지지 않는다 — Idle-pinned 세션이 Working-unpinned보다 위에 오지 않는다.

## UI design

### Pin 버튼

공통 패턴:
- 📌 이모지 버튼
- `onclick` 에서 `e.stopPropagation()` 필수 (카드 클릭 = 상세 진입과 충돌 방지)
- `aria-label` = `"Pin"` / `"Unpin"` 동적
- 기본 `opacity: 0.25` → hover 또는 pinned 상태에서 `opacity: 1`

### ActiveSessions (리스트 뷰)

배치: `.session-header-top` 행에 status-badge 왼쪽.

```html
<div class="session-item" class:pinned={isPinned(session.sessionId)} ...>
  <div class="session-header-top">
    <button class="pin-btn"
            class:pinned={isPinned(session.sessionId)}
            onclick={(e) => { e.stopPropagation(); togglePin(session.sessionId); }}
            aria-label={isPinned(session.sessionId) ? 'Unpin' : 'Pin'}>📌</button>
    <span class="status-badge ...">...</span>
    <span class="session-title">...</span>
  </div>
</div>
```

```css
.session-item.pinned {
  border-left: 2px solid var(--color-primary);
  padding-left: calc(var(--pad-left) - 2px);  /* 레이아웃 시프트 방지 */
}
.pin-btn {
  background: none; border: none; cursor: pointer;
  opacity: 0.25; transition: opacity 150ms;
  padding: 0 0.25rem;
}
.session-item:hover .pin-btn,
.pin-btn.pinned { opacity: 1; }
.pin-btn.pinned { color: var(--color-primary); }
```

### SessionCards (그리드 뷰)

배치: 카드 우상단 corner에 absolute. 카드 전체 테두리는 기존 `.focused`와 경합하므로 좌측 보더만 사용.

```html
<div class="session-card" class:pinned={isPinned(session.sessionId)} ...>
  <button class="pin-btn corner"
          class:pinned={...}
          onclick={(e) => { e.stopPropagation(); togglePin(session.sessionId); }}
          aria-label={...}>📌</button>
  ...
</div>
```

```css
.session-card { position: relative; }
.session-card.pinned {
  border-left: 2px solid var(--color-primary);
}
.pin-btn.corner {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
}
```

**하이라이트 강도 선택 근거 (Option A "은은형")**:
- 좌측 2px 보더만 사용 → 스캔 시 인지 가능하되 시각 소음 최소.
- 배경 tint 없음 → 기존 `.selected` (전체 보더) / `.focused` (outline) 스타일과 충돌 0.
- hover 전엔 📌 버튼이 거의 투명 → compact 레이아웃(38px 행 높이) 유지.

## Keyboard shortcut

- **`p`**: 포커스된 세션 pin 토글
- 적용 위치: `ActiveSessions.svelte:handleSessionKeydown`, `SessionCards.svelte:handleKeydown`
- 기존 단축키(`h/j/k/l/e/c/a/G`)와 충돌 없음 (`p`는 미사용)
- `ShortcutCheatsheet.svelte`에 `{ key: "p", desc: "세션 pin/unpin" }` 등록

## Persistence lifecycle

| 이벤트 | 동작 |
|--------|------|
| Pin 버튼 클릭 / `p` 키 | `togglePin(id)` → Set 변경 → localStorage write |
| 페이지 리로드 | `loadFromStorage()` 로 Set 복원 → 즉시 highlight+sort 반영 |
| 세션 삭제 (agent 측) | Pin entry는 그대로 남음 — 해당 세션이 다시 활성화되면 자동 복구. 삭제된 ID도 Set에 남지만 UI에 노출 안 되므로 무해. |
| 사용자 Unpin | `togglePin(id)` → Set.delete → localStorage write |
| "Clear all" (향후) | `clearAllPins()` — 본 스펙에선 UI 미노출 (YAGNI), store에는 함수만 준비 |

## Test strategy

| Layer | 대상 | 방법 |
|-------|------|------|
| **Store** | `pinned.svelte.ts` | vitest — toggle, isPinned, persistence round-trip (localStorage mock), clearAll |
| **Sort** | 정렬 비교자 | vitest — (waiting+pinned, waiting, working+pinned, working, idle+pinned, idle) 6개 세션 혼합 → 기대 순서 검증. Status 우선순위 불변 확인. |
| **UI** | `ActiveSessions.svelte` / `SessionCards.svelte` | Playwright e2e — pin 클릭 → 상위 이동 확인, reload → pinned 유지, Unpin → 원위치, 같은 Status 내에서만 이동(Idle-pin이 Working-unpin보다 위로 안 감). |

## Acceptance criteria

1. ✅ Monitor의 `ActiveSessions` 리스트에서 세션 카드의 📌 버튼 클릭 또는 `p` 키로 Pin 토글 가능.
2. ✅ Sessions의 `SessionCards` 그리드에서 동일 동작 가능.
3. ✅ Pin된 세션은 좌측 2px primary 보더로 하이라이트되고, 📌 아이콘이 상시 표시된다.
4. ✅ Pin된 세션은 같은 Status 그룹 내에서 상위로 정렬된다.
5. ✅ Status 우선순위는 절대 깨지지 않는다 (Idle-pinned < Working-unpinned).
6. ✅ 같은 Status + 같은 Pin 상태 내에서는 `lastActivityTime` desc 정렬 유지.
7. ✅ 페이지 리로드 후에도 Pin 상태가 유지된다 (localStorage).
8. ✅ Pin 버튼 클릭이 세션 상세 뷰 진입을 트리거하지 않는다 (`stopPropagation`).
9. ✅ ShortcutCheatsheet에 `p: 세션 pin/unpin` 항목이 표시된다.
10. ✅ `p` 키가 INPUT/TEXTAREA/SELECT 포커스 시엔 무시된다 (기존 단축키와 동일 가드).

## Files touched (expected)

**New:**
- `server/frontend/src/lib/stores/pinned.svelte.ts`
- `server/frontend/src/lib/stores/__tests__/pinned.test.ts` (or colocated)

**Modified:**
- `server/frontend/src/components/ActiveSessions.svelte` — sort 비교자 + pin 버튼 + `p` 키 + `.pinned` CSS
- `server/frontend/src/components/SessionCards.svelte` — 동일
- `server/frontend/src/components/ShortcutCheatsheet.svelte` — 단축키 등록
- `server/frontend/src/lib/__tests__/utils.test.ts` — pin-aware 정렬 테스트 추가 (또는 컴포넌트 레벨에서)
- `server/e2e/ui/*.spec.ts` — pin e2e (기존 UI 테스트 패턴 따름)

## References

- `server/frontend/src/lib/stores/dismissed.svelte.ts` — localStorage 기반 runes store 템플릿
- `server/frontend/src/lib/utils.ts:statusSortPriority` — Status 정렬 기준 (F-008 수정)
- `server/frontend/src/components/ActiveSessions.svelte:154-180` — topLevelSessions derived
- `server/frontend/src/components/SessionCards.svelte:48-68` — filteredSessions derived
- `.omc/knowledge/known-failures.md:F-008` — SSE delta 정렬 드리프트 (본 기능의 정렬 훅이 같은 derived 체인에 위치)

---

# Implementation Plan

> **실행 가이드:** 각 Task는 TDD 사이클(test fail → implement → test pass → commit)로 bite-sized 단위. 체크박스로 진행 추적.

**Goal:** localStorage 기반 Pin 기능을 Monitor/Sessions 뷰에 추가. Status 우선순위 내에서 pinned 세션 상위 고정, 해제 전까지 영속.

**Tech Stack:** Svelte 5 runes, TypeScript strict, vitest (unit), Playwright (e2e).

**작업 디렉토리:** `/Users/sbbae/project/session-dashboard` (main branch 직접 작업 — frontend only, 롤백 쉬움).

## File Structure

**New files:**
- `server/frontend/src/lib/stores/pinned.svelte.ts` — localStorage 기반 pin store
- `server/frontend/src/lib/stores/__tests__/pinned.test.ts` — store 단위 테스트

**Modified files:**
- `server/frontend/src/lib/utils.ts` — `sortSessionsByStatusAndPin()` 헬퍼 추출
- `server/frontend/src/lib/__tests__/utils.test.ts` — pin-aware 정렬 테스트
- `server/frontend/src/components/ActiveSessions.svelte` — sort 교체 + pin 버튼 + `p` 키 + CSS
- `server/frontend/src/components/SessionCards.svelte` — 동일
- `server/frontend/src/components/ShortcutCheatsheet.svelte` — `p` 등록
- `server/e2e/ui/dashboard.spec.ts` — pin e2e 추가

**Design decisions locked in:**
- Pin 정렬 로직은 `utils.ts`에 `sortSessionsByStatusAndPin(sessions, pinnedIds)`로 추출. `pinnedIds`를 파라미터로 받아 store import하지 않음 → 순환 없음, 순수 함수로 테스트 쉬움.
- 양쪽 컴포넌트가 같은 헬퍼 사용 (DRY).
- 스토어는 `Set<string>` 상태 + 토글 시 불변 패턴.

---

## Task 1: Pin store 작성 + 단위 테스트

**Files:**
- Create: `server/frontend/src/lib/stores/pinned.svelte.ts`
- Create: `server/frontend/src/lib/stores/__tests__/pinned.test.ts`

- [ ] **Step 1: 디렉토리 확인 및 생성**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
mkdir -p src/lib/stores/__tests__
```

- [ ] **Step 2: Failing 테스트 작성**

Create `server/frontend/src/lib/stores/__tests__/pinned.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { togglePin, isPinned, getPinnedIds, getPinnedCount, clearAllPins } from "../pinned.svelte.js";

describe("pinned store", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllPins();
  });

  it("isPinned returns false for unpinned session", () => {
    expect(isPinned("s1")).toBe(false);
  });

  it("togglePin adds an unpinned session", () => {
    togglePin("s1");
    expect(isPinned("s1")).toBe(true);
    expect(getPinnedCount()).toBe(1);
  });

  it("togglePin removes a pinned session", () => {
    togglePin("s1");
    togglePin("s1");
    expect(isPinned("s1")).toBe(false);
    expect(getPinnedCount()).toBe(0);
  });

  it("getPinnedIds returns current set", () => {
    togglePin("s1");
    togglePin("s2");
    const ids = getPinnedIds();
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("persists to localStorage", () => {
    togglePin("s1");
    togglePin("s2");
    const raw = localStorage.getItem("session-dashboard:pinned");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("clearAllPins empties the set", () => {
    togglePin("s1");
    togglePin("s2");
    clearAllPins();
    expect(getPinnedCount()).toBe(0);
    expect(isPinned("s1")).toBe(false);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("session-dashboard:pinned", "{not json");
    // 모듈은 이미 로드됐으므로 이 케이스는 loadFromStorage 내부 try/catch 검증용.
    // 여기서는 clearAllPins 후 다시 동작하는지만 확인.
    clearAllPins();
    togglePin("s1");
    expect(isPinned("s1")).toBe(true);
  });
});
```

- [ ] **Step 3: 테스트 실행 → FAIL 확인**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npx vitest run src/lib/stores/__tests__/pinned.test.ts
```

Expected: FAIL — `Cannot find module '../pinned.svelte.js'`.

- [ ] **Step 4: Store 구현**

Create `server/frontend/src/lib/stores/pinned.svelte.ts`:

```typescript
/**
 * Tracks pinned (favorited) sessions.
 * Persisted to localStorage so state survives page reload.
 * Unlike `dismissed`, pin has no expiry — user must explicitly unpin.
 */

const STORAGE_KEY = 'session-dashboard:pinned';

function loadFromStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const ids: string[] = JSON.parse(raw);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveToStorage(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

let pinned = $state<Set<string>>(loadFromStorage());

export function togglePin(sessionId: string): void {
  const next = new Set(pinned);
  if (next.has(sessionId)) {
    next.delete(sessionId);
  } else {
    next.add(sessionId);
  }
  pinned = next;
  saveToStorage(next);
}

export function isPinned(sessionId: string): boolean {
  return pinned.has(sessionId);
}

export function getPinnedIds(): Set<string> {
  return pinned;
}

export function getPinnedCount(): number {
  return pinned.size;
}

export function clearAllPins(): void {
  pinned = new Set();
  saveToStorage(pinned);
}
```

- [ ] **Step 5: 테스트 실행 → PASS 확인**

```bash
npx vitest run src/lib/stores/__tests__/pinned.test.ts
```

Expected: `7 passed`.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/frontend/src/lib/stores/pinned.svelte.ts \
        server/frontend/src/lib/stores/__tests__/pinned.test.ts
git commit -m "feat(frontend): add pinned sessions store (localStorage)"
```

---

## Task 2: `sortSessionsByStatusAndPin` 헬퍼 추출 + 테스트

**Files:**
- Modify: `server/frontend/src/lib/utils.ts` (add function)
- Modify: `server/frontend/src/lib/__tests__/utils.test.ts` (add tests)

- [ ] **Step 1: Failing 테스트 작성**

Append to `server/frontend/src/lib/__tests__/utils.test.ts` (end of file, after `describe("statusSortPriority", ...)`):

```typescript
import { sortSessionsByStatusAndPin } from "../utils.js";

describe("sortSessionsByStatusAndPin", () => {
  const base = { recentlyRenamed: false, machineConnected: true };

  function mk(id: string, kind: "waiting" | "working" | "idle", activity: number) {
    return {
      sessionId: id,
      lastActivityTime: activity,
      apiStatus: kind === "working" ? "busy" : null,
      currentTool: null,
      waitingForInput: kind === "waiting",
      ...base,
    };
  }

  it("pins go first within same status, status order preserved", () => {
    const sessions = [
      mk("idle-unpin-recent", "idle", 100),
      mk("work-pin-old",      "working", 10),
      mk("wait-unpin",        "waiting", 50),
      mk("idle-pin-old",      "idle", 1),
      mk("work-unpin-recent", "working", 200),
      mk("wait-pin",          "waiting", 5),
    ];
    const pinnedIds = new Set(["work-pin-old", "idle-pin-old", "wait-pin"]);
    const sorted = sortSessionsByStatusAndPin(sessions, pinnedIds);
    expect(sorted.map(s => s.sessionId)).toEqual([
      "wait-pin",          // waiting + pinned
      "wait-unpin",        // waiting + unpinned
      "work-pin-old",      // working + pinned
      "work-unpin-recent", // working + unpinned
      "idle-pin-old",      // idle + pinned
      "idle-unpin-recent", // idle + unpinned
    ]);
  });

  it("idle pinned never outranks working unpinned (status invariant)", () => {
    const sessions = [
      mk("idle-pin", "idle", 999),
      mk("work-unpin", "working", 1),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set(["idle-pin"]));
    expect(sorted[0].sessionId).toBe("work-unpin");
    expect(sorted[1].sessionId).toBe("idle-pin");
  });

  it("within same status and pin state, sorts by lastActivityTime desc", () => {
    const sessions = [
      mk("a", "idle", 10),
      mk("b", "idle", 30),
      mk("c", "idle", 20),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set());
    expect(sorted.map(s => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate input array", () => {
    const sessions = [mk("a", "idle", 1), mk("b", "waiting", 1)];
    const snapshot = sessions.map(s => s.sessionId);
    sortSessionsByStatusAndPin(sessions, new Set());
    expect(sessions.map(s => s.sessionId)).toEqual(snapshot);
  });

  it("empty pinnedIds falls back to pure status+activity order", () => {
    const sessions = [
      mk("i", "idle", 5),
      mk("w", "waiting", 1),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set());
    expect(sorted.map(s => s.sessionId)).toEqual(["w", "i"]);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL 확인**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npx vitest run src/lib/__tests__/utils.test.ts
```

Expected: FAIL — `sortSessionsByStatusAndPin is not exported`.

- [ ] **Step 3: 헬퍼 구현**

Edit `server/frontend/src/lib/utils.ts` — append after `statusSortPriority` function (before `detectStatusChanges`):

```typescript
/**
 * 세션 목록을 정렬한다. 우선순위:
 *   1. Status (Waiting > Working > Rename > Idle > Disconnected) — statusSortPriority
 *   2. 같은 status 내에서 pinned 먼저
 *   3. 같은 status + 같은 pin 상태 내에서 lastActivityTime 내림차순
 *
 * Status invariant는 절대 깨지지 않는다 — Idle-pinned 세션이 Working-unpinned 위에 오지 않는다.
 * 순수 함수: 입력 배열을 mutate 하지 않고 새 배열을 반환한다.
 */
export function sortSessionsByStatusAndPin<T extends {
  sessionId: string;
  apiStatus: string | null;
  currentTool: string | null;
  waitingForInput: boolean;
  recentlyRenamed?: boolean;
  machineConnected?: boolean;
  lastActivityTime: number;
}>(sessions: T[], pinnedIds: Set<string>): T[] {
  return sessions.slice().sort((a, b) => {
    const sp = statusSortPriority(a) - statusSortPriority(b);
    if (sp !== 0) return sp;
    const pa = pinnedIds.has(a.sessionId) ? 0 : 1;
    const pb = pinnedIds.has(b.sessionId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.lastActivityTime - a.lastActivityTime;
  });
}
```

- [ ] **Step 4: 테스트 실행 → PASS 확인**

```bash
npx vitest run src/lib/__tests__/utils.test.ts
```

Expected: 5 new tests pass (`40 passed` total).

- [ ] **Step 5: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/frontend/src/lib/utils.ts \
        server/frontend/src/lib/__tests__/utils.test.ts
git commit -m "feat(frontend): add sortSessionsByStatusAndPin helper"
```

---

## Task 3: ActiveSessions에 pin UI/sort/키보드 통합

**Files:**
- Modify: `server/frontend/src/components/ActiveSessions.svelte`

- [ ] **Step 1: import 확장**

Edit `server/frontend/src/components/ActiveSessions.svelte` line 8:

Before:
```typescript
import { relativeTime, formatDuration, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges, statusSortPriority } from "../lib/utils";
```

After:
```typescript
import { relativeTime, formatDuration, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges, sortSessionsByStatusAndPin } from "../lib/utils";
import { isPinned, togglePin, getPinnedIds } from "../lib/stores/pinned.svelte";
```

(Note: `statusSortPriority`는 더 이상 직접 필요 없음 — `sortSessionsByStatusAndPin`이 내부에서 호출.)

- [ ] **Step 2: `topLevelSessions` derived의 sort 교체**

Edit `server/frontend/src/components/ActiveSessions.svelte` around line 154-180:

Before (현재):
```typescript
let topLevelSessions = $derived(
  sessions
    .filter(s => !machineFilter || s.machineId === machineFilter)
    .filter(s => { ... })
    .filter(s => { ... })
    .filter(s => !s.parentSessionId)
    .filter(s => !projectFilter || s.projectCwd === projectFilter)
    .slice()
    .sort((a, b) => {
      const sp = statusSortPriority(a) - statusSortPriority(b);
      if (sp !== 0) return sp;
      return b.lastActivityTime - a.lastActivityTime;
    })
);
```

After:
```typescript
let topLevelSessions = $derived.by(() => {
  const filtered = sessions
    .filter(s => !machineFilter || s.machineId === machineFilter)
    .filter(s => {
      if (sourceFilter === "all") return true;
      if (sourceFilter === "opencode") return !s.source || s.source === "opencode";
      return s.source === sourceFilter;
    })
    .filter(s => {
      if (s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.waitingForInput) return true;
      const cutoff = getTimeRangeCutoff();
      return cutoff === 0 || s.lastActivityTime >= cutoff;
    })
    .filter(s => !s.parentSessionId)
    .filter(s => !projectFilter || s.projectCwd === projectFilter);
  return sortSessionsByStatusAndPin(filtered, getPinnedIds());
});
```

(`$derived.by`로 블록 구문 사용 — multi-step 계산 가독성 ↑. `getPinnedIds()`가 reactive dependency로 추적됨.)

- [ ] **Step 3: Pin 버튼 마크업 추가**

Edit `server/frontend/src/components/ActiveSessions.svelte` around line 232 (`session-header-top` div 내부), 추가 위치는 status-badge 바로 앞:

Before:
```svelte
<div class="session-header-top">
  <span class="status-badge {ds.cssClass}" class:status-flash={flashingIds.has(session.sessionId)}>{ds.label}{#if ds.cssClass === 'status-working'}&nbsp;<span class="dot-loader"><span></span><span></span><span></span></span>{/if}</span>
  <span class="session-title">{session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 8)}</span>
```

After:
```svelte
<div class="session-header-top">
  <button
    type="button"
    class="pin-btn"
    class:pinned={isPinned(session.sessionId)}
    aria-label={isPinned(session.sessionId) ? 'Unpin session' : 'Pin session'}
    title={isPinned(session.sessionId) ? 'Unpin' : 'Pin'}
    onclick={(e) => { e.stopPropagation(); togglePin(session.sessionId); }}
  >📌</button>
  <span class="status-badge {ds.cssClass}" class:status-flash={flashingIds.has(session.sessionId)}>{ds.label}{#if ds.cssClass === 'status-working'}&nbsp;<span class="dot-loader"><span></span><span></span><span></span></span>{/if}</span>
  <span class="session-title">{session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 8)}</span>
```

- [ ] **Step 4: `.pinned` 하이라이트 및 버튼 CSS 추가**

Edit `server/frontend/src/components/ActiveSessions.svelte` — `<style>` 블록 안 적절한 위치 (`.session-item` 정의 근처)에 추가:

```css
  .session-item.pinned {
    border-left: 2px solid var(--color-primary, #4a9eff);
  }

  .pin-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 0.25rem;
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.25;
    transition: opacity 150ms ease;
  }
  .session-item:hover .pin-btn,
  .pin-btn.pinned {
    opacity: 1;
  }
  .pin-btn:focus-visible {
    outline: 1px solid var(--color-primary, #4a9eff);
    outline-offset: 1px;
    opacity: 1;
  }
```

(`--color-primary` 변수가 전역에 있는지 확인; 없으면 fallback `#4a9eff` 사용.)

- [ ] **Step 5: `p` 키 단축키 추가**

Edit `server/frontend/src/components/ActiveSessions.svelte` `handleSessionKeydown` 함수 (around line 95), `switch (e.key)` 블록의 `case 'e'` 다음에 추가:

```typescript
      case 'p': {
        if (focusedSessionIndex >= 0 && focusedSessionIndex < len) {
          e.preventDefault();
          togglePin(topLevelSessions[focusedSessionIndex].sessionId);
        }
        break;
      }
```

- [ ] **Step 6: 빌드 확인**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npm run build
```

Expected: `✓ built in ...`, TypeScript/Svelte 에러 없음 (기존 unused-selector 경고는 무시).

- [ ] **Step 7: 단위 테스트 재실행 (회귀 확인)**

```bash
npx vitest run
```

Expected: 모든 테스트 pass.

- [ ] **Step 8: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/frontend/src/components/ActiveSessions.svelte
git commit -m "feat(frontend): pin UI + sort + p-key in ActiveSessions"
```

---

## Task 4: SessionCards에 pin UI/sort/키보드 통합

**Files:**
- Modify: `server/frontend/src/components/SessionCards.svelte`

- [ ] **Step 1: import 확장**

Edit `server/frontend/src/components/SessionCards.svelte` line 8:

Before:
```typescript
import { relativeTime, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges, statusSortPriority } from "../lib/utils";
```

After:
```typescript
import { relativeTime, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges, sortSessionsByStatusAndPin } from "../lib/utils";
import { isPinned, togglePin, getPinnedIds } from "../lib/stores/pinned.svelte";
```

- [ ] **Step 2: `filteredSessions` derived의 sort 교체**

Edit `server/frontend/src/components/SessionCards.svelte` around line 48-68:

Before:
```typescript
let filteredSessions = $derived(
  sessions
    .filter(...)
    ...
    .slice()
    .sort((a, b) => {
      const sp = statusSortPriority(a) - statusSortPriority(b);
      if (sp !== 0) return sp;
      return b.lastActivityTime - a.lastActivityTime;
    })
);
```

After:
```typescript
let filteredSessions = $derived.by(() => {
  const filtered = sessions
    .filter(s => !machineFilter || s.machineId === machineFilter)
    .filter(s => {
      if (sourceFilter === "all") return true;
      if (sourceFilter === "opencode") return !s.source || s.source === "opencode";
      return s.source === sourceFilter;
    })
    .filter(s => {
      if (s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.waitingForInput) return true;
      const cutoff = getTimeRangeCutoff();
      return cutoff === 0 || s.lastActivityTime >= cutoff;
    })
    .filter(s => !s.parentSessionId)
    .filter(s => !projectFilter || s.projectCwd === projectFilter);
  return sortSessionsByStatusAndPin(filtered, getPinnedIds());
});
```

- [ ] **Step 3: 카드에 pin 버튼 + `.pinned` 클래스 추가**

Edit `server/frontend/src/components/SessionCards.svelte` — `{#each filteredSessions as session}` 블록 내 카드 루트 div. 현재 클래스 속성에 `class:pinned` 추가하고 카드 내부 첫 자식으로 pin 버튼 삽입.

이 파일의 카드 마크업을 먼저 읽고(이 플랜 Task 실행 시 Read 도구 사용) 카드 루트를 찾은 뒤:

1. 카드 루트 div의 `class:` 속성 리스트에 `class:pinned={isPinned(session.sessionId)}` 추가.
2. 카드 루트 div 첫 자식으로 pin 버튼 삽입:

```svelte
<button
  type="button"
  class="pin-btn corner"
  class:pinned={isPinned(session.sessionId)}
  aria-label={isPinned(session.sessionId) ? 'Unpin session' : 'Pin session'}
  title={isPinned(session.sessionId) ? 'Unpin' : 'Pin'}
  onclick={(e) => { e.stopPropagation(); togglePin(session.sessionId); }}
>📌</button>
```

- [ ] **Step 4: CSS 추가**

Edit `server/frontend/src/components/SessionCards.svelte` — `<style>` 블록에 추가:

```css
  .session-card {
    position: relative;
  }
  .session-card.pinned {
    border-left: 2px solid var(--color-primary, #4a9eff);
  }
  .pin-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 0.25rem;
    font-size: 0.9rem;
    line-height: 1;
    opacity: 0.25;
    transition: opacity 150ms ease;
  }
  .session-card:hover .pin-btn,
  .pin-btn.pinned {
    opacity: 1;
  }
  .pin-btn.corner {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    z-index: 1;
  }
  .pin-btn:focus-visible {
    outline: 1px solid var(--color-primary, #4a9eff);
    outline-offset: 1px;
    opacity: 1;
  }
```

(기존에 `.session-card`에 `position: relative`가 이미 선언돼 있으면 중복 선언 제거.)

- [ ] **Step 5: `p` 키 단축키 추가**

Edit `server/frontend/src/components/SessionCards.svelte` `handleKeydown` 함수 (around line 121), `switch (e.key)` 블록의 `case 'c'` 다음에 추가:

```typescript
      case 'p':
        if (focusedIndex >= 0 && focusedIndex < len) {
          e.preventDefault();
          togglePin(filteredSessions[focusedIndex].sessionId);
        }
        break;
```

- [ ] **Step 6: 빌드 확인**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npm run build
```

Expected: 성공.

- [ ] **Step 7: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/frontend/src/components/SessionCards.svelte
git commit -m "feat(frontend): pin UI + sort + p-key in SessionCards"
```

---

## Task 5: ShortcutCheatsheet에 `p` 등록

**Files:**
- Modify: `server/frontend/src/components/ShortcutCheatsheet.svelte`

- [ ] **Step 1: `세션 패널 (h)` 섹션에 `p` 항목 추가**

Edit `server/frontend/src/components/ShortcutCheatsheet.svelte` — `shortcuts: [ { key: "j / ↓", desc: "다음 세션" }, ... ]` 배열에 `e / Enter` 다음 추가:

Before:
```typescript
    {
      title: "세션 패널 (h)",
      shortcuts: [
        { key: "j / ↓", desc: "다음 세션" },
        { key: "k / ↑", desc: "이전 세션" },
        { key: "e / Enter", desc: "세션 필터 토글" },
      ],
    },
```

After:
```typescript
    {
      title: "세션 패널 (h)",
      shortcuts: [
        { key: "j / ↓", desc: "다음 세션" },
        { key: "k / ↑", desc: "이전 세션" },
        { key: "e / Enter", desc: "세션 필터 토글" },
        { key: "p", desc: "세션 pin / unpin" },
      ],
    },
```

- [ ] **Step 2: 빌드 확인**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npm run build
```

Expected: 성공.

- [ ] **Step 3: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/frontend/src/components/ShortcutCheatsheet.svelte
git commit -m "docs(frontend): register p key in ShortcutCheatsheet"
```

---

## Task 6: E2E 테스트 추가

**Files:**
- Modify: `server/e2e/ui/dashboard.spec.ts`

- [ ] **Step 1: 기존 파일 구조 재확인**

```bash
cd /Users/sbbae/project/session-dashboard
wc -l server/e2e/ui/dashboard.spec.ts
```

파일 끝에 새 `test.describe` 블록 추가. 기존 helpers (`waitForDashboardReady`) 재사용.

- [ ] **Step 2: Pin e2e 테스트 작성**

Append to `server/e2e/ui/dashboard.spec.ts` (파일 끝):

```typescript
// =============================================================================
// Pin / Favorite
// =============================================================================

test.describe('Session Pin', () => {
  test.beforeEach(async ({ page }) => {
    // 테스트 간 pin 상태 격리 — localStorage 초기화
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('session-dashboard:pinned'));
    await page.reload();
    await waitForDashboardReady(page);
  });

  test('pin 버튼 클릭 시 카드가 최상단(같은 status 내)으로 이동', async ({ page }) => {
    const sessions = page.locator('[data-testid="active-sessions"] .session-item');
    const count = await sessions.count();
    test.skip(count < 2, '세션이 2개 미만이면 정렬 검증 불가');

    // 마지막(가장 아래) idle 세션을 pin → 같은 status 그룹 내에서 상위로 이동하는지 확인
    const targetIdle = sessions.filter({ has: page.locator('.status-idle') }).last();
    test.skip(!(await targetIdle.count()), 'idle 세션 없음');

    const targetTitle = await targetIdle.locator('.session-title').innerText();
    await targetIdle.locator('.pin-btn').click();

    // 재정렬 후 같은 title을 가진 세션이 더 앞쪽 idle 슬롯에 있어야 함
    const idleItems = sessions.filter({ has: page.locator('.status-idle') });
    const firstIdleTitle = await idleItems.first().locator('.session-title').innerText();
    expect(firstIdleTitle).toBe(targetTitle);

    // pinned 클래스 적용 확인
    await expect(idleItems.first()).toHaveClass(/pinned/);
  });

  test('pinned 상태가 페이지 리로드 후에도 유지', async ({ page }) => {
    const firstItem = page.locator('[data-testid="active-sessions"] .session-item').first();
    test.skip(!(await firstItem.count()), '세션 없음');

    const titleBefore = await firstItem.locator('.session-title').innerText();
    await firstItem.locator('.pin-btn').click();
    await expect(firstItem).toHaveClass(/pinned/);

    // localStorage 검증
    const stored = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).length).toBeGreaterThan(0);

    // 리로드 후 동일 세션이 여전히 pinned
    await page.reload();
    await waitForDashboardReady(page);

    // pin된 세션을 title 매칭으로 다시 찾음
    const pinnedNow = page.locator('[data-testid="active-sessions"] .session-item.pinned')
      .filter({ hasText: titleBefore });
    await expect(pinnedNow.first()).toBeVisible();
  });

  test('pin 버튼 클릭이 세션 상세 네비게이션을 트리거하지 않음', async ({ page }) => {
    const firstItem = page.locator('[data-testid="active-sessions"] .session-item').first();
    test.skip(!(await firstItem.count()), '세션 없음');

    const urlBefore = page.url();
    await firstItem.locator('.pin-btn').click();

    // URL 변화 없음 (세션 상세는 쿼리/해시 변경을 유발함)
    expect(page.url()).toBe(urlBefore);
  });

  test('unpin 클릭 시 하이라이트 제거 및 순서 복원', async ({ page }) => {
    const items = page.locator('[data-testid="active-sessions"] .session-item');
    test.skip(!(await items.count()), '세션 없음');

    const target = items.first();
    await target.locator('.pin-btn').click();
    await expect(target).toHaveClass(/pinned/);

    // 같은 버튼 재클릭 → unpin
    await target.locator('.pin-btn').click();
    await expect(target).not.toHaveClass(/pinned/);

    const stored = await page.evaluate(() => localStorage.getItem('session-dashboard:pinned'));
    expect(stored === null || JSON.parse(stored!).length === 0).toBe(true);
  });
});
```

- [ ] **Step 3: E2E 실행 (로컬)**

```bash
cd /Users/sbbae/project/session-dashboard/server
npx playwright test e2e/ui/dashboard.spec.ts --grep "Session Pin"
```

Expected: 4 tests (일부는 세션 수에 따라 skip 가능), 모두 pass 또는 skip.

- [ ] **Step 4: 커밋**

```bash
cd /Users/sbbae/project/session-dashboard
git add server/e2e/ui/dashboard.spec.ts
git commit -m "test(e2e): pin button behavior + persistence"
```

---

## Task 7: 통합 검증 + 배포

- [ ] **Step 1: 프론트엔드 전체 테스트**

```bash
cd /Users/sbbae/project/session-dashboard/server/frontend
npx vitest run
```

Expected: 모든 테스트 pass (Task 1, 2 추가분 포함).

- [ ] **Step 2: 프론트엔드 빌드**

```bash
npm run build
```

Expected: `✓ built in ...`.

- [ ] **Step 3: 로컬 수동 검증 (선택)**

서버를 로컬에서 띄워 브라우저로 확인:
- Monitor 뷰 → 세션 옆 📌 클릭 → 상위로 이동, 좌측 파란 보더.
- `p` 키 → 포커스된 세션 토글.
- 리로드 → pin 유지.
- Sessions 뷰에서도 동일.
- ShortcutCheatsheet (`?`) 열어 `p` 항목 확인.

- [ ] **Step 4: 원격 배포**

`/deploy-dashboard` 스킬 또는 수동:

```bash
cd /Users/sbbae/project/session-dashboard
git push
ssh 192.168.0.2 "bash -lc 'cd ~/project/session-dashboard && git pull && cd server && docker compose up -d --build'"
```

- [ ] **Step 5: 헬스체크 + 번들 교체 확인**

```bash
ssh 192.168.0.2 "curl -s http://127.0.0.1:3097/health"
ssh 192.168.0.2 "curl -s http://127.0.0.1:3097/ | grep -oE 'index-[A-Za-z0-9]+\\.js' | head -1"
```

Expected: `connectedMachines:2/2`, bundle hash가 이전 `BPkgxjzT` 와 달라야 함.

- [ ] **Step 6: 프로덕션 e2e 검증 (선택)**

배포된 URL에서 브라우저로 확인하거나 Playwright e2e를 원격 베이스 URL로 재실행.

---

## Acceptance Criteria (spec §Acceptance) 대조

| AC | 담당 Task |
|----|-----------|
| 1. Monitor pin 토글 (클릭/`p`) | Task 3 |
| 2. Sessions pin 토글 (클릭/`p`) | Task 4 |
| 3. 하이라이트 (좌측 2px 보더, 📌 상시) | Task 3, 4 (CSS) |
| 4. 같은 Status 내 상위 이동 | Task 2 (sort), Task 3/4 (통합) |
| 5. Status invariant 보존 | Task 2 test "idle pinned never outranks working unpinned" |
| 6. 동률 `lastActivityTime` desc | Task 2 test "sorts by lastActivityTime desc" |
| 7. 리로드 후 유지 | Task 1 test "persists", Task 6 e2e |
| 8. pin 클릭이 상세 진입 안 함 | Task 3/4 (`stopPropagation`), Task 6 e2e |
| 9. ShortcutCheatsheet `p` 표시 | Task 5 |
| 10. INPUT/TEXTAREA/SELECT 포커스 시 `p` 무시 | Task 3/4 — 기존 가드 `if (tag === 'INPUT'...)` 재사용, 별도 작업 없음 |

## 롤백 절차

문제 발견 시:
```bash
git revert <commit-sha-range>
git push
ssh 192.168.0.2 "cd ~/project/session-dashboard && git pull && cd server && docker compose up -d --build"
```

localStorage에 남은 pin 상태는 사용자가 DevTools에서 `localStorage.removeItem('session-dashboard:pinned')` 또는 그냥 남겨둬도 무해 (저장소 키만 점유).
