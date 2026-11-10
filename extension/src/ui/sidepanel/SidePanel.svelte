<!--
  Side panel: session management (FR-1, FR-2, FR-3), cookie overview, settings (FR-6, FR-7).
  Stays open while the user switches tabs; refreshes live on `ui:changed`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { UiState } from '../../shared/messages.js';
  import { nextColor, type SessionColor, type Settings } from '../../shared/sessions.js';
  import { api, onChanged } from '../api.js';
  import ModeToggle from '../components/ModeToggle.svelte';
  import NewSessionForm from '../components/NewSessionForm.svelte';
  import Theme from '../components/Theme.svelte';
  import SessionRow from './SessionRow.svelte';

  let st = $state<UiState | null>(null);
  let error = $state('');
  let creating = $state(false);
  let refreshKey = $state(0);

  const active = $derived(st?.sessions.filter((s) => s.status === 'active') ?? []);
  const archived = $derived(st?.sessions.filter((s) => s.status === 'archived') ?? []);

  async function load() {
    try {
      st = await api.state();
      refreshKey++;
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function create(name: string, color: SessionColor) {
    await api.create(name, color);
    creating = false;
  }

  async function setting(patch: Partial<Settings>) {
    try {
      await api.settings(patch);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void load();
    return onChanged(() => void load());
  });
</script>

<Theme />

<main>
  <header>
    <h1>Sessions</h1>
    {#if !creating}<button type="button" class="primary" onclick={() => (creating = true)}>+ New session</button>{/if}
  </header>

  {#if error}<div class="error">{error}</div>{/if}

  {#if creating && st}
    <section class="card">
      <NewSessionForm defaultColor={nextColor(st.sessions)} onsubmit={create} oncancel={() => (creating = false)} />
    </section>
  {/if}

  {#if st}
    {#if active.length === 0 && !creating}
      <p class="muted">No sessions yet. Create one, then use the toolbar popup to put a tab into it.</p>
    {/if}
    <ul class="list" aria-label="Active sessions">
      {#each active as s (s.id)}<SessionRow session={s} {refreshKey} />{/each}
    </ul>

    {#if archived.length}
      <h2>Archived</h2>
      <ul class="list" aria-label="Archived sessions">
        {#each archived as s (s.id)}<SessionRow session={s} {refreshKey} />{/each}
      </ul>
    {/if}

    <h2>Settings</h2>
    <section class="card settings">
      <div class="mode">
        <span>Show sessions</span>
        <ModeToggle value={st.settings.grouping} onchange={(grouping) => setting({ grouping })} />
        <span class="muted hint">
          {st.settings.grouping === 'tab'
            ? 'Per tab: each tab keeps its own session; only the toolbar badge shows it.'
            : "Per group: each session's tabs are also collected in a colored Chrome tab group."}
          Either way the session is chosen per tab; switching mode never logs anyone out.
        </span>
      </div>
      <label>
        <input
          type="checkbox"
          checked={st.settings.inheritOnOpen}
          onchange={(e) => setting({ inheritOnOpen: e.currentTarget.checked })}
        />
        Links opened from a session tab stay in that session
      </label>
    </section>

    <div class="notice">
      <strong>What is separated:</strong> only cookies. localStorage, IndexedDB and a site's Service Worker are
      still shared between sessions. Cookies are kept in memory only: logins are lost when Chrome restarts or the
      extension reloads (session names and colors are kept).
    </div>

    <details>
      <summary class="muted">Diagnostics</summary>
      <pre>{JSON.stringify(st.diag, null, 2)}</pre>
    </details>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</main>

<style>
  main {
    padding: 12px;
    display: grid;
    gap: 12px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    font-size: 16px;
    margin: 0;
  }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 4px 0 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 10px;
  }
  .settings {
    display: grid;
    gap: 8px;
  }
  .settings label {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .mode {
    display: grid;
    gap: 6px;
    justify-items: start;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .hint {
    font-size: 12px;
  }
  pre {
    font-size: 11px;
    white-space: pre-wrap;
    max-height: 240px;
    overflow: auto;
    background: var(--surface);
    padding: 8px;
    border-radius: var(--radius);
  }
</style>
