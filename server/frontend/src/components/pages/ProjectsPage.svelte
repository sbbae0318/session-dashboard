<script lang="ts">
  import { onMount } from 'svelte';
  import {
    projectsData,
    projectsAvailable,
    projectsLoading,
    fetchProjectsData,
    type ProjectSummary,
  } from '../../lib/stores/enrichment';
  import { onMachineChange } from '../../lib/stores/machine.svelte';
  import { getSessions } from '../../lib/stores/sessions.svelte';
  import { pushSessionDetail } from '../../lib/stores/navigation.svelte';
  import { relativeTime } from '../../lib/utils';
  import type { DashboardSession } from '../../types';

  type SortOption = 'recent' | 'sessions' | 'tokens';
  let sortBy = $state<SortOption>('recent');

  let expandedProjects = $state<Set<string>>(new Set());

  let sortedProjects = $derived(
    [...($projectsData ?? [])].sort((a, b) => {
      if (sortBy === 'recent') return b.lastActivityAt - a.lastActivityAt;
      if (sortBy === 'sessions') return b.sessionCount - a.sessionCount;
      return b.totalTokens - a.totalTokens;
    })
  );

  onMount(() => {
    fetchProjectsData();
    return onMachineChange(() => fetchProjectsData());
  });

  function toggleProject(id: string) {
    const next = new Set(expandedProjects);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedProjects = next;
  }

  function handleSessionClick(sessionId: string) {
    pushSessionDetail(sessionId);
  }

  function getProjectSessions(project: ProjectSummary): DashboardSession[] {
    const sessions = getSessions();
    return sessions.filter((s) => {
      if (!s.projectCwd) return false;
      const cwd = s.projectCwd.replace(/\\/g, '/');
      const worktree = project.worktree.replace(/\\/g, '/');
      return cwd === worktree || cwd.startsWith(worktree + '/');
    });
  }

  function shortPath(dir: string): string {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  function formatCost(n: number): string {
    return `$${n.toFixed(4)}`;
  }

  function getSessionStatus(s: DashboardSession): { label: string; cssClass: string } {
    if (s.apiStatus === 'busy') return { label: 'Working', cssClass: 'status-working' };
    if (s.status === 'active') return { label: 'Active', cssClass: 'status-active' };
    return { label: 'Idle', cssClass: 'status-idle' };
  }
</script>

<div class="page-container" data-testid="page-projects">
  <div class="page-header">
    <h2 class="page-title">Projects Overview</h2>
    <div class="sort-controls">
      <span class="sort-label">정렬:</span>
      <select
        class="sort-select"
        bind:value={sortBy}
      >
        <option value="recent">최근 활동순</option>
        <option value="sessions">세션 수</option>
        <option value="tokens">토큰 수</option>
      </select>
    </div>
  </div>

  {#if $projectsLoading}
    <div class="loading-state">데이터 로딩 중…</div>
  {:else if !$projectsAvailable}
    <div class="unavailable-state" data-testid="empty-state">
      <div class="unavailable-icon">⚠</div>
      <p>프로젝트 데이터를 불러올 수 없습니다.</p>
      <p class="unavailable-hint">Enrichment 데이터를 가져올 수 없습니다. Agent 연결 상태를 확인하세요.</p>
    </div>
  {:else if !$projectsData || sortedProjects.length === 0}
    <div class="empty-state-container" data-testid="empty-state">
      <div class="empty-icon">📁</div>
      <p class="empty-title">등록된 프로젝트 없음</p>
      <p class="empty-hint">세션이 시작되면 프로젝트가 자동으로 표시됩니다.</p>
    </div>
  {:else}
    <div class="projects-grid">
      {#each sortedProjects as project (project.id)}
        {@const isExpanded = expandedProjects.has(project.id)}
        {@const projectSessions = getProjectSessions(project)}

        <div
          class="project-card"
          class:expanded={isExpanded}
          data-testid="project-card"
        >
          <button
            class="project-card-header"
            onclick={() => toggleProject(project.id)}
            aria-expanded={isExpanded}
          >
            <div class="project-card-main">
              <div class="project-name-row">
                <span class="project-icon">📁</span>
                <span class="project-name" title={project.worktree}>
                  {shortPath(project.worktree)}
                </span>
                <span class="chevron" class:rotated={isExpanded}>▼</span>
              </div>

              <div class="project-meta-row">
                <span class="meta-sessions">
                  {project.sessionCount}개 세션
                  {#if project.activeSessionCount > 0}
                    <span class="active-badge">({project.activeSessionCount} 활성)</span>
                  {/if}
                </span>
                <span class="meta-sep">·</span>
                <span class="meta-time">{relativeTime(project.lastActivityAt)}</span>
              </div>

              <div class="project-stats-row">
                <span class="stat-tokens">{formatTokens(project.totalTokens)} 토큰</span>
                <span class="stat-cost">{formatCost(project.totalCost)}</span>
                {#if project.totalAdditions > 0 || project.totalDeletions > 0}
                  <span class="meta-sep">·</span>
                  <span class="stat-additions">+{project.totalAdditions}</span>
                  <span class="stat-deletions">-{project.totalDeletions}</span>
                {/if}
              </div>
            </div>
          </button>

          {#if isExpanded}
            <div class="project-sessions" data-testid="project-sessions">
              {#if projectSessions.length === 0}
                <div class="sessions-empty">세션 데이터 없음</div>
              {:else}
                {#each projectSessions as session (session.sessionId)}
                  {@const ds = getSessionStatus(session)}
                  <button
                    class="session-row"
                    data-testid="session-row"
                    onclick={() => handleSessionClick(session.sessionId)}
                  >
                    <span class="session-dot">•</span>
                    <span class="session-title-text">
                      {session.title || session.sessionId.slice(0, 8)}
                    </span>
                    <span class="session-status {ds.cssClass}">{ds.label}</span>
                    <span class="session-time">{relativeTime(session.lastActivityTime)}</span>
                    {#if session.source}
                      <span class="session-source">{session.source === 'claude-code' ? 'Claude' : 'OC'}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page-container {
    padding: 1.5rem;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .page-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sort-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .sort-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .sort-select {
    font-size: 0.8rem;
    font-family: inherit;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    outline: none;
  }

  .sort-select:focus {
    border-color: var(--accent);
  }

  .loading-state,
  .unavailable-state,
  .empty-state-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--text-secondary);
    font-size: 0.9rem;
    gap: 0.5rem;
    text-align: center;
  }

  .unavailable-icon,
  .empty-icon {
    font-size: 2rem;
    margin-bottom: 0.25rem;
  }

  .empty-title {
    font-size: 1rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .empty-hint,
  .unavailable-hint {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .projects-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .project-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color 0.2s ease;
  }

  .project-card:hover {
    border-color: var(--accent);
  }

  .project-card.expanded {
    border-color: rgba(88, 166, 255, 0.4);
  }

  .project-card-header {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.875rem 1rem;
    text-align: left;
    font-family: inherit;
    color: inherit;
  }

  .project-card-header:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .project-card-main {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .project-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .project-icon {
    font-size: 0.95rem;
    flex-shrink: 0;
  }

  .project-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .chevron {
    font-size: 0.7rem;
    color: var(--text-secondary);
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .chevron.rotated {
    transform: rotate(180deg);
  }

  .project-meta-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .meta-sessions {
    color: var(--text-secondary);
  }

  .active-badge {
    color: var(--success);
    font-weight: 500;
  }

  .meta-sep {
    color: var(--border);
    user-select: none;
  }

  .meta-time {
    color: var(--text-secondary);
  }

  .project-stats-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .stat-tokens {
    color: var(--accent);
    font-weight: 500;
  }

  .stat-cost {
    color: var(--text-secondary);
  }

  .stat-additions {
    color: var(--success);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.72rem;
  }

  .stat-deletions {
    color: var(--error);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.72rem;
  }

  .project-sessions {
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    padding: 0.25rem 0;
  }

  .sessions-empty {
    padding: 0.75rem 1rem;
    font-size: 0.78rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .session-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.45rem 1rem;
    text-align: left;
    font-family: inherit;
    color: inherit;
    transition: background 0.15s ease;
    font-size: 0.8rem;
  }

  .session-row:hover {
    background: var(--bg-tertiary);
  }

  .session-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .session-dot {
    color: var(--border);
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .session-title-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .session-status {
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    font-weight: 500;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .status-working {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.3);
  }

  .status-active {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }

  .status-idle {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .session-time {
    font-size: 0.72rem;
    color: var(--text-secondary);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .session-source {
    font-size: 0.68rem;
    color: var(--text-secondary);
    flex-shrink: 0;
    white-space: nowrap;
    background: var(--bg-tertiary);
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
</style>
