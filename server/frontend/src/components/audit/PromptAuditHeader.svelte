<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import { truncate } from '../../lib/utils';

  let {
    turn,
    expanded = false,
    onclick,
  }: {
    turn: PromptTurnSummary;
    expanded?: boolean;
    onclick?: () => void;
  } = $props();

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  let totalTokens = $derived(turn.inputTokens + turn.outputTokens);
  let timeLabel = $derived(formatTime(turn.startedAt));
  let userTextDisplay = $derived(turn.userText ? truncate(turn.userText, 60) : '(no user text)');
  let tokenLabel = $derived(formatTokens(totalTokens));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="audit-header"
  class:expanded
  onclick={onclick}
  onkeydown={(e) => e.key === 'Enter' && onclick?.()}
  role="button"
  tabindex="0"
>
  <span class="time">{timeLabel}</span>

  <span class="user-text" title={turn.userText ?? ''}>{userTextDisplay}</span>

  <div class="badges">
    {#if turn.subagentCount > 0}
      <span class="badge badge-subagent">{turn.subagentCount} subagent{turn.subagentCount > 1 ? 's' : ''}</span>
    {/if}
    {#if turn.toolCount > 0}
      <span class="badge badge-tools">{turn.toolCount} tool{turn.toolCount > 1 ? 's' : ''}</span>
    {/if}
    {#if totalTokens > 0}
      <span class="badge badge-tokens">{tokenLabel}</span>
    {/if}
  </div>

  <span class="chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
</div>

<style>
  .audit-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    user-select: none;
    min-width: 0;
  }

  .audit-header:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .audit-header.expanded {
    border-color: rgba(88, 166, 255, 0.4);
    background: rgba(88, 166, 255, 0.04);
  }

  .audit-header:focus-visible {
    outline: 2px solid rgba(88, 166, 255, 0.6);
    outline-offset: -2px;
  }

  .time {
    font-size: 0.68rem;
    color: var(--text-secondary);
    font-family: "SF Mono", "Fira Code", monospace;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .user-text {
    font-size: 0.82rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .badges {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
  }

  .badge {
    font-size: 0.6rem;
    padding: 0.07rem 0.4rem;
    border-radius: 9999px;
    font-weight: 600;
    white-space: nowrap;
    line-height: 1.4;
  }

  .badge-subagent {
    background: rgba(136, 98, 234, 0.2);
    color: #a87eff;
    border: 1px solid rgba(136, 98, 234, 0.35);
  }

  .badge-tools {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    border: 1px solid rgba(88, 166, 255, 0.3);
  }

  .badge-tokens {
    background: rgba(139, 148, 158, 0.15);
    color: var(--text-secondary);
    border: 1px solid rgba(139, 148, 158, 0.25);
  }

  .chevron {
    font-size: 0.7rem;
    color: var(--text-secondary);
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
