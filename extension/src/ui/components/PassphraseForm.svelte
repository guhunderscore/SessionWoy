<!--
  Passphrase entry for setup (with confirmation) and unlock. The value is cleared after submit and is
  only ever sent to the service worker.
-->
<script lang="ts">
  import { MIN_PASSPHRASE } from '../../shared/crypto.js';

  let {
    mode,
    submitLabel,
    onsubmit,
  }: {
    mode: 'setup' | 'unlock';
    submitLabel: string;
    onsubmit: (passphrase: string) => Promise<void>;
  } = $props();

  let passphrase = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    if (mode === 'setup') {
      if (passphrase.length < MIN_PASSPHRASE) {
        error = `Use at least ${MIN_PASSPHRASE} characters.`;
        return;
      }
      if (passphrase !== confirm) {
        error = 'The two passphrases do not match.';
        return;
      }
    }
    busy = true;
    try {
      await onsubmit(passphrase);
      passphrase = '';
      confirm = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="form" onsubmit={submit}>
  <input
    type="password"
    autocomplete={mode === 'setup' ? 'new-password' : 'current-password'}
    placeholder="Passphrase"
    aria-label="Passphrase"
    bind:value={passphrase}
  />
  {#if mode === 'setup'}
    <input
      type="password"
      autocomplete="new-password"
      placeholder="Repeat passphrase"
      aria-label="Repeat passphrase"
      bind:value={confirm}
    />
  {/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  <button type="submit" class="primary" disabled={busy || !passphrase}>{busy ? 'Working…' : submitLabel}</button>
</form>

<style>
  .form {
    display: grid;
    gap: 6px;
  }
  input[type='password'] {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
  }
</style>
