# Timeline Activity Segments — Decisions

## 1. Defensive Unwrap for EnrichmentResponse
**Decision**: Use `raw.data ?? raw as unknown as SessionSegmentsResponse` instead of strict unwrap.
**Rationale**: Provides backward compatibility if agent response format changes. Falls back to treating raw response as SessionSegmentsResponse if `data` field is missing.

## 2. QA Verdict: APPROVE
**Date**: 2026-03-18
**Evidence**: 8/8 scenarios pass, 0 console errors, screenshots captured.
**Condition**: One bug fix applied during QA (type mismatch). Must be committed before deploy.
