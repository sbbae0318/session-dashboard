<script lang="ts">
  import { getQueries } from "../lib/stores/queries.svelte";
  import PromptDetailModal from "./PromptDetailModal.svelte";
  import { getSelectedSessionId, getSourceFilter, selectSession } from "../lib/stores/filter.svelte";
  import { getSelectedMachineId, shouldShowMachineFilter } from '../lib/stores/machine.svelte';
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { relativeTime, truncate, getQueryResult, getCompletionTime, formatTimestamp, copyToClipboard, isBackgroundQuery } from "../lib/utils";
  import type { DashboardSession } from "../types";

  let {
    sessionIdFilter = null,
  }: {
    sessionIdFilter?: string | null;
  } = $props();

  let queries = $derived(getQueries());
  let selectedSessionId = $derived(getSelectedSessionId());
  let machineFilter = $derived(getSelectedMachineId());
  let showMachines = $derived(shouldShowMachineFilter());
  let sessions = $derived(getSessions());
  let sourceFilter = $derived(getSourceFilter());

  // --- State ---
  let showBackground = $state(false);

  let filteredQueries = $derived(
    queries
      .filter(q => showBackground || !isBackgroundQuery(q, sessions))
      // bg query를 parent 세션으로 리매핑
      .map(q => {
        if (!isBackgroundQuery(q, sessions)) return q;
        const childSession = sessions.find(s => s.sessionId === q.sessionId);
        const parentId = childSession?.parentSessionId;
        if (!parentId) return q; // orphaned — 원본 유지
        const parentSession = sessions.find(s => s.sessionId === parentId);
        if (!parentSession) return q; // parent not in store — 원본 유지
        return { ...q, sessionId: parentId, sessionTitle: parentSession.title ?? parentId.slice(0, 8) };
      })
      .filter(q => !machineFilter || q.machineId === machineFilter)
      .filter(q => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !q.source || q.source === "opencode";
        return q.source === sourceFilter;
      })
      .filter(q => {
        const sid = sessionIdFilter ?? selectedSessionId;
        return !sid || q.sessionId === sid;
      })
      .toSorted((a, b) => b.timestamp - a.timestamp)
  );

  // 세션별 최신 프롬프트 인덱스 (filteredQueries는 timestamp desc 정렬이므로 첫 등장이 최신)
  let latestIndexBySession = $derived(
    filteredQueries.reduce((acc, q, idx) => {
      if (!(q.sessionId in acc)) acc[q.sessionId] = idx;
      return acc;
    }, {} as Record<string, number>)
  );

  let backgroundCount = $derived(
    queries
      .filter(q => isBackgroundQuery(q, sessions))
      .filter(q => !machineFilter || q.machineId === machineFilter)
      .filter(q => {
        if (sourceFilter === "all") return true;
        if (sourceFilter === "opencode") return !q.source || q.source === "opencode";
        return q.source === sourceFilter;
      })
      .filter(q => {
        const sid = sessionIdFilter ?? selectedSessionId;
        if (!sid) return true;
        if (q.sessionId === sid) return true;
        // bg query의 parent가 선택된 세션인 경우도 포함
        const childSession = sessions.find(s => s.sessionId === q.sessionId);
        return childSession?.parentSessionId === sid;
      })
      .length
  );

  // --- Clipboard copy ---
  let toastMessage = $state<string | null>(null);
  let modalEntry = $state<{ sessionId: string; source?: string; query: string; sessionTitle?: string; timestamp: number } | null>(null);
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  function buildCommandFromQuery(entry: { sessionId: string; source?: string }): string {
    const session = sessions.find((s: DashboardSession) => s.sessionId === entry.sessionId);
    const cwd = session?.projectCwd ?? '~';
    const source = entry.source ?? session?.source;
    if (source === 'claude-code') {
      return `cd ${cwd} && claude --resume ${entry.sessionId}`;
    }
    return `cd ${cwd} && opencode --session ${entry.sessionId}`;
  }

  function handlePromptClick(entry: typeof filteredQueries[number]): void {
    selectSession(entry.sessionId);
  }

  function handleDetailClick(entry: typeof filteredQueries[number], event: Event): void {
    event.stopPropagation();
    modalEntry = entry;
  }

  function showToast(msg: string): void {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = null; }, 1800);
  }
</script>

<div class="recent-prompts" data-testid="recent-prompts">
  {#if backgroundCount > 0}
    <div class="bg-toggle-bar">
      <button
        class="bg-toggle-btn"
        class:active={showBackground}
        onclick={() => { showBackground = !showBackground; }}
      >
        {#if showBackground}
          bg 숨김
        {:else}
          bg 포함 ({backgroundCount})
        {/if}
      </button>
    </div>
  {/if}
  {#if filteredQueries.length === 0}
    <div class="empty-state">{selectedSessionId ? '선택된 세션의 프롬프트 없음' : '최근 프롬프트 없음'}</div>
  {:else}
    <div class="prompts-list">

      {#each filteredQueries as entry, i (entry.sessionId + '-' + entry.timestamp + '-' + i)}
        {@const resolvedTitle = entry.sessionTitle || sessions.find(s => s.sessionId === entry.sessionId)?.title || entry.sessionId.slice(0, 8)}
        {@const result = getQueryResult(entry, sessions)}
        {@const completionTs = getCompletionTime(entry)}
        {@const session = sessions.find(s => s.sessionId === entry.sessionId)}
        {@const isSessionBusy = session?.apiStatus === 'busy' || session?.status === 'active'}
        {@const isLatestForSession = i === latestIndexBySession[entry.sessionId]}
        {@const isWorking = !completionTs || (isSessionBusy && isLatestForSession)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="prompt-item" class:in-progress={isWorking}
          class:background={entry.isBackground}
          class:clickable={true}
          onclick={() => handlePromptClick(entry)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && handlePromptClick(entry)}
        >
          <div class="prompt-header">
            <span class="prompt-session">{resolvedTitle}</span>
            <div class="prompt-meta">
              <span class="prompt-time">
                {formatTimestamp(entry.timestamp)}
                <span class="time-arrow">→</span>
                {#if completionTs && !isWorking}
                  {formatTimestamp(completionTs)}
                  <span class="time-ago">({relativeTime(completionTs)})</span>
                {:else}
                  <span class="dot-loader"><span></span><span></span><span></span></span>
                {/if}
              </span>
              {#if showMachines && entry.machineAlias}
                <span class="machine-tag">{entry.machineAlias}</span>
              {/if}
              {#if result === 'completed'}
                <span class="result-badge result-completed">✓</span>
              {:else if result === 'user_exit'}
                <span class="result-badge result-exit">↩</span>
              {:else if result === 'error'}
                <span class="result-badge result-error">⚠</span>
              {:else if result === 'idle'}
                <span class="result-badge result-idle">○</span>
              {:else if result === 'busy' || result === 'active'}
                <span class="result-badge result-active"><span class="dot-loader-sm"><span></span><span></span><span></span></span></span>
              {/if}
              {#if entry.source === "claude-code"}
                <span class="source-badge claude">Claude</span>
              {:else}
                <span class="source-badge opencode">OpenCode</span>
              {/if}
              <button
                class="prompt-detail-btn"
                onclick={(e) => handleDetailClick(entry, e)}
                title="프롬프트 전문 보기"
              >전문</button>
            </div>
          </div>
          <p class="prompt-text" title={entry.query}>
            {truncate(entry.query, 200)}
          </p>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if modalEntry}
  <PromptDetailModal
    entry={modalEntry}
    buildCommand={buildCommandFromQuery}
    onClose={() => { modalEntry = null; }}
    onCopy={async (cmd) => {
      const ok = await copyToClipboard(cmd);
      showToast(ok ? 'Copied!' : 'Copy failed');
    }}
  />
{/if}

{#if toastMessage}
  <div class="copy-toast">{toastMessage}</div>
{/if}

<style>
  .recent-prompts {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .prompts-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-bottom: 1rem;
  }

  .prompt-item {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1rem;
    transition: border-color 0.2s ease;
  }

  .prompt-item.clickable {
    cursor: pointer;
  }

  .prompt-item:hover {
    border-color: var(--accent);
  }

  .prompt-item.background {
    border-left: 2px solid rgba(139, 148, 158, 0.4);
    opacity: 0.85;
    background: rgba(139, 148, 158, 0.03);
  }


  .prompt-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.4rem;
  }

  .prompt-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .prompt-session {
    font-size: 0.75rem;
    color: var(--accent);
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
  }

  .prompt-time {
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .time-arrow {
    opacity: 0.4;
  }

  .time-ago {
    font-size: 0.6rem;
    opacity: 0.6;
  }

  .prompt-text {
    font-size: 0.9rem;
    color: var(--text-primary);
    line-height: 1.6;
  }


  .machine-tag {
    font-size: 0.6rem;
    padding: 0.05rem 0.4rem;
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .result-badge {
    display: inline-block;
    font-size: 0.6rem;
    padding: 0.05rem 0.35rem;
    border-radius: 9999px;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .result-completed {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }
  .result-exit {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid rgba(210, 153, 34, 0.3);
  }
  .result-error {
    background: rgba(248, 81, 73, 0.15);
    color: var(--error);
    border: 1px solid rgba(248, 81, 73, 0.3);
  }
  .result-idle {
    background: rgba(139, 148, 158, 0.15);
    color: var(--text-secondary);
    border: 1px solid rgba(139, 148, 158, 0.3);
  }
  .result-active {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.3);
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

  .prompt-detail-btn {
    display: inline-flex;
    align-items: center;
    background: none;
    border: 1px solid rgba(139, 148, 158, 0.3);
    border-radius: 9999px;
    padding: 0.05rem 0.4rem;
    font-size: 0.6rem;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .prompt-detail-btn:hover {
    background: rgba(88, 166, 255, 0.1);
    border-color: rgba(88, 166, 255, 0.4);
    color: var(--accent);
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

  .bg-toggle-bar {
    display: flex;
    justify-content: flex-end;
    padding: 0 0 0.4rem 0;
    flex-shrink: 0;
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
  @media (max-width: 599px) {
    .prompts-list {
      max-height: 60vh;
    }
    .prompt-item {
      padding: 0.65rem;
    }
    .prompt-meta {
      flex-wrap: wrap;
    }
    .prompt-text {
      overflow-wrap: break-word;
      font-size: 0.85rem;
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

  /* ===== In-progress prompt item — pulsing glow card ===== */
  .prompt-item.in-progress {
    border-left: 3px solid var(--accent);
    background: linear-gradient(90deg, rgba(88, 166, 255, 0.08) 0%, var(--bg-tertiary) 40%);
    animation: card-pulse 2.5s ease-in-out infinite;
  }

  @keyframes card-pulse {
    0%, 100% {
      border-left-color: rgba(88, 166, 255, 0.3);
      box-shadow: inset 3px 0 8px rgba(88, 166, 255, 0);
    }
    50% {
      border-left-color: rgba(88, 166, 255, 1);
      box-shadow: inset 3px 0 12px rgba(88, 166, 255, 0.15);
    }
  }

  /* ===== 3-dot bounce loader (time display) ===== */
  .dot-loader {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    vertical-align: middle;
    padding-left: 2px;
  }

  .dot-loader span {
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
    animation: dot-bounce 1.4s ease-in-out infinite;
    box-shadow: 0 0 4px rgba(88, 166, 255, 0.5);
  }

  .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce {
    0%, 80%, 100% {
      opacity: 0.25;
      transform: scale(0.7) translateY(0);
    }
    40% {
      opacity: 1;
      transform: scale(1.2) translateY(-6px);
      box-shadow: 0 0 8px rgba(88, 166, 255, 0.8);
    }
  }

  /* ===== Small dot loader for result badge ===== */
  .dot-loader-sm {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .dot-loader-sm span {
    width: 4px;
    height: 4px;
    background: var(--accent);
    border-radius: 50%;
    animation: dot-bounce 1.4s ease-in-out infinite;
  }

  .dot-loader-sm span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader-sm span:nth-child(3) { animation-delay: 0.4s; }

  @media (prefers-reduced-motion: reduce) {
    .prompt-item.in-progress { animation: none; border-left-color: var(--accent); box-shadow: none; }
    .dot-loader span, .dot-loader-sm span { animation: none; opacity: 0.7; transform: none; }
  }
</style>
