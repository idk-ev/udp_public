<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { enhance } from "$app/forms";
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
  }

  const { children }: Props = $props();
</script>

<!-- Works without JavaScript as a plain POST; use:enhance only keeps the page. -->
<form method="POST" use:enhance>
  {@render children()}
</form>

<style>
  form {
    display: grid;
    gap: var(--space-4);
    max-width: var(--width-form);
  }
</style>
