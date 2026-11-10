<!-- Optional local backend (FR-18/20/21, ADR 0004): connect, status, sync, restore, disconnect. -->
<script lang="ts">
  import type { BackendSummary, VaultSummary } from '../../shared/messages.js';
  import { api } from '../api.js';
  import BackendStatus from '../components/BackendStatus.svelte';
  import ConfirmInline from '../components/ConfirmInline.svelte';
  import PassphraseForm from '../components/PassphraseForm.svelte';

  let { backend, vault }: { backend: BackendSummary; vault: VaultSummary } = $props();

  // svelte-ignore state_referenced_locally
  let url = $state(backend.url);
  let secret = $state('');
  let error = $state('');
  let message = $state('');
  let busy = $state(false);
  let restoring = $state(false);

  async function act(fn: () => Promise<unknown>) {
    error = message = '';
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      error = 'Enter a URL like http://127.0.0.1:3004';
      return;
    }
    // Host access for the backend, asked in this click (needs the user gesture).
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      error = 'Access to the backend was not granted.';
      return;
    }
    await act(async () => {
      await api.backend({ url: origin, secret, enabled: true });
      secret = '';
    });
  }

  const lastSync = $derived(backend.lastSyncAt ? new Date(backend.lastSyncAt).toLocaleTimeString() : null);
</script>

<section class="card backend" aria-label="Backend">
  {#if !backend.enabled}
    <p class="muted small">
      Optional: also keep an encrypted copy of your saved logins in the local Docker backend
      (<code>docker compose --profile backend up -d backend</code>). It only ever receives ciphertext.
    </p>
    <form class="form" onsubmit={connect}>
      <input type="text" aria-label="Backend URL" bind:value={url} />
      <input type="password" autocomplete="off" placeholder="API_SECRET from .env" aria-label="Backend secret" bind:value={secret} />
      <button type="submit" class="primary" disabled={busy || !secret}>Connect</button>
    </form>
  {:else}
    <div class="row">
      <BackendStatus {backend} />
      <span class="muted small">{backend.url}</span>
    </div>
    {#if backend.state === 'offline'}
      <p class="notice small">
        {backend.error ?? 'The backend is not reachable.'} Logins are still saved on this device; changes are sent when
        the backend is back (retried every minute).
      </p>
    {:else if lastSync}
      <p class="muted small">Last sync at {lastSync}.</p>
    {/if}
    {#if backend.remoteDiffers}
      <div class="notice small" role="alert">
        The backend already holds saved logins from another device or another passphrase. Nothing is sent until you
        choose: restore them here, or replace them with this device's logins.
        <ConfirmInline
          label="Replace backend with this device"
          question="Delete the backend's saved logins and upload this device's instead?"
          confirmLabel="Replace"
          danger
          onconfirm={() => act(async () => void (await api.backendSync(true)))}
        />
      </div>
    {/if}
    {#if vault.state === 'none'}
      <p class="muted small">Set a passphrase in Security first: only encrypted logins are sent to the backend.</p>
    {/if}
    <div class="row">
      <button type="button" disabled={busy} onclick={() => act(async () => void (await api.backendSync()))}>Sync now</button>
      <button type="button" onclick={() => (restoring = !restoring)} aria-expanded={restoring}>Restore from backend…</button>
      <ConfirmInline
        label="Disconnect"
        question="Stop syncing? Data already in the backend stays there."
        confirmLabel="Disconnect"
        onconfirm={() => act(() => api.backend({ enabled: false }))}
      />
    </div>
    {#if restoring}
      <p class="muted small">Replaces the saved logins on this device with the backend's copy. Enter the passphrase it was saved with.</p>
      <PassphraseForm
        mode="unlock"
        submitLabel="Restore"
        onsubmit={async (p) => {
          const r = await api.backendRestore(p);
          restoring = false;
          message = `Restored ${r.sessions} session${r.sessions === 1 ? '' : 's'} from the backend.`;
        }}
      />
    {/if}
  {/if}
  {#if message}<div class="notice" role="status">{message}</div>{/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
</section>

<style>
  .backend {
    display: grid;
    gap: 8px;
  }
  .small {
    font-size: 12px;
    margin: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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
  code {
    font-size: 11px;
  }
</style>
