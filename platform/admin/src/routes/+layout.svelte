<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import "#lib/design/tokens.css";
  import "#lib/design/base.css";
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

{@render children()}
