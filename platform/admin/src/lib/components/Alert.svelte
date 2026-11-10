<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    kind: "error" | "warning" | "success";
    children: Snippet;
  }

  const { kind, children }: Props = $props();
</script>

<p class={["alert", kind]} role={kind === "error" ? "alert" : "status"}>{@render children()}</p>

<style>
  .alert {
    border: var(--border-width) solid currentcolor;
    border-radius: var(--radius-small);
    padding: var(--space-3) var(--space-4);
  }

  .error {
    background: var(--status-serious-surface);
    color: var(--status-serious);
  }

  .warning {
    background: var(--status-warn-surface);
    color: var(--status-warn);
  }

  .success {
    background: var(--status-good-surface);
    color: var(--status-good);
  }
</style>
