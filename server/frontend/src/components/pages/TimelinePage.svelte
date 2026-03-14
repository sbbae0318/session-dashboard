<script lang="ts">
  import { onMount } from 'svelte';
  import { getEnrichmentState, fetchTimelineData } from '../../lib/stores/enrichment.svelte';
  import { onMachineChange } from '../../lib/stores/machine.svelte';
  import { timeToX, formatTimeAxis, getTimeRange, type TimeRangePreset } from '../../lib/timeline-utils';

  let es = $derived(getEnrichmentState());

  const SVG_WIDTH = 900;
  const LANE_HEIGHT = 40;
  const AXIS_HEIGHT = 30;
  const PADDING_TOP = 10;

  let selectedPreset = $state<TimeRangePreset>('24h');
  let selectedProject = $state<string>('all');
  let timeRange = $derived(getTimeRange(selectedPreset));

  let filteredSessions = $derived(
    (es.timelineData ?? []).filter(s =>
      selectedProject === 'all' || s.projectId === selectedProject
    )
  );

  let projects = $derived([...new Set((es.timelineData ?? []).map(s => s.projectId))]);

  let svgHeight = $derived(AXIS_HEIGHT + PADDING_TOP + filteredSessions.length * LANE_HEIGHT + 10);

  let ticks = $derived(formatTimeAxis(timeRange.from, timeRange.to, 6));

  let nowX = $derived(timeToX(Date.now(), timeRange.from, timeRange.to, SVG_WIDTH));

  function shortPath(dir: string): string {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  onMount(() => {
    fetchTimelineData(timeRange.from, timeRange.to);
    return onMachineChange(() => fetchTimelineData(timeRange.from, timeRange.to));
  });

  async function handlePresetChange(preset: TimeRangePreset) {
    selectedPreset = preset;
    const range = getTimeRange(preset);
    await fetchTimelineData(range.from, range.to, selectedProject === 'all' ? undefined : selectedProject);
  }

  async function handleProjectChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    selectedProject = target.value;
    const range = getTimeRange(selectedPreset);
    await fetchTimelineData(range.from, range.to, selectedProject === 'all' ? undefined : selectedProject);
  }
</script>

<div class="page-container" data-testid="page-timeline">
  <div class="controls">
    <div class="time-range-control" data-testid="time-range-control">
      {#each (['1h', '6h', '24h', '7d'] as const) as preset}
        <button
          class="range-btn"
          class:active={selectedPreset === preset}
          onclick={() => handlePresetChange(preset)}
        >{preset}</button>
      {/each}
    </div>

    <select class="project-filter" value={selectedProject} onchange={handleProjectChange}>
      <option value="all">All Projects</option>
      {#each projects as proj}
        <option value={proj}>{shortPath(proj)}</option>
      {/each}
    </select>
  </div>

  {#if es.timelineLoading}
    <div class="loading">타임라인 로딩 중...</div>
  {:else if !es.timelineAvailable}
    <div class="empty-state" data-testid="empty-state">Agent에 OPENCODE_DB_PATH가 설정되지 않았거나 Agent가 연결되지 않았습니다.</div>
  {:else if filteredSessions.length === 0}
    <div class="empty-state" data-testid="empty-state">타임라인 데이터 없음</div>
  {:else}
    <div class="timeline-wrapper">
      <div class="lane-labels">
        <div class="axis-spacer" style="height: {AXIS_HEIGHT}px"></div>
        {#each filteredSessions as session}
          <div class="lane-label" style="height: {LANE_HEIGHT}px" title={session.sessionTitle}>
            {session.sessionTitle.slice(0, 20)}{session.sessionTitle.length > 20 ? '…' : ''}
          </div>
        {/each}
      </div>

      <div class="svg-scroll">
        <svg
          width={SVG_WIDTH}
          height={svgHeight}
          data-testid="timeline-svg"
        >
          <g data-testid="time-axis">
            {#each ticks as tick}
              {@const x = tick.x * SVG_WIDTH}
              <line x1={x} y1={0} x2={x} y2={svgHeight} stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4" />
              <text x={x} y={AXIS_HEIGHT - 5} text-anchor="middle" fill="var(--text-secondary)" font-size="11">
                {tick.label}
              </text>
            {/each}
          </g>

          {#each filteredSessions as session, i}
            {@const y = AXIS_HEIGHT + PADDING_TOP + i * LANE_HEIGHT}
            {@const laneY = y + 5}
            {@const laneH = LANE_HEIGHT - 10}
            {@const startX = timeToX(session.startTime, timeRange.from, timeRange.to, SVG_WIDTH)}
            {@const endX = timeToX(session.endTime ?? Date.now(), timeRange.from, timeRange.to, SVG_WIDTH)}
            {@const blockWidth = Math.max(endX - startX, 4)}

            <g data-testid="swim-lane" class="swim-lane">
              <rect x={0} y={y} width={SVG_WIDTH} height={LANE_HEIGHT}
                fill={i % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)'} opacity="0.5" />

              <rect
                x={startX}
                y={laneY}
                width={blockWidth}
                height={laneH}
                rx="3"
                fill={session.status === 'busy' ? 'var(--accent)' : session.status === 'completed' ? 'var(--success)' : 'var(--text-secondary)'}
                opacity="0.7"
              />
            </g>
          {/each}

          {#if nowX >= 0 && nowX <= SVG_WIDTH}
            <line
              x1={nowX} y1={0} x2={nowX} y2={svgHeight}
              stroke="var(--error)" stroke-width="2" stroke-dasharray="6,3"
            />
            <text x={nowX + 4} y={AXIS_HEIGHT - 5} fill="var(--error)" font-size="10">Now</text>
          {/if}
        </svg>
      </div>
    </div>
  {/if}
</div>

<style>
  .page-container { padding: 1.5rem; flex: 1; overflow: hidden; }
  .controls { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
  .time-range-control { display: flex; gap: 0.25rem; }
  .range-btn {
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.8rem;
    font-family: inherit;
  }
  .range-btn.active {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
  }
  .project-filter {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    font-family: inherit;
  }
  .timeline-wrapper { display: flex; overflow: hidden; }
  .lane-labels { flex-shrink: 0; width: 180px; }
  .lane-label {
    display: flex;
    align-items: center;
    padding: 0 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    white-space: nowrap;
  }
  .axis-spacer { border-bottom: 1px solid var(--border); }
  .svg-scroll { overflow-x: auto; flex: 1; }
  .loading, .empty-state {
    color: var(--text-secondary);
    font-size: 0.85rem;
    padding: 2rem;
    text-align: center;
  }
</style>
