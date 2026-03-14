<script lang="ts">
  import {
    fetchImpactData,
    getImpactData,
    isImpactAvailable,
    isImpactLoading,
  } from '../../lib/stores/enrichment.svelte';
  import type { SessionCodeImpact } from '../../lib/stores/enrichment.svelte';
  import { getSelectedMachineId } from '../../lib/stores/machine.svelte';
  import { relativeTime } from '../../lib/utils';

  let impactData = $derived(getImpactData());
  let impactAvailable = $derived(isImpactAvailable());
  let impactLoading = $derived(isImpactLoading());

  let selectedProject = $state<string>('all');

  let projects = $derived(
    [...new Set((impactData ?? []).map((i) => i.projectId))]
  );

  let filteredImpact = $derived(
    selectedProject === 'all'
      ? (impactData ?? [])
      : (impactData ?? []).filter((i) => i.projectId === selectedProject)
  );

  const maxChange = $derived(
    Math.max(...(filteredImpact).map((i) => i.additions + i.deletions), 1)
  );

  function addWidth(item: SessionCodeImpact): number {
    if (maxChange === 0) return 0;
    return Math.round((item.additions / maxChange) * 100);
  }

  function delWidth(item: SessionCodeImpact): number {
    if (maxChange === 0) return 0;
    return Math.round((item.deletions / maxChange) * 100);
  }

  function shortPath(dir: string): string {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function hasNoChanges(item: SessionCodeImpact): boolean {
    return item.additions === 0 && item.deletions === 0;
  }

  $effect(() => {
    getSelectedMachineId();
    fetchImpactData();
  });
</script>

<div class="page-container" data-testid="page-code-impact">
  <div class="page-header">
    <h2 class="page-title">Code Impact</h2>

    <div class="filters">
      <label class="filter-label" for="project-filter">프로젝트</label>
      <select
        id="project-filter"
        class="filter-select"
        bind:value={selectedProject}
      >
        <option value="all">All Projects</option>
        {#each projects as projectId (projectId)}
          <option value={projectId}>{shortPath(projectId)}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if impactLoading}
    <div class="loading-state">
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
    </div>
  {:else if !impactAvailable}
    <div class="empty-state" data-testid="empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
      </svg>
      <p class="empty-title">코드 변경 기록 없음</p>
      <p class="empty-desc">Agent에 OPENCODE_DB_PATH가 설정되지 않았거나 Agent가 연결되지 않았습니다.</p>
    </div>
  {:else if filteredImpact.length === 0}
    <div class="empty-state" data-testid="empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
      </svg>
      <p class="empty-title">코드 변경 기록 없음</p>
      <p class="empty-desc">선택한 프로젝트에 데이터가 없습니다.</p>
    </div>
  {:else}
    <div class="impact-list" data-testid="impact-list">
      {#each filteredImpact as item (item.sessionId)}
        <div
          class="impact-item"
          class:no-changes={hasNoChanges(item)}
          data-testid="impact-item"
        >
          <div class="impact-header">
            <span class="session-title">{item.sessionTitle || item.sessionId.slice(0, 8)}</span>
            <span class="time">{relativeTime(item.timeUpdated)}</span>
          </div>
          <div class="project-path">{shortPath(item.directory)}</div>

          {#if hasNoChanges(item)}
            <div class="change-stats">
              <span class="no-change-label">변경 없음</span>
            </div>
          {:else}
            <div class="change-stats">
              <span class="additions">+{item.additions.toLocaleString()}</span>
              <span class="deletions">-{item.deletions.toLocaleString()}</span>
              <span class="files">{item.files} {item.files === 1 ? 'file' : 'files'}</span>
            </div>
            <div class="impact-bar" data-testid="impact-bar">
              <div
                class="bar-additions"
                style="width: {addWidth(item)}%"
                aria-label="+{item.additions} additions"
              ></div>
              <div
                class="bar-deletions"
                style="width: {delWidth(item)}%"
                aria-label="-{item.deletions} deletions"
              ></div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page-container {
    padding: 1.25rem 1.5rem;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .page-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── Filters ── */

  .filters {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .filter-select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8rem;
    font-family: inherit;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .filter-select:hover,
  .filter-select:focus {
    border-color: var(--accent);
  }

  /* ── Loading ── */

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

  /* ── Empty State ── */

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
  }

  /* ── Impact List ── */

  .impact-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-bottom: 1rem;
  }

  .impact-item {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    transition: border-color 0.15s ease;
  }

  .impact-item:hover {
    border-color: var(--accent);
  }

  .impact-item.no-changes {
    opacity: 0.6;
  }

  /* ── Impact Item Layout ── */

  .impact-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.2rem;
  }

  .session-title {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .time {
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .project-path {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: "SF Mono", "Fira Code", monospace;
    margin-bottom: 0.4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Change Stats ── */

  .change-stats {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
    font-size: 0.8rem;
    font-family: "SF Mono", "Fira Code", monospace;
    font-weight: 500;
  }

  .additions {
    color: var(--success);
  }

  .deletions {
    color: var(--error);
  }

  .files {
    color: var(--text-secondary);
    font-weight: 400;
  }

  .no-change-label {
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-style: italic;
    font-family: inherit;
    font-weight: 400;
  }

  /* ── GitHub-style Impact Bar ── */

  .impact-bar {
    display: flex;
    height: 8px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-tertiary);
    gap: 1px;
  }

  .bar-additions {
    background: var(--success);
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    transition: width 0.3s ease;
    min-width: 2px;
  }

  .bar-deletions {
    background: var(--error);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    transition: width 0.3s ease;
    min-width: 2px;
  }

  .bar-additions:last-child {
    border-radius: var(--radius-sm);
  }
</style>
