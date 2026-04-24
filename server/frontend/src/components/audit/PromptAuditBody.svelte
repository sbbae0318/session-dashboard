<script lang="ts">
  import { onMount } from 'svelte';
  import type { PromptAuditResponse, ToolInvocationEntry, SubagentRunEntry } from '../../types';
  import { fetchPromptAudit, getPromptAudit } from '../../lib/stores/audit.svelte';

  let { promptId }: { promptId: string } = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);

  let audit = $derived(getPromptAudit(promptId));

  onMount(async () => {
    loading = true;
    error = null;
    const result = await fetchPromptAudit(promptId);
    if (!result) {
      error = '감사 데이터를 불러올 수 없습니다';
    }
    loading = false;
  });

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function toolIcon(toolName: string): string {
    const lower = toolName.toLowerCase();
    if (lower === 'agent' || lower.startsWith('agent')) return '🤖';
    if (lower === 'skill' || lower.startsWith('skill')) return '🧪';
    return '🔧';
  }

  function formatTokensShort(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  let sortedTools = $derived(
    audit
      ? [...audit.tools].sort((a, b) => a.startedAt - b.startedAt)
      : []
  );
</script>

<div class="audit-body">
  {#if loading}
    <div class="body-status">
      <span class="dot-loader"><span></span><span></span><span></span></span>
      <span>로딩 중...</span>
    </div>
  {:else if error}
    <div class="body-status dim">{error}</div>
  {:else if audit}
    <!-- Tool timeline -->
    {#if sortedTools.length > 0}
      <div class="section">
        <div class="section-title">도구 타임라인 ({sortedTools.length})</div>
        <div class="tool-list">
          {#each sortedTools as tool (tool.id)}
            <div class="tool-row" class:tool-error={tool.error}>
              <span class="tool-time">{formatTime(tool.startedAt)}</span>
              <span class="tool-icon">{toolIcon(tool.toolName)}</span>
              <div class="tool-info">
                <span class="tool-name">{tool.toolName}</span>
                {#if tool.toolSubname}
                  <span class="tool-subname">{tool.toolSubname}</span>
                {/if}
                {#if tool.inputSummary}
                  <span class="tool-input">{tool.inputSummary}</span>
                {/if}
              </div>
              {#if tool.error}
                <span class="tool-err-badge">⚠</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="body-status dim">도구 없음</div>
    {/if}

    <!-- Subagent section -->
    {#if audit.subagents.length > 0}
      <div class="section">
        <div class="section-title">Subagents ({audit.subagents.length})</div>
        <div class="subagent-list">
          {#each audit.subagents as sub (sub.agentKey)}
            <div class="subagent-card">
              <div class="subagent-top">
                {#if sub.agentType}
                  <span class="agent-type-badge">{sub.agentType}</span>
                {/if}
                {#if sub.description}
                  <span class="subagent-desc">{sub.description}</span>
                {/if}
              </div>
              <div class="subagent-stats">
                <span class="stat">{sub.messageCount} msgs</span>
                <span class="stat-sep">·</span>
                <span class="stat">{formatTokensShort(sub.inputTokens + sub.outputTokens)} tokens</span>
                {#if sub.model}
                  <span class="stat-sep">·</span>
                  <span class="stat model-name">{sub.model}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {:else}
    <div class="body-status dim">데이터 없음</div>
  {/if}
</div>

<style>
  .audit-body {
    padding: 0.5rem 0.75rem 0.75rem;
    border: 1px solid rgba(88, 166, 255, 0.2);
    border-top: none;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    background: rgba(88, 166, 255, 0.03);
  }

  .body-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    padding: 0.5rem 0;
  }

  .body-status.dim {
    opacity: 0.6;
    font-style: italic;
  }

  .section {
    margin-top: 0.5rem;
  }

  .section + .section {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .section-title {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    opacity: 0.7;
    margin-bottom: 0.4rem;
  }

  /* ── Tool list ── */
  .tool-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .tool-row {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.3rem 0.4rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    transition: border-color 0.15s ease;
  }

  .tool-row:hover {
    border-color: var(--border);
  }

  .tool-row.tool-error {
    border-color: rgba(248, 81, 73, 0.3);
    background: rgba(248, 81, 73, 0.05);
  }

  .tool-time {
    font-size: 0.62rem;
    color: var(--text-secondary);
    font-family: "SF Mono", "Fira Code", monospace;
    flex-shrink: 0;
    padding-top: 0.05rem;
    opacity: 0.7;
  }

  .tool-icon {
    font-size: 0.75rem;
    flex-shrink: 0;
    line-height: 1.4;
  }

  .tool-info {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }

  .tool-name {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-primary);
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .tool-subname {
    font-size: 0.72rem;
    color: var(--accent);
    font-family: "SF Mono", "Fira Code", monospace;
    opacity: 0.8;
  }

  .tool-input {
    font-size: 0.7rem;
    color: var(--text-secondary);
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    width: 100%;
  }

  .tool-err-badge {
    font-size: 0.7rem;
    color: var(--error);
    flex-shrink: 0;
    opacity: 0.85;
  }

  /* ── Subagent list ── */
  .subagent-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .subagent-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.4rem 0.5rem;
    background: rgba(136, 98, 234, 0.06);
    border: 1px solid rgba(136, 98, 234, 0.2);
    border-radius: var(--radius-sm);
  }

  .subagent-top {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
    min-width: 0;
  }

  .agent-type-badge {
    font-size: 0.58rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.4rem;
    background: rgba(136, 98, 234, 0.2);
    color: #a87eff;
    border-radius: 9999px;
    border: 1px solid rgba(136, 98, 234, 0.35);
    flex-shrink: 0;
  }

  .subagent-desc {
    font-size: 0.78rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .subagent-stats {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.65rem;
    color: var(--text-secondary);
    opacity: 0.8;
  }

  .stat-sep {
    opacity: 0.4;
  }

  .model-name {
    font-family: "SF Mono", "Fira Code", monospace;
    opacity: 0.65;
  }

  /* ── Dot loader (reuse global pattern) ── */
  .dot-loader {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .dot-loader span {
    width: 4px;
    height: 4px;
    background: var(--text-secondary);
    border-radius: 50%;
    animation: dot-bounce 1.2s ease-in-out infinite;
  }

  .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce {
    0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
