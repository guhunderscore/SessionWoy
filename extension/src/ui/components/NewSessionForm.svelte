<script lang="ts">
  import { NAME_MAX, validateName, type SessionColor } from '../../shared/sessions.js';
  import ColorPicker from './ColorPicker.svelte';

  let {
    defaultColor,
    submitLabel = 'Create',
    onsubmit,
    oncancel,
  }: {
    defaultColor: SessionColor;
    submitLabel?: string;
    onsubmit: (name: string, color: SessionColor) => Promise<void> | void;
    oncancel?: () => void;
  } = $props();

  let name = $state('');
  // Initial value only; the user picks a color afterwards.
  // svelte-ignore state_referenced_locally
  let color = $state<SessionColor>(defaultColor);
  let error = $state('');
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const v = validateName(name);
    if (!v.ok) {
      error = v.error;
      return;
    }
    busy = true;
    error = '';
    try {
      await onsubmit(v.name, color);
      name = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="form" onsubmit={submit}>
  <!-- svelte-ignore a11y_autofocus -->
  <input
    type="text"
    placeholder="Session name, e.g. Customer"
    maxlength={NAME_MAX}
    bind:value={name}
    aria-label="Session name"
    autofocus
  />
  <ColorPicker value={color} onchange={(c) => (color = c)} />
  {#if error}<div class="error">{error}</div>{/if}
  <div class="actions">
    <button type="submit" class="primary" disabled={busy}>{submitLabel}</button>
    {#if oncancel}<button type="button" onclick={oncancel}>Cancel</button>{/if}
  </div>
</form>

<style>
  .form {
    display: grid;
    gap: 8px;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
</style>
