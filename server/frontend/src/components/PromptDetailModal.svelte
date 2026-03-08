<script lang="ts">
  import { formatTimestamp } from "../lib/utils";
  import { onMount } from "svelte";

  let {
    entry,
    buildCommand,
    onClose,
    onCopy,
  }: {
    entry: { sessionId: string; source?: string; query: string; sessionTitle?: string; timestamp: number };
    buildCommand: (entry: { sessionId: string; source?: string }) => string;
    onClose: () => void;
    onCopy: (cmd: string) => Promise<void>;
  } = $props();

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
    <div class="modal-body">
      <pre class="prompt-full">{entry.query}</pre>
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
    max-width: 640px;
    max-height: 80vh;
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

  .copy-btn:hover {
    opacity: 0.85;
  }

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
    .modal-panel {
      max-height: 90vh;
    }
    .modal-body {
      padding: 0.75rem;
    }
  }
</style>
