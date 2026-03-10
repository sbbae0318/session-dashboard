<script lang="ts">
  import type { DashboardSession } from "../types";
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { getSelectedSessionId, selectSession, getSourceFilter } from "../lib/stores/filter.svelte";
  import { shouldShowMachineFilter, getSelectedMachineId } from '../lib/stores/machine.svelte';
  import { dismissSession, isDismissed, getDismissedCount, restoreAll } from "../lib/stores/dismissed.svelte";
  import { getDetailSessionId, pushSessionDetail } from '../lib/stores/navigation.svelte';
  import { relativeTime, copyToClipboard, formatTimestamp } from "../lib/utils";
  import { onMount } from "svelte";

  let tick = $state(0);
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
  let detailId = $derived(getDetailSessionId());

  const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  function handleDismiss(sessionId: string, lastActivityTime: number, event: Event): void {
    event.stopPropagation();
    dismissSession(sessionId, lastActivityTime);
  }

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

  function handleSessionClick(session: DashboardSession): void {
    selectSession(session.sessionId);
    copySessionCommand(session);
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
      .filter(s =>
        !s.parentSessionId ||
        !sessions.some(p => p.sessionId === s.parentSessionId)
      )
  );


  interface DisplayStatus {
    label: string;
    cssClass: string;
  }

  function getDisplayStatus(session: DashboardSession): DisplayStatus {
    // apiStatus (from SSE cache) takes priority over session.status
    // because status can lag behind real-time SSE updates
    if (session.apiStatus === 'busy' || session.currentTool) {
      return { label: 'Working', cssClass: 'status-working' };
    }
    if (session.apiStatus === 'idle') {
      return { label: 'Waiting', cssClass: 'status-waiting' };
    }
    if (session.apiStatus === 'retry') {
      return { label: 'Retry', cssClass: 'status-retry' };
    }
    if (session.status === 'completed') {
      return { label: 'Done', cssClass: 'status-completed' };
    }
    if (session.status === 'orphaned') {
      return { label: 'Orphaned', cssClass: 'status-orphaned' };
    }
    if (session.apiStatus === null && session.status === 'active') {
      return { label: 'Active', cssClass: 'status-active' };
    }
    const idleMs = Date.now() - session.lastActivityTime;
    if (idleMs < IDLE_THRESHOLD_MS) {
      return { label: 'Idle', cssClass: 'status-idle' };
    }
    return { label: 'Stale', cssClass: 'status-stale' };
  }
</script>

<div class="active-sessions" data-testid="active-sessions">
  {#if sessions.length === 0}
    <div class="empty-state">세션 없음</div>
  {:else}
    <div class="sessions-list">
      {#each topLevelSessions as session (session.sessionId)}
        {@const ds = getDisplayStatus(session)}
        <div class="session-group">
          <!-- Parent / standalone session -->
          <div
            class="session-item"
            class:selected={selectedSessionId === session.sessionId}
            class:detail-active={detailId === session.sessionId}
            onclick={() => handleSessionClick(session)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && handleSessionClick(session)}
          >
            <div class="session-header">
              <!-- Row 1: status + title + actions -->
              <div class="session-header-top">
                <span class="status-badge {ds.cssClass}">{ds.label}</span>
                <span class="session-title">{session.title || session.sessionId.slice(0, 8)}</span>
                <span class="header-actions">
                  <button
                    class="action-btn action-detail"
                    onclick={(e) => { e.stopPropagation(); pushSessionDetail(session.sessionId); }}
                    title="View session detail"
                  >›</button>
                  <button
                    class="action-btn action-dismiss"
                    onclick={(e) => handleDismiss(session.sessionId, session.lastActivityTime, e)}
                    title="Hide until new activity"
                  >×</button>
                </span>
              </div>
              <!-- Row 2: time · machine · source -->
              <div class="session-header-meta">
                {#if session.lastPromptTime}
                  {@const isBusy = ds.cssClass === 'status-working'}
                  {@const showCompletion = !isBusy && session.lastActivityTime > session.lastPromptTime}
                  <span class="session-time-range">
                    {formatTimestamp(session.lastPromptTime)}
                    <span class="time-arrow">→</span>
                    {#if isBusy}
                      <span class="dot-loader-session"><span></span><span></span><span></span></span>
                    {:else if showCompletion}
                      {formatTimestamp(session.lastActivityTime)}
                      <span class="time-ago">({(tick, relativeTime(session.lastActivityTime))})</span>
                    {:else}
                      {(tick, relativeTime(session.lastPromptTime))}
                    {/if}
                  </span>
                {:else}
                  <span class="session-activity-time" title="Last activity">{(tick, relativeTime(session.lastActivityTime))}</span>
                {/if}
                {#if session.machineAlias}
                  <span class="meta-sep">·</span>
                  <span class="machine-meta">{session.machineAlias}</span>
                {/if}
                <span class="meta-sep">·</span>
                {#if session.source === "claude-code"}
                  <span class="source-text claude">Claude</span>
                {:else}
                  <span class="source-text opencode">OpenCode</span>
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

  .session-item.detail-active {
    border-color: var(--accent);
    background: rgba(88, 166, 255, 0.12);
    box-shadow: inset 3px 0 0 var(--accent);
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
  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .session-item:hover .header-actions {
    opacity: 1;
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

  .status-idle {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }

  .status-stale {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid rgba(210, 153, 34, 0.3);
  }

  .status-completed {
    background: rgba(139, 148, 158, 0.15);
    color: var(--text-secondary);
    border: 1px solid rgba(139, 148, 158, 0.3);
  }

  .status-orphaned {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid rgba(210, 153, 34, 0.3);
  }

  .status-waiting {
    background: rgba(168, 113, 255, 0.15);
    color: #a871ff;
    border: 1px solid rgba(168, 113, 255, 0.3);
  }

  .status-retry {
    background: rgba(248, 81, 73, 0.15);
    color: var(--error);
    border: 1px solid rgba(248, 81, 73, 0.3);
  }

  .status-active {
    background: rgba(45, 212, 191, 0.15);
    color: #2dd4bf;
    border: 1px solid rgba(45, 212, 191, 0.3);
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

  .session-time-range {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .time-arrow {
    opacity: 0.4;
  }

  .time-ago {
    font-size: 0.6rem;
    opacity: 0.6;
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

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    background: rgba(139, 148, 158, 0.08);
    border: none;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1;
    padding: 0;
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .action-detail:hover {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
  }

  .action-dismiss:hover {
    background: rgba(248, 81, 73, 0.15);
    color: var(--error);
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

  /* ===== Touch devices ===== */
  @media (pointer: coarse) {
    .header-actions {
      opacity: 1;
    }

    .action-btn {
      width: 2rem;
      height: 2rem;
      font-size: 1rem;
    }

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

    .action-btn {
      width: 1.6rem;
      height: 1.6rem;
      font-size: 0.9rem;
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

  @keyframes toast-fade {
    0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
    75% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
