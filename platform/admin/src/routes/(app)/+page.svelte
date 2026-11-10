<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { resolve } from "$app/paths";
  import Alert from "#lib/components/Alert.svelte";
  import Card from "#lib/components/Card.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import RecordItem from "#lib/components/RecordItem.svelte";
  import RecordList from "#lib/components/RecordList.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import { formatDateTime } from "#lib/format.ts";
  import type { PageProps } from "./$types";

  const { data }: PageProps = $props();

  const confirmed = $derived(data.blocks.filter((block) => block.live === "confirmed").length);
  const pending = $derived(data.blocks.filter((block) => block.live === "pending").length);
  const unchecked = $derived(data.blocks.filter((block) => block.live === null).length);
</script>

<PageHeader title="Übersicht" subtitle="Öffentliche Seiten, die gerade gesperrt sind" />

{#if data.held.length > 0}
  <Alert kind="error">
    Die Datenbank ist älter als der veröffentlichte Stand. Die unten als „gehalten“ aufgeführten Seiten bleiben zur
    Sicherheit gesperrt. Einzelne lassen sich freigeben, die übrigen klärt der Betrieb.
  </Alert>
{/if}
{#if data.publishFailed}
  <Alert kind="error">
    Die letzte Veröffentlichung ist fehlgeschlagen. Das System versucht es jede Minute erneut. Hält das an, bitte den
    Betrieb informieren.
  </Alert>
{/if}
{#if data.publishWarning}
  <Alert kind="warning">Die veröffentlichten Dateien enthielten ungültige Einträge. Bitte den Betrieb informieren.</Alert>
{/if}
{#if data.reimposed.length > 0}
  <Alert kind="warning">
    Eine zurückgespielte Datenbank hat diese Sperren wieder in Kraft gesetzt:
    {data.reimposed.map((block) => block.label).join(", ")}. Sie waren vorher aufgehoben. Bitte prüfen und bei Bedarf
    freigeben.
  </Alert>
{/if}

{#if data.publishFailed || data.held.length > 0}
  <!-- The warnings above say it: no claim about the state here. -->
{:else if pending > 0}
  <Alert kind="warning">Wird veröffentlicht: Noch nicht alle Sperren sind auf der öffentlichen Seite zu sehen.</Alert>
{:else if unchecked > 0}
  <Alert kind="warning">
    {confirmed} von {data.blocks.length} Sperren sind stichprobenartig bestätigt, {unchecked} wurden nicht geprüft.
  </Alert>
{:else if data.blocks.length > 0}
  <Alert kind="success">Wirksam: Stichproben auf der öffentlichen Seite bestätigen alle Sperren.</Alert>
{/if}

<Card title="Gesperrte Seiten">
  {#if data.blocks.length === 0 && data.held.length === 0}
    <p>Zurzeit ist keine Seite gesperrt.</p>
  {:else}
    <RecordList>
      {#each data.blocks as block (block.key)}
        <RecordItem>
          {#snippet title()}
            <a href={resolve("/(app)/staedte/[slug]", { slug: block.param })}>{block.label}</a>
          {/snippet}
          {#snippet aside()}
            {#if block.live === "confirmed"}
              <StatusBadge kind="good">Wirksam</StatusBadge>
            {:else if block.live === "pending"}
              <StatusBadge kind="warn">Noch nicht bestätigt</StatusBadge>
            {:else}
              <StatusBadge kind="neutral">Nicht geprüft</StatusBadge>
            {/if}
          {/snippet}
          <p>Grund: {block.reason}</p>
          <p>Gesperrt von {block.blockedBy} am {formatDateTime(block.blockedAt)}</p>
        </RecordItem>
      {/each}
      {#each data.held as block (block.key)}
        <RecordItem>
          {#snippet title()}
            <a href={resolve("/(app)/staedte/[slug]", { slug: block.param })}>{block.label}</a>
          {/snippet}
          {#snippet aside()}
            <StatusBadge kind="serious">Gesperrt (gehalten)</StatusBadge>
          {/snippet}
          <p>Bleibt gesperrt, steht aber nicht mehr in der Datenbank. Grund und Person sind dadurch nicht bekannt.</p>
        </RecordItem>
      {/each}
    </RecordList>
  {/if}
  <p><a href={resolve("/(app)/staedte")}>Stadt oder Landkreis suchen</a></p>
</Card>
