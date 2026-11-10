<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<!-- A list instead of a table: entries wrap by themselves on a phone. -->
<ul class="records">
  {@render children()}
</ul>

<style>
  .records {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
