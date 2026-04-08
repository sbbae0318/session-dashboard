<script lang="ts">
  import { getQueries } from "../lib/stores/queries.svelte";
  import { getSelectedSessionId, getSourceFilter, selectSession } from "../lib/stores/filter.svelte";
  import { getSelectedMachineId, shouldShowMachineFilter } from '../lib/stores/machine.svelte';
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { truncate, getQueryResult, getCompletionTime, formatTimestamp, formatDuration, copyToClipboard, isBackgroundQuery } from "../lib/utils";
  import { renderMarkdown } from "../lib/markdown";
  import type { DashboardSession } from "../types";
  import { onMount } from "svelte";

  let {
    sessionIdFilter = null,
    showBackground = $bindable(false),
    onBackgroundCountChange,
    paneActive = true,
  }: {
    sessionIdFilter?: string | null;
    showBackground?: boolean;
    onBackgroundCountChange?: (count: number) => void;
    paneActive?: boolean;
  } = $props();

  let queries = $derived(getQueries());
  let selectedSessionId = $derived(getSelectedSessionId());
  let machineFilter = $derived(getSelectedMachineId());
  let showMachines = $derived(shouldShowMachineFilter());
  let sessions = $derived(getSessions());
  let sourceFilter = $derived(getSourceFilter());

  // --- State ---

  let filteredQueries = $derived(
    queries
      .filter(q => showBackground || !isBackgroundQuery(q, sessions))
      .map(q => {
        if (!isBackgroundQuery(q, sessions)) return q;
        const childSession = sessions.find(s => s.sessionId === q.sessionId);
        const parentId = childSession?.parentSessionId;
        if (!parentId) return q;
        const parentSession = sessions.find(s => s.sessionId === parentId);
        if (!parentSession) return q;
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

  // in-progress (busy 세션의 최신 프롬프트)를 목록 맨 위로
  let sortedQueries = $derived.by(() => {
    const busySessions = new Set(
      sessions
        .filter(s => (s.apiStatus === 'busy' || s.apiStatus === 'retry' || s.currentTool) && !s.waitingForInput)
        .map(s => s.sessionId)
    );
    // latestTimestamp per session
    const latestTs: Record<string, number> = {};
    for (const q of filteredQueries) {
      if (!(q.sessionId in latestTs) || q.timestamp > latestTs[q.sessionId]) {
        latestTs[q.sessionId] = q.timestamp;
      }
    }
    const isInProgress = (q: typeof filteredQueries[number]) =>
      busySessions.has(q.sessionId) && q.timestamp === latestTs[q.sessionId];

    return filteredQueries.toSorted((a, b) => {
      const aP = isInProgress(a) ? 1 : 0;
      const bP = isInProgress(b) ? 1 : 0;
      if (aP !== bP) return bP - aP;
      return b.timestamp - a.timestamp;
    });
  });

  let latestIndexBySession = $derived(
    sortedQueries.reduce((acc, q, idx) => {
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
        const childSession = sessions.find(s => s.sessionId === q.sessionId);
        return childSession?.parentSessionId === sid;
      })
      .length
  );

  $effect(() => { onBackgroundCountChange?.(backgroundCount); });

  // --- Expand/collapse state (always multi-expand) ---
  let expandedKeys = $state<Set<string>>(new Set());
  let responseCache = $state<Map<string, { text: string | null; loading: boolean; error: string | null }>>(new Map());

  function entryKey(entry: { sessionId: string; timestamp: number }): string {
    return `${entry.sessionId}:${entry.timestamp}`;
  }

  function toggleExpand(entry: typeof filteredQueries[number]): void {
    const key = entryKey(entry);
    if (expandedKeys.has(key)) {
      const next = new Set(expandedKeys);
      next.delete(key);
      expandedKeys = next;
    } else {
      expandedKeys = new Set([...expandedKeys, key]);
      if (!responseCache.has(key)) {
        void fetchResponse(entry, key);
      }
    }
  }

  async function fetchResponse(entry: typeof filteredQueries[number], key: string): Promise<void> {
    responseCache = new Map(responseCache).set(key, { text: null, loading: true, error: null });
    try {
      const params = new URLSearchParams({
        sessionId: entry.sessionId,
        timestamp: String(entry.timestamp),
        source: entry.source ?? '',
        ...(entry.machineId ? { machineId: entry.machineId } : {}),
      });
      const res = await fetch(`/api/prompt-response?${params}`);
      const data = await res.json() as { response: string | null; error?: string };
      responseCache = new Map(responseCache).set(key, {
        text: data.response,
        loading: false,
        error: data.error ?? null,
      });
    } catch {
      responseCache = new Map(responseCache).set(key, {
        text: null,
        loading: false,
        error: '응답을 불러올 수 없습니다',
      });
    }
  }

  // --- Keyboard navigation (vim-style TUI) ---
  let focusedIndex = $state(-1);
  let lastGTime = 0;

  function isInputFocused(): boolean {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isPaletteOpen(): boolean {
    return !!document.querySelector('[data-testid="command-palette"]');
  }

  function scrollToFocused(): void {
    requestAnimationFrame(() => {
      const items = document.querySelectorAll<HTMLElement>('[data-prompt-index]');
      items[focusedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // --- Expand all / collapse all with concurrency limit ---
  async function toggleExpandAll(): Promise<void> {
    const allKeys = sortedQueries.map(entryKey);
    const allExpanded = allKeys.length > 0 && allKeys.every(k => expandedKeys.has(k));

    if (allExpanded) {
      // Collapse all
      expandedKeys = new Set();
      return;
    }

    // Expand all — set keys first, then fetch responses with concurrency limit
    expandedKeys = new Set(allKeys);

    const toFetch = sortedQueries.filter(e => !responseCache.has(entryKey(e)));
    const CONCURRENCY = 3;
    let i = 0;
    async function next(): Promise<void> {
      while (i < toFetch.length) {
        const entry = toFetch[i++];
        await fetchResponse(entry, entryKey(entry));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, () => next()));
  }

  function handleGlobalKeydown(e: KeyboardEvent): void {
    if (!paneActive) return;
    if (isInputFocused() || isPaletteOpen()) return;

    const ctrl = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    // Ctrl+Shift combos
    if (ctrl && shift) {
      if (e.key === 'A' || e.key === 'a') {
        e.preventDefault();
        void toggleExpandAll();
        return;
      }
    }

    // Single-key vim bindings (no modifiers)
    if (ctrl || e.altKey) return;

    const len = sortedQueries.length;
    if (len === 0) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        focusedIndex = Math.min(focusedIndex + 1, len - 1);
        scrollToFocused();
        break;

      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        focusedIndex = Math.max(focusedIndex - 1, 0);
        scrollToFocused();
        break;

      case 'Enter':
      case ' ':
      case 'e':
        if (focusedIndex >= 0 && focusedIndex < len) {
          e.preventDefault();
          toggleExpand(sortedQueries[focusedIndex]);
        }
        break;

      case 'a':
        e.preventDefault();
        void toggleExpandAll();
        break;

      case 'c':
        if (focusedIndex >= 0 && focusedIndex < len) {
          void handleCopyCommand(sortedQueries[focusedIndex], e);
        }
        break;

      case 'g':
        if (shift) {
          // G → go to bottom
          e.preventDefault();
          focusedIndex = len - 1;
          scrollToFocused();
        } else {
          // g g → go to top (double tap within 300ms)
          const now = Date.now();
          if (now - lastGTime < 300) {
            e.preventDefault();
            focusedIndex = 0;
            scrollToFocused();
            lastGTime = 0;
          } else {
            lastGTime = now;
          }
        }
        break;

      case 'Escape':
        expandedKeys = new Set();
        focusedIndex = -1;
        break;
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleGlobalKeydown);
    return () => document.removeEventListener('keydown', handleGlobalKeydown);
  });

  // --- Session filter (click session name) ---
  function handleSessionClick(sessionId: string, event: Event): void {
    event.stopPropagation();
    selectSession(sessionId);
  }

  // --- Clipboard ---
  let toastMessage = $state<string | null>(null);
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  function showToast(msg: string): void {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = null; }, 1800);
  }

  function buildResumeCommand(entry: { sessionId: string; source?: string }): string {
    const session = sessions.find((s: DashboardSession) => s.sessionId === entry.sessionId);
    const cwd = session?.projectCwd ?? '~';
    const source = entry.source ?? session?.source;
    if (source === 'claude-code') {
      return `cd ${cwd} && claude --resume ${entry.sessionId}`;
    }
    return `cd ${cwd} && opencode --session ${entry.sessionId}`;
  }

  async function handleCopyCommand(entry: typeof filteredQueries[number], event: Event): Promise<void> {
    event.stopPropagation();
    const cmd = buildResumeCommand(entry);
    const ok = await copyToClipboard(cmd);
    showToast(ok ? 'Copied!' : 'Copy failed');
  }

</script>

<div class="recent-prompts" data-testid="recent-prompts">
  {#if sortedQueries.length === 0}
    <div class="empty-state">{selectedSessionId ? '선택된 세션의 프롬프트 없음' : '최근 프롬프트 없음'}</div>
  {:else}
    <div class="prompts-list">
      {#each sortedQueries as entry, i (entry.sessionId + '-' + entry.timestamp)}
        {@const matchedSession = sessions.find(s => s.sessionId === entry.sessionId)}
        {@const resolvedTitle = entry.sessionTitle || matchedSession?.title || matchedSession?.projectCwd?.split('/').pop() || entry.sessionId.slice(0, 8)}
        {@const result = getQueryResult(entry, sessions)}
        {@const completionTs = getCompletionTime(entry)}
        {@const session = sessions.find(s => s.sessionId === entry.sessionId)}
        {@const isSessionBusy = (session?.apiStatus === 'busy' || session?.apiStatus === 'retry' || session?.currentTool) && !session?.waitingForInput}
        {@const isLatestForSession = i === latestIndexBySession[entry.sessionId]}
        {@const isWorking = isSessionBusy && isLatestForSession}
        {@const key = entryKey(entry)}
        {@const isExpanded = expandedKeys.has(key)}
        {@const cached = responseCache.get(key)}

        <div
          class="prompt-item" class:in-progress={isWorking} class:expanded={isExpanded}
          class:background={entry.isBackground} class:focused={focusedIndex === i}
          data-prompt-index={i}
        >
          <!-- Prompt area (clickable) -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="prompt-clickable"
            onclick={() => toggleExpand(entry)}
            onkeydown={(e) => e.key === 'Enter' && toggleExpand(entry)}
            tabindex="0"
            role="button"
          >
            <div class="prompt-header">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="prompt-session"
                onclick={(e) => handleSessionClick(entry.sessionId, e)}
                onkeydown={(e) => e.key === 'Enter' && handleSessionClick(entry.sessionId, e)}
                role="button"
                tabindex="0"
                title="세션 필터"
              >{resolvedTitle}</span>
              <div class="prompt-meta">
                <span class="prompt-time">
                  {formatTimestamp(entry.timestamp)}
                  {#if isWorking}
                    <span class="time-arrow">→</span>
                    <span class="dot-loader"><span></span><span></span><span></span></span>
                  {:else if completionTs}
                    <span class="prompt-duration">({formatDuration(completionTs - entry.timestamp)})</span>
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
                  {#if isWorking}
                    <span class="result-badge result-active"><span class="dot-loader-sm"><span></span><span></span><span></span></span></span>
                  {:else}
                    <span class="result-badge result-active">⟳</span>
                  {/if}
                {/if}
                {#if entry.source === "claude-code"}
                  <span class="source-badge claude">Claude</span>
                {:else}
                  <span class="source-badge opencode">OpenCode</span>
                {/if}
                <button
                  class="copy-cmd-btn"
                  onclick={(e) => handleCopyCommand(entry, e)}
                  title="resume 명령어 복사"
                >⎘</button>
              </div>
            </div>
            <div class="prompt-text">{isExpanded ? entry.query : truncate(entry.query, 200)}</div>
          </div>

          <!-- Response area (inline, shown when expanded) -->
          {#if isExpanded}
            <div class="response-area">
              {#if isWorking}
                <div class="response-status">
                  <span class="dot-loader"><span></span><span></span><span></span></span>
                  <span>실행 중...</span>
                </div>
              {:else if cached?.loading}
                <div class="response-status">
                  <span class="dot-loader"><span></span><span></span><span></span></span>
                  <span>응답 로딩 중...</span>
                </div>
              {:else if cached?.text}
                <div class="response-rendered">{@html renderMarkdown(cached.text)}</div>
              {:else if cached?.error}
                <div class="response-status dim">{cached.error}</div>
              {:else}
                <div class="response-status dim">응답 데이터 없음</div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

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
    transition: border-color 0.2s ease;
    overflow: hidden;
    flex-shrink: 0;
  }

  .prompt-item:hover {
    border-color: var(--accent);
  }

  .prompt-item.expanded {
    border-color: rgba(88, 166, 255, 0.4);
  }

  .prompt-item.focused {
    outline: 2px solid rgba(88, 166, 255, 0.6);
    outline-offset: -1px;
  }

  .prompt-item.background {
    border-left: 2px solid rgba(139, 148, 158, 0.4);
    opacity: 0.85;
    background: rgba(139, 148, 158, 0.03);
  }

  /* ── Prompt clickable area ── */
  .prompt-clickable {
    padding: 0.75rem 1rem;
    cursor: pointer;
  }

  .prompt-clickable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .prompt-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.35rem;
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
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    transition: background 0.15s ease;
  }

  .prompt-session:hover {
    background: rgba(88, 166, 255, 0.12);
    text-decoration: underline;
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

  .time-arrow { opacity: 0.4; }

  .prompt-duration {
    font-size: 0.6rem;
    opacity: 0.6;
  }

  .prompt-text {
    font-size: 0.9rem;
    color: var(--text-primary);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── Copy command button ── */
  .copy-cmd-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid rgba(139, 148, 158, 0.3);
    border-radius: 9999px;
    width: 1.3rem;
    height: 1.3rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    padding: 0;
    line-height: 1;
  }

  .copy-cmd-btn:hover {
    background: rgba(88, 166, 255, 0.1);
    border-color: rgba(88, 166, 255, 0.4);
    color: var(--accent);
  }

  /* ── Badges ── */
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
  .result-completed { background: rgba(63, 185, 80, 0.15); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.3); }
  .result-exit { background: rgba(210, 153, 34, 0.15); color: var(--warning); border: 1px solid rgba(210, 153, 34, 0.3); }
  .result-error { background: rgba(248, 81, 73, 0.15); color: var(--error); border: 1px solid rgba(248, 81, 73, 0.3); }
  .result-idle { background: rgba(139, 148, 158, 0.15); color: var(--text-secondary); border: 1px solid rgba(139, 148, 158, 0.3); }
  .result-active { background: rgba(88, 166, 255, 0.15); color: var(--accent); border: 1px solid rgba(88, 166, 255, 0.3); }

  .source-badge {
    font-size: 0.6rem;
    padding: 0.05rem 0.4rem;
    border-radius: 9999px;
    white-space: nowrap;
    flex-shrink: 0;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .source-badge.claude { background: rgba(168, 113, 255, 0.15); color: #a871ff; border: 1px solid rgba(168, 113, 255, 0.3); }
  .source-badge.opencode { background: rgba(63, 185, 80, 0.15); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.3); }

  /* ── Response area ── */
  .response-area {
    border-top: 1px solid var(--border);
    padding: 0.75rem 1rem;
    background: rgba(88, 166, 255, 0.03);
    border-left: 3px solid rgba(88, 166, 255, 0.4);
    animation: response-fadein 0.2s ease-out;
  }

  @keyframes response-fadein {
    from { opacity: 0; max-height: 0; }
    to { opacity: 1; max-height: 2000px; }
  }

  .response-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }

  .response-status.dim {
    opacity: 0.6;
    font-style: italic;
  }

  /* ── Rendered markdown ── */
  .response-rendered {
    font-size: 0.85rem;
    color: var(--text-primary);
    line-height: 1.65;
  }

  .response-rendered :global(.md-p) { margin: 0.4rem 0; }
  .response-rendered :global(.md-h) { margin: 0.8rem 0 0.3rem; color: var(--text-primary); font-weight: 600; }
  .response-rendered :global(h3.md-h) { font-size: 1rem; }
  .response-rendered :global(h4.md-h) { font-size: 0.92rem; }
  .response-rendered :global(h5.md-h) { font-size: 0.85rem; }
  .response-rendered :global(h6.md-h) { font-size: 0.8rem; }

  .response-rendered :global(.md-list) { margin: 0.3rem 0; padding-left: 1.5rem; }
  .response-rendered :global(.md-list li) { margin: 0.15rem 0; }

  .response-rendered :global(.md-inline-code) {
    background: rgba(110, 118, 129, 0.2);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.82rem;
  }

  .response-rendered :global(.md-link) {
    color: var(--accent);
    text-decoration: none;
  }
  .response-rendered :global(.md-link:hover) {
    text-decoration: underline;
  }

  .response-rendered :global(.md-hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.6rem 0;
  }

  .response-rendered :global(.md-table-wrap) {
    overflow-x: auto;
    margin: 0.5rem 0;
  }

  .response-rendered :global(.md-table) {
    border-collapse: collapse;
    font-size: 0.8rem;
    width: 100%;
  }

  .response-rendered :global(.md-table th),
  .response-rendered :global(.md-table td) {
    border: 1px solid var(--border);
    padding: 0.3rem 0.5rem;
    text-align: left;
  }

  .response-rendered :global(.md-table th) {
    background: rgba(110, 118, 129, 0.1);
    font-weight: 600;
  }

  .response-rendered :global(.code-block-wrap),
  .response-rendered :global(.code-fold) {
    margin: 0.5rem 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .response-rendered :global(.code-lang) {
    display: inline-block;
    font-size: 0.7rem;
    color: var(--text-secondary);
    padding: 0.2rem 0.5rem;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .response-rendered :global(.code-block) {
    margin: 0;
    padding: 0.6rem 0.8rem;
    background: rgba(0, 0, 0, 0.25);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
    color: var(--text-primary);
  }

  .response-rendered :global(.code-fold-summary) {
    cursor: pointer;
    padding: 0.35rem 0.6rem;
    background: rgba(110, 118, 129, 0.08);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    user-select: none;
  }

  .response-rendered :global(.code-fold-summary:hover) {
    background: rgba(110, 118, 129, 0.15);
  }

  .response-rendered :global(.code-fold-lines) {
    font-size: 0.7rem;
    opacity: 0.7;
  }

  /* ── Empty / toast ── */
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-style: italic;
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

  /* ── In-progress pulse ── */
  .prompt-item.in-progress {
    border-left: 3px solid var(--accent);
    background: linear-gradient(90deg, rgba(88, 166, 255, 0.08) 0%, var(--bg-tertiary) 40%);
    animation: card-pulse 2.5s ease-in-out infinite;
  }

  @keyframes card-pulse {
    0%, 100% { border-left-color: rgba(88, 166, 255, 0.3); box-shadow: inset 3px 0 8px rgba(88, 166, 255, 0); }
    50% { border-left-color: rgba(88, 166, 255, 1); box-shadow: inset 3px 0 12px rgba(88, 166, 255, 0.15); }
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt-item.in-progress { animation: none; border-left-color: var(--accent); box-shadow: none; }
    .response-area { animation: none; }
  }

  @media (max-width: 599px) {
    .prompts-list { max-height: 60vh; }
    .prompt-clickable { padding: 0.65rem; }
    .prompt-meta { flex-wrap: wrap; }
    .prompt-text { overflow-wrap: break-word; font-size: 0.85rem; }
  }
</style>
