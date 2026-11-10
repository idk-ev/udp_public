<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  interface Props {
    title: string;
    subtitle?: string;
  }

  const { title, subtitle }: Props = $props();
</script>

<svelte:head>
  <title>{title} · UDP-Verwaltung</title>
</svelte:head>

<header class="page-header">
  <h1>{title}</h1>
  {#if subtitle !== undefined}
    <p>{subtitle}</p>
  {/if}
</header>

<style>
  .page-header {
    display: grid;
    gap: var(--space-1);
  }

  h1 {
    font-size: var(--font-size-title);
    font-weight: var(--font-weight-strong);
    line-height: var(--line-height-tight);
  }

  p {
    color: var(--text-secondary);
  }
</style>
