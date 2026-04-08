<script lang="ts">
  let { size = 'md' }: { size?: 'sm' | 'md' } = $props();
</script>

<span class="dot-loader" class:dot-sm={size === 'sm'}>
  <span></span><span></span><span></span>
</span>
