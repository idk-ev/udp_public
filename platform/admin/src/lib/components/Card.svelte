<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title?: string;
    children: Snippet;
  }

  const { title, children }: Props = $props();
</script>

<section class="card">
  {#if title !== undefined}
    <h2>{title}</h2>
  {/if}
  {@render children()}
</section>

<style>
  .card {
    background: var(--surface-1);
    border: var(--border-width) solid var(--border);
    border-radius: var(--radius-medium);
    box-shadow: var(--shadow-card);
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  h2 {
    font-size: var(--font-size-large);
    font-weight: var(--font-weight-strong);
    line-height: var(--line-height-tight);
  }
</style>
