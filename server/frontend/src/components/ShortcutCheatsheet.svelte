<script lang="ts">
  let { open = false, onClose }: { open: boolean; onClose: () => void } = $props();

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  const sections = [
    {
      title: "글로벌",
      shortcuts: [
        { key: `${mod}+K`, desc: "커맨드 팔레트 열기/닫기" },
        { key: "?", desc: "단축키 도움말 토글" },
        { key: "h", desc: "세션 패널로 이동" },
        { key: "l", desc: "프롬프트 패널로 이동" },
        { key: "Esc", desc: "상세 → 목록으로 돌아가기" },
      ],
    },
    {
      title: "세션 패널 (h)",
      shortcuts: [
        { key: "j / ↓", desc: "다음 세션" },
        { key: "k / ↑", desc: "이전 세션" },
        { key: "e / Enter", desc: "세션 필터 토글" },
      ],
    },
    {
      title: "프롬프트 패널 (l)",
      shortcuts: [
        { key: "j / ↓", desc: "다음 프롬프트" },
        { key: "k / ↑", desc: "이전 프롬프트" },
        { key: "Enter / e", desc: "펼침 / 접힘" },
        { key: "Space", desc: "펼침 / 접힘" },
        { key: "a", desc: "전체 펼치기 / 접기" },
        { key: "c", desc: "resume 명령어 복사" },
        { key: "g g", desc: "목록 최상단" },
        { key: "G", desc: "목록 최하단" },
        { key: "Esc", desc: "모두 접기 + 포커스 해제" },
      ],
    },
    {
      title: "커맨드 팔레트",
      shortcuts: [
        { key: "↑ / ↓", desc: "결과 탐색" },
        { key: "Enter", desc: "선택" },
        { key: "Esc", desc: "닫기" },
      ],
    },
  ];

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="cheatsheet-overlay" onclick={handleOverlayClick} onkeydown={handleKeydown}>
    <div class="cheatsheet-panel">
      <div class="cheatsheet-header">
        <h3>Keyboard Shortcuts</h3>
        <button class="cheatsheet-close" onclick={onClose} aria-label="닫기">✕</button>
      </div>
      <div class="cheatsheet-body">
        {#each sections as section}
          <div class="cheatsheet-section">
            <h4>{section.title}</h4>
            <div class="shortcut-grid">
              {#each section.shortcuts as s}
                <kbd>{s.key}</kbd><span>{s.desc}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .cheatsheet-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    animation: fadeIn 120ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .cheatsheet-panel {
    background: var(--bg-secondary, #161b22);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.2rem 1.5rem 1rem;
    min-width: 380px;
    max-width: 480px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    animation: slideUp 150ms ease-out;
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .cheatsheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.8rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .cheatsheet-header h3 {
    font-size: 0.9rem;
    color: var(--text-primary);
    font-weight: 600;
    margin: 0;
  }

  .cheatsheet-close {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .cheatsheet-close:hover {
    color: var(--text-primary);
    background: rgba(110, 118, 129, 0.2);
  }

  .cheatsheet-body {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }

  .cheatsheet-section h4 {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent, #58a6ff);
    margin: 0 0 0.4rem;
    font-weight: 600;
  }

  .shortcut-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 1rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  .shortcut-grid kbd {
    font-family: "SF Mono", "Fira Code", monospace;
    background: rgba(110, 118, 129, 0.2);
    padding: 0.05rem 0.45rem;
    border-radius: 4px;
    font-size: 0.73rem;
    color: var(--text-primary);
    white-space: nowrap;
    border: 1px solid rgba(110, 118, 129, 0.15);
  }

  @media (max-width: 480px) {
    .cheatsheet-panel {
      min-width: unset;
      margin: 0 1rem;
    }
  }
</style>
