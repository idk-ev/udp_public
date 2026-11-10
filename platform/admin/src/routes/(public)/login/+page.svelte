<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import ActionForm from "#lib/components/ActionForm.svelte";
  import Alert from "#lib/components/Alert.svelte";
  import AuthLayout from "#lib/components/AuthLayout.svelte";
  import Button from "#lib/components/Button.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import TextField from "#lib/components/TextField.svelte";
  import type { PageProps } from "./$types";

  const { form }: PageProps = $props();
</script>

<AuthLayout>
  <PageHeader title="Anmelden" subtitle="UDP-Verwaltung" />
  {#if form?.message}
    <Alert kind="error">{form.message}</Alert>
  {/if}
  <ActionForm>
    <TextField label="Benutzername" name="username" autocomplete="username" value={form?.username ?? ""} />
    <TextField label="Passwort" name="password" type="password" autocomplete="current-password" />
    <Button>Anmelden</Button>
  </ActionForm>
</AuthLayout>
