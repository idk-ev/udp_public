<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** The headline of the entry, usually a link. */
    title: Snippet;
    /** Short state at the side: a StatusBadge. */
    aside?: Snippet;
    children?: Snippet;
  }

  const { title, aside, children }: Props = $props();
</script>

<li class="record">
  <div class="head">
    <div class="title">{@render title()}</div>
    {#if aside !== undefined}
      {@render aside()}
    {/if}
  </div>
  {#if children !== undefined}
    <div class="body">{@render children()}</div>
  {/if}
</li>

<style>
  .record {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3) 0;
  }

  .record:not(:first-child) {
    border-top: var(--border-width) solid var(--border);
  }

  .head {
    align-items: start;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    justify-content: space-between;
  }

  .title {
    font-weight: var(--font-weight-strong);
    overflow-wrap: anywhere;
  }

  .body {
    color: var(--text-secondary);
    display: grid;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    overflow-wrap: anywhere;
  }
</style>
