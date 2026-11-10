<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import AuthLayout from "#lib/components/AuthLayout.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
</script>

<AuthLayout>
  <PageHeader
    title={page.status === 404 ? "Seite nicht gefunden" : "Das hat nicht geklappt"}
    subtitle={page.status === 404 ? "Diese Adresse gibt es hier nicht." : "Bitte versuche es in einem Moment noch einmal."}
  />
  <a href={resolve("/(app)")}>Zur Übersicht</a>
</AuthLayout>
