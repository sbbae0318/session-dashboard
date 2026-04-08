<script lang="ts">
  let { size = 'md' }: { size?: 'sm' | 'md' } = $props();
</script>

<span class="dot-loader" class:dot-sm={size === 'sm'}>
  <span></span><span></span><span></span>
</span>

<style>
  .dot-loader {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    vertical-align: middle;
  }

  .dot-loader span {
    width: 4px;
    height: 4px;
    background: var(--accent);
    border-radius: 50%;
    animation: dot-bounce 1.4s ease-in-out infinite;
    will-change: transform, opacity;
  }

  .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

  .dot-sm {
    gap: 2px;
  }

  .dot-sm span {
    width: 3px;
    height: 3px;
  }

  @keyframes dot-bounce {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.7); }
    40% { opacity: 1; transform: scale(1.2); }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot-loader span { animation: none; opacity: 0.5; }
  }
</style>
