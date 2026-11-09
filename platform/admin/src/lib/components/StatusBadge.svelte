<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    kind: "good" | "warn" | "serious" | "neutral";
    children: Snippet;
  }

  const { kind, children }: Props = $props();
</script>

<span class={["badge", kind]}>{@render children()}</span>

<style>
  .badge {
    border: var(--border-width) solid currentcolor;
    border-radius: var(--radius-small);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-strong);
    padding: 0 var(--space-2);
    white-space: nowrap;
  }

  .good {
    background: var(--status-good-surface);
    color: var(--status-good);
  }

  .warn {
    background: var(--status-warn-surface);
    color: var(--status-warn);
  }

  .serious {
    background: var(--status-serious-surface);
    color: var(--status-serious);
  }

  .neutral {
    color: var(--text-secondary);
  }
</style>
