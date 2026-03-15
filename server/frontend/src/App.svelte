<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ActiveSessions from "./components/ActiveSessions.svelte";
  import RecentPrompts from "./components/RecentPrompts.svelte";
  import type { QueryEntry, DashboardSession, MachineInfo } from "./types";
  import { fetchSessions, getSessions, setSessions } from "./lib/stores/sessions.svelte";
  import { fetchQueries, addQuery } from "./lib/stores/queries.svelte";
  import { getSelectedSessionId, clearFilter, getSourceFilter, setSourceFilter } from "./lib/stores/filter.svelte";
  import MachineSelector from './components/MachineSelector.svelte';
  import { fetchMachines, setMachines } from './lib/stores/machine.svelte';
  import { createSSEClient } from "./lib/sse-client";
  import { reviveSessions } from "./lib/stores/dismissed.svelte";
  import { handleEnrichmentSSEUpdate, handleMergedEnrichmentSSEUpdate } from './lib/stores/enrichment';
  import { getDetailSessionId, pushSessionDetail, popToOverview, isDetailView, getCurrentView } from "./lib/stores/navigation.svelte";
  import CommandPalette from './components/CommandPalette.svelte';
  import TopNav from './components/TopNav.svelte';
  import TokenCostPage from './components/pages/TokenCostPage.svelte';
  import CodeImpactPage from './components/pages/CodeImpactPage.svelte';
  import TimelinePage from './components/pages/TimelinePage.svelte';
  import ProjectsPage from './components/pages/ProjectsPage.svelte';
  import ContextRecoveryPage from './components/pages/ContextRecoveryPage.svelte';

  let connected = $state(false);
  let loading = $state(true);
  let paletteOpen = $state(false);
  let selectedSessionId = $derived(getSelectedSessionId());
  let isDetail = $derived(isDetailView());
  let detailId = $derived(getDetailSessionId());
  let sourceFilter = $derived(getSourceFilter());
  let currentView = $derived(getCurrentView());
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

  let refetchTimer: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await Promise.all([fetchQueries(), fetchSessions(), fetchMachines()]);
    reviveSessions(getSessions());
    loading = false;

    createSSEClient({ url: "/api/events" })
      .onConnectionChange((c) => { connected = c; })
      .on("query.new", (data) => { addQuery(data as QueryEntry); })
      .on("session.update", (data) => { const s = data as DashboardSession[]; setSessions(s); reviveSessions(s); })
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

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      paletteOpen = !paletteOpen;
      return;
    }

    if (paletteOpen) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Escape' && isDetail) {
      e.preventDefault();
      popToOverview();
      return;
    }

    if (e.key === 'j' || e.key === 'k') {
      const list = document.querySelector('.prompts-list');
      if (!list) return;
      const items = list.querySelectorAll('.prompt-item');
      if (items.length === 0) return;

      const focused = list.querySelector('.prompt-item:focus') as HTMLElement;
      let idx = focused ? Array.from(items).indexOf(focused) : -1;

      if (e.key === 'j') idx = Math.min(idx + 1, items.length - 1);
      if (e.key === 'k') idx = Math.max(idx - 1, 0);

      const target = items[idx] as HTMLElement;
      target.focus();
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  {:else}
    {#if isDetail}
      <div class="detail-header view-transition">
        <button class="back-btn" onclick={popToOverview}>← 돌아가기</button>
        <span class="detail-session-id">{detailId}</span>
      </div>
    {/if}
    <div class="dashboard-layout">
      <aside class="sidebar">
        <div class="panel">
          <h2>Sessions</h2>
          <ActiveSessions />
        </div>
      </aside>
      <section class="main-content">
        {#if isDetail}
          <div class="panel prompts-panel view-transition">
            <h2>세션 프롬프트</h2>
            <RecentPrompts sessionIdFilter={detailId} bind:showBackground onBackgroundCountChange={(c) => { backgroundCount = c; }} />
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
            <RecentPrompts bind:showBackground onBackgroundCountChange={(c) => { backgroundCount = c; }} />
          </div>
        {/if}
      </section>
    </div>
  {/if}
</main>

<CommandPalette
  open={paletteOpen}
  onClose={() => { paletteOpen = false; }}
  onSelectSession={(id) => { pushSessionDetail(id); paletteOpen = false; }}
/>
<style>
  .view-transition {
    transition: transform 200ms ease-out, opacity 200ms ease-out;
  }

  .dashboard-icon {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .source-filter {
    display: flex;
    gap: 0.25rem;
    padding: 0;
    margin-bottom: 0;
    margin-left: auto;
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
</style>
