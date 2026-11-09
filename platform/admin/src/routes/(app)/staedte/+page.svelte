<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { resolve } from "$app/paths";
  import Button from "#lib/components/Button.svelte";
  import Card from "#lib/components/Card.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import RecordItem from "#lib/components/RecordItem.svelte";
  import RecordList from "#lib/components/RecordList.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import TextField from "#lib/components/TextField.svelte";
  import type { PageProps } from "./$types";

  const { data }: PageProps = $props();
</script>

<PageHeader title="Städte" subtitle="Gemeinde, Stadt oder Landkreis suchen, um die Seite zu sperren oder freizugeben" />

<Card>
  <!-- A plain GET form: the search works without JavaScript and can be bookmarked. -->
  <form method="GET" class="search">
    <TextField
      label="Name oder Adresse"
      name="q"
      type="search"
      autocomplete="off"
      natural
      value={data.query}
      hint="Zum Beispiel Tübingen oder kreis-reutlingen"
    />
    <Button>Suchen</Button>
  </form>
</Card>

{#if data.query.trim() !== ""}
  <Card title="Ergebnisse">
    {#if data.hits.length === 0}
      <p>Dazu wurde nichts gefunden. Bitte die Schreibweise prüfen.</p>
    {:else}
      <RecordList>
        {#each data.hits as hit (`${hit.kind}:${hit.key}`)}
          <RecordItem>
            {#snippet title()}
              <a href={resolve("/(app)/staedte/[slug]", { slug: hit.slug })}>{hit.name}</a>
            {/snippet}
            {#snippet aside()}
              {#if hit.blocked}
                <StatusBadge kind="serious">Gesperrt</StatusBadge>
              {:else if hit.held}
                <StatusBadge kind="serious">Gesperrt (gehalten)</StatusBadge>
              {:else}
                <StatusBadge kind="neutral">Öffentlich</StatusBadge>
              {/if}
            {/snippet}
            <p>{hit.category}{hit.context === null ? "" : ` · ${hit.context}`} · /{hit.slug}</p>
          </RecordItem>
        {/each}
      </RecordList>
      {#if data.hits.length === data.maxHits}
        <p>Es werden die ersten {data.maxHits} Treffer gezeigt. Bitte die Suche genauer fassen.</p>
      {/if}
    {/if}
  </Card>
{/if}

<style>
  .search {
    display: grid;
    gap: var(--space-4);
    justify-items: start;
    max-width: var(--width-form);
  }

  .search :global(.field) {
    width: 100%;
  }
</style>
