<script lang="ts">
  import type { DashboardSession, QueryEntry } from "../types";
  import { getSessions } from "../lib/stores/sessions.svelte";
  import { getQueries } from "../lib/stores/queries.svelte";
  import { relativeTime, truncate } from "../lib/utils";

  let {
    open,
    onClose,
    onSelectSession,
  }: {
    open: boolean;
    onClose: () => void;
    onSelectSession: (sessionId: string) => void;
  } = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  // ── Fuzzy search (case-insensitive substring match) ──────────────────
  function fuzzyMatch(text: string, searchQuery: string): boolean {
    const lower = text.toLowerCase();
    const terms = searchQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return true;
    return terms.every((term) => lower.includes(term));
  }

  // ── Derived filtered results ──────────────────────────────────────────
  let allSessions = $derived(getSessions());
  let allQueries = $derived(getQueries());

  let filteredSessions: DashboardSession[] = $derived(
    query.trim() === ""
      ? allSessions.slice(0, 5)
      : allSessions
          .filter((s) =>
            fuzzyMatch(
              [s.title ?? "", s.sessionId, s.machineAlias ?? ""].join(" "),
              query,
            ),
          )
          .slice(0, 5),
  );

  let filteredPrompts: QueryEntry[] = $derived(
    query.trim() === ""
      ? allQueries.filter((q) => !q.isBackground).slice(0, 10)
      : allQueries
          .filter((q) => !q.isBackground)
          .filter((q) =>
            fuzzyMatch(
              [q.query, q.sessionTitle ?? "", q.sessionId].join(" "),
              query,
            ),
          )
          .slice(0, 10),
  );

  // Flat results list for Enter-key handling
  type SessionResult = { type: "session"; item: DashboardSession };
  type PromptResult = { type: "prompt"; item: QueryEntry };
  type AnyResult = SessionResult | PromptResult;

  let results: AnyResult[] = $derived([
    ...filteredSessions.map((s): SessionResult => ({ type: "session", item: s })),
    ...filteredPrompts.map((p): PromptResult => ({ type: "prompt", item: p })),
  ]);

  let totalResults = $derived(results.length);

  // ── Effects ───────────────────────────────────────────────────────────

  // Reset selectedIndex whenever the query changes
  $effect(() => {
    if (query !== null) selectedIndex = 0;
  });

  // Auto-focus input when modal opens
  $effect(() => {
    if (open && inputEl) {
      inputEl.focus();
    }
  });

  // Reset state when closed
  $effect(() => {
    if (!open) {
      query = "";
      selectedIndex = 0;
    }
  });

  // ── Event handlers ────────────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (totalResults > 0) {
        selectedIndex = Math.min(selectedIndex + 1, totalResults - 1);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) {
        onSelectSession(selected.item.sessionId);
        onClose();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("palette-backdrop")) {
      onClose();
    }
  }

  function handleResultClick(sessionId: string) {
    onSelectSession(sessionId);
    onClose();
  }

  function clearQuery() {
    query = "";
    inputEl?.focus();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="palette-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="커맨드 팔레트"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    tabindex="-1"
    data-testid="command-palette"
  >
    <div class="palette-modal">
      <!-- Search input -->
      <div class="palette-search">
        <span class="search-icon" aria-hidden="true">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          bind:this={inputEl}
          type="text"
          placeholder="세션 또는 프롬프트 검색..."
          bind:value={query}
          class="search-input"
          data-testid="command-palette-input"
          autocomplete="off"
          spellcheck="false"
        />
        {#if query}
          <button class="clear-btn" onclick={clearQuery} aria-label="검색어 지우기">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        {/if}
      </div>

      <!-- Results -->
      <div class="palette-results" role="listbox" aria-label="검색 결과">
        {#if totalResults === 0}
          <div class="empty-results">
            {query.trim()
              ? `"${truncate(query, 40)}"에 대한 결과 없음`
              : "세션 또는 프롬프트가 없습니다"}
          </div>
        {:else}
          <!-- Sessions group -->
          {#if filteredSessions.length > 0}
            <div class="result-group" data-testid="sessions-group">
              <div class="group-header">
                <span class="group-label">세션</span>
                <span class="group-count">{filteredSessions.length}</span>
              </div>
              {#each filteredSessions as session, i (session.sessionId)}
                {@const globalIdx = i}
                <button
                  class="result-item"
                  class:selected={selectedIndex === globalIdx}
                  onclick={() => handleResultClick(session.sessionId)}
                  onmouseenter={() => {
                    selectedIndex = globalIdx;
                  }}
                  role="option"
                  aria-selected={selectedIndex === globalIdx}
                  data-testid="session-result"
                >
                  <div class="result-main">
                    <span class="result-title">
                      {session.title ?? "Untitled Session"}
                    </span>
                    <span class="result-time">
                      {relativeTime(session.lastActivityTime)}
                    </span>
                  </div>
                  <div class="result-meta">
                    <span class="result-id">{truncate(session.sessionId, 20)}</span>
                    {#if session.machineAlias}
                      <span class="machine-badge">{session.machineAlias}</span>
                    {/if}
                    <span class="status-badge status-{session.status}">
                      {session.status}
                    </span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}

          <!-- Prompts group -->
          {#if filteredPrompts.length > 0}
            <div class="result-group" data-testid="prompts-group">
              <div class="group-header">
                <span class="group-label">프롬프트</span>
                <span class="group-count">{filteredPrompts.length}</span>
              </div>
              {#each filteredPrompts as prompt, i (`${prompt.sessionId}-${prompt.timestamp}-${i}`)}
                {@const globalIdx = filteredSessions.length + i}
                <button
                  class="result-item"
                  class:selected={selectedIndex === globalIdx}
                  onclick={() => handleResultClick(prompt.sessionId)}
                  onmouseenter={() => {
                    selectedIndex = globalIdx;
                  }}
                  role="option"
                  aria-selected={selectedIndex === globalIdx}
                  data-testid="prompt-result"
                >
                  <div class="result-main">
                    <span class="result-prompt-text">
                      {truncate(prompt.query, 120)}
                    </span>
                    <span class="result-time">
                      {relativeTime(prompt.timestamp)}
                    </span>
                  </div>
                  <div class="result-meta">
                    <span class="result-session-name">
                      {prompt.sessionTitle ?? truncate(prompt.sessionId, 20)}
                    </span>
                    {#if prompt.machineAlias}
                      <span class="machine-badge">{prompt.machineAlias}</span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Footer hints -->
      <div class="palette-footer">
        <span class="hint"><kbd>↑</kbd><kbd>↓</kbd> 이동</span>
        <span class="hint"><kbd>↵</kbd> 선택</span>
        <span class="hint"><kbd>Esc</kbd> 닫기</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ── */
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 10vh 1rem 0;
    outline: none;
  }

  /* ── Modal container ── */
  .palette-modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 100%;
    max-width: 600px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow:
      0 16px 48px rgba(0, 0, 0, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.05);
    animation: palette-in 0.15s ease;
  }

  @keyframes palette-in {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* ── Search row ── */
  .palette-search {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .search-icon {
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 1rem;
    font-family: inherit;
    caret-color: var(--accent);
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--text-secondary);
  }

  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    padding: 0.2rem;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .clear-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  /* ── Results area ── */
  .palette-results {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    min-height: 0;
  }

  .empty-results {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100px;
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-style: italic;
  }

  /* ── Group ── */
  .result-group {
    margin-bottom: 0.25rem;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.625rem;
    margin-bottom: 0.125rem;
  }

  .group-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .group-count {
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  /* ── Individual result ── */
  .result-item {
    width: 100%;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    padding: 0.625rem 0.75rem;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.125rem;
    transition:
      background 0.1s ease,
      border-color 0.1s ease;
  }

  .result-item:hover,
  .result-item.selected {
    background: rgba(88, 166, 255, 0.07);
    border-left-color: var(--accent);
  }

  /* ── Result row: title + time ── */
  .result-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }

  .result-title {
    font-size: 0.9rem;
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .result-prompt-text {
    font-size: 0.875rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    line-height: 1.4;
  }

  .result-time {
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── Result row: meta info ── */
  .result-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .result-id {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.7rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .result-session-name {
    font-size: 0.7rem;
    color: var(--accent);
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .machine-badge {
    font-size: 0.6rem;
    padding: 0.1rem 0.4rem;
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 9999px;
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .status-badge {
    font-size: 0.6rem;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    white-space: nowrap;
    flex-shrink: 0;
    border: 1px solid transparent;
  }

  .status-badge.status-active {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border-color: rgba(63, 185, 80, 0.3);
  }

  .status-badge.status-completed {
    background: rgba(139, 148, 158, 0.1);
    color: var(--text-secondary);
    border-color: var(--border);
  }

  .status-badge.status-orphaned {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border-color: rgba(210, 153, 34, 0.3);
  }

  /* ── Footer ── */
  .palette-footer {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.1rem 0.35rem;
    font-size: 0.65rem;
    font-family: "SF Mono", "Fira Code", monospace;
    color: var(--text-secondary);
    min-width: 1.4rem;
  }

  /* ── Responsive ── */
  @media (max-width: 640px) {
    .palette-backdrop {
      padding-top: 5vh;
      padding-left: 0.75rem;
      padding-right: 0.75rem;
    }

    .palette-modal {
      max-height: 80vh;
    }

    .palette-footer {
      gap: 0.75rem;
    }
  }

  /* ── Touch device optimizations ── */
  @media (pointer: coarse) {
    /* 키보드 단축키 힌트는 터치 기기에서 불필요 */
    .palette-footer {
      display: none;
    }
    /* 최소 터치 타겟 44px */
    .result-item {
      min-height: 44px;
    }
    .clear-btn {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
  }
</style>
