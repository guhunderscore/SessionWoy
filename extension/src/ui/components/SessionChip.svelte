<script lang="ts">
  import { COLOR_HEX, type SessionColor } from '../../shared/sessions.js';

  let { name, color }: { name: string; color: SessionColor } = $props();
</script>

<span class="chip"><span class="dot" style:background={COLOR_HEX[color]}></span>{name}</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
</style>
