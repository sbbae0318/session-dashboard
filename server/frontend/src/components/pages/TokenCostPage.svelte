<script lang="ts">
  import { onMount } from 'svelte';
  import { enrichment } from '../../lib/stores/enrichment.svelte';
  import type { SessionTokenStats } from '../../lib/stores/enrichment.svelte';
  import { onMachineChange } from '../../lib/stores/machine.svelte';

  onMount(() => {
    enrichment.fetchTokenStats();
    return onMachineChange(() => enrichment.fetchTokenStats());
  });

  function formatTokens(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  }

  function formatCost(n: number): string {
    return `$${n.toFixed(4)}`;
  }

  function projectLabel(dir: string): string {
    const parts = dir.replace(/\/$/, '').split('/');
    return parts.slice(-2).join('/') || dir;
  }

  interface ProjectRow {
    name: string;
    sessionCount: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }

  let projectRows = $derived((): ProjectRow[] => {
    if (!enrichment.tokenData) return [];
    const map = new Map<string, ProjectRow>();
    for (const s of enrichment.tokenData.sessions) {
      const key = s.directory || s.projectId;
      const existing = map.get(key);
      if (existing) {
        existing.sessionCount += 1;
        existing.input += s.totalInput;
        existing.output += s.totalOutput;
        existing.cacheRead += s.cacheRead;
        existing.cacheWrite += s.cacheWrite;
        existing.cost += s.totalCost;
      } else {
        map.set(key, {
          name: projectLabel(s.directory || s.projectId),
          sessionCount: 1,
          input: s.totalInput,
          output: s.totalOutput,
          cacheRead: s.cacheRead,
          cacheWrite: s.cacheWrite,
          cost: s.totalCost,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  });

  let sessionRows = $derived((): SessionTokenStats[] => {
    if (!enrichment.tokenData) return [];
    return [...enrichment.tokenData.sessions].sort((a, b) => b.totalCost - a.totalCost);
  });
</script>

<div class="page-container" data-testid="page-token-cost">
  <h2 class="page-title">Token &amp; Cost Analytics</h2>

  {#if enrichment.tokenLoading}
    <div class="loading-state">
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
    </div>
  {:else if !enrichment.tokenAvailable || !enrichment.tokenData}
    <div class="empty-state" data-testid="empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
      </svg>
      <p class="empty-title">데이터 없음</p>
      <p class="empty-desc">
        {!enrichment.tokenAvailable ? 'Agent에 OPENCODE_DB_PATH가 설정되지 않았거나 Agent가 연결되지 않았습니다.' : '토큰 통계 데이터가 없습니다.'}
      </p>
    </div>
  {:else}
    <div class="summary-grid" data-testid="token-summary">
      <div class="summary-card">
        <div class="card-label">Input Tokens</div>
        <div class="card-value accent">{formatTokens(enrichment.tokenData.grandTotal.input)}</div>
      </div>
      <div class="summary-card">
        <div class="card-label">Output Tokens</div>
        <div class="card-value">{formatTokens(enrichment.tokenData.grandTotal.output)}</div>
      </div>
      <div class="summary-card">
        <div class="card-label">Reasoning</div>
        <div class="card-value">{formatTokens(enrichment.tokenData.grandTotal.reasoning)}</div>
      </div>
      <div class="summary-card">
        <div class="card-label">Total Cost</div>
        <div class="card-value success">{formatCost(enrichment.tokenData.grandTotal.cost)}</div>
      </div>
      <div class="summary-card">
        <div class="card-label">Cache Read</div>
        <div class="card-value muted">{formatTokens(enrichment.tokenData.grandTotal.cacheRead)}</div>
      </div>
      <div class="summary-card">
        <div class="card-label">Cache Write</div>
        <div class="card-value muted">{formatTokens(enrichment.tokenData.grandTotal.cacheWrite)}</div>
      </div>
    </div>

    <div class="section" data-testid="project-table">
      <h3 class="section-title">프로젝트별</h3>
      {#if projectRows().length === 0}
        <div class="table-empty">프로젝트 데이터 없음</div>
      {:else}
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th class="num">Sessions</th>
                <th class="num">Input</th>
                <th class="num">Output</th>
                <th class="num">Cache</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {#each projectRows() as row (row.name)}
                <tr>
                  <td class="project-name" title={row.name}>{row.name}</td>
                  <td class="num">{row.sessionCount}</td>
                  <td class="num">{formatTokens(row.input)}</td>
                  <td class="num">{formatTokens(row.output)}</td>
                  <td class="num">{formatTokens(row.cacheRead + row.cacheWrite)}</td>
                  <td class="num cost-val">{formatCost(row.cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <div class="section" data-testid="session-table">
      <h3 class="section-title">세션별</h3>
      {#if sessionRows().length === 0}
        <div class="table-empty">세션 데이터 없음</div>
      {:else}
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Model</th>
                <th>Agent</th>
                <th class="num">Input</th>
                <th class="num">Output</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {#each sessionRows() as s (s.sessionId)}
                <tr>
                  <td class="session-title-cell" title={s.sessionTitle || s.sessionId}>
                    {s.sessionTitle || s.sessionId.slice(0, 8)}
                  </td>
                  <td class="model-cell">{s.models[0] ?? '—'}</td>
                  <td class="agent-cell">{s.agents[0] ?? '—'}</td>
                  <td class="num">{formatTokens(s.totalInput)}</td>
                  <td class="num">{formatTokens(s.totalOutput)}</td>
                  <td class="num cost-val">{formatCost(s.totalCost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page-container {
    padding: 1.25rem 1.5rem;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-height: 0;
    overflow-y: auto;
  }

  .page-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 3rem 0;
    flex: 1;
  }

  .loading-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-secondary);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .loading-dot:nth-child(2) { animation-delay: 0.2s; }
  .loading-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 3rem 1rem;
    flex: 1;
    text-align: center;
  }

  .empty-icon {
    width: 2.5rem;
    height: 2.5rem;
    color: var(--text-secondary);
    opacity: 0.5;
    margin-bottom: 0.25rem;
  }

  .empty-title {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .empty-desc {
    font-size: 0.8rem;
    color: var(--text-secondary);
    opacity: 0.6;
    max-width: 28rem;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .summary-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .card-label {
    font-size: 0.7rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }

  .card-value {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .card-value.accent { color: var(--accent); }
  .card-value.success { color: var(--success); }
  .card-value.muted { color: var(--text-secondary); }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .table-empty {
    font-size: 0.8rem;
    color: var(--text-secondary);
    padding: 1rem 0;
    text-align: center;
    font-style: italic;
  }

  .table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  .data-table thead tr {
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border);
  }

  .data-table th {
    padding: 0.5rem 0.75rem;
    text-align: left;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .data-table td {
    padding: 0.5rem 0.75rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .data-table tbody tr:last-child td {
    border-bottom: none;
  }

  .data-table tbody tr:hover td {
    background: rgba(255, 255, 255, 0.025);
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .cost-val {
    color: var(--success);
    font-weight: 600;
  }

  .project-name {
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    color: var(--accent);
  }

  .session-title-cell {
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .model-cell,
  .agent-cell {
    font-size: 0.72rem;
    color: var(--text-secondary);
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 599px) {
    .page-container {
      padding: 0.75rem;
      gap: 1rem;
    }

    .summary-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .card-value {
      font-size: 1rem;
    }
  }
</style>
