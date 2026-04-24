<script lang="ts">
  import { fetchPromptAudit, getPromptAudit } from '../../lib/stores/audit.svelte';
  import PromptAuditView from '../audit/PromptAuditView.svelte';
  import { popToOverview } from '../../lib/stores/navigation.svelte';
  import { onMount } from 'svelte';

  let { promptId }: { promptId: string } = $props();

  let loading = $state(true);

  onMount(async () => {
    await fetchPromptAudit(promptId);
    loading = false;
  });

  let audit = $derived(getPromptAudit(promptId));
</script>

<div class="page-container">
  <div class="page-header">
    <button class="back-btn" onclick={popToOverview}>← Back</button>
    <h2>Prompt Audit</h2>
    <span class="prompt-id">{promptId.slice(0, 8)}</span>
  </div>

  {#if loading}
    <p class="loading">Loading...</p>
  {:else if audit}
    <PromptAuditView turn={audit.turn} autoExpand={true} />
  {:else}
    <p class="empty">Prompt not found.</p>
  {/if}
</div>

<style>
  .page-container {
    padding: 1.25rem 1.5rem;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .back-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  h2 {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .prompt-id {
    font-size: 0.7rem;
    font-family: "SF Mono", "Fira Code", monospace;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    opacity: 0.7;
  }

  .loading {
    font-size: 0.85rem;
    color: var(--text-secondary);
    padding: 2rem 0;
    text-align: center;
  }

  .empty {
    font-size: 0.85rem;
    color: var(--text-secondary);
    padding: 2rem 0;
    text-align: center;
    opacity: 0.6;
  }
</style>
