<script lang="ts">
  import type { DashboardSession } from "../types";
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { getSelectedSessionId, selectSession, getSourceFilter, getTimeRangeCutoff, getProjectFilter, setProjectFilter } from "../lib/stores/filter.svelte";
  import { shouldShowMachineFilter, getSelectedMachineId } from '../lib/stores/machine.svelte';
  import { isDismissed, getDismissedCount, restoreAll } from "../lib/stores/dismissed.svelte";
  import { pushSessionDetail, popToOverview } from '../lib/stores/navigation.svelte';
  import { relativeTime, formatDuration, formatRss, copyToClipboard, getDisplayStatus, detectStatusChanges } from "../lib/utils";
  import { onMount } from "svelte";

  let { paneActive = false }: { paneActive?: boolean } = $props();

  let tick = $state(0);
  let focusedSessionIndex = $state(-1);

  // 상태 변경 flash 추적: sessionId -> 이전 cssClass
  let prevStatusMap = new Map<string, string>();
  let flashingIds = $state(new Set<string>());

  onMount(() => {
    const id = setInterval(() => tick++, 60_000);
    return () => clearInterval(id);
  });
  let allSessions = $derived(getSessions());
  let sessions = $derived(allSessions.filter(s => !isDismissed(s.sessionId)));
  let selectedSessionId = $derived(getSelectedSessionId());
  let dismissedCount = $derived(getDismissedCount());
  let showMachines = $derived(shouldShowMachineFilter());
  let machineFilter = $derived(getSelectedMachineId());
  let sourceFilter = $derived(getSourceFilter());
  let projectFilter = $derived(getProjectFilter());

  // Extract unique projectCwd values from all visible sessions
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

  // --- Clipboard copy: build session resume command ---
  let toastMessage = $state<string | null>(null);
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  function buildSessionCommand(session: DashboardSession): string {
    const cwd = session.projectCwd ?? '~';
    if (session.source === 'claude-code') {
      return `cd ${cwd} && claude --resume ${session.sessionId}`;
    }
    // OpenCode → attach to oc-serve
    const rawHost = session.machineHost ?? 'localhost';
    const host = (rawHost === 'host.docker.internal' || rawHost === '127.0.0.1')
      ? 'localhost'
      : rawHost;
    return `opencode attach http://${host}:4096 --session ${session.sessionId}`;
  }

  async function copySessionCommand(session: DashboardSession): Promise<void> {
    const cmd = buildSessionCommand(session);
    const ok = await copyToClipboard(cmd);
    showToast(ok ? 'Copied!' : 'Copy failed');
  }

  function showToast(msg: string): void {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = null; }, 1800);
  }

  // pane 활성화 시 focus 초기화
  $effect(() => {
    if (paneActive && focusedSessionIndex < 0 && topLevelSessions.length > 0) {
      focusedSessionIndex = 0;
    }
  });

  function scrollToFocusedSession(): void {
    requestAnimationFrame(() => {
      const items = document.querySelectorAll<HTMLElement>('[data-session-index]');
      items[focusedSessionIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  function handleSessionKeydown(e: KeyboardEvent): void {
    if (!paneActive) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const len = topLevelSessions.length;
    if (len === 0) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        focusedSessionIndex = Math.min(focusedSessionIndex + 1, len - 1);
        scrollToFocusedSession();
        break;

      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        focusedSessionIndex = Math.max(focusedSessionIndex - 1, 0);
        scrollToFocusedSession();
        break;

      case 'e':
      case 'Enter': {
        if (focusedSessionIndex >= 0 && focusedSessionIndex < len) {
          e.preventDefault();
          const s = topLevelSessions[focusedSessionIndex];
          // 이미 선택된 세션이면 필터 해제
          if (selectedSessionId === s.sessionId) {
            selectSession(s.sessionId); // toggles off
            popToOverview();
          } else {
            selectSession(s.sessionId);
            pushSessionDetail(s.sessionId);
          }
        }
        break;
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleSessionKeydown);
    return () => document.removeEventListener('keydown', handleSessionKeydown);
  });

  function handleSessionClick(session: DashboardSession): void {
    if (selectedSessionId === session.sessionId) {
      selectSession(session.sessionId);
      popToOverview();
    } else {
      selectSession(session.sessionId);
      copySessionCommand(session);
      pushSessionDetail(session.sessionId);
    }
  }

  // Top-level sessions: no parent, or parent not in active set
  let topLevelSessions = $derived(
    sessions
      .filter(s => !machineFilter || s.machineId === machineFilter)
      .filter(s => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !s.source || s.source === "opencode";
        return s.source === sourceFilter;
      })
      .filter(s => {
        // Active sessions always pass time filter
        if (s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.waitingForInput) return true;
        const cutoff = getTimeRangeCutoff();
        return cutoff === 0 || s.lastActivityTime >= cutoff;
      })
      .filter(s => !s.parentSessionId)
      .filter(s => !projectFilter || s.projectCwd === projectFilter)
  );


  // 상태 변경 감지 → flash 트리거
  $effect(() => {
    const changed = detectStatusChanges(prevStatusMap, topLevelSessions);
    // prevStatusMap 갱신
    const current = new Map<string, string>();
    for (const s of topLevelSessions) {
      current.set(s.sessionId, getDisplayStatus(s).cssClass);
    }
    prevStatusMap = current;
    if (changed.size > 0) {
      flashingIds = changed;
      setTimeout(() => { flashingIds = new Set(); }, 1200);
    }
  });
</script>

<div class="active-sessions" data-testid="active-sessions">
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
  {#if sessions.length === 0}
    <div class="empty-state">세션 없음</div>
  {:else}
    <div class="sessions-list">
      {#each topLevelSessions as session, si (session.sessionId)}
        {@const ds = getDisplayStatus(session)}
        <div class="session-group">
          <!-- Parent / standalone session -->
          <div
            class="session-item"
            class:selected={selectedSessionId === session.sessionId}
            class:focused={paneActive && focusedSessionIndex === si}
            data-session-index={si}
            onclick={() => handleSessionClick(session)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && handleSessionClick(session)}
          >
            <div class="session-header">
              <!-- Row 1: status + title + actions -->
              <div class="session-header-top">
                <span class="status-badge {ds.cssClass}" class:status-flash={flashingIds.has(session.sessionId)}>{ds.label}{#if ds.cssClass === 'status-working'}&nbsp;<span class="dot-loader-session"><span></span><span></span><span></span></span>{/if}</span>
                <span class="session-title">{session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 8)}</span>
                {#if session.childSessionIds && session.childSessionIds.length > 0}
                  <span class="subagent-badge" title="{session.childSessionIds.length} subagent session(s)">{session.childSessionIds.length}</span>
                {/if}
              </div>
              <!-- Row 2: time · machine · source -->
              <div class="session-header-meta">
                <span class="session-activity-time" title="Last activity">{(tick, relativeTime(session.lastActivityTime))}</span>
                {#if session.machineAlias}
                  <span class="meta-sep">·</span>
                  <span class="machine-meta">{session.machineAlias}</span>
                {/if}
                <span class="meta-sep">·</span>
                {#if session.source === "claude-code"}
                  <span class="source-text claude">Claude</span>
                  {#if session.hooksActive === false}
                    <span class="no-hooks-indicator" title="Hooks 미연결 — currentTool, lastPrompt 등 실시간 데이터 미수신">no hooks</span>
                  {/if}
                {:else}
                  <span class="source-text opencode">OpenCode</span>
                {/if}
                {#if session.processMetrics}
                  <span class="meta-sep">·</span>
                  <span class="process-metric" title="CPU {session.processMetrics.cpuPercent.toFixed(1)}% · RSS {formatRss(session.processMetrics.rssKb)}">
                    {session.processMetrics.cpuPercent.toFixed(0)}% · {formatRss(session.processMetrics.rssKb)}
                  </span>
                {/if}
              </div>
            </div>
            {#if session.currentTool}
              <div class="session-tool">
                <span class="tool-indicator">⚙</span>
                <span class="tool-name">{session.currentTool}</span>
              </div>
            {/if}
            {#if session.projectCwd}
              <div class="session-cwd" title={session.projectCwd}>
                {session.projectCwd.split("/").slice(-2).join("/")}
              </div>
            {/if}
{#if session.lastPrompt}
  <div class="session-prompt" title={session.lastPrompt}>
    {session.lastPrompt.length > 100 ? session.lastPrompt.slice(0, 100) + '…' : session.lastPrompt}
  </div>
{/if}
          </div>

        </div>
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
  .project-filter-bar {
    margin-bottom: 0.5rem;
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

  .sessions-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow-y: auto;
  }

  .session-group {
    display: flex;
    flex-direction: column;
  }

  .session-item {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.75rem;
    transition: border-color 0.2s ease, background 0.2s ease;
    cursor: pointer;
    user-select: none;
  }

  .session-item:hover {
    border-color: var(--accent);
  }

  .session-item.selected {
    border-color: var(--accent);
    background: rgba(88, 166, 255, 0.08);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .session-item.focused {
    outline: 2px solid rgba(88, 166, 255, 0.6);
    outline-offset: -2px;
  }

  .session-header {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-bottom: 0.25rem;
  }

  .session-header-top {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .session-header-meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
    flex-wrap: wrap;
  }

  .meta-sep {
    opacity: 0.4;
  }

  .machine-meta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 8rem;
  }

  .source-text {
    white-space: nowrap;
    font-weight: 500;
  }

  .source-text.opencode {
    color: #3fb950;
  }

  .source-text.claude {
    color: #a871ff;
  }

  .no-hooks-indicator {
    font-size: 0.6rem;
    color: var(--text-secondary);
    opacity: 0.5;
    font-style: italic;
  }
  .session-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    flex: 1;
    min-width: 0;
  }


  .status-badge {
    font-size: 0.65rem;
    padding: 0.1rem 0.5rem;
    border-radius: 9999px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .subagent-badge {
    font-size: 0.55rem;
    padding: 0.05rem 0.35rem;
    background: rgba(139, 148, 158, 0.15);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
    font-weight: 600;
    line-height: 1;
  }

  .machine-badge {
    font-size: 0.6rem;
    padding: 0.05rem 0.4rem;
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
    font-weight: 400;
  }

  .source-badge {
    font-size: 0.6rem;
    padding: 0.05rem 0.4rem;
    border-radius: 9999px;
    white-space: nowrap;
    flex-shrink: 0;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .source-badge.claude {
    background: rgba(168, 113, 255, 0.15);
    color: #a871ff;
    border: 1px solid rgba(168, 113, 255, 0.3);
  }

  .source-badge.opencode {
    background: rgba(63, 185, 80, 0.15);
    color: #3fb950;
    border: 1px solid rgba(63, 185, 80, 0.3);
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


  .session-tool {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--accent);
    margin-bottom: 0.15rem;
  }

  .tool-indicator {
    font-size: 0.7rem;
  }

  .session-duration {
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  .session-duration-meta {
    white-space: nowrap;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.65rem;
    opacity: 0.8;
  }

  .process-metric {
    white-space: nowrap;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.6rem;
    opacity: 0.7;
  }

  .session-cwd {
    font-size: 0.7rem;
    color: var(--text-secondary);
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 0.15rem;
  }

  .session-activity-time {
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .session-time-working {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .dot-loader-session {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    vertical-align: middle;
  }

  .dot-loader-session span {
    width: 4px;
    height: 4px;
    background: var(--accent);
    border-radius: 50%;
    animation: dot-bounce-session 1.4s ease-in-out infinite;
  }

  .dot-loader-session span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader-session span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce-session {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.7) translateY(0); }
    40% { opacity: 1; transform: scale(1.2) translateY(-3px); }
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-style: italic;
  }

  .restore-btn {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
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
.session-prompt {
  font-size: 0.7rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 0.15rem;
  opacity: 0.8;
  font-style: italic;
}

  /* ===== Mobile (≤599px) ===== */
  @media (max-width: 599px) {
    .session-item {
      padding: 0.4rem 0.5rem;
    }

    .session-header {
      gap: 0.2rem;
    }

    .status-badge {
      font-size: 0.6rem;
      padding: 0.05rem 0.35rem;
    }

    .session-title {
      font-size: 0.85rem;
    }

    .session-cwd,
    .session-prompt {
      font-size: 0.75rem;
    }
  }


  /* ===== Copy toast ===== */
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
  }

  @keyframes toast-fade {
    0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
    75% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
