<!-- Encrypted backup export / import (FR-19, ADR 0004). -->
<script lang="ts">
  import type { ImportPreview, VaultSummary } from '../../shared/messages.js';
  import { api, downloadText } from '../api.js';
  import PassphraseForm from '../components/PassphraseForm.svelte';

  let { vault }: { vault: VaultSummary } = $props();

  let exporting = $state(false);
  let fileText = $state('');
  let fileName = $state('');
  let importPass = $state('');
  let preview = $state<ImportPreview | null>(null);
  let message = $state('');
  let error = $state('');
  let busy = $state(false);

  const locked = $derived(vault.state === 'locked');

  async function doExport(passphrase: string) {
    const r = await api.exportBackup(passphrase);
    downloadText(r.fileName, r.data);
    exporting = false;
    message = `Backup saved as ${r.fileName}. Keep it safe: it holds your logins (encrypted).`;
  }

  async function pickFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    preview = null;
    error = message = '';
    if (!file) return;
    fileName = file.name;
    fileText = await file.text();
  }

  async function run(apply: boolean) {
    error = message = '';
    busy = true;
    try {
      const r = await api.importBackup(fileText, importPass, apply);
      if (apply) {
        message = `Imported ${r.imported} session${r.imported === 1 ? '' : 's'}.`;
        preview = null;
        fileText = fileName = importPass = '';
      } else {
        preview = r;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card backup" aria-label="Backup">
  {#if locked}
    <p class="muted">Unlock your saved logins first to export or import a backup.</p>
  {:else}
    <div class="block">
      <strong>Export</strong>
      <span class="muted small">
        Saves all sessions and their logins to a file, encrypted with a passphrase you choose now.
      </span>
      {#if exporting}
        <PassphraseForm mode="setup" submitLabel="Export encrypted backup" onsubmit={doExport} />
      {:else}
        <button type="button" onclick={() => (exporting = true)}>Export backup…</button>
      {/if}
    </div>

    <div class="block">
      <strong>Import</strong>
      <input type="file" accept="application/json,.json" aria-label="Backup file" onchange={pickFile} />
      {#if fileText}
        <input type="password" placeholder="Backup passphrase" aria-label="Backup passphrase" bind:value={importPass} />
        <button type="button" disabled={busy || !importPass} onclick={() => run(false)}>Check backup</button>
      {/if}
      {#if preview}
        <ul class="preview" aria-label="Sessions in this backup">
          {#each preview.sessions as s (s.id)}
            <li>
              {s.name} <span class="muted">· {s.cookies} cookie{s.cookies === 1 ? '' : 's'} · {s.exists ? 'replaces the existing session' : 'new'}</span>
            </li>
          {/each}
        </ul>
        <button type="button" class="primary" disabled={busy} onclick={() => run(true)}>
          Import {preview.sessions.length} session{preview.sessions.length === 1 ? '' : 's'}
        </button>
      {/if}
    </div>
  {/if}
  {#if message}<div class="notice" role="status">{message}</div>{/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
</section>

<style>
  .backup {
    display: grid;
    gap: 12px;
  }
  .block {
    display: grid;
    gap: 6px;
    justify-items: start;
  }
  .small {
    font-size: 12px;
  }
  .preview {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
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
