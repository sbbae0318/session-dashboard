<script lang="ts">
  import type { DashboardSession } from "../types";
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { getSourceFilter, getTimeRangeCutoff, getProjectFilter, setProjectFilter } from "../lib/stores/filter.svelte";
  import { getSelectedMachineId } from '../lib/stores/machine.svelte';
  import { isDismissed, getDismissedCount, restoreAll } from "../lib/stores/dismissed.svelte";
  import { pushSessionPrompts } from '../lib/stores/navigation.svelte';
  import { relativeTime, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges } from "../lib/utils";
  import { onMount } from "svelte";

  let tick = $state(0);
  let focusedIndex = $state(-1);
  let prevStatusMap = new Map<string, string>();
  let flashingIds = $state(new Set<string>());
  let toastMessage = $state<string | null>(null);
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const id = setInterval(() => tick++, 60_000);
    return () => clearInterval(id);
  });

  let allSessions = $derived(getSessions());
  let sessions = $derived(allSessions.filter(s => !isDismissed(s.sessionId)));
  let dismissedCount = $derived(getDismissedCount());
  let machineFilter = $derived(getSelectedMachineId());
  let sourceFilter = $derived(getSourceFilter());
  let projectFilter = $derived(getProjectFilter());

  let uniqueProjects = $derived(
    [...new Set(
      sessions
        .filter(s => !machineFilter || s.machineId === machineFilter)
        .filter(s => {
          if (sourceFilter === "all") return true;
          if (sourceFilter === "opencode") return !s.source || s.source === "opencode";
          return s.source === sourceFilter;
        })
        .map(s => s.projectCwd)
        .filter((cwd): cwd is string => cwd != null)
    )].sort((a, b) => {
      const aName = a.split("/").pop() ?? a;
      const bName = b.split("/").pop() ?? b;
      return aName.localeCompare(bName);
    })
  );

  let filteredSessions = $derived(
    sessions
      .filter(s => !machineFilter || s.machineId === machineFilter)
      .filter(s => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !s.source || s.source === "opencode";
        return s.source === sourceFilter;
      })
      .filter(s => {
        if (s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.waitingForInput) return true;
        const cutoff = getTimeRangeCutoff();
        return cutoff === 0 || s.lastActivityTime >= cutoff;
      })
      .filter(s => !s.parentSessionId)
      .filter(s => !projectFilter || s.projectCwd === projectFilter)
  );

  $effect(() => {
    const changed = detectStatusChanges(prevStatusMap, filteredSessions);
    const current = new Map<string, string>();
    for (const s of filteredSessions) {
      current.set(s.sessionId, getDisplayStatus(s).cssClass);
    }
    prevStatusMap = current;
    if (changed.size > 0) {
      flashingIds = changed;
      setTimeout(() => { flashingIds = new Set(); }, 1200);
    }
  });

  function handleCardClick(session: DashboardSession): void {
    pushSessionPrompts(session.sessionId);
  }

  function buildSessionCommand(session: DashboardSession): string {
    const cwd = session.projectCwd ?? '~';
    if (session.source === 'claude-code') {
      return `cd ${cwd} && claude --resume ${session.sessionId}`;
    }
    const rawHost = session.machineHost ?? 'localhost';
    const host = (rawHost === 'host.docker.internal' || rawHost === '127.0.0.1')
      ? 'localhost' : rawHost;
    return `opencode attach http://${host}:4096 --session ${session.sessionId}`;
  }

  function showToast(msg: string): void {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = null; }, 1800);
  }

  function scrollToFocused(): void {
    requestAnimationFrame(() => {
      const cards = document.querySelectorAll<HTMLElement>('[data-card-index]');
      cards[focusedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  /** 그리드 열 수 계산 (auto-fill 기반) */
  function getGridColumns(): number {
    const grid = document.querySelector<HTMLElement>('.cards-grid');
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  }

  function handleKeydown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const len = filteredSessions.length;
    if (len === 0) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown': {
        e.preventDefault();
        const cols = getGridColumns();
        const next = focusedIndex < 0 ? 0 : Math.min(focusedIndex + cols, len - 1);
        focusedIndex = next;
        scrollToFocused();
        break;
      }
      case 'k':
      case 'ArrowUp': {
        e.preventDefault();
        const cols = getGridColumns();
        const next = focusedIndex < 0 ? 0 : Math.max(focusedIndex - cols, 0);
        focusedIndex = next;
        scrollToFocused();
        break;
      }
      case 'h':
      case 'ArrowLeft':
        e.preventDefault();
        focusedIndex = focusedIndex < 1 ? 0 : focusedIndex - 1;
        scrollToFocused();
        break;
      case 'l':
      case 'ArrowRight':
        e.preventDefault();
        focusedIndex = focusedIndex < 0 ? 0 : Math.min(focusedIndex + 1, len - 1);
        scrollToFocused();
        break;
      case 'e':
      case 'Enter':
        if (focusedIndex >= 0 && focusedIndex < len) {
          e.preventDefault();
          handleCardClick(filteredSessions[focusedIndex]);
        }
        break;
      case 'c':
        if (focusedIndex >= 0 && focusedIndex < len) {
          e.preventDefault();
          const cmd = buildSessionCommand(filteredSessions[focusedIndex]);
          copyToClipboard(cmd).then(ok => showToast(ok ? 'Copied!' : 'Copy failed'));
        }
        break;
    }
  }

</script>

<svelte:window onkeydown={handleKeydown} />

<div class="session-cards-container" data-testid="session-cards">
  {#if uniqueProjects.length > 1}
    <div class="project-filter-bar">
      <select
        class="project-filter-select"
        value={projectFilter ?? ''}
        onchange={(e) => setProjectFilter(e.currentTarget.value || null)}
      >
        <option value="">전체 프로젝트</option>
        {#each uniqueProjects as cwd}
          <option value={cwd} title={cwd}>{cwd.split("/").slice(-2).join("/")}</option>
        {/each}
      </select>
    </div>
  {/if}

  {#if filteredSessions.length === 0}
    <div class="empty-state">세션 없음</div>
  {:else}
    <div class="cards-grid">
      {#each filteredSessions as session, si (session.sessionId)}
        {@const ds = getDisplayStatus(session)}
        <button
          class="card"
          class:card-working={ds.cssClass === 'status-working'}
          class:focused={focusedIndex === si}
          onclick={() => handleCardClick(session)}
          data-card-index={si}
          data-testid="session-card"
        >
          <div class="card-top">
            <span class="status-badge {ds.cssClass}" class:status-flash={flashingIds.has(session.sessionId)}>
              {ds.label}
              {#if ds.cssClass === 'status-working'}
                &nbsp;<span class="dot-loader"><span></span><span></span><span></span></span>
              {/if}
            </span>
            {#if session.source === "claude-code"}
              <span class="source-text claude">Claude</span>
            {:else}
              <span class="source-text opencode">OpenCode</span>
            {/if}
            {#if session.childSessionIds && session.childSessionIds.length > 0}
              <span class="subagent-count">{session.childSessionIds.length}</span>
            {/if}
          </div>

          <div class="card-title">
            {session.title || session.lastPrompt?.slice(0, 80) || session.sessionId.slice(0, 12)}
          </div>

          {#if session.currentTool}
            <div class="card-tool">
              <span class="tool-icon">⚙</span> {session.currentTool}
            </div>
          {/if}

          <div class="card-meta">
            <span class="meta-time">{(tick, relativeTime(session.lastActivityTime))}</span>
            {#if session.machineAlias}
              <span class="meta-sep">·</span>
              <span>{session.machineAlias}</span>
            {/if}
            {#if session.processMetrics}
              <span class="meta-sep">·</span>
              <span class="meta-mono">{session.processMetrics.cpuPercent.toFixed(0)}% · {formatRss(session.processMetrics.rssKb)}</span>
            {/if}
          </div>

          {#if session.projectCwd}
            <div class="card-cwd">{session.projectCwd.split("/").slice(-2).join("/")}</div>
          {/if}

          {#if session.lastPrompt}
            <div class="card-prompt">{session.lastPrompt.length > 120 ? session.lastPrompt.slice(0, 120) + '…' : session.lastPrompt}</div>
          {/if}
        </button>
      {/each}
    </div>

    {#if dismissedCount > 0}
      <button class="restore-btn" onclick={restoreAll}>
        {dismissedCount}개 숨김 — 복원
      </button>
    {/if}
  {/if}
</div>

{#if toastMessage}
  <div class="copy-toast">{toastMessage}</div>
{/if}

<style>
  .session-cards-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 1rem;
  }

  .project-filter-bar {
    margin-bottom: 0.75rem;
    max-width: 280px;
  }

  .project-filter-select {
    width: 100%;
    font-size: 0.78rem;
    font-family: "SF Mono", "Fira Code", monospace;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.5rem;
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .project-filter-select:focus {
    border-color: var(--accent);
  }

  .cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .card {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 0.85rem;
    cursor: pointer;
    transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    box-sizing: border-box;
    min-width: 0;
  }

  .card:hover {
    border-color: var(--accent);
    background: rgba(88, 166, 255, 0.04);
  }

  .card:focus-visible,
  .card.focused {
    outline: 2px solid rgba(88, 166, 255, 0.6);
    outline-offset: -2px;
  }

  .card-working {
    box-shadow: inset 0 0 0 1px rgba(88, 166, 255, 0.15);
  }

  .card-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .status-badge {
    font-size: 0.6rem;
    padding: 0.08rem 0.45rem;
    border-radius: 9999px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .status-working {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.3);
  }

  .status-waiting {
    background: rgba(209, 105, 239, 0.15);
    color: #d169ef;
    border: 1px solid rgba(209, 105, 239, 0.3);
  }

  .status-idle {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }

  .status-rename {
    background: rgba(255, 180, 50, 0.15);
    color: #ffb432;
    border: 1px solid rgba(255, 180, 50, 0.3);
  }

  .source-text {
    font-size: 0.65rem;
    font-weight: 500;
    margin-left: auto;
  }

  .source-text.opencode { color: #3fb950; }
  .source-text.claude { color: #a871ff; }

  .subagent-count {
    font-size: 0.55rem;
    padding: 0.05rem 0.35rem;
    background: rgba(139, 148, 158, 0.15);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    font-weight: 600;
    line-height: 1;
  }

  .card-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.35;
  }

  .card-tool {
    font-size: 0.72rem;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tool-icon {
    font-size: 0.68rem;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.68rem;
    color: var(--text-secondary);
    flex-wrap: wrap;
  }

  .meta-sep { opacity: 0.4; }

  .meta-mono {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.6rem;
    opacity: 0.7;
  }

  .card-cwd {
    font-size: 0.68rem;
    color: var(--text-secondary);
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-prompt {
    font-size: 0.68rem;
    color: var(--text-secondary);
    opacity: 0.8;
    font-style: italic;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.4;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-style: italic;
  }

  .restore-btn {
    display: block;
    width: 100%;
    margin-top: 0.75rem;
    padding: 0.35rem 0;
    background: none;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .restore-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .dot-loader {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    vertical-align: middle;
  }

  .dot-loader span {
    width: 3.5px;
    height: 3.5px;
    background: var(--accent);
    border-radius: 50%;
    animation: dot-bounce 1.4s ease-in-out infinite;
  }

  .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.7) translateY(0); }
    40% { opacity: 1; transform: scale(1.2) translateY(-3px); }
  }

  .status-flash {
    animation: badge-flash 1.2s ease-out;
  }

  @keyframes badge-flash {
    0%   { filter: brightness(1); transform: scale(1); }
    15%  { filter: brightness(1.8); transform: scale(1.15); }
    30%  { filter: brightness(1); transform: scale(1); }
    45%  { filter: brightness(1.5); transform: scale(1.1); }
    60%  { filter: brightness(1); transform: scale(1); }
    100% { filter: brightness(1); transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-flash { animation: none; }
    .dot-loader span { animation: none; opacity: 0.5; }
  }

  .copy-toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-tertiary);
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 0.4rem 1rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    z-index: 1000;
    pointer-events: none;
    animation: toast-fade 1.8s ease-out forwards;
    white-space: nowrap;
  }

  @keyframes toast-fade {
    0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
    75% { opacity: 1; }
    100% { opacity: 0; }
  }

  @media (max-width: 599px) {
    .cards-grid {
      grid-template-columns: 1fr;
      gap: 0.5rem;
    }
    .card {
      padding: 0.55rem 0.6rem;
    }
  }
</style>
