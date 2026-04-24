# Prompt History Density Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `RecentPrompts.svelte`를 ~30px row 기반 7-column 테이블로 압축해 같은 뷰포트에 ~3배 더 많은 프롬프트를 표시. 모든 기존 정보 보존 + project 아이콘(색+첫글자) 추가 + 반응형(≤600px는 project 이름 드롭).

**Architecture:** (1) 에이전트에 `GitRepoResolver`를 추가해 `projectCwd` → git repo basename을 memoized 캐시로 해석한다. (2) `projectRepo?` 필드를 `DashboardSession`·`QueryEntry`에 추가해 agent→server→frontend로 propagate한다. (3) 프론트엔드에서 `RecentPrompts.svelte`를 CSS grid 행 레이아웃으로 전면 재작성하고, 결정론적(djb2) 색·첫글자 아이콘을 담당할 `projectIcon` util + `ProjectIcon` 컴포넌트를 분리한다.

**Tech Stack:** TypeScript, Svelte 5 (runes), Fastify, Vitest, Playwright, better-sqlite3.

**Spec:** [`docs/superpowers/specs/2026-04-24-prompt-history-density-design.md`](../specs/2026-04-24-prompt-history-density-design.md)

---

## File Map

### Backend
- **CREATE** `agent/src/git-repo-resolver.ts` — memoized `git rev-parse --show-toplevel` resolver
- **CREATE** `agent/src/__tests__/git-repo-resolver.test.ts` — unit tests
- **MODIFY** `server/src/shared/api-contract.ts` — add `projectRepo?: string` to `DashboardSession` and `QueryEntry`
- **MODIFY** `server/src/shared/contract-validators.ts` — allow optional `projectRepo` field
- **MODIFY** `agent/src/server.ts` — wire resolver into `/api/sessions` and `/api/queries` and `/api/claude/sessions` and `/api/claude/queries` responses
- **MODIFY** `server/src/modules/active-sessions/index.ts` — pass `projectRepo` through to `DashboardSession`
- **MODIFY** `server/src/modules/recent-prompts/index.ts` — pass `projectRepo` through `normalizeRaw`

### Frontend
- **CREATE** `server/frontend/src/lib/projectIcon.ts` — `colorFor(name)`, `letterFor(name)`, djb2 palette
- **CREATE** `server/frontend/src/lib/__tests__/projectIcon.test.ts` — determinism tests
- **CREATE** `server/frontend/src/components/ProjectIcon.svelte` — 20×20 monogram + source dot
- **MODIFY** `server/frontend/src/types.ts` — re-export `projectRepo`-aware types (uses shared contract)
- **MODIFY** `server/frontend/src/components/RecentPrompts.svelte` — full row/grid rewrite

### E2E / regression
- **CREATE** `server/e2e/ui/prompt-history-density.spec.ts` — density/hover/icon tests
- **CREATE** `server/e2e/ui/prompt-history-project-icon.spec.ts` — icon determinism
- **MODIFY** `server/e2e/dashboard.spec.ts` and `server/e2e/dashboard-features.spec.ts` — update selectors if they reference `.prompt-item`/`.prompt-clickable` card DOM

---

## Phase 1 — Backend: projectRepo plumbing

### Task 1: GitRepoResolver in agent

**Files:**
- Create: `agent/src/git-repo-resolver.ts`
- Test: `agent/src/__tests__/git-repo-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `agent/src/__tests__/git-repo-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { GitRepoResolver } from '../git-repo-resolver.js';

describe('GitRepoResolver', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'grr-'));
  });

  function makeGitRepo(name: string): string {
    const repo = join(tmpRoot, name);
    mkdirSync(repo, { recursive: true });
    execSync('git init -q', { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test');
    return repo;
  }

  it('returns repo basename for git directories', () => {
    const repo = makeGitRepo('my-project');
    const resolver = new GitRepoResolver();

    expect(resolver.resolve(repo)).toBe('my-project');
  });

  it('returns repo basename when cwd is a subdirectory', () => {
    const repo = makeGitRepo('parent');
    const sub = join(repo, 'server', 'frontend');
    mkdirSync(sub, { recursive: true });
    const resolver = new GitRepoResolver();

    expect(resolver.resolve(sub)).toBe('parent');
  });

  it('returns null when cwd is not inside a git repo', () => {
    const nonGit = join(tmpRoot, 'not-a-repo');
    mkdirSync(nonGit, { recursive: true });
    const resolver = new GitRepoResolver();

    expect(resolver.resolve(nonGit)).toBeNull();
  });

  it('returns null when cwd does not exist', () => {
    const resolver = new GitRepoResolver();

    expect(resolver.resolve('/nonexistent/path/xyz')).toBeNull();
  });

  it('caches repeated calls — only executes git once per cwd', () => {
    const repo = makeGitRepo('cached');
    const spy = vi.fn().mockReturnValue(repo);
    const resolver = new GitRepoResolver({ runGit: spy });

    resolver.resolve(repo);
    resolver.resolve(repo);
    resolver.resolve(repo);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches null results too (non-git dirs)', () => {
    const spy = vi.fn().mockReturnValue(null);
    const resolver = new GitRepoResolver({ runGit: spy });

    resolver.resolve('/nonexistent');
    resolver.resolve('/nonexistent');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('treats null and undefined cwd as null', () => {
    const resolver = new GitRepoResolver();

    expect(resolver.resolve(null)).toBeNull();
    expect(resolver.resolve(undefined)).toBeNull();
    expect(resolver.resolve('')).toBeNull();
  });

  // Teardown
  it('cleans up', () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && npm test -- git-repo-resolver`
Expected: FAIL with "Cannot find module '../git-repo-resolver.js'"

- [ ] **Step 3: Implement GitRepoResolver**

Create `agent/src/git-repo-resolver.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export interface GitRepoResolverOptions {
  /** Injected for tests. Returns toplevel path or null. */
  runGit?: (cwd: string) => string | null;
}

/**
 * Resolve a cwd to its git repository root basename.
 * Returns null for non-git directories. Results are memoized per cwd.
 */
export class GitRepoResolver {
  private cache = new Map<string, string | null>();
  private runGit: (cwd: string) => string | null;

  constructor(opts: GitRepoResolverOptions = {}) {
    this.runGit = opts.runGit ?? defaultRunGit;
  }

  resolve(cwd: string | null | undefined): string | null {
    if (!cwd) return null;
    if (this.cache.has(cwd)) return this.cache.get(cwd)!;

    const toplevel = this.runGit(cwd);
    const result = toplevel ? basename(toplevel) : null;
    this.cache.set(cwd, result);
    return result;
  }
}

function defaultRunGit(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && npm test -- git-repo-resolver`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/src/git-repo-resolver.ts agent/src/__tests__/git-repo-resolver.test.ts
git commit -m "feat(agent): add GitRepoResolver with memoized cache"
```

---

### Task 2: Add `projectRepo` to shared API contract

**Files:**
- Modify: `server/src/shared/api-contract.ts:42-76` (add to `DashboardSession`)
- Modify: `server/src/shared/api-contract.ts:84-97` (add to `QueryEntry`)
- Modify: `server/src/shared/contract-validators.ts:101` (accept optional field)

- [ ] **Step 1: Edit api-contract.ts — add `projectRepo?` to DashboardSession**

In `server/src/shared/api-contract.ts`, find the `DashboardSession` interface (around line 42) and add `projectRepo?` immediately after `projectCwd`:

```typescript
  projectCwd: string | null;
  /** git repo basename (e.g. "session-dashboard"). null/undefined → fallback to projectCwd basename on frontend */
  projectRepo?: string | null;
```

Find the `QueryEntry` interface (around line 84) and add `projectRepo?` after `sessionTitle`:

```typescript
  sessionTitle: string | null;
  /** git repo basename. null/undefined → frontend falls back to projectCwd basename via session lookup */
  projectRepo?: string | null;
  timestamp: number;
```

- [ ] **Step 2: Update contract-validators.ts**

In `server/src/shared/contract-validators.ts`, find the block validating `DashboardSession` fields (line ~101). Add a validator for the new optional field right after the `projectCwd` line:

```typescript
  push(check('projectCwd', 'string | null', s.projectCwd, isStringOrNull(s.projectCwd)));
  if (s.projectRepo !== undefined) {
    push(check('projectRepo', 'string | null | undefined', s.projectRepo, isStringOrNull(s.projectRepo)));
  }
```

If there is a similar validator block for `QueryEntry` in the same file, add equivalent for `sessionTitle` / `projectRepo` block. (Search first: `grep -n 'QueryEntry' server/src/shared/contract-validators.ts`. If absent, skip.)

- [ ] **Step 3: Verify type-check**

Run: `cd server && npx tsc --noEmit`
Expected: PASS (no new errors; unused field warnings are expected until Tasks 3–4 land)

- [ ] **Step 4: Commit**

```bash
git add server/src/shared/api-contract.ts server/src/shared/contract-validators.ts
git commit -m "feat(contract): add optional projectRepo to DashboardSession and QueryEntry"
```

---

### Task 3: Agent wires projectRepo into session and query responses

**Files:**
- Modify: `agent/src/server.ts` (instantiate resolver, enrich session and query responses)
- Modify: `agent/src/claude-source.ts` (enrich Claude query entries)
- Modify: `agent/src/oc-query-collector.ts` (enrich OpenCode query entries)
- Modify: `agent/src/claude-heartbeat.ts` (enrich Claude session list)

- [ ] **Step 1: Write the failing test**

Create `agent/src/__tests__/server-project-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GitRepoResolver } from '../git-repo-resolver.js';
import { enrichSessionWithRepo, enrichQueryWithRepo } from '../git-repo-resolver.js';

describe('enrichment helpers', () => {
  it('enrichSessionWithRepo adds projectRepo from directory', () => {
    const resolver = new GitRepoResolver({
      runGit: (cwd) => (cwd === '/repo/foo' ? '/repo/foo' : null),
    });
    const s = { id: 'abc', directory: '/repo/foo', title: 't' } as Record<string, unknown>;

    const out = enrichSessionWithRepo(s, resolver);

    expect(out.projectRepo).toBe('foo');
  });

  it('enrichSessionWithRepo sets projectRepo=null for non-git cwd', () => {
    const resolver = new GitRepoResolver({ runGit: () => null });
    const s = { id: 'abc', directory: '/tmp/non-git' } as Record<string, unknown>;

    const out = enrichSessionWithRepo(s, resolver);

    expect(out.projectRepo).toBeNull();
  });

  it('enrichQueryWithRepo resolves via sessionId → directory map', () => {
    const resolver = new GitRepoResolver({
      runGit: (cwd) => (cwd === '/repo/bar' ? '/repo/bar' : null),
    });
    const directoryForSession = new Map([['sess-1', '/repo/bar']]);
    const q = { sessionId: 'sess-1', query: 'hi' } as Record<string, unknown>;

    const out = enrichQueryWithRepo(q, resolver, directoryForSession);

    expect(out.projectRepo).toBe('bar');
  });

  it('enrichQueryWithRepo returns projectRepo=null when session directory missing', () => {
    const resolver = new GitRepoResolver();
    const q = { sessionId: 'unknown', query: 'hi' } as Record<string, unknown>;

    const out = enrichQueryWithRepo(q, resolver, new Map());

    expect(out.projectRepo).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && npm test -- server-project-repo`
Expected: FAIL with "enrichSessionWithRepo is not a function"

- [ ] **Step 3: Add helpers to git-repo-resolver.ts**

In `agent/src/git-repo-resolver.ts`, append:

```typescript
/** Returns a shallow clone of the session raw object with projectRepo added. */
export function enrichSessionWithRepo<T extends Record<string, unknown>>(
  session: T,
  resolver: GitRepoResolver,
): T & { projectRepo: string | null } {
  const directory = (session.directory as string | null | undefined) ?? null;
  const projectRepo = resolver.resolve(directory);
  return { ...session, projectRepo };
}

/** Returns a shallow clone of the query with projectRepo added, using sessionId→directory map. */
export function enrichQueryWithRepo<T extends { sessionId?: string }>(
  query: T,
  resolver: GitRepoResolver,
  directoryForSession: ReadonlyMap<string, string | null>,
): T & { projectRepo: string | null } {
  const sessionId = query.sessionId ?? '';
  const directory = directoryForSession.get(sessionId) ?? null;
  const projectRepo = resolver.resolve(directory);
  return { ...query, projectRepo };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && npm test -- server-project-repo`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire GitRepoResolver into agent server.ts**

In `agent/src/server.ts` near the top of the file (after imports), add:

```typescript
import { GitRepoResolver, enrichSessionWithRepo, enrichQueryWithRepo } from './git-repo-resolver.js';
```

In the function where the fastify app is constructed, instantiate the resolver **once** (scan for where `ocQueryCollector`, `promptStore` are instantiated and add next to them):

```typescript
const gitRepoResolver = new GitRepoResolver();
```

- [ ] **Step 6: Enrich /api/sessions response**

Find the `/api/sessions` handler (around line 303 — the one that proxies `oc-serve/session`). Wrap the `sessions` array with enrichment before returning:

```typescript
const sessions = Array.isArray(data) ? data : [];
const enriched = sessions.map(s => enrichSessionWithRepo(s as Record<string, unknown>, gitRepoResolver));
return { sessions: enriched };
```

Do the same in the `fallback` path (the `catch` block that returns `{ sessions, fallback: true }`):

```typescript
return { sessions: sessions.map(s => enrichSessionWithRepo(s, gitRepoResolver)), fallback: true };
```

- [ ] **Step 7: Enrich /api/claude/sessions response**

Find the `/api/claude/sessions` handler (around line 359). Replace its body with:

```typescript
app.get('/api/claude/sessions', async () => {
  const sessions = claudeHeartbeat.getActiveSessions();
  const enriched = sessions.map(s => enrichSessionWithRepo(s as Record<string, unknown>, gitRepoResolver));
  return { sessions: enriched };
});
```

- [ ] **Step 8: Build a sessionId→directory map for query enrichment**

Add a helper near the top of `agent/src/server.ts`:

```typescript
function buildDirectoryMap(sessionsRaw: Array<Record<string, unknown>>): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const s of sessionsRaw) {
    const id = (s.id as string) ?? (s.sessionId as string);
    if (!id) continue;
    const dir = (s.directory as string | null | undefined) ?? null;
    m.set(id, dir);
  }
  return m;
}
```

- [ ] **Step 9: Enrich /api/queries response**

Find the `/api/queries` handler (around line 277). Replace its body with:

```typescript
app.get<{ Querystring: { limit?: string } }>('/api/queries', async (request) => {
  const limit = parseLimit(request.query.limit);

  const getEnriched = (queries: QueryEntry[]): QueryEntry[] => {
    // best-effort directory lookup via sessionCache (oc-serve) or claudeHeartbeat
    const dirMap = new Map<string, string | null>();
    if (claudeHeartbeat) {
      for (const s of claudeHeartbeat.getActiveSessions() as Array<Record<string, unknown>>) {
        const id = s.id as string;
        if (id) dirMap.set(id, (s.directory as string | null) ?? null);
      }
    }
    if (sessionCache) {
      for (const s of sessionCache.getCachedSessions() as Array<Record<string, unknown>>) {
        const id = (s.id as string) ?? (s.sessionId as string);
        if (id && !dirMap.has(id)) dirMap.set(id, (s.directory as string | null) ?? null);
      }
    }
    return queries.map(q => enrichQueryWithRepo(q, gitRepoResolver, dirMap) as QueryEntry);
  };

  // 1) Instant response from SQLite (persistent store)
  if (promptStore && promptStore.count() > 0) {
    const queries = promptStore.getRecent(limit);
    const response: QueriesResponse = { queries: getEnriched(queries) };
    return response;
  }

  // 2) Fallback: live collection from oc-serve
  if (ocQueryCollector) {
    const queries = await ocQueryCollector.collectQueries(limit);
    const response: QueriesResponse = { queries: getEnriched(queries) };
    return response;
  }

  // 3) Final fallback: queries.jsonl
  const filePath = join(config.historyDir, 'queries.jsonl');
  const reader = new JsonlReader<Record<string, unknown>>(filePath);
  const queries = await reader.tailLines(limit);
  const response: QueriesResponse = { queries: queries as unknown as QueryEntry[] };
  return response;
});
```

> **Note on `sessionCache.getCachedSessions()`:** if that method doesn't exist, check `session-cache.ts` for an equivalent getter and substitute its name. If no getter exists, skip that branch (Claude-only enrichment is acceptable for the fallback path).

- [ ] **Step 10: Enrich /api/claude/queries response**

Find the `/api/claude/queries` handler (around line 365). Replace with:

```typescript
app.get<{ Querystring: { limit?: string; sessionId?: string } }>('/api/claude/queries', async (request) => {
  const limit = parseLimit(request.query.limit);
  const sessionId = request.query.sessionId || undefined;
  const queries = await claudeSource!.getRecentQueries(limit, sessionId);

  const dirMap = new Map<string, string | null>();
  for (const s of claudeHeartbeat.getActiveSessions() as Array<Record<string, unknown>>) {
    const id = s.id as string;
    if (id) dirMap.set(id, (s.directory as string | null) ?? null);
  }
  const enriched = queries.map(q => enrichQueryWithRepo(q as unknown as Record<string, unknown>, gitRepoResolver, dirMap));
  return { queries: enriched };
});
```

- [ ] **Step 11: Build agent**

Run: `cd agent && npm run build`
Expected: PASS (no TS errors)

- [ ] **Step 12: Run all agent tests**

Run: `cd agent && npm test`
Expected: PASS (all existing tests + new ones)

- [ ] **Step 13: Commit**

```bash
git add agent/src/git-repo-resolver.ts agent/src/server.ts agent/src/__tests__/server-project-repo.test.ts
git commit -m "feat(agent): enrich sessions and queries with projectRepo"
```

---

### Task 4: Server propagates projectRepo through modules

**Files:**
- Modify: `server/src/modules/active-sessions/index.ts:264` and `:310` (pass projectRepo through)
- Modify: `server/src/modules/recent-prompts/index.ts:166-179` (normalizeRaw includes projectRepo)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/project-repo-propagation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// Relative import based on the normalizeRaw location
import { normalizeRawForTest } from '../modules/recent-prompts/index.test-export.js';

describe('normalizeRaw — projectRepo propagation', () => {
  it('preserves projectRepo when present on raw', () => {
    const raw = {
      sessionId: 's1',
      timestamp: 1,
      query: 'q',
      source: 'claude-code',
      projectRepo: 'my-repo',
      machineId: 'm',
    };
    const q = normalizeRawForTest(raw);
    expect(q.projectRepo).toBe('my-repo');
  });

  it('sets projectRepo=null when absent', () => {
    const raw = {
      sessionId: 's1',
      timestamp: 1,
      query: 'q',
      source: 'opencode',
      machineId: 'm',
    };
    const q = normalizeRawForTest(raw);
    expect(q.projectRepo).toBeNull();
  });
});
```

- [ ] **Step 2: Expose `normalizeRaw` for testing**

At the bottom of `server/src/modules/recent-prompts/index.ts`, add a test-only named export:

```typescript
// Exposed for tests only — do not use from production code
export { normalizeRaw as normalizeRawForTest };
```

(If the module uses ESM-only `.js` import resolution and `import` statements don't easily find unlisted named exports, skip the rename and re-export with the original name instead: `export { normalizeRaw };`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test -- project-repo-propagation`
Expected: FAIL with `projectRepo` field missing on result.

- [ ] **Step 4: Update `normalizeRaw` in recent-prompts**

Edit `server/src/modules/recent-prompts/index.ts` line 166–179. Replace the body of `normalizeRaw` with:

```typescript
function normalizeRaw(raw: Record<string, unknown>): QueryEntry {
  return {
    sessionId: (raw.sessionId as string) ?? "",
    sessionTitle: (raw.sessionTitle as string | null) ?? null,
    projectRepo: (raw.projectRepo as string | null | undefined) ?? null,
    timestamp: (raw.timestamp as number) ?? 0,
    query: (raw.query as string) ?? "",
    isBackground: (raw.isBackground as boolean) ?? false,
    source: (raw.source as string) === 'claude-code' ? 'claude-code' as const : 'opencode' as const,
    completedAt: (raw.completedAt as number | null) ?? null,
    machineId: (raw.machineId as string) ?? "",
    machineHost: (raw.machineHost as string) ?? "",
    machineAlias: (raw.machineAlias as string) ?? "",
  };
}
```

- [ ] **Step 5: Update QueryEntry import**

Check the server's local QueryEntry declaration (likely `server/src/modules/recent-prompts/queries-reader.ts`). If it mirrors the contract, add `projectRepo?: string | null`. If it **reuses** the contract type via `import type`, no change needed. Run:

```bash
grep -n "projectRepo\|QueryEntry" server/src/modules/recent-prompts/queries-reader.ts
```

If local shape exists, add `projectRepo: string | null` (not optional at this module's internal layer — `null` default).

- [ ] **Step 6: Update active-sessions module**

In `server/src/modules/active-sessions/index.ts`, find the two places (~lines 264 and ~310) where `projectCwd` is assigned on a `DashboardSession` literal. For each, add `projectRepo` pulled from the raw/cached source:

Line ~264 block (raw session from agent):

```typescript
        projectCwd: (s.directory as string) || null,
        projectRepo: (s.projectRepo as string | null | undefined) ?? null,
```

Line ~310 block (cached fallback):

```typescript
        projectCwd: cached.directory,
        projectRepo: (cached as { projectRepo?: string | null }).projectRepo ?? null,
```

If `cached` comes from a typed cache, extend that cache type with `projectRepo?: string | null`.

- [ ] **Step 7: Run tests and type-check**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS (new propagation test + no TS errors)

- [ ] **Step 8: Run validator and integration test**

Run: `cd server && npm test -- contract`
Expected: PASS (existing contract validators unaffected)

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/active-sessions/index.ts server/src/modules/recent-prompts/index.ts server/src/__tests__/project-repo-propagation.test.ts
git commit -m "feat(server): propagate projectRepo through active-sessions and recent-prompts"
```

---

## Phase 2 — Frontend: projectIcon utility + component

### Task 5: projectIcon utility

**Files:**
- Create: `server/frontend/src/lib/projectIcon.ts`
- Test: `server/frontend/src/lib/__tests__/projectIcon.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/frontend/src/lib/__tests__/projectIcon.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { colorFor, letterFor, PROJECT_PALETTE } from '../projectIcon';

describe('projectIcon', () => {
  describe('colorFor', () => {
    it('returns a color from the palette', () => {
      expect(PROJECT_PALETTE).toContain(colorFor('session-dashboard'));
    });

    it('is deterministic — same input yields same color', () => {
      expect(colorFor('foo')).toBe(colorFor('foo'));
      expect(colorFor('my-repo')).toBe(colorFor('my-repo'));
    });

    it('different inputs tend to yield different colors', () => {
      const seen = new Set(
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map(colorFor),
      );
      // Not required to be all-unique, but the 8-color palette should spread
      expect(seen.size).toBeGreaterThanOrEqual(3);
    });

    it('returns fallback color for null/empty', () => {
      const fallback = colorFor(null);
      expect(fallback).toBe(PROJECT_PALETTE[PROJECT_PALETTE.length - 1]);
      expect(colorFor('')).toBe(fallback);
      expect(colorFor(undefined)).toBe(fallback);
    });
  });

  describe('letterFor', () => {
    it('returns lowercase first character for simple names', () => {
      expect(letterFor('session-dashboard')).toBe('s');
      expect(letterFor('Agent')).toBe('a');
    });

    it('strips leading non-alphanumeric chars', () => {
      expect(letterFor('-tui')).toBe('t');
      expect(letterFor('/server')).toBe('s');
    });

    it('returns "?" for null/empty/no-alphanumeric', () => {
      expect(letterFor(null)).toBe('?');
      expect(letterFor('')).toBe('?');
      expect(letterFor('---')).toBe('?');
      expect(letterFor(undefined)).toBe('?');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/frontend && npm test -- projectIcon`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement projectIcon.ts**

Create `server/frontend/src/lib/projectIcon.ts`:

```typescript
/**
 * Deterministic project icon generator.
 * - color: djb2 hash % palette.length
 * - letter: lowercased first alphanumeric character of the name
 */

export const PROJECT_PALETTE = [
  '#58a6ff', // blue
  '#f78166', // orange
  '#3fb950', // green
  '#d29922', // yellow
  '#bc8cff', // purple
  '#f85149', // red
  '#39c5cf', // teal
  '#8b949e', // gray — also fallback
] as const;

const FALLBACK_COLOR = PROJECT_PALETTE[PROJECT_PALETTE.length - 1];

export function colorFor(name: string | null | undefined): string {
  if (!name) return FALLBACK_COLOR;
  const h = djb2(name);
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}

export function letterFor(name: string | null | undefined): string {
  if (!name) return '?';
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch)) return ch.toLowerCase();
  }
  return '?';
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/frontend && npm test -- projectIcon`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add server/frontend/src/lib/projectIcon.ts server/frontend/src/lib/__tests__/projectIcon.test.ts
git commit -m "feat(frontend): add projectIcon util (djb2 color + first-letter)"
```

---

### Task 6: ProjectIcon.svelte component

**Files:**
- Create: `server/frontend/src/components/ProjectIcon.svelte`

- [ ] **Step 1: Write the component**

Create `server/frontend/src/components/ProjectIcon.svelte`:

```svelte
<script lang="ts">
  import { colorFor, letterFor } from '../lib/projectIcon';
  import type { SessionSource } from '../types';

  let {
    projectRepo = null,
    projectCwd = null,
    source,
    machineAlias = null,
    onclick,
  }: {
    projectRepo?: string | null;
    projectCwd?: string | null;
    source: SessionSource;
    machineAlias?: string | null;
    onclick?: (e: MouseEvent) => void;
  } = $props();

  // Fallback: projectCwd basename if projectRepo is null
  let effectiveName = $derived(
    projectRepo ?? (projectCwd ? projectCwd.split('/').filter(Boolean).pop() ?? null : null)
  );
  let color = $derived(colorFor(effectiveName));
  let letter = $derived(letterFor(effectiveName));
  let title = $derived(
    [effectiveName ?? '(no project)', source, machineAlias]
      .filter(Boolean)
      .join(' · ')
  );
</script>

<button
  type="button"
  class="picon"
  class:clickable={!!onclick}
  class:claude={source === 'claude-code'}
  class:opencode={source === 'opencode'}
  style="background: {color}"
  {title}
  onclick={onclick}
  data-testid="project-icon"
  data-project={effectiveName ?? ''}
>
  {letter}
</button>

<style>
  .picon {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
    position: relative;
    border: none;
    padding: 0;
    cursor: default;
    line-height: 1;
  }

  .picon.clickable { cursor: pointer; }
  .picon.clickable:hover { filter: brightness(1.15); }
  .picon.clickable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .picon::after {
    content: "";
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1.5px solid var(--bg-tertiary, #0d1117);
  }
  .picon.claude::after { background: #a871ff; }
  .picon.opencode::after { background: #3fb950; }
</style>
```

- [ ] **Step 2: Type-check**

Run: `cd server/frontend && npm run build`
Expected: PASS (no TS errors). Component is not yet imported anywhere.

- [ ] **Step 3: Commit**

```bash
git add server/frontend/src/components/ProjectIcon.svelte
git commit -m "feat(frontend): add ProjectIcon.svelte component"
```

---

## Phase 3 — RecentPrompts rewrite

### Task 7: Rewrite RecentPrompts layout (wide)

**Files:**
- Modify: `server/frontend/src/components/RecentPrompts.svelte` (full `<div class="prompts-list">` + styles rewrite)
- Modify: `server/frontend/src/types.ts` (only if `QueryEntry` is re-exported locally; otherwise no change)

Keep all script-level state (filteredQueries, sortedQueries, expandedKeys, responseCache, keyboard nav, clipboard, etc.) unchanged. Only rewrite the template markup block from line ~343 (`<div class="recent-prompts">`) and its CSS below.

- [ ] **Step 1: Replace the template block**

In `server/frontend/src/components/RecentPrompts.svelte`, replace the entire `<div class="recent-prompts" ...>...</div>` template block (lines ~343–453) with:

```svelte
<div class="recent-prompts" data-testid="recent-prompts">
  {#if sortedQueries.length === 0}
    <div class="empty-state">{selectedSessionId ? '선택된 세션의 프롬프트 없음' : '최근 프롬프트 없음'}</div>
  {:else}
    <div class="prompts-table">
      <div class="ph-head" aria-hidden="true">
        <span class="ph-col-status"></span>
        <span class="ph-col-project">project</span>
        <span class="ph-col-session">session</span>
        <span class="ph-col-prompt">prompt</span>
        <span class="ph-col-start">start</span>
        <span class="ph-col-dur">dur</span>
        <span class="ph-col-copy"></span>
      </div>

      {#each sortedQueries as entry, i (entry.sessionId + '-' + entry.timestamp)}
        {@const session = sessionMap.get(entry.sessionId)}
        {@const resolvedTitle = entry.sessionTitle || session?.title || session?.projectCwd?.split('/').pop() || entry.sessionId.slice(0, 8)}
        {@const result = getQueryResult(entry, sessions)}
        {@const completionTs = getCompletionTime(entry)}
        {@const isSessionBusy = (session?.apiStatus === 'busy' || session?.apiStatus === 'retry' || session?.currentTool) && !session?.waitingForInput}
        {@const isLatestForSession = i === latestIndexBySession[entry.sessionId]}
        {@const isWorking = isSessionBusy && isLatestForSession}
        {@const key = entryKey(entry)}
        {@const isExpanded = expandedKeys.has(key)}
        {@const cached = responseCache.get(key)}
        {@const projectRepo = entry.projectRepo ?? session?.projectRepo ?? null}
        {@const projectCwd = session?.projectCwd ?? null}

        <div
          class="ph-row"
          class:in-progress={isWorking}
          class:expanded={isExpanded}
          class:bg={entry.isBackground}
          class:focused={focusedIndex === i}
          data-prompt-index={i}
          data-testid="prompt-row"
        >
          <!-- status -->
          <span class="ph-col-status">
            {#if isWorking}
              <span class="dot-loader-sm" aria-label="실행 중"><span></span><span></span><span></span></span>
            {:else if result === 'completed'}
              <span class="status s-done" title="완료">✓</span>
            {:else if result === 'user_exit'}
              <span class="status s-exit" title="종료">↩</span>
            {:else if result === 'error'}
              <span class="status s-err" title="에러">⚠</span>
            {:else if result === 'idle'}
              <span class="status s-idle" title="대기">○</span>
            {:else if result === 'busy' || result === 'active'}
              <span class="status s-run" title="진행">⟳</span>
            {:else}
              <span class="status s-idle">·</span>
            {/if}
          </span>

          <!-- project -->
          <span class="ph-col-project">
            <ProjectIcon
              projectRepo={projectRepo}
              projectCwd={projectCwd}
              source={entry.source}
              machineAlias={showMachines ? entry.machineAlias : null}
              onclick={(e) => handleProjectIconClick(projectRepo, projectCwd, e)}
            />
            <span class="proj-name" class:fallback={!projectRepo}>
              {#if projectRepo}<span class="git-mark">⎇</span>{/if}
              {projectRepo ?? (projectCwd?.split('/').filter(Boolean).pop() ?? '—')}
            </span>
          </span>

          <!-- session -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="ph-col-session sess-name"
            onclick={(e) => handleSessionClick(entry.sessionId, e)}
            onkeydown={(e) => e.key === 'Enter' && handleSessionClick(entry.sessionId, e)}
            role="button"
            tabindex="0"
            title="세션 필터"
          >{resolvedTitle}</span>

          <!-- prompt — hover or expanded = multi-line -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="ph-col-prompt"
            onclick={() => toggleExpand(entry)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleExpand(entry)}
            role="button"
            tabindex="0"
          >{entry.query}</span>

          <!-- start time -->
          <span class="ph-col-start">{formatTimestamp(entry.timestamp)}</span>

          <!-- duration -->
          <span class="ph-col-dur">
            {#if isWorking}
              —
            {:else if completionTs}
              {formatDuration(completionTs - entry.timestamp)}
            {:else}
              —
            {/if}
          </span>

          <!-- copy -->
          <button
            class="ph-col-copy copy-cmd-btn"
            onclick={(e) => handleCopyCommand(entry, e)}
            title="resume 명령어 복사"
          >⎘</button>
        </div>

        <!-- expanded response area -->
        {#if isExpanded}
          <div class="ph-response">
            {#if isWorking}
              <div class="response-status">
                <span class="dot-loader"><span></span><span></span><span></span></span>
                <span>실행 중...</span>
              </div>
            {:else if cached?.loading}
              <div class="response-status">
                <span class="dot-loader"><span></span><span></span><span></span></span>
                <span>응답 로딩 중...</span>
              </div>
            {:else if cached?.text}
              <div class="response-rendered">{@html renderMarkdown(cached.text)}</div>
            {:else if cached?.error}
              <div class="response-status dim">{cached.error}</div>
            {:else}
              <div class="response-status dim">응답 데이터 없음</div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

{#if toastMessage}
  <div class="copy-toast">{toastMessage}</div>
{/if}
```

- [ ] **Step 2: Add ProjectIcon import and icon-click handler at the top of the `<script>` block**

Find the import section at the top of `RecentPrompts.svelte`. Add:

```typescript
import ProjectIcon from './ProjectIcon.svelte';
import { selectProject } from '../lib/stores/filter.svelte';
```

Near the other handlers (e.g. `handleSessionClick`), add:

```typescript
function handleProjectIconClick(projectRepo: string | null, projectCwd: string | null, event: MouseEvent): void {
  event.stopPropagation();
  const key = projectRepo ?? projectCwd?.split('/').filter(Boolean).pop() ?? null;
  if (key) selectProject(key);
}
```

> **Note:** `selectProject` does not yet exist in the filter store. This step only declares the call — Task 9 wires it up.

- [ ] **Step 3: Replace the entire `<style>` block with the new grid layout**

Replace the entire `<style>` block (starting at line ~459) with:

```svelte
<style>
  .recent-prompts {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .prompts-table {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-bottom: 1rem;
  }

  /* ───── Grid header + rows ───── */
  .ph-head,
  .ph-row {
    display: grid;
    grid-template-columns: 20px 120px 140px minmax(0, 1fr) 62px 54px 20px;
    gap: 10px;
    align-items: center;
    padding: 5px 12px;
  }

  .ph-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border);
    font-size: 9.5px;
    font-family: ui-monospace, "SF Mono", monospace;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .ph-row {
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    transition: background 0.15s ease;
  }
  .ph-row:hover { background: rgba(88, 166, 255, 0.06); }

  .ph-row.focused { outline: 2px solid rgba(88, 166, 255, 0.6); outline-offset: -1px; }

  .ph-row.in-progress {
    background: linear-gradient(90deg, rgba(88, 166, 255, 0.1), var(--bg-tertiary) 60%);
    animation: row-pulse 2.5s ease-in-out infinite;
  }
  @keyframes row-pulse {
    0%, 100% { box-shadow: inset 3px 0 8px rgba(88, 166, 255, 0); }
    50% { box-shadow: inset 3px 0 12px rgba(88, 166, 255, 0.15); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ph-row.in-progress { animation: none; }
  }

  .ph-row.bg {
    opacity: 0.75;
    border-left: 2px solid rgba(139, 148, 158, 0.4);
  }

  /* ───── Status column ───── */
  .ph-col-status { text-align: center; font-size: 12px; }
  .status.s-done { color: var(--success); }
  .status.s-run  { color: var(--accent); }
  .status.s-err  { color: var(--error); }
  .status.s-exit { color: var(--warning); }
  .status.s-idle { color: var(--text-secondary); }

  /* ───── Project column ───── */
  .ph-col-project {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .proj-name {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10.5px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .proj-name.fallback {
    color: var(--text-secondary);
    font-style: italic;
  }
  .git-mark { color: var(--success); font-size: 9px; margin-right: 3px; }

  /* ───── Session column ───── */
  .sess-name {
    color: var(--accent);
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    transition: background 0.15s ease;
  }
  .sess-name:hover { background: rgba(88, 166, 255, 0.12); text-decoration: underline; }
  .sess-name:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }

  /* ───── Prompt column — hover = multi-line ───── */
  .ph-col-prompt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    cursor: pointer;
    color: var(--text-primary);
  }
  .ph-row:hover .ph-col-prompt,
  .ph-row.expanded .ph-col-prompt {
    white-space: normal;
    word-break: break-word;
    overflow: visible;
  }

  /* ───── Start / Dur ───── */
  .ph-col-start,
  .ph-col-dur {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10.5px;
    text-align: right;
    white-space: nowrap;
  }
  .ph-col-start { color: var(--text-secondary); }
  .ph-col-dur  { color: var(--text-secondary); opacity: 0.85; }

  /* ───── Copy button ───── */
  .copy-cmd-btn {
    background: none;
    border: 1px solid rgba(139, 148, 158, 0.3);
    border-radius: 9999px;
    width: 20px;
    height: 20px;
    font-size: 10px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .copy-cmd-btn:hover {
    background: rgba(88, 166, 255, 0.1);
    border-color: rgba(88, 166, 255, 0.4);
    color: var(--accent);
  }

  /* ───── Response area (inline, below row) ───── */
  .ph-response {
    padding: 8px 16px;
    background: rgba(88, 166, 255, 0.03);
    border-left: 3px solid rgba(88, 166, 255, 0.4);
    border-bottom: 1px solid var(--border);
    animation: resp-fadein 0.2s ease-out;
  }
  @keyframes resp-fadein {
    from { opacity: 0; max-height: 0; }
    to { opacity: 1; max-height: 2000px; }
  }
  .response-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
    padding: 0.25rem 0;
  }
  .response-status.dim { opacity: 0.6; font-style: italic; }

  .response-rendered {
    font-size: 0.82rem;
    color: var(--text-primary);
    line-height: 1.6;
  }
  .response-rendered :global(.md-p) { margin: 0.4rem 0; }
  .response-rendered :global(.md-h) { margin: 0.8rem 0 0.3rem; color: var(--text-primary); font-weight: 600; }
  .response-rendered :global(h3.md-h) { font-size: 1rem; }
  .response-rendered :global(h4.md-h) { font-size: 0.92rem; }
  .response-rendered :global(h5.md-h) { font-size: 0.85rem; }
  .response-rendered :global(h6.md-h) { font-size: 0.8rem; }
  .response-rendered :global(.md-list) { margin: 0.3rem 0; padding-left: 1.5rem; }
  .response-rendered :global(.md-list li) { margin: 0.15rem 0; }
  .response-rendered :global(.md-inline-code) {
    background: rgba(110, 118, 129, 0.2);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
    font-size: 0.82rem;
  }
  .response-rendered :global(.md-link) { color: var(--accent); text-decoration: none; }
  .response-rendered :global(.md-link:hover) { text-decoration: underline; }
  .response-rendered :global(.md-hr) { border: none; border-top: 1px solid var(--border); margin: 0.6rem 0; }
  .response-rendered :global(.md-table-wrap) { overflow-x: auto; margin: 0.5rem 0; }
  .response-rendered :global(.md-table) { border-collapse: collapse; font-size: 0.8rem; width: 100%; }
  .response-rendered :global(.md-table th),
  .response-rendered :global(.md-table td) { border: 1px solid var(--border); padding: 0.3rem 0.5rem; text-align: left; }
  .response-rendered :global(.md-table th) { background: rgba(110, 118, 129, 0.1); font-weight: 600; }
  .response-rendered :global(.code-block-wrap),
  .response-rendered :global(.code-fold) {
    margin: 0.5rem 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .response-rendered :global(.code-lang) {
    display: inline-block;
    font-size: 0.7rem;
    color: var(--text-secondary);
    padding: 0.2rem 0.5rem;
    font-family: ui-monospace, monospace;
  }
  .response-rendered :global(.code-block) {
    margin: 0;
    padding: 0.6rem 0.8rem;
    background: rgba(0, 0, 0, 0.25);
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
    color: var(--text-primary);
  }
  .response-rendered :global(.code-fold-summary) {
    cursor: pointer;
    padding: 0.35rem 0.6rem;
    background: rgba(110, 118, 129, 0.08);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    user-select: none;
  }
  .response-rendered :global(.code-fold-summary:hover) { background: rgba(110, 118, 129, 0.15); }
  .response-rendered :global(.code-fold-lines) { font-size: 0.7rem; opacity: 0.7; }

  /* ───── Empty / toast ───── */
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-style: italic;
  }
  .copy-toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-tertiary);
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 0.4rem 1rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    z-index: 1000;
    pointer-events: none;
    animation: toast-fade 1.8s ease-out forwards;
    white-space: nowrap;
  }
  @keyframes toast-fade {
    0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
    75% { opacity: 1; }
    100% { opacity: 0; }
  }

  /* Inline loader used inside status column when in-progress */
  .dot-loader-sm { display: inline-flex; gap: 2px; }
  .dot-loader-sm span {
    width: 3px; height: 3px; border-radius: 50%; background: var(--accent);
    animation: dot-blink 1.2s infinite;
  }
  .dot-loader-sm span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader-sm span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dot-blink { 0%,80%,100% { opacity: 0.2; } 40% { opacity: 1; } }
</style>
```

- [ ] **Step 4: Build frontend**

Run: `cd server/frontend && npm run build`
Expected: PASS. If it errors on `selectProject` (not yet defined), Task 9 will add it — temporarily stub `handleProjectIconClick` with `console.debug(...)` to pass the build; un-stub in Task 9.

> **Temporary stub fix (if build fails at step 4):**
>
> ```typescript
> function handleProjectIconClick(projectRepo: string | null, projectCwd: string | null, event: MouseEvent): void {
>   event.stopPropagation();
>   // TODO(Task 9): wire up to selectProject
> }
> ```

- [ ] **Step 5: Smoke test in dev**

Run: `cd server && npm run dev` (and in another shell `cd server/frontend && npm run dev` if a frontend dev server is configured).
Open the dashboard, visually confirm: rows are compact (~30px), project icons visible, prompts show first line only with hover expanding to multi-line, click still opens response area.

- [ ] **Step 6: Commit**

```bash
git add server/frontend/src/components/RecentPrompts.svelte
git commit -m "feat(frontend): rewrite RecentPrompts as 7-column grid rows"
```

---

### Task 8: Narrow responsive layout (≤600px)

**Files:**
- Modify: `server/frontend/src/components/RecentPrompts.svelte` (append media query)

- [ ] **Step 1: Append narrow media query to `<style>`**

In `server/frontend/src/components/RecentPrompts.svelte`, at the bottom of the `<style>` block (before `</style>`), replace any existing `@media (max-width: 599px)` block with:

```css
  @media (max-width: 600px) {
    .ph-head,
    .ph-row {
      grid-template-columns: 20px 140px minmax(0, 1fr) 54px 20px;
      gap: 8px;
      padding: 5px 10px;
    }
    .ph-col-project {
      /* Keep icon visible, hide project name text */
      grid-column: auto;
    }
    .ph-col-project .proj-name,
    .ph-col-start {
      display: none;
    }
    /* Reorder: status | icon (inside project col) | session | prompt | dur | copy */
    /* Since project's .proj-name is hidden, the icon stays inline with status column.
       Simpler: move icon into its own slot by making status col also hold the icon. */
    .ph-head .ph-col-project,
    .ph-head .ph-col-start {
      display: none;
    }
  }
```

> **Implementation note:** because `grid-template-columns` reduces from 7 to 5, and the project column is dropped from the header but **not** from the rows, we hide just the label text inside the project column and let the icon occupy that slot. This keeps DOM consistent between breakpoints (no slot reshuffle).
>
> Adjusted columns at narrow:
> - status (20) | project-icon (20 — inside ph-col-project, label hidden) — **but the grid now has 5 cols**
>
> The cleanest narrow layout collapses project into status visually. Alternative spec-aligned approach: keep 7 cols in DOM but visually hide project-name text and start column. The CSS above does this.

- [ ] **Step 2: Build and smoke test**

Run: `cd server/frontend && npm run build`
Then open the dashboard, resize browser to ≤600px: verify project name and start time disappear, icon + session + prompt + dur + copy remain.

- [ ] **Step 3: Commit**

```bash
git add server/frontend/src/components/RecentPrompts.svelte
git commit -m "feat(frontend): narrow responsive layout for ≤600px"
```

---

### Task 9: Project-icon click filter

**Files:**
- Modify: `server/frontend/src/lib/stores/filter.svelte.ts` (add `selectedProject` + `selectProject`)
- Modify: `server/frontend/src/components/RecentPrompts.svelte` (apply `selectedProject` filter)
- Modify: `server/frontend/src/App.svelte` (clear-filter UI also clears project)

- [ ] **Step 1: Write the failing test**

Create `server/frontend/src/lib/__tests__/filter-project.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getSelectedProject, selectProject, clearProject } from '../stores/filter.svelte';

describe('filter store — project', () => {
  beforeEach(() => {
    clearProject();
  });

  it('defaults to null', () => {
    expect(getSelectedProject()).toBeNull();
  });

  it('selectProject sets the value', () => {
    selectProject('session-dashboard');
    expect(getSelectedProject()).toBe('session-dashboard');
  });

  it('selectProject with same value toggles off', () => {
    selectProject('foo');
    selectProject('foo');
    expect(getSelectedProject()).toBeNull();
  });

  it('clearProject resets to null', () => {
    selectProject('foo');
    clearProject();
    expect(getSelectedProject()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/frontend && npm test -- filter-project`
Expected: FAIL with "selectProject is not a function".

- [ ] **Step 3: Extend filter store**

In `server/frontend/src/lib/stores/filter.svelte.ts`, add (next to existing session/source filter logic):

```typescript
let selectedProject = $state<string | null>(null);

export function getSelectedProject(): string | null {
  return selectedProject;
}

export function selectProject(repo: string | null): void {
  if (!repo) { selectedProject = null; return; }
  selectedProject = selectedProject === repo ? null : repo;
}

export function clearProject(): void {
  selectedProject = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/frontend && npm test -- filter-project`
Expected: PASS (4 tests)

- [ ] **Step 5: Apply project filter in RecentPrompts**

In `server/frontend/src/components/RecentPrompts.svelte`, at the top of the `<script>` block, add to imports:

```typescript
import { getSelectedProject, selectProject } from '../lib/stores/filter.svelte';
```

Add a derived store:

```typescript
let projectFilter = $derived(getSelectedProject());
```

In the `filteredQueries` derived expression, add a project filter step — after the existing `sourceFilter` step and before the session-id filter:

```typescript
.filter(q => {
  if (!projectFilter) return true;
  const s = sessionMap.get(q.sessionId);
  const repo = q.projectRepo ?? s?.projectRepo ?? null;
  const fallback = s?.projectCwd?.split('/').filter(Boolean).pop() ?? null;
  return (repo ?? fallback) === projectFilter;
})
```

Replace the stub `handleProjectIconClick` from Task 7 with the real implementation:

```typescript
function handleProjectIconClick(projectRepo: string | null, projectCwd: string | null, event: MouseEvent): void {
  event.stopPropagation();
  const key = projectRepo ?? projectCwd?.split('/').filter(Boolean).pop() ?? null;
  if (key) selectProject(key);
}
```

- [ ] **Step 6: Surface clear-project in App.svelte filter bar**

In `server/frontend/src/App.svelte`, find the existing `{#if selectedSessionId}...clearFilter...{/if}` block (around line 301–305). Extend the surrounding conditional to also cover project filter:

```svelte
{#if selectedSessionId || selectedProject}
  <button class="filter-badge" onclick={clearFilter}>
    ✕ 필터 해제{#if selectedProject} ({selectedProject}){/if}
  </button>
{/if}
```

Update the imports and the `clearFilter` function in `App.svelte` to also call `clearProject`:

```typescript
import { getSelectedSessionId, getSelectedProject, clearSession, clearProject } from './lib/stores/filter.svelte';
```

```typescript
let selectedProject = $derived(getSelectedProject());

function clearFilter() {
  clearSession();
  clearProject();
}
```

> If `clearSession` does not exist under that name in the filter store, look for the equivalent (e.g. `selectSession(null)` or similar) and use it.

- [ ] **Step 7: Build and run all unit tests**

Run: `cd server/frontend && npm run build && npm test`
Expected: PASS.

- [ ] **Step 8: Smoke test**

Dev server running: click a project icon. Verify only that project's prompts remain. Click the filter badge to clear. Click the same icon twice to toggle off.

- [ ] **Step 9: Commit**

```bash
git add server/frontend/src/lib/stores/filter.svelte.ts server/frontend/src/lib/__tests__/filter-project.test.ts server/frontend/src/components/RecentPrompts.svelte server/frontend/src/App.svelte
git commit -m "feat(frontend): icon click → filter by project"
```

---

## Phase 4 — E2E tests + regression updates

### Task 10: E2E — density + hover + responsive

**Files:**
- Create: `server/e2e/ui/prompt-history-density.spec.ts`

- [ ] **Step 1: Write the E2E spec**

Create `server/e2e/ui/prompt-history-density.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Prompt History — density & interaction', () => {
  test('rows are ≤ 40px tall when not expanded', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="prompt-row"]');

    const heights = await page.locator('[data-testid="prompt-row"]:not(.expanded)').evaluateAll(
      (els) => els.slice(0, 5).map((el) => (el as HTMLElement).getBoundingClientRect().height)
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) {
      expect(h).toBeLessThanOrEqual(40);
    }
  });

  test('hover expands prompt text to multi-line without changing row width', async ({ page }) => {
    await page.goto('/');
    const firstRow = page.locator('[data-testid="prompt-row"]').first();
    await firstRow.waitFor();

    const widthBefore = await firstRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    await firstRow.hover();
    const widthAfter = await firstRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

    expect(widthAfter).toBe(widthBefore);

    const promptWhiteSpace = await firstRow.locator('.ph-col-prompt').evaluate(
      (el) => getComputedStyle(el).whiteSpace
    );
    expect(promptWhiteSpace).toBe('normal');
  });

  test('click expands response area below the row', async ({ page }) => {
    await page.goto('/');
    const firstRow = page.locator('[data-testid="prompt-row"]').first();
    await firstRow.waitFor();
    await firstRow.locator('.ph-col-prompt').click();
    await expect(page.locator('.ph-response').first()).toBeVisible();
  });

  test('narrow viewport (≤600px) hides project name and start column, keeps session', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="prompt-row"]');

    // session column still visible
    await expect(page.locator('.sess-name').first()).toBeVisible();

    // project-name text hidden
    const projNameDisplay = await page.locator('.proj-name').first().evaluate(
      (el) => getComputedStyle(el).display
    );
    expect(projNameDisplay).toBe('none');

    // start column hidden
    const startDisplay = await page.locator('.ph-col-start').first().evaluate(
      (el) => getComputedStyle(el).display
    );
    expect(startDisplay).toBe('none');

    // icon still rendered
    await expect(page.locator('[data-testid="project-icon"]').first()).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the E2E suite**

Run: `cd server && npm run e2e -- prompt-history-density`
Expected: PASS.

> If the project's e2e runner differs (playwright cli directly or a custom script), use that instead. Check `server/package.json` `"scripts"` for the correct invocation.

- [ ] **Step 3: Commit**

```bash
git add server/e2e/ui/prompt-history-density.spec.ts
git commit -m "test(e2e): prompt-history density + hover + responsive"
```

---

### Task 11: E2E — project icon determinism + filter

**Files:**
- Create: `server/e2e/ui/prompt-history-project-icon.spec.ts`

- [ ] **Step 1: Write the spec**

Create `server/e2e/ui/prompt-history-project-icon.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Prompt History — project icon', () => {
  test('same project name yields same icon color across rows', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-icon"]');

    const groups = await page.locator('[data-testid="project-icon"]').evaluateAll((els) => {
      const m = new Map<string, Set<string>>();
      for (const el of els) {
        const name = el.getAttribute('data-project') ?? '';
        if (!name) continue;
        const bg = (el as HTMLElement).style.background || getComputedStyle(el).background;
        if (!m.has(name)) m.set(name, new Set());
        m.get(name)!.add(bg);
      }
      return Array.from(m.entries()).map(([k, v]) => [k, Array.from(v)] as const);
    });

    for (const [name, colors] of groups) {
      expect(colors.length, `project ${name} should have a single color, got ${colors.length}`).toBe(1);
    }
  });

  test('clicking a project icon filters rows to that project', async ({ page }) => {
    await page.goto('/');
    const icon = page.locator('[data-testid="project-icon"]').first();
    await icon.waitFor();
    const targetProject = await icon.getAttribute('data-project');
    test.skip(!targetProject, 'no project data to assert filter');

    await icon.click();

    const rows = page.locator('[data-testid="prompt-row"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const mismatched = await rows.locator(`[data-testid="project-icon"]:not([data-project="${targetProject}"])`).count();
    expect(mismatched).toBe(0);
  });
});
```

- [ ] **Step 2: Run the E2E suite**

Run: `cd server && npm run e2e -- prompt-history-project-icon`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/e2e/ui/prompt-history-project-icon.spec.ts
git commit -m "test(e2e): project icon determinism + filter"
```

---

### Task 12: Update existing e2e tests for new DOM

**Files:**
- Modify: any `server/e2e/*.spec.ts` referencing `.prompt-item`, `.prompt-clickable`, `.prompt-session`, `.prompt-text`, `.prompt-meta`, or `.prompt-header`

- [ ] **Step 1: Find stale selectors**

Run:

```bash
grep -rn -E '\.prompt-(item|clickable|session|text|meta|header|time|duration)' server/e2e/
```

- [ ] **Step 2: Migrate each match**

For each match, map to the new selector:

| Old selector | New selector |
|---|---|
| `.prompt-item` | `[data-testid="prompt-row"]` |
| `.prompt-clickable` | `.ph-col-prompt` (the clickable prompt cell) |
| `.prompt-session` | `.sess-name` |
| `.prompt-text` | `.ph-col-prompt` |
| `.prompt-header` | (no equivalent — remove the assertion or rewrite to target `.ph-row > .ph-col-*`) |
| `.prompt-time` | `.ph-col-start` |
| `.prompt-duration` | `.ph-col-dur` |

- [ ] **Step 3: Run full e2e suite**

Run: `cd server && npm run e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/e2e/
git commit -m "test(e2e): migrate selectors to new prompt-history DOM"
```

---

## Phase 5 — Verification

### Task 13: Full verification + deploy dry-run

- [ ] **Step 1: Run every test suite**

```bash
cd agent && npm test
cd ../server && npm test
cd ../server/frontend && npm test
cd ../server && npm run e2e
```

Expected: all PASS.

- [ ] **Step 2: Type-check full repo**

```bash
cd agent && npx tsc --noEmit
cd ../server && npx tsc --noEmit
cd ../server/frontend && npm run build
```

Expected: zero errors.

- [ ] **Step 3: Visual regression checklist (manual)**

Open the dashboard in browser:
- [ ] List view rows visibly denser (~30px/row)
- [ ] Project icons display consistent color per repo
- [ ] Non-git sessions show italic gray project name + `?` letter icon
- [ ] Hover expands prompt multi-line; width unchanged
- [ ] Click opens response area below row
- [ ] Click project icon → filters; click again to clear
- [ ] Click session name → filters by session (existing behavior preserved)
- [ ] In-progress row pulses
- [ ] Background queries have left gray border + 0.75 opacity
- [ ] Keyboard: j/k, Enter, e, c, gg, G, Escape all work
- [ ] Resize to ≤600px: project name + start hidden, session + icon + prompt + dur visible
- [ ] Copy button still works (resume command copied)

- [ ] **Step 4: No commit — verification only**

Tests and type-checks passing is the signal. If anything fails, loop back to the owning task.

---

## Self-Review (pre-execution checklist)

- **Spec coverage**:
  - Row layout 7-col ✓ (Task 7)
  - Row ≤ 30px goal ✓ (Task 7 CSS + Task 10 E2E ≤ 40px threshold)
  - project icon color/letter/source dot ✓ (Tasks 5, 6)
  - djb2 hash ✓ (Task 5)
  - git rev-parse → projectRepo ✓ (Task 1)
  - projectRepo in DashboardSession + QueryEntry ✓ (Tasks 2, 4)
  - ≤600px narrow, project name hidden, session kept ✓ (Task 8, verified in Task 10)
  - hover → multi-line ✓ (Task 7 CSS + Task 10 E2E)
  - click → response expand ✓ (Task 7 preserves behavior + Task 10 E2E)
  - icon click → project filter ✓ (Task 9)
  - in-progress gradient + pulse ✓ (Task 7 CSS)
  - background query visual ✓ (Task 7 CSS `.ph-row.bg`)
  - keyboard nav (j/k/Enter/e/c/gg/G/Escape) — preserved from existing script ✓
  - machine alias → icon tooltip ✓ (Task 6 component)
  - source → icon dot ✓ (Task 6 component)
  - unit tests (projectIcon, git-repo-resolver) ✓ (Tasks 1, 5)
  - E2E (density, responsive, icon) ✓ (Tasks 10, 11)

- **Type consistency**:
  - `projectRepo` — `string | null` throughout contract and modules. Optional in contract (`?`), defaulted to `null` in helpers.
  - `colorFor(name)` / `letterFor(name)` — accept `string | null | undefined` consistently.
  - `selectProject(repo)` — `string | null`, toggles.
  - Component `ProjectIcon` props — all optional except `source`.

- **Ambiguity review**:
  - Narrow layout: keeps 7 DOM slots but hides two via CSS (Task 8 note explains). Clear.
  - `sessionCache.getCachedSessions()` might not exist (Task 3 Step 9 note) — executor instructed to verify and substitute.
  - `normalizeRawForTest` export (Task 4 Step 2) — fallback to plain `normalizeRaw` export if Vitest resolution fails.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-prompt-history-density.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints

**Worktree setup**: the user requested a separate worktree at the start of brainstorming. Before executing, create one with `git worktree add ../session-dashboard-prompt-density -b feat/prompt-history-density` (or via `superpowers:using-git-worktrees` skill).

Which approach?
