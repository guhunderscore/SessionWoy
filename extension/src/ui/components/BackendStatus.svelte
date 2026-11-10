<!-- FR-21: connection status dot + label for the optional local backend. Renders nothing when disabled. -->
<script lang="ts">
  import type { BackendSummary } from '../../shared/messages.js';

  let { backend, compact = false }: { backend: BackendSummary; compact?: boolean } = $props();

  const label = $derived(
    backend.state === 'connected'
      ? 'Backend connected'
      : backend.state === 'offline'
        ? `Backend offline${backend.pending ? ` · ${backend.pending} change${backend.pending === 1 ? '' : 's'} waiting` : ''}`
        : 'Backend: checking…',
  );
</script>

{#if backend.enabled}
  <span class="status {backend.state}" class:compact role="status" title={backend.error ?? label}>
    <span class="dot" aria-hidden="true"></span>{label}
  </span>
{/if}

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .compact {
    font-size: 11px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .connected .dot {
    background: #188038;
  }
  .offline .dot {
    background: var(--danger);
  }
</style>
