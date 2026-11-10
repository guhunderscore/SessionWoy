<!-- Global design tokens and base styles for the popup and the side panel (light + dark). -->
<script lang="ts"></script>

<style>
  :global(:root) {
    --bg: #ffffff;
    --surface: #f6f7f9;
    --border: #e1e4e8;
    --text: #1f2328;
    --muted: #656d76;
    --accent: #1a73e8;
    --danger: #d93025;
    --danger-bg: #fce8e6;
    --warn-bg: #fef7e0;
    --warn-text: #7a5400;
    --radius: 8px;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #1f1f1f;
      --surface: #2a2a2a;
      --border: #3c3c3c;
      --text: #e8eaed;
      --muted: #9aa0a6;
      --accent: #8ab4f8;
      --danger: #f28b82;
      --danger-bg: #3c2422;
      --warn-bg: #3a3017;
      --warn-text: #fdd663;
    }
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  :global(button) {
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  :global(button:hover:not(:disabled)) {
    border-color: var(--muted);
  }
  :global(button:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  :global(button.primary) {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  :global(button.danger) {
    color: var(--danger);
  }
  :global(button.link) {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
  }
  :global(input[type='text']),
  :global(select) {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
  }
  :global(:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  :global(.muted) {
    color: var(--muted);
  }
  :global(.notice) {
    background: var(--warn-bg);
    color: var(--warn-text);
    border-radius: var(--radius);
    padding: 8px 10px;
    font-size: 12px;
  }
  :global(.error) {
    background: var(--danger-bg);
    color: var(--danger);
    border-radius: var(--radius);
    padding: 6px 10px;
    font-size: 12px;
  }
</style>
