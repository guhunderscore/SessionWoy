<!--
  Popup: quick actions for the active tab (FR-4, FR-5).
  Session management (rename, recolor, archive, delete, cookies, settings) lives in the side panel.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { UiState } from '../../shared/messages.js';
  import { nextColor, type GroupingMode, type SessionColor } from '../../shared/sessions.js';
  import { activeTab, api, isWebUrl, onChanged, originPattern } from '../api.js';
  import BackendStatus from '../components/BackendStatus.svelte';
  import ModeToggle from '../components/ModeToggle.svelte';
  import NewSessionForm from '../components/NewSessionForm.svelte';
  import PassphraseForm from '../components/PassphraseForm.svelte';
  import RestoreNotice from '../components/RestoreNotice.svelte';
  import SessionChip from '../components/SessionChip.svelte';
  import Theme from '../components/Theme.svelte';

  let tab = $state<chrome.tabs.Tab | undefined>();
  let st = $state<UiState | null>(null);
  let hasPermission = $state(true);
  let error = $state('');
  let creating = $state(false);
  let openIn = $state('');

  const isWeb = $derived(isWebUrl(tab?.url));
  const active = $derived(st?.sessions.filter((s) => s.status === 'active') ?? []);
  const current = $derived(st?.sessions.find((s) => s.id === st?.tabSessionId) ?? null);

  async function load() {
    try {
      tab = await activeTab();
      st = await api.state(tab?.id);
      hasPermission = isWebUrl(tab?.url) ? await chrome.permissions.contains({ origins: [originPattern(tab.url)] }) : true;
      if (!active.some((s) => s.id === openIn)) openIn = active[0]?.id ?? '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    error = '';
    try {
      await fn();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * F8: a session only works on sites SessionWoy may access. Asks for access when needed.
   * Must be the first await of a click handler (permissions.request needs the user gesture).
   */
  async function ensureAccess(): Promise<boolean> {
    if (!isWeb || hasPermission || !tab?.url) return true;
    const granted = await chrome.permissions.request({ origins: [originPattern(tab.url)] });
    if (granted) {
      hasPermission = true;
      await api.permissionsChanged();
    }
    return granted;
  }

  const NO_ACCESS = 'Access to this site was not granted, so no session was applied.';

  async function grant() {
    if (await ensureAccess()) await act(async () => {
      if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
    });
  }

  async function assignTo(sessionId: string) {
    if (!(await ensureAccess())) {
      error = NO_ACCESS;
      return;
    }
    await act(() => api.assign(tab!.id!, sessionId));
  }

  async function createAndAssign(name: string, color: SessionColor) {
    if (tab?.id === undefined) return;
    if (isWeb && !(await ensureAccess())) throw new Error(NO_ACCESS);
    await api.create(name, color, isWeb ? tab.id : undefined);
    creating = false;
    await load();
  }

  async function openManager() {
    if (tab?.windowId === undefined) return;
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  }

  const setMode = (grouping: GroupingMode) => act(() => api.settings({ grouping }));

  async function openTabIn() {
    if (!openIn) return;
    if (!(await ensureAccess())) {
      error = NO_ACCESS;
      return;
    }
    await act(() => api.openTab(openIn, isWeb && tab?.url ? tab.url : 'about:blank'));
    window.close();
  }

  onMount(() => {
    void load();
    return onChanged(() => void load());
  });
</script>

<Theme />

<main>
  <header>
    <strong>SessionWoy</strong>
    <button type="button" class="link" onclick={openManager}>Manage sessions</button>
  </header>

  {#if error}<div class="error">{error}</div>{/if}

  {#if st}<RestoreNotice restore={st.restore} />{/if}

  {#if st?.vault.state === 'locked'}
    <section class="card locked" aria-label="Unlock saved logins">
      <strong>Saved logins are locked</strong>
      <span class="muted">
        Session tabs stay logged out until you enter your passphrase ({st.vault.savedSessions} saved session{st.vault
          .savedSessions === 1
          ? ''
          : 's'}).
      </span>
      <PassphraseForm mode="unlock" submitLabel="Unlock" onsubmit={async (p) => void (await api.unlock(p))} />
    </section>
  {:else if st?.vault.state === 'none' && st.sessions.some((s) => s.cookieCount > 0)}
    <div class="notice">
      Logins are lost when Chrome closes.
      <button type="button" class="link" onclick={openManager}>Set a passphrase</button> to keep them, encrypted.
    </div>
  {/if}

  {#if st}
    <section class="card">
      <div class="label muted">This tab</div>
      {#if !isWeb}
        <div class="muted">SessionWoy works on http(s) pages only.</div>
      {:else}
        <div class="current">
          {#if current}
            <SessionChip name={current.name} color={current.color} />
            <button type="button" onclick={() => act(() => api.assign(tab!.id!, null))}>Remove from session</button>
          {:else}
            <span class="muted">No session (normal Chrome cookies)</span>
          {/if}
        </div>
        {#if !hasPermission && current}
          <div class="error" role="alert">
            <strong>Logins on this site are NOT separated.</strong> This tab is in "{current.name}", but SessionWoy has
            no access to this site, so it uses normal Chrome cookies, shared with every other tab.
            <button type="button" class="primary" onclick={grant}>Grant access and reload</button>
          </div>
        {:else if !hasPermission}
          <div class="notice">
            SessionWoy has no access to this site yet. Choosing a session will ask for access first.
          </div>
        {/if}
      {/if}
    </section>

    {#if isWeb}
      <section>
        <div class="label muted">{current ? 'Switch this tab to' : 'Use a session in this tab'}</div>
        {#if active.length === 0 && !creating}
          <p class="muted">No sessions yet. Create one for this tab:</p>
        {/if}
        <ul class="sessions">
          {#each active as s (s.id)}
            <li>
              <button
                type="button"
                class="session"
                aria-pressed={s.id === current?.id}
                disabled={s.id === current?.id}
                onclick={() => assignTo(s.id)}
              >
                <SessionChip name={s.name} color={s.color} />
                <span class="muted count">{s.tabCount} tab{s.tabCount === 1 ? '' : 's'}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if creating || active.length === 0}
          <NewSessionForm
            defaultColor={nextColor(st.sessions)}
            submitLabel="Create and use here"
            onsubmit={createAndAssign}
            oncancel={active.length ? () => (creating = false) : undefined}
          />
        {:else}
          <button type="button" class="link" onclick={() => (creating = true)}>+ New session</button>
        {/if}
      </section>
    {/if}

    {#if active.length > 0}
      <section class="open">
        <div class="label muted">Open a new tab in</div>
        <div class="row">
          <select bind:value={openIn} aria-label="Session for the new tab">
            {#each active as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
          <button type="button" onclick={openTabIn}>Open tab</button>
        </div>
      </section>
    {/if}

    <section class="mode">
      <span class="muted">Show sessions</span>
      <ModeToggle compact value={st.settings.grouping} onchange={setMode} />
    </section>

    <BackendStatus backend={st.backend} compact />
    <footer class="muted">Only cookies are separated per session. localStorage and IndexedDB stay shared.</footer>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</main>

<style>
  main {
    width: 320px;
    padding: 12px;
    display: grid;
    gap: 12px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 10px;
    display: grid;
    gap: 8px;
  }
  .card.locked {
    border: 1px solid var(--accent);
  }
  .current {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .sessions {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .session {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg);
    text-align: left;
  }
  .session[aria-pressed='true'] {
    border-color: var(--accent);
    opacity: 1;
  }
  .count {
    font-size: 11px;
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .row select {
    flex: 1;
    min-width: 0;
  }
  footer {
    font-size: 11px;
  }
  .mode {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
</style>
