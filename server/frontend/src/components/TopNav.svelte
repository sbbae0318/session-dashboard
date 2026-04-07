<script lang="ts">
  import { getCurrentView, pushView } from '../lib/stores/navigation.svelte';

  const tabs = [
    { view: 'sessions' as const, label: 'Sessions' },
    { view: 'overview' as const, label: 'Monitor' },
    { view: 'summaries' as const, label: 'Summaries' },
    { view: 'token-cost' as const, label: 'Tokens' },
    { view: 'code-impact' as const, label: 'Impact' },
    { view: 'timeline' as const, label: 'Timeline' },
    { view: 'projects' as const, label: 'Projects' },
    { view: 'context-recovery' as const, label: 'Recovery' },
    { view: 'memos' as const, label: 'Memos' },
  ];

  let currentView = $derived(getCurrentView());

  function isTabActive(tabView: string): boolean {
    if (tabView === 'overview') {
      return currentView === 'overview' || currentView === 'session-detail';
    }
    if (tabView === 'sessions') {
      return currentView === 'sessions' || currentView === 'session-prompts';
    }
    return currentView === tabView;
  }

  function handleKeydown(e: KeyboardEvent, tabView: typeof tabs[number]['view']) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pushView(tabView);
    }
  }
</script>

<nav class="top-nav" data-testid="top-nav" aria-label="Page navigation">
  {#each tabs as tab}
    <button
      class="tab-btn"
      class:active={isTabActive(tab.view)}
      onclick={() => pushView(tab.view)}
      onkeydown={(e) => handleKeydown(e, tab.view)}
      data-testid="tab-{tab.view}"
      tabindex="0"
      aria-current={isTabActive(tab.view) ? 'page' : undefined}
    >
      {tab.label}
    </button>
  {/each}
</nav>

<style>
  .top-nav {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.75rem;
    flex-shrink: 0;
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 0.4rem 0.85rem;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
    white-space: nowrap;
    margin-bottom: -1px;
    letter-spacing: 0.02em;
  }

  .tab-btn:hover {
    color: var(--text-primary);
  }

  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: var(--radius-sm);
  }
</style>
