<!--
  Segmented control for the session marker mode (ADR 0003, D4).
  The session is always chosen per tab; "Per group" only adds Chrome tab groups as a marker.
-->
<script lang="ts">
  import type { GroupingMode } from '../../shared/sessions.js';

  let {
    value,
    onchange,
    compact = false,
  }: { value: GroupingMode; onchange: (mode: GroupingMode) => void; compact?: boolean } = $props();

  const options: { mode: GroupingMode; label: string; hint: string }[] = [
    { mode: 'tab', label: 'Per tab', hint: 'Badge on the toolbar icon only; tabs stay ungrouped' },
    { mode: 'group', label: 'Per group', hint: "Each session's tabs are also put in a colored Chrome tab group" },
  ];
</script>

<div class="toggle" class:compact role="radiogroup" aria-label="Session marker mode">
  {#each options as o (o.mode)}
    <button
      type="button"
      role="radio"
      aria-checked={value === o.mode}
      title={o.hint}
      onclick={() => value !== o.mode && onchange(o.mode)}>{o.label}</button
    >
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .toggle button {
    border: none;
    border-radius: 0;
    background: var(--bg);
    padding: 4px 12px;
  }
  .toggle button + button {
    border-left: 1px solid var(--border);
  }
  .toggle button[aria-checked='true'] {
    background: var(--accent);
    color: #fff;
  }
  .compact button {
    padding: 2px 8px;
    font-size: 12px;
  }
</style>
