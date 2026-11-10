<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Card from "./Card.svelte";

  const { children }: { children: Snippet } = $props();
</script>

<main class="auth">
  <div class="box">
    <Card>
      {@render children()}
    </Card>
  </div>
</main>

<style>
  .auth {
    display: grid;
    min-height: 100vh;
    padding: var(--space-5) var(--space-4);
    place-items: center;
  }

  .box {
    max-width: var(--width-auth);
    width: 100%;
  }
</style>
