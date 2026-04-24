<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import PromptAuditView from './PromptAuditView.svelte';

  let {
    turn = null,
    onclose,
  }: {
    turn?: PromptTurnSummary | null;
    onclose?: () => void;
  } = $props();

  function handleOverlayClick(): void {
    onclose?.();
  }

  function handlePanelKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onclose?.();
  }
</script>

{#if turn !== null}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    onclick={handleOverlayClick}
    onkeydown={handlePanelKeydown}
    role="presentation"
  ></div>

  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Prompt Audit"
  >
    <div class="panel-header">
      <span class="panel-title">Prompt Audit</span>
      <button
        type="button"
        class="close-btn"
        onclick={onclose}
        aria-label="닫기"
      >✕</button>
    </div>

    <div class="panel-body">
      <PromptAuditView {turn} autoExpand={true} />
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 200;
    cursor: pointer;
  }

  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 480px;
    max-width: 100vw;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    z-index: 201;
    display: flex;
    flex-direction: column;
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    animation: slide-in 0.2s ease-out;
  }

  @keyframes slide-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-secondary);
  }

  .panel-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: background 0.15s ease, color 0.15s ease;
    font-family: inherit;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-primary);
  }

  .close-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>
