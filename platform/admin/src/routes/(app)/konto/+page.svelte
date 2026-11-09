<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import ActionForm from "#lib/components/ActionForm.svelte";
  import Alert from "#lib/components/Alert.svelte";
  import Button from "#lib/components/Button.svelte";
  import Card from "#lib/components/Card.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import TextField from "#lib/components/TextField.svelte";
  import type { PageProps } from "./$types";

  const { data, form }: PageProps = $props();
</script>

<PageHeader title="Konto" subtitle="Angemeldet als {data.username}" />

{#if data.mustChangePassword}
  <Alert kind="warning">Bitte vergib zuerst ein eigenes Passwort. Erst danach ist die Verwaltung nutzbar.</Alert>
{/if}

<Card title="Passwort ändern">
  {#if form?.message}
    <Alert kind="error">{form.message}</Alert>
  {:else if form?.changed}
    <Alert kind="success">Das Passwort wurde geändert. Andere Sitzungen sind damit beendet.</Alert>
  {/if}
  <ActionForm>
    <TextField label="Aktuelles Passwort" name="current" type="password" autocomplete="current-password" />
    <TextField
      label="Neues Passwort"
      name="next"
      type="password"
      autocomplete="new-password"
      hint="Mindestens 15 Zeichen. Am einfachsten ist ein Satz aus mehreren Wörtern."
    />
    <TextField label="Neues Passwort wiederholen" name="confirm" type="password" autocomplete="new-password" />
    <Button>Passwort ändern</Button>
  </ActionForm>
</Card>
