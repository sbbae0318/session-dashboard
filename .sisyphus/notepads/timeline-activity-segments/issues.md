# Timeline Activity Segments — Issues

## CRITICAL: Route Ordering Bug — Segments API Returns "Invalid feature"

**Date**: 2026-03-18
**Severity**: CRITICAL (blocks tooltip functionality)

### Problem
`/api/enrichment/merged/timeline-segments?sessionId=...` returns `{"error":"Invalid feature"}` instead of segment data.

### Root Cause
In `server/src/modules/enrichment/index.ts`:
- Line 72: Catch-all route `/api/enrichment/merged/:feature` is registered BEFORE the specific route
- Line 185: Dedicated route `/api/enrichment/merged/timeline-segments` is registered AFTER

Fastify matches the parametric `:feature` route first, where `timeline-segments` is not in the valid features list `['timeline', 'impact', 'projects', 'recovery', 'tokens']`.

### Impact
- `segments` Map is always empty for all sessions
- TimelinePage falls to `:else` branch (line 199-208) — renders single fallback rect per session
- Fallback rects have NO `onmouseenter` handler → **tooltip never triggers**
- `class="segment-rect"` never appears in DOM (only segment rects get this class)

### Fix
Register `/api/enrichment/merged/timeline-segments` BEFORE `/api/enrichment/merged/:feature`.
Same issue likely exists for `/api/enrichment/:machineId/timeline-segments` vs `/api/enrichment/:machineId/:feature` (if such a catch-all exists).

### Status: ✅ RESOLVED (commit 390540c)

---

## BUG: SessionSegmentsResponse Type Mismatch in Merged Handler

**Date**: 2026-03-18
**Severity**: HIGH (segments always empty → fallback rects only)

### Problem
`fetchFromMachine<SessionSegmentsResponse>` returned `EnrichmentResponse<SessionSegmentsResponse>` (wrapped in `{data, available, cachedAt}`), but the handler accessed `data.segments` directly — which was `undefined` because `segments` was nested inside `data.data`.

### Root Cause
Agent wraps all enrichment responses in `EnrichmentResponse<T>` envelope. The merged timeline-segments handler didn't unwrap it.

### Fix
Changed type to `fetchFromMachine<EnrichmentResponse<SessionSegmentsResponse>>` and added unwrap: `const segData = raw.data ?? raw as unknown as SessionSegmentsResponse;`

### Status: ✅ RESOLVED (pending commit)
