<script lang="ts">
  import { getSessions } from '../../lib/stores/sessions.svelte';
  import { getSourceFilter } from '../../lib/stores/filter.svelte';
  import { summaryCache, summaryLoadingIds, fetchSessionSummary } from '../../lib/stores/enrichment';
  import { pushSessionDetail } from '../../lib/stores/navigation.svelte';
  import { relativeTime, formatTimestamp } from '../../lib/utils';
  import type { DashboardSession } from '../../types';

  let sessions = $derived(getSessions());
  let sourceFilter = $derived(getSourceFilter());

  // Top-level sessions, source-filtered
  let filteredSessions = $derived(
    sessions
      .filter(s => !s.parentSessionId)
      .filter(s => {
        if (sourceFilter === 'all') return true;
        if (sourceFilter === 'opencode') return !s.source || s.source === 'opencode';
        return s.source === sourceFilter;
      })
  );

  // Group by project (projectCwd)
  interface ProjectGroup {
    cwd: string;
    name: string;
    sessions: DashboardSession[];
    lastActivity: number;
  }

  let projectGroups = $derived.by(() => {
    const map = new Map<string, DashboardSession[]>();
    for (const s of filteredSessions) {
      const key = s.projectCwd ?? '__unknown__';
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }

    const groups: ProjectGroup[] = [];
    for (const [cwd, projectSessions] of map) {
      const sorted = projectSessions.sort((a, b) => b.lastActivityTime - a.lastActivityTime);
      groups.push({
        cwd,
        name: cwd === '__unknown__' ? 'Unknown' : cwd.split('/').pop() ?? cwd,
        sessions: sorted,
        lastActivity: sorted[0]?.lastActivityTime ?? 0,
      });
    }
    return groups.sort((a, b) => b.lastActivity - a.lastActivity);
  });

  let expandedProjects = $state<Set<string>>(new Set());

  // Auto-expand the most recently active project
  $effect(() => {
    if (projectGroups.length > 0 && expandedProjects.size === 0) {
      expandedProjects = new Set([projectGroups[0].cwd]);
    }
  });

  function toggleProject(cwd: string) {
    const next = new Set(expandedProjects);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    expandedProjects = next;
  }

  function getStatusInfo(s: DashboardSession): { label: string; cls: string } {
    if ((s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.currentTool) && !s.waitingForInput)
      return { label: 'Working', cls: 'st-working' };
    if (s.waitingForInput)
      return { label: 'Waiting', cls: 'st-waiting' };
    return { label: 'Idle', cls: 'st-idle' };
  }

  function shortPath(p: string): string {
    if (p === '__unknown__') return 'Unknown';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }
</script>

<div class="summaries-page" data-testid="page-summaries">
  <!-- Header -->
  <header class="page-head">
    <div class="head-left">
      <h2 class="head-title">Summaries</h2>
      <span class="head-sub">AI-powered session digests</span>
    </div>
    <div class="head-stats">
      <span class="stat">{projectGroups.length}<small>projects</small></span>
      <span class="stat-div"></span>
      <span class="stat">{filteredSessions.length}<small>sessions</small></span>
    </div>
  </header>

  {#if projectGroups.length === 0}
    <div class="empty">
      <div class="empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      </div>
      <p>표시할 세션이 없습니다</p>
    </div>
  {:else}
    <div class="projects-stack">
      {#each projectGroups as group (group.cwd)}
        {@const isOpen = expandedProjects.has(group.cwd)}
        {@const activeSessions = group.sessions.filter(s => s.apiStatus === 'busy' || s.waitingForInput)}
        <section class="project-card" class:open={isOpen}>
          <!-- Project header -->
          <button class="project-head" onclick={() => toggleProject(group.cwd)}>
            <div class="project-info">
              <span class="project-chevron" class:rotated={isOpen}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
              <span class="project-name">{group.name}</span>
              <span class="project-path" title={group.cwd}>{shortPath(group.cwd)}</span>
            </div>
            <div class="project-badges">
              {#if activeSessions.length > 0}
                <span class="badge badge-active">{activeSessions.length} active</span>
              {/if}
              <span class="badge badge-count">{group.sessions.length}</span>
              <span class="project-time">{relativeTime(group.lastActivity)}</span>
            </div>
          </button>

          <!-- Session list -->
          {#if isOpen}
            <div class="sessions-grid">
              {#each group.sessions as session (session.sessionId)}
                {@const cached = $summaryCache[session.sessionId]}
                {@const isLoading = $summaryLoadingIds.includes(session.sessionId)}
                {@const st = getStatusInfo(session)}
                <article class="session-card" class:has-summary={!!cached}>
                  <!-- Session header row -->
                  <div class="s-head">
                    <button class="s-title" onclick={() => pushSessionDetail(session.sessionId)}>
                      {session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 12)}
                    </button>
                    <span class="s-status {st.cls}">{st.label}</span>
                  </div>

                  <!-- Meta row -->
                  <div class="s-meta">
                    <span>{relativeTime(session.lastActivityTime)}</span>
                    <span class="dot"></span>
                    <span class="s-source" class:claude={session.source === 'claude-code'}>
                      {session.source === 'claude-code' ? 'Claude' : 'OC'}
                    </span>
                    {#if session.childSessionIds?.length}
                      <span class="dot"></span>
                      <span class="s-agents">{session.childSessionIds.length} agents</span>
                    {/if}
                  </div>

                  <!-- Summary area -->
                  <div class="s-body">
                    {#if cached}
                      <div class="s-summary">{cached.summary}</div>
                      <div class="s-footer">
                        <span class="s-gen-time">{formatTimestamp(cached.generatedAt)}</span>
                        <button
                          class="s-btn s-btn-ghost"
                          onclick={() => fetchSessionSummary(session.sessionId)}
                          disabled={isLoading}
                        >
                          {#if isLoading}
                            <span class="spinner"></span>
                          {:else}
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                          {/if}
                        </button>
                      </div>
                    {:else}
                      <div class="s-empty">
                        <button
                          class="s-btn s-btn-generate"
                          onclick={() => fetchSessionSummary(session.sessionId)}
                          disabled={isLoading}
                        >
                          {#if isLoading}
                            <span class="spinner"></span> 요약 생성 중...
                          {:else}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                            요약 생성
                          {/if}
                        </button>
                      </div>
                    {/if}
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* ── Page layout ── */
  .summaries-page {
    padding: 1.25rem 1.5rem;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 1.25rem;
    gap: 1rem;
  }

  .head-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.01em;
    margin: 0;
  }

  .head-sub {
    font-size: 0.7rem;
    color: var(--text-secondary);
    opacity: 0.6;
    margin-left: 0.5rem;
    letter-spacing: 0.03em;
  }

  .head-left {
    display: flex;
    align-items: baseline;
  }

  .head-stats {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .stat {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }

  .stat small {
    font-size: 0.65rem;
    font-weight: 400;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .stat-div {
    width: 1px;
    height: 14px;
    background: var(--border);
  }

  /* ── Empty state ── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 250px;
    gap: 0.75rem;
    color: var(--text-secondary);
  }

  .empty-icon { opacity: 0.3; }
  .empty p { font-size: 0.85rem; margin: 0; }

  /* ── Project cards ── */
  .projects-stack {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .project-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.2s ease;
  }

  .project-card.open {
    border-color: rgba(88, 166, 255, 0.25);
  }

  .project-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.7rem 0.9rem;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    gap: 0.5rem;
  }

  .project-head:hover { background: rgba(255,255,255,0.02); }
  .project-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .project-info {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .project-chevron {
    color: var(--text-secondary);
    flex-shrink: 0;
    transition: transform 0.2s ease;
    display: flex;
  }

  .project-chevron.rotated { transform: rotate(90deg); }

  .project-name {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-path {
    font-size: 0.68rem;
    font-family: "SF Mono", "Fira Code", monospace;
    color: var(--text-secondary);
    opacity: 0.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-badges {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .badge {
    font-size: 0.62rem;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .badge-active {
    background: rgba(88, 166, 255, 0.12);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.25);
  }

  .badge-count {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .project-time {
    font-size: 0.68rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  /* ── Session grid ── */
  .sessions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 0.5rem;
    padding: 0.5rem 0.7rem 0.7rem;
    border-top: 1px solid var(--border);
    background: rgba(0,0,0,0.15);
  }

  /* ── Session card ── */
  .session-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .session-card:hover {
    border-color: rgba(88, 166, 255, 0.2);
  }

  .session-card.has-summary {
    border-left: 2px solid rgba(88, 166, 255, 0.4);
  }

  /* session head */
  .s-head {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .s-title {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.35;
  }

  .s-title:hover { color: var(--accent); }

  .s-status {
    font-size: 0.58rem;
    padding: 0.1rem 0.35rem;
    border-radius: 9999px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .st-working { background: rgba(88,166,255,0.12); color: var(--accent); border: 1px solid rgba(88,166,255,0.25); }
  .st-waiting { background: rgba(209,105,239,0.12); color: #d169ef; border: 1px solid rgba(209,105,239,0.25); }
  .st-idle { background: rgba(63,185,80,0.1); color: var(--success); border: 1px solid rgba(63,185,80,0.2); }

  /* session meta */
  .s-meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.68rem;
    color: var(--text-secondary);
  }

  .dot {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: var(--text-secondary);
    opacity: 0.4;
  }

  .s-source { font-weight: 500; color: #3fb950; }
  .s-source.claude { color: #a871ff; }
  .s-agents { opacity: 0.7; }

  /* session body (summary area) */
  .s-body {
    margin-top: 0.2rem;
  }

  .s-summary {
    font-size: 0.76rem;
    line-height: 1.55;
    color: var(--text-primary);
    opacity: 0.9;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 6.5rem;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .s-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.35rem;
    padding-top: 0.3rem;
    border-top: 1px solid rgba(255,255,255,0.04);
  }

  .s-gen-time {
    font-size: 0.62rem;
    color: var(--text-secondary);
    opacity: 0.5;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  /* empty summary */
  .s-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.4rem 0 0.1rem;
  }

  /* ── Buttons ── */
  .s-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
    border: none;
    background: none;
  }

  .s-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .s-btn-generate {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--text-secondary);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border);
    background: transparent;
  }

  .s-btn-generate:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
    border-style: solid;
    background: rgba(88,166,255,0.05);
  }

  .s-btn-ghost {
    padding: 0.2rem;
    border-radius: 4px;
    color: var(--text-secondary);
    opacity: 0.4;
  }

  .s-btn-ghost:hover:not(:disabled) {
    opacity: 1;
    color: var(--accent);
    background: rgba(88,166,255,0.08);
  }

  /* spinner */
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Responsive ── */
  @media (max-width: 599px) {
    .summaries-page { padding: 0.75rem; }
    .sessions-grid { grid-template-columns: 1fr; }
    .page-head { flex-direction: column; align-items: flex-start; }
    .head-stats { align-self: flex-end; }
  }
</style>
