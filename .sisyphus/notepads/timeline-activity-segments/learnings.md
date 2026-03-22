# Timeline Activity Segments — Learnings

## 1. Agent EnrichmentResponse Envelope Pattern
Agent wraps all enrichment API responses in `EnrichmentResponse<T>` = `{ data: T, available: boolean, cachedAt?: string }`. Dashboard server's `fetchFromMachine<T>` returns this envelope, NOT the inner `T`. Always unwrap with `raw.data` before accessing domain fields.

## 2. Fastify Route Ordering Matters
Parametric routes (`:feature`) match before specific routes (`timeline-segments`) if registered first. Always register specific routes BEFORE catch-all parametric routes.

## 3. QA Requires Fresh Builds
Stale Docker containers and agent processes mask bugs. Always rebuild both server (Docker) and agent before QA testing. Check container age with `docker ps` and agent PID start time.

## 4. Segment Count as Health Metric
- 1h: ~289 segments (2 sessions)
- 6h: ~292 segments (3 sessions)
- 24h: ~350 segments (4 sessions)
- 7d: ~7202 segments (31 sessions)
These numbers serve as baseline for future regression testing.
