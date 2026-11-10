<script lang="ts">
  import type { UiCookies, UiSession } from '../../shared/messages.js';
  import { NAME_MAX, validateName, type SessionColor } from '../../shared/sessions.js';
  import { api } from '../api.js';
  import ColorPicker from '../components/ColorPicker.svelte';
  import ConfirmInline from '../components/ConfirmInline.svelte';
  import SessionChip from '../components/SessionChip.svelte';

  let { session, refreshKey }: { session: UiSession; refreshKey: number } = $props();

  let editing = $state(false);
  let draft = $state('');
  let recoloring = $state(false);
  let showCookies = $state(false);
  let cookies = $state<UiCookies | null>(null);
  let error = $state('');

  const archived = $derived(session.status === 'archived');

  async function act(fn: () => Promise<unknown>) {
    error = '';
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function startRename() {
    draft = session.name;
    editing = true;
  }

  async function saveRename(e: SubmitEvent) {
    e.preventDefault();
    const v = validateName(draft);
    if (!v.ok) {
      error = v.error;
      return;
    }
    await act(() => api.update(session.id, { name: v.name }));
    if (!error) editing = false;
  }

  async function setColor(color: SessionColor) {
    await act(() => api.update(session.id, { color }));
    recoloring = false;
  }

  async function loadCookies() {
    try {
      cookies = await api.cookies(session.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Keep the open cookie list live: re-fetch whenever the panel signals a state change.
  $effect(() => {
    void refreshKey;
    if (showCookies) void loadCookies();
  });

  function expiry(ms: number | null): string {
    return ms === null ? 'session' : new Date(ms).toLocaleString();
  }
</script>

<li class="row" class:archived data-session={session.name}>
  <div class="top">
    {#if editing}
      <form class="rename" onsubmit={saveRename}>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" bind:value={draft} maxlength={NAME_MAX} aria-label="New name" autofocus />
        <button type="submit" class="primary">Save</button>
        <button type="button" onclick={() => (editing = false)}>Cancel</button>
      </form>
    {:else}
      <SessionChip name={session.name} color={session.color} />
      <span class="muted stats">
        {session.tabCount} tab{session.tabCount === 1 ? '' : 's'} · {session.cookieCount} cookie{session.cookieCount === 1 ? '' : 's'}
      </span>
    {/if}
  </div>

  {#if error}<div class="error">{error}</div>{/if}

  {#if recoloring}
    <ColorPicker value={session.color} onchange={setColor} />
  {/if}

  <div class="actions">
    {#if archived}
      <button type="button" onclick={() => act(() => api.restore(session.id))}>Restore</button>
    {:else}
      <button type="button" onclick={startRename} disabled={editing}>Rename</button>
      <button type="button" onclick={() => (recoloring = !recoloring)} aria-expanded={recoloring}>Color</button>
      <button
        type="button"
        onclick={() => {
          showCookies = !showCookies;
        }}
        aria-expanded={showCookies}>Cookies</button
      >
      <ConfirmInline
        label="Reset"
        question="Clear this session's cookies (logs it out)?"
        confirmLabel="Reset"
        onconfirm={() => act(() => api.reset(session.id))}
      />
      <ConfirmInline
        label="Archive"
        question="Archive? Its tabs become normal tabs."
        confirmLabel="Archive"
        onconfirm={() => act(() => api.archive(session.id))}
      />
    {/if}
    <ConfirmInline
      label="Delete"
      question="Delete this session and all its cookies? This cannot be undone."
      confirmLabel="Delete"
      danger
      onconfirm={() => act(() => api.remove(session.id))}
    />
  </div>

  {#if showCookies && !archived}
    <div class="cookies">
      {#if !cookies}
        <span class="muted">Loading…</span>
      {:else if cookies.length === 0}
        <span class="muted">No cookies stored in this session.</span>
      {:else}
        <p class="muted hint">Names only; cookie values are never shown.</p>
        {#each cookies as group (group.domain)}
          <div class="domain">{group.domain}</div>
          <ul>
            {#each group.cookies as c (c.name + c.path)}
              <li>
                <code>{c.name}</code>
                {#if c.path !== '/'}<span class="muted">{c.path}</span>{/if}
                {#if c.httpOnly}<span class="tag">HttpOnly</span>{/if}
                {#if c.secure}<span class="tag">Secure</span>{/if}
                <span class="muted exp">{expiry(c.expires)}</span>
              </li>
            {/each}
          </ul>
        {/each}
      {/if}
    </div>
  {/if}
</li>

<style>
  .row {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 10px;
    display: grid;
    gap: 8px;
  }
  .row.archived {
    opacity: 0.8;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .stats {
    font-size: 11px;
    flex: none;
  }
  .rename {
    display: flex;
    gap: 6px;
    width: 100%;
  }
  .rename input {
    flex: 1;
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cookies {
    font-size: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .hint {
    margin: 0 0 6px;
    font-size: 11px;
  }
  .domain {
    font-weight: 600;
    margin-top: 6px;
  }
  .cookies ul {
    list-style: none;
    margin: 2px 0 0;
    padding: 0 0 0 8px;
  }
  .cookies li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
  }
  .tag {
    font-size: 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
  }
  .exp {
    font-size: 11px;
  }
</style>
