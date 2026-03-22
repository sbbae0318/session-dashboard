<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions } from '../../lib/stores/sessions.svelte';
  import { getSourceFilter } from '../../lib/stores/filter.svelte';
  import { summaryCache, summaryLoadingIds, fetchSessionSummary } from '../../lib/stores/enrichment';
  import { pushSessionDetail } from '../../lib/stores/navigation.svelte';
  import { relativeTime } from '../../lib/utils';
  import type { DashboardSession } from '../../types';

  let sessions = $derived(getSessions());
  let sourceFilter = $derived(getSourceFilter());

  // 최근 활동순, source 필터 적용, 상위 세션만
  let filteredSessions = $derived(
    sessions
      .filter(s => !s.parentSessionId)
      .filter(s => {
        if (sourceFilter === 'all') return true;
        if (sourceFilter === 'opencode') return !s.source || s.source === 'opencode';
        return s.source === sourceFilter;
      })
      .sort((a, b) => b.lastActivityTime - a.lastActivityTime)
      .slice(0, 50)
  );

  function shortCwd(cwd: string | null): string {
    if (!cwd) return '';
    return cwd.split('/').slice(-2).join('/');
  }
</script>

<div class="page-container" data-testid="page-summaries">
  <div class="page-header">
    <h2 class="page-title">Session Summaries</h2>
    <span class="page-hint">세션별 LLM 요약 (Haiku)</span>
  </div>

  {#if filteredSessions.length === 0}
    <div class="empty-state">
      <p>표시할 세션이 없습니다.</p>
    </div>
  {:else}
    <div class="summaries-list">
      {#each filteredSessions as session (session.sessionId)}
        {@const cached = $summaryCache[session.sessionId]}
        {@const isLoading = $summaryLoadingIds.includes(session.sessionId)}
        <div class="summary-card">
          <div class="card-header">
            <button
              class="session-title-btn"
              onclick={() => pushSessionDetail(session.sessionId)}
            >
              {session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 12)}
            </button>
            <div class="card-meta">
              <span class="meta-time">{relativeTime(session.lastActivityTime)}</span>
              {#if session.projectCwd}
                <span class="meta-sep">·</span>
                <span class="meta-cwd">{shortCwd(session.projectCwd)}</span>
              {/if}
              <span class="meta-sep">·</span>
              <span class="meta-source" class:claude={session.source === 'claude-code'}>
                {session.source === 'claude-code' ? 'Claude' : 'OpenCode'}
              </span>
            </div>
          </div>

          <div class="card-body">
            {#if cached}
              <pre class="summary-text">{cached.summary}</pre>
              <div class="summary-footer">
                <span class="generated-at">생성: {relativeTime(cached.generatedAt)}</span>
                <button
                  class="refresh-btn"
                  onclick={() => fetchSessionSummary(session.sessionId)}
                  disabled={isLoading}
                >
                  {isLoading ? '생성 중...' : '갱신'}
                </button>
              </div>
            {:else}
              <div class="no-summary">
                <button
                  class="generate-btn"
                  onclick={() => fetchSessionSummary(session.sessionId)}
                  disabled={isLoading}
                >
                  {isLoading ? '생성 중...' : '요약 생성'}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page-container {
    padding: 1.5rem;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .page-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .page-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .page-hint {
    font-size: 0.75rem;
    color: var(--text-secondary);
    opacity: 0.6;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .summaries-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .summary-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .card-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .session-title-btn {
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
    text-align: left;
    font-family: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    width: 100%;
  }

  .session-title-btn:hover {
    color: var(--accent);
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
    margin-top: 0.2rem;
  }

  .meta-sep { opacity: 0.4; }

  .meta-cwd {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.68rem;
  }

  .meta-source {
    font-weight: 500;
    color: #3fb950;
  }

  .meta-source.claude {
    color: #a871ff;
  }

  .card-body {
    padding: 0.75rem 1rem;
  }

  .summary-text {
    font-size: 0.8rem;
    color: var(--text-primary);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    font-family: inherit;
  }

  .summary-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--border);
  }

  .generated-at {
    font-size: 0.68rem;
    color: var(--text-secondary);
  }

  .no-summary {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0;
  }

  .generate-btn,
  .refresh-btn {
    font-size: 0.75rem;
    font-family: inherit;
    padding: 0.3rem 0.8rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .generate-btn:hover:not(:disabled),
  .refresh-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .generate-btn:disabled,
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
