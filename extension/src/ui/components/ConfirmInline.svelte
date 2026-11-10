<!-- An action button that asks for confirmation in place (no window.confirm, which blocks the page). -->
<script lang="ts">
  let {
    label,
    question,
    confirmLabel = 'Yes',
    danger = false,
    onconfirm,
  }: { label: string; question: string; confirmLabel?: string; danger?: boolean; onconfirm: () => void } = $props();

  let asking = $state(false);
</script>

{#if asking}
  <span class="ask" role="alert">
    <span>{question}</span>
    <button
      type="button"
      class:danger
      onclick={() => {
        asking = false;
        onconfirm();
      }}>{confirmLabel}</button
    >
    <button type="button" onclick={() => (asking = false)}>Cancel</button>
  </span>
{:else}
  <button type="button" class:danger onclick={() => (asking = true)}>{label}</button>
{/if}

<style>
  .ask {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
</style>
