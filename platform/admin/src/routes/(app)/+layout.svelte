<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import AppShell from "#lib/components/AppShell.svelte";
  import type { LayoutProps } from "./$types";

  const { data, children }: LayoutProps = $props();
</script>

<AppShell username={data.username} restricted={data.mustChangePassword}>
  {@render children()}
</AppShell>
