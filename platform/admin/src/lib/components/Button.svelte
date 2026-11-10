<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    variant?: "primary" | "secondary" | "danger";
    children: Snippet;
  }

  const { variant = "primary", children }: Props = $props();
</script>

<button type="submit" class={["button", variant]}>{@render children()}</button>

<style>
  .button {
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-small);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-strong);
    padding: var(--space-2) var(--space-4);
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
  }

  .primary:hover {
    background: var(--accent-hover);
  }

  .danger {
    background: var(--status-serious-solid);
    color: var(--on-status-serious-solid);
  }

  .danger:hover {
    background: var(--status-serious-solid-hover);
  }

  .secondary {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .secondary:hover {
    background: var(--surface-0);
  }
</style>
