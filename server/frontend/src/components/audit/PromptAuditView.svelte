<script lang="ts">
  import type { PromptTurnSummary } from '../../types';
  import PromptAuditHeader from './PromptAuditHeader.svelte';
  import PromptAuditBody from './PromptAuditBody.svelte';

  let {
    turn,
    autoExpand = false,
  }: {
    turn: PromptTurnSummary;
    autoExpand?: boolean;
  } = $props();

  let expanded = $state(autoExpand);

  function toggle(): void {
    expanded = !expanded;
  }
</script>

<div class="audit-view">
  <PromptAuditHeader {turn} {expanded} onclick={toggle} />
  {#if expanded}
    <PromptAuditBody promptId={turn.promptId} />
  {/if}
</div>

<style>
  .audit-view {
    display: flex;
    flex-direction: column;
  }
</style>
