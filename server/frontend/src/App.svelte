<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ActiveSessions from "./components/ActiveSessions.svelte";
  import RecentPrompts from "./components/RecentPrompts.svelte";
  import type { QueryEntry, DashboardSession, MachineInfo } from "./types";
  import { fetchSessions, getSessions, setSessions, mergeSessions } from "./lib/stores/sessions.svelte";
  import { fetchQueries, addQuery, fetchSessionQueries } from "./lib/stores/queries.svelte";
  import { getSelectedSessionId, clearFilter, getSourceFilter, setSourceFilter, getTimeRange, setTimeRange, type TimeRange } from "./lib/stores/filter.svelte";
  import MachineSelector from './components/MachineSelector.svelte';
  import { fetchMachines, setMachines } from './lib/stores/machine.svelte';
  import { createSSEClient } from "./lib/sse-client";
  import { reviveSessions, dismissSession } from "./lib/stores/dismissed.svelte";
  import { handleEnrichmentSSEUpdate, handleMergedEnrichmentSSEUpdate } from './lib/stores/enrichment';
  import { getDetailSessionId, pushSessionDetail, popToOverview, isDetailView, getCurrentView, popToSessions, isSessionPromptsView, cycleTab } from "./lib/stores/navigation.svelte";
  import CommandPalette from './components/CommandPalette.svelte';
  import ShortcutCheatsheet from './components/ShortcutCheatsheet.svelte';
  import TopNav from './components/TopNav.svelte';
  import TokenCostPage from './components/pages/TokenCostPage.svelte';
  import CodeImpactPage from './components/pages/CodeImpactPage.svelte';
  import TimelinePage from './components/pages/TimelinePage.svelte';
  import ProjectsPage from './components/pages/ProjectsPage.svelte';
  import ContextRecoveryPage from './components/pages/ContextRecoveryPage.svelte';
  import SummariesPage from './components/pages/SummariesPage.svelte';
  import MemosPage from './components/pages/MemosPage.svelte';
  import SessionCards from './components/SessionCards.svelte';

  let connected = $state(false);
  let loading = $state(true);
  let paletteOpen = $state(false);
  let cheatsheetOpen = $state(false);
  let focusPane = $state<'sessions' | 'prompts'>('prompts');
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  let selectedSessionId = $derived(getSelectedSessionId());
  let isDetail = $derived(isDetailView());
  let detailId = $derived(getDetailSessionId());
  let sourceFilter = $derived(getSourceFilter());
  let timeRange = $derived(getTimeRange());
  const timeRangeOptions: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1h" },
    { value: "6h", label: "6h" },
    { value: "1d", label: "1d" },
    { value: "7d", label: "7d" },
    { value: "all", label: "All" },
  ];
  let currentView = $derived(getCurrentView());
  let isSessionPrompts = $derived(isSessionPromptsView());
  let showBackground = $state(false);
  let backgroundCount = $state(0);

  $effect(() => {
    const sessions = getSessions();
    if (selectedSessionId && !sessions.some(s => s.sessionId === selectedSessionId)) {
      clearFilter();
    }
  });

  $effect(() => {
    const sessions = getSessions();
    if (isDetail && detailId) {
      if (!sessions.some(s => s.sessionId === detailId)) {
        popToOverview();
      }
    }
  });

  // 세션 디테일/프롬프트 뷰 진입 시 해당 세션 쿼리 fetch
  $effect(() => {
    if (detailId && (isDetail || isSessionPrompts)) {
      fetchSessionQueries(detailId);
    }
  });

  let refetchTimer: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await Promise.all([fetchQueries(), fetchSessions(), fetchMachines()]);
    reviveSessions(getSessions());
    loading = false;

    createSSEClient({ url: "/api/events" })
      .onConnectionChange((c) => { connected = c; })
      .on("query.new", (data) => { addQuery(data as QueryEntry); })
      .on("session.update", (data) => { const s = data as DashboardSession[]; setSessions(s); reviveSessions(s); })
      .on("session.delta", (data) => {
        const d = data as { updated: DashboardSession[]; removed: string[] };
        mergeSessions(d.updated, d.removed);
        if (d.updated.length > 0) reviveSessions(d.updated);
      })
      .on("machine.status", (data) => { setMachines(data as MachineInfo[]); })
      .on("enrichment.updated", (data) => {
        const d = data as { machineId: string; feature: string; cachedAt: number };
        handleEnrichmentSSEUpdate(d.feature);
      })
      .on("enrichment.merged.updated", (data) => {
        const d = data as { feature: string; machineCount: number; cachedAt: number };
        handleMergedEnrichmentSSEUpdate(d.feature);
      })
      .on("enrichment.cache", (_data) => {
        // hydration: 초기 연결 시 현재 캐시 상태 수신 — 각 페이지 onMount에서 초기 fetch
      })
      .start();

    refetchTimer = setInterval(async () => {
      await Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
    }, 30_000);

    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      Promise.all([fetchSessions(), fetchQueries(), fetchMachines()]);
    }
  }

  onDestroy(() => {
    if (refetchTimer) clearInterval(refetchTimer);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  function handleDismissFromDetail() {
    if (!detailId) return;
    const session = getSessions().find(s => s.sessionId === detailId);
    if (session) {
      dismissSession(session.sessionId, session.lastActivityTime);
    }
    popToOverview();
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      paletteOpen = !paletteOpen;
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    if (paletteOpen) return;
    if (cheatsheetOpen) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === '?') {
      e.preventDefault();
      cheatsheetOpen = true;
      return;
    }

    if (e.key === 'Escape' && isSessionPrompts) {
      e.preventDefault();
      popToSessions();
      return;
    }

    if (e.key === 'Escape' && isDetail) {
      e.preventDefault();
      popToOverview();
      return;
    }

    // h/l: pane 전환 (Monitor 뷰에서만)
    if (currentView === 'overview' || currentView === 'session-detail') {
      if (e.key === 'h') {
        e.preventDefault();
        focusPane = 'sessions';
        return;
      }
      if (e.key === 'l') {
        e.preventDefault();
        focusPane = 'prompts';
        return;
      }
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />
<main>
<header class="dashboard-header">
  <svg class="dashboard-icon" width="16" height="16" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1"/>
    <rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/>
    <rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
  <span class="connection-status" class:connected
        title={connected ? "Connected" : "Disconnected"}>
    {connected ? "●" : "○"}
  </span>
  <MachineSelector />
  <div class="time-filter">
    {#each timeRangeOptions as opt (opt.value)}
      <button
        class="source-filter-btn"
        class:active={timeRange === opt.value}
        onclick={() => setTimeRange(opt.value)}
      >{opt.label}</button>
    {/each}
  </div>
  <div class="source-filter">
    <button
      class="source-filter-btn"
      class:active={sourceFilter === "all"}
      onclick={() => setSourceFilter("all")}
    >All</button>
    <button
      class="source-filter-btn"
      class:active={sourceFilter === "opencode"}
      onclick={() => setSourceFilter("opencode")}
    >OpenCode</button>
    <button
      class="source-filter-btn"
      class:active={sourceFilter === "claude-code"}
      onclick={() => setSourceFilter("claude-code")}
    >Claude</button>
  </div>
</header>
<TopNav />
  {#if loading}
    <div class="loading">Loading...</div>
  {:else if currentView === 'token-cost'}
    <TokenCostPage />
  {:else if currentView === 'code-impact'}
    <CodeImpactPage />
  {:else if currentView === 'timeline'}
    <TimelinePage />
  {:else if currentView === 'projects'}
    <ProjectsPage />
  {:else if currentView === 'context-recovery'}
    <ContextRecoveryPage />
  {:else if currentView === 'summaries'}
    <SummariesPage />
  {:else if currentView === 'memos'}
    <MemosPage />
  {:else if currentView === 'sessions'}
    <div class="panel sessions-page">
      <h2>Sessions</h2>
      <SessionCards />
    </div>
  {:else if currentView === 'session-prompts' && detailId}
    <div class="panel prompts-page view-transition">
      <div class="prompts-page-header">
        <button class="back-btn" onclick={popToSessions} title="세션 목록으로">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Sessions
        </button>
        <span class="prompts-page-id" title={detailId}>{getSessions().find(s => s.sessionId === detailId)?.title || detailId.slice(0, 16)}</span>
      </div>
      <RecentPrompts sessionIdFilter={detailId} bind:showBackground onBackgroundCountChange={(c) => { backgroundCount = c; }} paneActive={true} />
    </div>
  {:else}
    <div class="dashboard-layout">
      <aside class="sidebar" class:pane-active={focusPane === 'sessions'}>
        <div class="panel">
          <div class="sessions-panel-head">
            <h2>Sessions</h2>
            {#if isDetail}
              <div class="detail-bar">
                <button class="detail-bar-btn" onclick={popToOverview} title="돌아가기">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <span class="detail-bar-id" title={detailId}>{detailId?.slice(0, 12)}</span>
                <button class="detail-bar-btn" onclick={handleDismissFromDetail} title="숨기기">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            {/if}
          </div>
          <ActiveSessions paneActive={focusPane === 'sessions'} />
        </div>
      </aside>
      <section class="main-content" class:pane-active={focusPane === 'prompts'}>
        {#if isDetail}
          <div class="panel prompts-panel view-transition">
            <h2>세션 프롬프트</h2>
            <RecentPrompts sessionIdFilter={detailId} bind:showBackground onBackgroundCountChange={(c) => { backgroundCount = c; }} paneActive={focusPane === 'prompts'} />
          </div>
        {:else}
          <div class="panel prompts-panel view-transition">
            <div class="panel-header-row">
              <h2>Prompt History</h2>
              {#if backgroundCount > 0}
                <button class="bg-toggle-btn" class:active={showBackground}
                  onclick={() => { showBackground = !showBackground; }}>
                  {#if showBackground}hide bg{:else}background ({backgroundCount}){/if}
                </button>
              {/if}
              {#if selectedSessionId}
                <button class="filter-badge" onclick={clearFilter}>
                  ✕ 필터 해제
                </button>
              {/if}
            </div>
            <RecentPrompts bind:showBackground onBackgroundCountChange={(c) => { backgroundCount = c; }} paneActive={focusPane === 'prompts'} />
          </div>
        {/if}
      </section>
    </div>
  {/if}
  {#if !paletteOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="palette-hint" onclick={() => { paletteOpen = true; }} role="button" tabindex="-1" aria-label="커맨드 팔레트 열기">
      {#if isMac}
        <kbd>⌘</kbd><kbd>K</kbd>
      {:else}
        <kbd>Ctrl</kbd><kbd>K</kbd>
      {/if}
      <span>검색</span>
      <span class="hint-divider">│</span>
      <kbd>?</kbd>
      <span>단축키</span>
    </div>
  {/if}
</main>

<ShortcutCheatsheet open={cheatsheetOpen} onClose={() => { cheatsheetOpen = false; }} />

<CommandPalette
  open={paletteOpen}
  onClose={() => { paletteOpen = false; }}
  onSelectSession={(id) => { pushSessionDetail(id); paletteOpen = false; }}
/>
<style>
  .dismiss-btn {
    margin-left: auto;
    background: none;
    border: 1px solid rgba(248, 81, 73, 0.4);
    border-radius: 9999px;
    padding: 0.15rem 0.6rem;
    font-size: 0.7rem;
    color: rgba(248, 81, 73, 0.7);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .dismiss-btn:hover {
    background: rgba(248, 81, 73, 0.12);
    border-color: rgb(248, 81, 73);
    color: rgb(248, 81, 73);
  }

  .view-transition {
    transition: transform 200ms ease-out, opacity 200ms ease-out;
  }

  .dashboard-icon {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .time-filter {
    display: flex;
    gap: 0.25rem;
    padding: 0;
    margin-bottom: 0;
    margin-left: auto;
  }

  .source-filter {
    display: flex;
    gap: 0.25rem;
    padding: 0;
    margin-bottom: 0;
  }

  .source-filter-btn {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s ease;
  }

  .source-filter-btn:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .source-filter-btn.active {
    background: rgba(88, 166, 255, 0.12);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }


  .bg-toggle-btn {
    background: none;
    border: 1px solid rgba(139, 148, 158, 0.3);
    border-radius: 9999px;
    padding: 0.15rem 0.6rem;
    font-size: 0.65rem;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .bg-toggle-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .bg-toggle-btn.active {
    background: rgba(88, 166, 255, 0.1);
    border-color: rgba(88, 166, 255, 0.4);
    color: var(--accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .view-transition {
      transition: none;
    }
  }

  .palette-hint {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    display: flex;
    align-items: center;
    gap: 0.2rem;
    opacity: 0.4;
    cursor: pointer;
    transition: opacity 0.15s ease;
    z-index: 10;
    user-select: none;
  }

  .palette-hint:hover {
    opacity: 0.8;
  }

  .palette-hint kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 3px);
    padding: 0.05rem 0.25rem;
    font-size: 0.6rem;
    font-family: "SF Mono", "Fira Code", monospace;
    color: var(--text-secondary);
  }

  .palette-hint span {
    font-size: 0.6rem;
    color: var(--text-secondary);
    margin-left: 0.15rem;
  }

  .hint-divider {
    margin: 0 0.15rem;
    opacity: 0.4;
  }

  .sessions-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .prompts-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .prompts-page-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .back-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .prompts-page-id {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  :global(.pane-active) > .panel > h2,
  :global(.pane-active) > .panel > .sessions-panel-head > h2,
  :global(.pane-active) > .panel > .panel-header-row > h2 {
    color: var(--accent);
    transition: color 0.15s ease;
  }
</style>
