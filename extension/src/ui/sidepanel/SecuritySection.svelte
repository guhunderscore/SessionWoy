<!-- Encrypted vault controls (FR-15, ADR 0004): set up, unlock, lock, change passphrase, forget saved logins. -->
<script lang="ts">
  import { MIN_PASSPHRASE } from '../../shared/crypto.js';
  import type { VaultSummary } from '../../shared/messages.js';
  import { api } from '../api.js';
  import ConfirmInline from '../components/ConfirmInline.svelte';
  import PassphraseForm from '../components/PassphraseForm.svelte';

  let { vault }: { vault: VaultSummary } = $props();

  let changing = $state(false);
  let current = $state('');
  let next = $state('');
  let repeat = $state('');
  let error = $state('');
  let busy = $state(false);

  async function act(fn: () => Promise<unknown>) {
    error = '';
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function change(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    if (next.length < MIN_PASSPHRASE) return void (error = `Use at least ${MIN_PASSPHRASE} characters.`);
    if (next !== repeat) return void (error = 'The new passphrases do not match.');
    busy = true;
    await act(async () => {
      await api.changePassphrase(current, next);
      changing = false;
      current = next = repeat = '';
    });
    busy = false;
  }

  const savedAt = $derived(vault.lastSavedAt ? new Date(vault.lastSavedAt).toLocaleTimeString() : null);
</script>

<section class="card security" aria-label="Security">
  {#if vault.state === 'none'}
    <p>
      <strong>Keep logins after Chrome restarts.</strong> Set a passphrase: session cookies are then saved encrypted
      (AES-256-GCM) and unlocked with it once per Chrome start.
    </p>
    <p class="muted small">
      There is no way to recover a forgotten passphrase. You would only lose the saved logins, not your sessions.
    </p>
    <PassphraseForm mode="setup" submitLabel="Set passphrase and save logins" onsubmit={async (p) => void (await api.vaultSetup(p))} />
  {:else if vault.state === 'locked'}
    <p><strong>Saved logins are locked.</strong> Session tabs stay logged out until you unlock.</p>
    <PassphraseForm mode="unlock" submitLabel="Unlock" onsubmit={async (p) => void (await api.unlock(p))} />
    <div class="row">
      <ConfirmInline
        label="Forgot passphrase?"
        question="Forget all saved logins? Sessions stay; you log in again."
        confirmLabel="Forget saved logins"
        danger
        onconfirm={() => act(() => api.vaultReset())}
      />
    </div>
  {:else}
    <p>
      <strong>Logins are saved encrypted.</strong>
      <span class="muted">{vault.savedSessions} session{vault.savedSessions === 1 ? '' : 's'} saved{savedAt ? `, last at ${savedAt}` : ''}.</span>
    </p>
    <div class="row">
      <button type="button" onclick={() => act(() => api.lock())}>Lock now</button>
      <button type="button" onclick={() => (changing = !changing)} aria-expanded={changing}>Change passphrase</button>
      <ConfirmInline
        label="Forget saved logins"
        question="Delete all saved logins? Current tabs stay logged in until Chrome closes."
        confirmLabel="Forget"
        danger
        onconfirm={() => act(() => api.vaultReset())}
      />
    </div>
    {#if changing}
      <form class="form" onsubmit={change}>
        <input type="password" autocomplete="current-password" placeholder="Current passphrase" aria-label="Current passphrase" bind:value={current} />
        <input type="password" autocomplete="new-password" placeholder="New passphrase" aria-label="New passphrase" bind:value={next} />
        <input type="password" autocomplete="new-password" placeholder="Repeat new passphrase" aria-label="Repeat new passphrase" bind:value={repeat} />
        <button type="submit" class="primary" disabled={busy || !current || !next}>{busy ? 'Working…' : 'Change passphrase'}</button>
      </form>
    {/if}
  {/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
</section>

<style>
  .security {
    display: grid;
    gap: 8px;
  }
  p {
    margin: 0;
  }
  .small {
    font-size: 12px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
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
