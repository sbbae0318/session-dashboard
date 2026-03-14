# OpenCode Latency Analysis Report
Generated: 2026-03-10T10:25:35.590Z
Data files: 1

## 1. Measurement Environment
| Key | Value |
|-----|-------|
| OS | darwin arm64 |
| Bun | 1.3.6 |
| OpenCode Source | 1.1.60 |
| Binary | 1.2.22 |
| Data files | 1 |
| Total measurements | 15 |

## 2. Phase Breakdown
| Phase | Count | Min(ms) | Mean(ms) | p50(ms) | p95(ms) | Max(ms) |
|-------|-------|---------|----------|---------|---------|---------|
| loop.iteration | 1 | 2848.0 | 2848.0 | 2848.0 | 2848.0 | 2848.0 |
| prompt.total | 2 | 2000.0 | 2499.5 | 2999.0 | 2999.0 | 2999.0 |
| llm.stream | 2 | 1200.0 | 1625.0 | 2050.0 | 2050.0 | 2050.0 |
| stream.firstEvent | 1 | 1250.0 | 1250.0 | 1250.0 | 1250.0 | 1250.0 |
| resolveTools.total | 1 | 600.0 | 600.0 | 600.0 | 600.0 | 600.0 |
| mcp.tools.total | 2 | 550.0 | 550.0 | 550.0 | 550.0 | 550.0 |
| mcp.listTools.perServer | 2 | 250.0 | 275.0 | 300.0 | 300.0 | 300.0 |
| message.stream | 1 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| createUserMessage | 1 | 45.0 | 45.0 | 45.0 | 45.0 | 45.0 |
| session.get | 1 | 4.0 | 4.0 | 4.0 | 4.0 | 4.0 |
| session.touch | 1 | 2.0 | 2.0 | 2.0 | 2.0 | 2.0 |

## 3. Top Bottlenecks
### Bottleneck 1: loop.iteration
- Mean: 2848.0ms | p95: 2848.0ms | Count: 1
- % of prompt.total: 113.9%

### Bottleneck 2: prompt.total
- Mean: 2499.5ms | p95: 2999.0ms | Count: 2
- % of prompt.total: 100.0%

### Bottleneck 3: llm.stream
- Mean: 1625.0ms | p95: 2050.0ms | Count: 2
- % of prompt.total: 65.0%

## 4. MCP Server Timing
| Server | Min(ms) | Mean(ms) | Max(ms) |
|--------|---------|----------|---------|
| perServer | 250.0 | 275.0 | 300.0 |

## 5. Loop Iteration Analysis
| Phase | Step 1 Mean(ms) | Step 2+ Mean(ms) | Δ |
|-------|-----------------|------------------|---|
| loop.iteration | 2848.0 | — | N/A (no step 2+) |
| message.stream | 100.0 | — | N/A (no step 2+) |
| resolveTools.total | 600.0 | — | N/A (no step 2+) |
| mcp.tools.total | 550.0 | — | N/A (no step 2+) |
| mcp.listTools.perServer | 275.0 | — | N/A (no step 2+) |
| llm.stream | 1625.0 | — | N/A (no step 2+) |
| stream.firstEvent | 1250.0 | — | N/A (no step 2+) |

## 6. Recommendations

1. **mcp.tools.total**: Mean 550.0ms — Consider caching MCP tool lists (MCP.tools() is called on every prompt)
2. **resolveTools.total**: Mean 600.0ms — Tool resolution is slow — profile per-tool initialization
