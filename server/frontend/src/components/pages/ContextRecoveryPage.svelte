<script lang="ts">
  import { onMount } from 'svelte';
  import {
    enrichmentStore,
    fetchRecoveryData,
    fetchSummary,
    type RecoveryContext,
  } from '../../lib/stores/enrichment';
  import { onMachineChange } from '../../lib/stores/machine.svelte';
  import { relativeTime, truncate, copyToClipboard } from '../../lib/utils';
  import { pushSessionDetail } from '../../lib/stores/navigation.svelte';

  let sortedSessions = $derived(
    $enrichmentStore.recoveryData
      ? [...$enrichmentStore.recoveryData].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      : []
  );

  let toastMessage = $state<string | null>(null);
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  function buildResumeCommand(ctx: RecoveryContext): string {
    return `opencode attach http://localhost:4096 --session ${ctx.sessionId}`;
  }

  async function handleResume(ctx: RecoveryContext): Promise<void> {
    const cmd = buildResumeCommand(ctx);
    const ok = await copyToClipboard(cmd);
    showToast(ok ? 'Copied!' : 'Copy failed');
  }

  function showToast(msg: string): void {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = null; }, 1800);
  }

  function handleViewDetail(sessionId: string): void {
    pushSessionDetail(sessionId);
  }

  onMount(() => {
    fetchRecoveryData();
    return onMachineChange(() => fetchRecoveryData());
  });
</script>

<div class="page-container" data-testid="page-context-recovery">
  <div class="page-header">
    <h2 class="page-title">Context Recovery</h2>
    <p class="page-subtitle">Idle 세션을 재개하려면 Resume 버튼을 클릭하세요</p>
  </div>

  {#if $enrichmentStore.recoveryLoading}
    <div class="loading-state">불러오는 중...</div>
  {:else if !$enrichmentStore.recoveryAvailable}
    <div class="unavailable-state">
      Agent에 OPENCODE_DB_PATH가 설정되지 않았거나 Agent가 연결되지 않았습니다.
    </div>
  {:else if sortedSessions.length === 0}
    <div class="empty-state" data-testid="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-text">복구할 idle 세션이 없습니다</div>
    </div>
  {:else}
    <div class="recovery-list">
      {#each sortedSessions as ctx (ctx.sessionId)}
        <div class="recovery-card" data-testid="recovery-card">
          <div class="card-header">
            <div class="card-title-row">
              <span class="card-icon">📋</span>
              <span class="card-title" title={ctx.sessionTitle}>
                {ctx.sessionTitle || ctx.sessionId.slice(0, 8)}
              </span>
              <div class="card-actions">
                <button
                  class="resume-btn"
                  data-testid="resume-btn"
                  onclick={() => handleResume(ctx)}
                  title="Resume session (copy opencode attach command)"
                >
                  Resume
                </button>
                <button
                  class="summary-btn"
                  data-testid="summary-btn"
                  onclick={() => fetchSummary(ctx.sessionId)}
                  disabled={$enrichmentStore.summaryLoadingIds.includes(ctx.sessionId)}
                >
                  {$enrichmentStore.summaryLoadingIds.includes(ctx.sessionId) ? '생성 중...' : '요약'}
                </button>
                <button
                  class="view-btn"
                  onclick={() => handleViewDetail(ctx.sessionId)}
                  title="View session detail"
                >
                  보기
                </button>
              </div>
            </div>
            <div class="card-meta">
              <span class="card-dir" title={ctx.directory}>
                {ctx.directory.split('/').slice(-2).join('/')}
              </span>
              <span class="meta-sep">·</span>
              <span class="card-time">{relativeTime(ctx.lastActivityAt)}</span>
            </div>
          </div>

          {#if ctx.lastPrompts && ctx.lastPrompts.length > 0}
            <div class="card-section" data-testid="recovery-prompts">
              <div class="section-label">마지막 프롬프트:</div>
              <ul class="prompts-list">
                {#each ctx.lastPrompts.slice(0, 5) as prompt}
                  <li class="prompt-item">"{truncate(prompt, 60)}"</li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if ctx.lastTools && ctx.lastTools.length > 0}
            <div class="card-section recovery-tools" data-testid="recovery-tools">
              <span class="section-label">마지막 도구:</span>
              <span class="tools-list">{ctx.lastTools.join(' → ')}</span>
            </div>
          {/if}

          <div class="card-section recovery-impact" data-testid="recovery-impact">
            <span class="impact-additions">+{ctx.additions}</span>
            <span class="impact-deletions">-{ctx.deletions}</span>
            <span class="impact-files">{ctx.files} files</span>
          </div>

          {#if ctx.todos && ctx.todos.length > 0}
            <div class="card-section recovery-todos" data-testid="recovery-todos">
              <div class="section-label">Todos:</div>
              <div class="todos-list">
                {#each ctx.todos as todo}
                  <span class="todo-item" class:completed={todo.status === 'completed'}>
                    {todo.status === 'completed' ? '✓' : '○'} {todo.content}
                  </span>
                {/each}
              </div>
            </div>
          {/if}

          {#if $enrichmentStore.summaryCache[ctx.sessionId]}
            <div class="card-section summary-section" data-testid="recovery-summary">
              <div class="section-label">세션 요약:</div>
              <pre class="summary-text">{$enrichmentStore.summaryCache[ctx.sessionId].summary}</pre>
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
  .page-container {
    padding: 1.5rem;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .page-header {
    margin-bottom: 1.25rem;
  }

  .page-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 0.25rem;
  }

  .page-subtitle {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .loading-state,
  .unavailable-state {
    color: var(--text-secondary);
    font-size: 0.85rem;
    padding: 2rem 0;
    text-align: center;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--text-secondary);
    gap: 0.75rem;
  }

  .empty-icon {
    font-size: 2.5rem;
    opacity: 0.4;
  }

  .empty-text {
    font-size: 0.9rem;
    font-style: italic;
  }

  .recovery-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .recovery-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    transition: border-color 0.2s ease;
  }

  .recovery-card:hover {
    border-color: var(--accent);
  }

  .card-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .card-title-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .card-icon {
    font-size: 0.9rem;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .card-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-actions {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .resume-btn,
  .view-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.65rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .resume-btn {
    background: rgba(88, 166, 255, 0.12);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.3);
  }

  .resume-btn:hover {
    background: rgba(88, 166, 255, 0.25);
    border-color: var(--accent);
  }

  .view-btn {
    background: none;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .view-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-secondary);
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
    padding-left: 1.4rem;
  }

  .card-dir {
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22rem;
  }

  .meta-sep {
    opacity: 0.4;
  }

  .card-time {
    white-space: nowrap;
    flex-shrink: 0;
  }

  .card-section {
    padding-left: 1.4rem;
    font-size: 0.78rem;
  }

  .section-label {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin-bottom: 0.25rem;
  }

  .prompts-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .prompt-item {
    color: var(--text-primary);
    font-size: 0.78rem;
    opacity: 0.85;
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  }

  .prompt-item::before {
    content: '•';
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .recovery-tools {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .tools-list {
    color: var(--accent);
    font-size: 0.75rem;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .recovery-impact {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .impact-additions {
    color: var(--success);
    font-size: 0.78rem;
    font-weight: 600;
  }

  .impact-deletions {
    color: var(--error);
    font-size: 0.78rem;
    font-weight: 600;
  }

  .impact-files {
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .todos-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .todo-item {
    font-size: 0.75rem;
    color: var(--text-secondary);
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .todo-item.completed {
    color: var(--success);
    text-decoration: line-through;
    opacity: 0.7;
  }

  .summary-text {
    font-size: 0.78rem;
    color: var(--text-primary);
    white-space: pre-wrap;
    line-height: 1.5;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    margin-top: 0.25rem;
    font-family: inherit;
    overflow-x: auto;
  }

  .summary-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.65rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
    transition: background 0.15s ease, border-color 0.15s ease;
    background: rgba(63, 185, 80, 0.12);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }

  .summary-btn:hover:not(:disabled) {
    background: rgba(63, 185, 80, 0.25);
    border-color: var(--success);
  }

  .summary-btn:disabled {
    opacity: 0.6;
    cursor: wait;
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
    0%   { opacity: 0; transform: translateX(-50%) translateY(8px); }
    10%  { opacity: 1; transform: translateX(-50%) translateY(0); }
    75%  { opacity: 1; }
    100% { opacity: 0; }
  }

  @media (max-width: 599px) {
    .page-container {
      padding: 1rem 0.75rem;
    }

    .recovery-card {
      padding: 0.75rem 1rem;
    }

    .card-title {
      font-size: 0.85rem;
    }

    .resume-btn,
    .view-btn,
    .summary-btn {
      font-size: 0.7rem;
      padding: 0.2rem 0.5rem;
    }

    .card-dir {
      max-width: 12rem;
    }
  }
</style>
