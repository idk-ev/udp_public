<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { refreshAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import ActionForm from "#lib/components/ActionForm.svelte";
  import Alert from "#lib/components/Alert.svelte";
  import Button from "#lib/components/Button.svelte";
  import Card from "#lib/components/Card.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import TextField from "#lib/components/TextField.svelte";
  import { formatDateTime } from "#lib/format.ts";
  import { startRecheck } from "#lib/recheck.ts";
  import type { PageProps } from "./$types";

  const { data, form }: PageProps = $props();

  const RECHECK_MS = 15_000;

  const blocked = $derived(data.block !== null || data.held);
  // Right after a change the page looks again by itself until the check confirms it.
  const waiting = $derived(data.changed !== null && data.live === "pending");
  // Stops by itself on leaving the page or once confirmed. See lib/recheck.ts for why
  // this is not a meta refresh; that one stays for browsers without JavaScript.
  $effect(() => {
    if (!waiting) return undefined;
    return startRecheck(async () => {
      // A failed refresh would replace the page with the error page and end this timer,
      // so a restart of the panel is waited out instead.
      const reachable = await fetch(resolve("/readyz")).then(
        (answer) => answer.ok,
        () => false,
      );
      if (reachable) await refreshAll();
    }, RECHECK_MS);
  });

  const subtitle = $derived(
    [data.description.category, data.description.context, `/${data.city.slug}`]
      .filter((part) => part !== null)
      .join(" · "),
  );
</script>

<svelte:head>
  {#if waiting}
    <noscript><meta http-equiv="refresh" content="15" /></noscript>
  {/if}
</svelte:head>

<PageHeader title={data.city.name} {subtitle} />

{#if data.anyHeld}
  <Alert kind="error">
    Die Datenbank ist älter als der veröffentlichte Stand. Betroffene Seiten bleiben gesperrt, bis sie einzeln
    freigegeben sind oder der Betrieb es geklärt hat.
  </Alert>
{/if}
{#if data.publishFailed}
  <Alert kind="error">
    Die Änderung ist gespeichert, aber noch nicht veröffentlicht. Das System versucht es jede Minute erneut. Hält das
    an, bitte den Betrieb informieren.
  </Alert>
{/if}

{#if data.changed !== null}
  {#if data.live === "confirmed"}
    <Alert kind="success">
      {data.changed === "gesperrt"
        ? "Die Seite ist gesperrt. Stichproben auf der öffentlichen Seite bestätigen das."
        : "Die Seite ist wieder öffentlich. Stichproben auf der öffentlichen Seite bestätigen das."}
    </Alert>
  {:else if data.live === "pending"}
    <Alert kind="warning">
      {data.changed === "gesperrt" ? "Die Sperre ist gespeichert." : "Die Freigabe ist gespeichert."}
      Sie wird in etwa zwei Minuten wirksam und ist noch nicht bestätigt. Diese Ansicht prüft alle 15 Sekunden erneut.
    </Alert>
  {/if}
{/if}

<Card title="Status">
  <p>
    {#if data.block !== null}
      <StatusBadge kind="serious">Gesperrt</StatusBadge>
    {:else if data.held}
      <StatusBadge kind="serious">Gesperrt (gehalten)</StatusBadge>
    {:else}
      <StatusBadge kind="good">Öffentlich</StatusBadge>
    {/if}
  </p>
  {#if data.block !== null}
    <p>Grund: {data.block.reason}</p>
    <p>Gesperrt von {data.block.blockedBy} am {formatDateTime(data.block.blockedAt)}</p>
  {:else if data.held}
    <p>
      Diese Sperre gilt weiter, steht aber nicht mehr in der Datenbank. Grund und Person sind dadurch nicht bekannt. Wer
      sicher ist, dass sie nicht mehr gelten soll, kann sie unten aufheben.
    </p>
  {/if}
  {#if blocked && data.live === "pending" && data.changed === null}
    <p>Die Sperre ist auf der öffentlichen Seite noch nicht bestätigt.</p>
  {/if}
  {#if !data.inCatalogue}
    <p>Diese Seite gibt es im aktuellen Verzeichnis nicht mehr.</p>
  {/if}
  {#if data.addressReassigned}
    <p>Ihre frühere Adresse gehört inzwischen einer anderen Seite. Diese Sperre wirkt dort nicht.</p>
  {/if}
</Card>

{#if !waiting}
  {#if blocked}
    <Card title="Seite freigeben">
      <p>Die Seite ist danach wieder öffentlich und in der Suche zu finden.</p>
      {#if form?.action === "freigeben"}
        <Alert kind="error">{form.message}</Alert>
      {/if}
      <ActionForm action="?/freigeben">
        <TextField
          label="Grund"
          name="reason"
          autocomplete="off"
          natural
          value={form?.action === "freigeben" ? form.reason : ""}
          hint="Bitte keine Namen von Personen. Der Grund bleibt dauerhaft im Protokoll."
        />
        <Button>Seite freigeben</Button>
      </ActionForm>
    </Card>
  {:else if data.inCatalogue}
    <Card title="Seite sperren">
      <p>
        Die Seite ist danach nicht mehr erreichbar und verschwindet aus der Suche und aus den Listen des Landkreises.
        Die Daten bleiben über die Schnittstelle abrufbar und in den Summen des Landkreises enthalten.
      </p>
      {#if form?.action === "sperren"}
        <Alert kind="error">{form.message}</Alert>
      {/if}
      <ActionForm action="?/sperren">
        <TextField
          label="Grund"
          name="reason"
          autocomplete="off"
          natural
          value={form?.action === "sperren" ? form.reason : ""}
          hint="Bitte keine Namen von Personen. Der Grund bleibt dauerhaft im Protokoll."
        />
        <TextField
          label="Zur Bestätigung eintippen: {data.description.label}"
          name="confirmation"
          autocomplete="off"
          natural
        />
        <Button variant="danger">Seite sperren</Button>
      </ActionForm>
    </Card>
  {/if}
{/if}

<p><a href={resolve("/(app)/staedte")}>Zurück zur Suche</a></p>
