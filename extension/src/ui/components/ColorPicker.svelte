<script lang="ts">
  import { COLOR_HEX, SESSION_COLORS, type SessionColor } from '../../shared/sessions.js';

  let { value, onchange }: { value: SessionColor; onchange: (c: SessionColor) => void } = $props();
</script>

<div class="picker" role="radiogroup" aria-label="Session color">
  {#each SESSION_COLORS as c (c)}
    <button
      type="button"
      class="swatch"
      role="radio"
      aria-checked={value === c}
      aria-label={c}
      title={c}
      style:background={COLOR_HEX[c]}
      onclick={() => onchange(c)}
    ></button>
  {/each}
</div>

<style>
  .picker {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .swatch {
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid transparent;
  }
  .swatch[aria-checked='true'] {
    border-color: var(--text);
    box-shadow: 0 0 0 2px var(--bg) inset;
  }
</style>
