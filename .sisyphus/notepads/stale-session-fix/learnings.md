# Learnings — stale-session-fix Code Review

## F2 Code Quality Review (2026-03-09)

### Pattern: sseConnected tri-state handling
- `sseConnected !== false` correctly handles 3 cases: true→trust, false→fallback, undefined→trust(backward compat)
- `sseConnected === false` used for orphan synthesis skip — strict equality prevents undefined from triggering

### Pattern: Bootstrap race protection
- `existing.updatedAt >= this.sseConnectedAt` skip condition works because SSE events set `updatedAt = Date.now()` which is always >= `sseConnectedAt`
- `connectionState !== 'connected'` early return in bootstrap() prevents stale REST data after SSE disconnect

### Pattern: Backward compat in fetchSessionDetails
- New format `{ meta, sessions }` detected by `'meta' in parsed && 'sessions' in parsed`
- Old flat format falls through — sseConnected will be undefined → `!== false` = true → trusts cache (safe for old agents)
- `meta?.sseConnected ?? false` defaults to conservative (false) if meta exists but field missing

### Test quality
- 20 session-cache tests, 22 machine-manager tests, 10 active-sessions tests
- Tests G-J in active-sessions explicitly cover sseConnected tri-state
- Test 16-18 in session-cache cover bootstrap race condition, first-boot, and disconnect-during-bootstrap
