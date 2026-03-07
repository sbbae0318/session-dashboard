<script lang="ts">
  import { getCards } from "../lib/stores/cards.svelte";
  import { getSelectedSessionId } from "../lib/stores/filter.svelte";
  import { getSelectedMachineId, shouldShowMachineFilter } from '../lib/stores/machine.svelte';
  import { relativeTime, truncate, formatTimestamp } from "../lib/utils";

  let { sessionIdFilter = null }: { sessionIdFilter?: string | null } = $props();

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  let cards = $derived(getCards());
  let selectedSessionId = $derived(getSelectedSessionId());
  let machineFilter = $derived(getSelectedMachineId());
  let showMachines = $derived(shouldShowMachineFilter());

  let filteredCards = $derived(
    cards
      .filter(c => !machineFilter || c.machineId === machineFilter)
      .filter(c => {
        const sid = sessionIdFilter ?? selectedSessionId;
        return !sid || c.sessionId === sid;
      })
      .toSorted((a, b) => b.endTime - a.endTime)
  );
</script>

<div class="session-cards" data-testid="session-cards">
  {#if filteredCards.length === 0}
    <div class="empty-state">{selectedSessionId ? '선택된 세션의 히스토리 없음' : '히스토리 없음'}</div>
  {:else}
    <div class="cards-list">
      {#each filteredCards as card, i (card.sessionId + '-' + card.endTime + '-' + i)}
        <div class="card-item">
          <div class="card-row-top">

            {#if showMachines && card.machineAlias}
              <span class="machine-tag">{card.machineAlias}</span>
            {/if}
            <span class="card-meta">
              <span>{card.duration}</span>
              <span class="card-timestamp">{formatTimestamp(card.endTime)}</span>
              <span>{relativeTime(card.endTime)}</span>
            </span>
          </div>
          <div class="card-row-bottom">
            {#if card.summary}
              <span class="card-summary" title={card.summary}>{truncate(card.summary, 60)}</span>
            {/if}
            <span class="card-stats">
              {#if card.tokenUsage}
                <span class="stat-badge token-badge" title="{card.tokenUsage.inputTokens} in / {card.tokenUsage.outputTokens} out">
                  {formatTokens(card.tokenUsage.totalTokens)} tok
                </span>
              {/if}
              {#if card.invocations && card.invocations.total > 0}
                <span class="stat-badge call-badge" class:has-errors={card.invocations.errorTotal > 0}>
                  🔧{card.invocations.total}{#if card.invocations.errorTotal > 0}<span class="error-count"> ({card.invocations.errorTotal}err)</span>{/if}
                </span>
              {/if}
              {#if card.tools.length > 0}
                {#each card.tools.slice(0, 3) as tool}
                  <span class="tool-tag">{tool}</span>
                {/each}
                {#if card.tools.length > 3}
                  <span class="tool-tag more">+{card.tools.length - 3}</span>
                {/if}
              {/if}
            </span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .session-cards {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .cards-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 0.25rem;
    padding-bottom: 1rem;
  }

  .card-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.65rem;
    transition: border-color 0.2s ease;
    cursor: pointer;
  }

  .card-item:hover {
    border-color: var(--accent);
  }

  .card-row-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .card-row-bottom {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }


  .card-meta {
    display: flex;
    gap: 0.5rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .card-timestamp {
    font-family: "SF Mono", "Fira Code", monospace;
    opacity: 0.7;
  }

  .card-summary {
    font-size: 0.72rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .card-stats {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .stat-badge {
    font-size: 0.6rem;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .token-badge {
    background: rgba(88, 166, 255, 0.1);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.2);
  }

  .call-badge {
    background: rgba(63, 185, 80, 0.1);
    color: var(--success);
    border: 1px solid rgba(63, 185, 80, 0.2);
  }

  .call-badge.has-errors {
    background: rgba(248, 81, 73, 0.1);
    color: var(--error);
    border: 1px solid rgba(248, 81, 73, 0.2);
  }

  .error-count {
    color: var(--error);
  }

  .tool-tag {
    font-size: 0.6rem;
    padding: 0.05rem 0.35rem;
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .tool-tag.more {
    color: var(--accent);
    border-color: var(--accent);
  }

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

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-style: italic;
  }

  @media (max-width: 599px) {
    .cards-list {
      max-height: 50vh;
    }
    .card-row-top {
      flex-wrap: wrap;
    }
    .card-meta {
      white-space: normal;
      flex-shrink: 1;
      gap: 0.35rem;
    }
    .card-item {
      padding: 0.35rem 0.5rem;
    }
    .card-row-bottom {
      flex-wrap: wrap;
    }
    .card-stats {
      flex-wrap: wrap;
    }
  }

</style>
