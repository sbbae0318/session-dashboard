<script lang="ts">
  import { formatTimestamp } from "../lib/utils";
  import { renderMarkdown } from "../lib/markdown";
  import DotLoader from "./DotLoader.svelte";
  import { onMount } from "svelte";

  let {
    entry,
    buildCommand,
    onClose,
    onCopy,
  }: {
    entry: {
      sessionId: string;
      source?: string;
      query: string;
      sessionTitle?: string;
      timestamp: number;
      machineId?: string;
      machineHost?: string;
    };
    buildCommand: (entry: { sessionId: string; source?: string }) => string;
    onClose: () => void;
    onCopy: (cmd: string) => Promise<void>;
  } = $props();

  let activeTab = $state<'prompt' | 'response'>('prompt');
  let responseText = $state<string | null>(null);
  let responseLoading = $state(false);
  let responseError = $state<string | null>(null);
  let responseFetched = $state(false);

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  async function handleCopy(): Promise<void> {
    const cmd = buildCommand(entry);
    await onCopy(cmd);
  }

  async function fetchResponse(): Promise<void> {
    if (responseFetched || responseLoading) return;
    responseLoading = true;
    responseError = null;
    try {
      const params = new URLSearchParams({
        sessionId: entry.sessionId,
        timestamp: String(entry.timestamp),
        source: entry.source ?? '',
        ...(entry.machineId ? { machineId: entry.machineId } : {}),
      });
      const res = await fetch(`/api/prompt-response?${params}`);
      const data = await res.json() as { response: string | null; error?: string };
      responseText = data.response;
      if (data.error) responseError = data.error;
    } catch {
      responseError = '응답을 불러올 수 없습니다';
    } finally {
      responseLoading = false;
      responseFetched = true;
    }
  }

  function switchTab(tab: 'prompt' | 'response'): void {
    activeTab = tab;
    if (tab === 'response' && !responseFetched) {
      void fetchResponse();
    }
  }

  let renderedResponse = $derived(
    responseText ? renderMarkdown(responseText) : ''
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="modal-backdrop" onclick={handleBackdropClick} role="dialog" aria-modal="true">
  <div class="modal-panel">
    <div class="modal-header">
      <div class="modal-title">
        {#if entry.sessionTitle}
          <span class="session-name">{entry.sessionTitle}</span>
        {/if}
        <span class="modal-timestamp">{formatTimestamp(entry.timestamp)}</span>
      </div>
      <button class="close-btn" onclick={onClose} aria-label="닫기">×</button>
    </div>

    <div class="modal-tabs">
      <button
        class="tab-btn" class:active={activeTab === 'prompt'}
        onclick={() => switchTab('prompt')}
      >Prompt</button>
      <button
        class="tab-btn" class:active={activeTab === 'response'}
        onclick={() => switchTab('response')}
      >Response</button>
    </div>

    <div class="modal-body">
      {#if activeTab === 'prompt'}
        <pre class="prompt-full">{entry.query}</pre>
      {:else}
        {#if responseLoading}
          <div class="response-loading">
            <DotLoader />
            <span>응답 로딩 중...</span>
          </div>
        {:else if responseError && !responseText}
          <div class="response-empty">{responseError}</div>
        {:else if responseText}
          <div class="response-rendered">{@html renderedResponse}</div>
        {:else}
          <div class="response-empty">응답 데이터 없음</div>
        {/if}
      {/if}
    </div>

    <div class="modal-footer">
      <button class="copy-btn" onclick={handleCopy}>명령어 복사</button>
      <button class="cancel-btn" onclick={onClose}>닫기</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 1rem;
  }

  .modal-panel {
    background: var(--bg-secondary, #161b22);
    border: 1px solid var(--border, #30363d);
    border-radius: 0.5rem;
    width: 100%;
    max-width: 720px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, #30363d);
    flex-shrink: 0;
  }

  .modal-title {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .session-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent, #58a6ff);
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .modal-timestamp {
    font-size: 0.7rem;
    color: var(--text-secondary, #8b949e);
  }

  .close-btn {
    background: none;
    border: 1px solid rgba(139, 148, 158, 0.3);
    border-radius: 9999px;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-secondary, #8b949e);
    font-size: 1rem;
    line-height: 1;
    padding: 0;
    transition: background 0.15s ease, color 0.15s ease;
    flex-shrink: 0;
  }

  .close-btn:hover {
    background: rgba(248, 81, 73, 0.15);
    color: var(--error, #f85149);
    border-color: rgba(248, 81, 73, 0.4);
  }

  /* ── Tabs ── */
  .modal-tabs {
    display: flex;
    border-bottom: 1px solid var(--border, #30363d);
    flex-shrink: 0;
  }

  .tab-btn {
    flex: 1;
    padding: 0.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary, #8b949e);
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .tab-btn:hover {
    color: var(--text-primary, #e6edf3);
  }

  .tab-btn.active {
    color: var(--accent, #58a6ff);
    border-bottom-color: var(--accent, #58a6ff);
  }

  /* ── Body ── */
  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    min-height: 0;
  }

  .prompt-full {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
    color: var(--text-primary, #e6edf3);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  /* ── Response loading / empty ── */
  .response-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-secondary, #8b949e);
    font-size: 0.85rem;
    padding: 2rem 0;
    justify-content: center;
  }

  .response-empty {
    color: var(--text-secondary, #8b949e);
    font-size: 0.85rem;
    text-align: center;
    padding: 2rem 0;
  }

  /* ── Rendered markdown ── */
  .response-rendered {
    font-size: 0.85rem;
    color: var(--text-primary, #e6edf3);
    line-height: 1.65;
  }

  .response-rendered :global(.md-p) {
    margin: 0.4rem 0;
  }

  .response-rendered :global(.md-h) {
    margin: 0.8rem 0 0.3rem;
    color: var(--text-primary, #e6edf3);
    font-weight: 600;
  }

  .response-rendered :global(h3.md-h) { font-size: 1rem; }
  .response-rendered :global(h4.md-h) { font-size: 0.92rem; }
  .response-rendered :global(h5.md-h) { font-size: 0.85rem; }

  .response-rendered :global(.md-list) {
    margin: 0.3rem 0;
    padding-left: 1.5rem;
  }

  .response-rendered :global(.md-list li) {
    margin: 0.15rem 0;
  }

  .response-rendered :global(.md-inline-code) {
    background: rgba(110, 118, 129, 0.2);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.82rem;
  }

  .response-rendered :global(.code-block-wrap),
  .response-rendered :global(.code-fold) {
    margin: 0.5rem 0;
    border: 1px solid var(--border, #30363d);
    border-radius: 6px;
    overflow: hidden;
  }

  .response-rendered :global(.code-lang) {
    display: inline-block;
    font-size: 0.7rem;
    color: var(--text-secondary, #8b949e);
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
    color: var(--text-primary, #e6edf3);
  }

  .response-rendered :global(.code-fold-summary) {
    cursor: pointer;
    padding: 0.35rem 0.6rem;
    background: rgba(110, 118, 129, 0.08);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary, #8b949e);
    user-select: none;
  }

  .response-rendered :global(.code-fold-summary:hover) {
    background: rgba(110, 118, 129, 0.15);
  }

  .response-rendered :global(.code-fold-lines) {
    font-size: 0.7rem;
    opacity: 0.7;
  }


  /* ── Footer ── */
  .modal-footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border, #30363d);
    flex-shrink: 0;
  }

  .copy-btn {
    background: var(--accent, #58a6ff);
    color: #0d1117;
    border: none;
    border-radius: 0.375rem;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s ease;
    font-family: inherit;
  }

  .copy-btn:hover { opacity: 0.85; }

  .cancel-btn {
    background: none;
    border: 1px solid var(--border, #30363d);
    border-radius: 0.375rem;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    color: var(--text-secondary, #8b949e);
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
    font-family: inherit;
  }

  .cancel-btn:hover {
    border-color: var(--accent, #58a6ff);
    color: var(--text-primary, #e6edf3);
  }

  @media (max-width: 599px) {
    .modal-panel { max-height: 90vh; }
    .modal-body { padding: 0.75rem; }
  }
</style>
