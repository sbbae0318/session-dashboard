<script lang="ts">
  import { getMachines, getSelectedMachineId, selectMachine, shouldShowMachineFilter } from '../lib/stores/machine.svelte';

  let machines = $derived(getMachines());
  let selectedId = $derived(getSelectedMachineId());
  let showFilter = $derived(shouldShowMachineFilter());
</script>

{#if showFilter}
  <div class="machine-selector" data-testid="machine-selector">
    <button
      class="machine-btn"
      class:active={selectedId === null}
      onclick={() => selectMachine(null)}
    >
      전체
    </button>
    {#each machines as machine (machine.id)}
      <button
        class="machine-btn"
        class:active={selectedId === machine.id}
        data-testid="machine-filter-{machine.id}"
        onclick={() => selectMachine(machine.id)}
      >
        <span
          class="status-dot"
          class:connected={machine.status === 'connected'}
          data-testid="machine-status-{machine.status}"
        ></span>
        {machine.alias}
      </button>
    {/each}
  </div>
{/if}

<style>
.machine-selector {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .machine-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.6rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--text-secondary);
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
  }

  .machine-btn:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .machine-btn.active {
    background: rgba(88, 166, 255, 0.1);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-secondary);
    flex-shrink: 0;
    opacity: 0.5;
  }

  .status-dot.connected {
    background: var(--success);
    opacity: 1;
  }

  @media (max-width: 599px) {
.machine-selector {
    /* inline mode - no padding needed */
  }

    .machine-btn {
      padding: 0.25rem 0.5rem;
      min-height: 44px;
    }
  }
</style>
