<!-- FR-17: tells the user how many tabs from the last browser run could not rejoin their session. -->
<script lang="ts">
  import type { RestoreStatus } from '../../shared/messages.js';
  import { api } from '../api.js';

  let { restore }: { restore: RestoreStatus } = $props();
</script>

{#if restore.unrestored > 0}
  <div class="notice restore" role="status">
    <span>
      {restore.unrestored} tab{restore.unrestored === 1 ? '' : 's'} from your last Chrome session could not be put back in
      {restore.unrestored === 1 ? 'its' : 'their'} session. Choose a session for {restore.unrestored === 1 ? 'it' : 'them'} again.
    </span>
    <button type="button" onclick={() => void api.dismissRestore()}>Dismiss</button>
  </div>
{/if}

<style>
  .restore {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
  }
</style>
