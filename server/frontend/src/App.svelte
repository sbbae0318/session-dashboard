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
  import { getDetailSessionId, pushSessionDetail, popToOverview, isDetailView } from "./lib/stores/navigation.svelte";
  import CommandPalette from './components/CommandPalette.svelte';

  let connected = $state(false);
  let loading = $state(true);
  let paletteOpen = $state(false);
  let selectedSessionId = $derived(getSelectedSessionId());
  let isDetail = $derived(isDetailView());
  let detailId = $derived(getDetailSessionId());
  let sourceFilter = $derived(getSourceFilter());

  $effect(() => {
    const sessions = getSessions();
    if (selectedSessionId && !sessions.some(s => s.sessionId === selectedSessionId)) {
      clearFilter();
    }
  });

  // Auto-pop to overview when detail session disappears from active sessions
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
      .start();

    refetchTimer = setInterval(async () => {
      await Promise.all([fetchQueries(), fetchMachines()]);
    }, 30_000);
  });

  onDestroy(() => {
    if (refetchTimer) clearInterval(refetchTimer);
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Cmd+K / Ctrl+K: toggle palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      paletteOpen = !paletteOpen;
      return;
    }

    // Don't handle other shortcuts when palette is open or input is focused
    if (paletteOpen) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // ESC: close detail view
    if (e.key === 'Escape' && isDetail) {
      e.preventDefault();
      popToOverview();
      return;
    }

    // J/K: navigate prompts
    if (e.key === 'j' || e.key === 'k') {
      const list = document.querySelector('.prompts-list');
      if (!list) return;
      const items = list.querySelectorAll('.prompt-item');
      if (items.length === 0) return;

      // Find currently focused/visible item
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
    <h1>Session Dashboard</h1>
    <span class="connection-status" class:connected>
      {connected ? "● Connected" : "○ Disconnected"}
    </span>
  </header>

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

  {#if loading}
    <div class="loading">Loading...</div>
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
            <RecentPrompts sessionIdFilter={detailId} />
          </div>
        {:else}
          <div class="panel prompts-panel view-transition">
            <div class="panel-header-row">
              <h2>Prompt History</h2>
              {#if selectedSessionId}
                <button class="filter-badge" onclick={clearFilter}>
                  ✕ 필터 해제
                </button>
              {/if}
            </div>
            <RecentPrompts />
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

  .source-filter {
    display: flex;
    gap: 0.25rem;
    padding: 0 1rem;
    margin-bottom: 0.5rem;
  }

  .source-filter-btn {
    font-size: 0.72rem;
    padding: 0.25rem 0.65rem;
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

  @media (prefers-reduced-motion: reduce) {
    .view-transition {
      transition: none;
    }
  }
</style>
