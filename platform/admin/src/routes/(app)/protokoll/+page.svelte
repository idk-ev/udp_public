<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { resolve } from "$app/paths";
  import Card from "#lib/components/Card.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import RecordItem from "#lib/components/RecordItem.svelte";
  import RecordList from "#lib/components/RecordList.svelte";
  import { formatDateTime } from "#lib/format.ts";
  import type { PageProps } from "./$types";

  const { data }: PageProps = $props();

  const LABELS: Readonly<Record<string, string>> = {
    "city.blocked": "Seite gesperrt",
    "city.unblocked": "Seite freigegeben",
    "city.publication_accepted": "Veröffentlichter Stand durch die Datenbank ersetzt",
    "city.blocks_restored": "Sperren durch eine zurückgespielte Datenbank wieder in Kraft",
    "user.added": "Konto angelegt",
    "user.password_reset": "Passwort zurückgesetzt",
    "user.disabled": "Konto gesperrt",
    "user.enabled": "Konto entsperrt",
    "user.listed": "Kontenliste abgerufen",
    "user.password_changed": "Eigenes Passwort geändert",
    "throttle.cleared": "Anmeldesperre aufgehoben",
    "login.success": "Anmeldung",
    "login.failure": "Fehlgeschlagene Anmeldung",
    logout: "Abmeldung",
  };

  const ACTORS: Readonly<Record<string, string>> = {
    cli: "Betrieb (Kommandozeile)",
    anonym: "unbekannt",
    system: "System",
  };

  const lookup = (table: Readonly<Record<string, string>>, key: string): string =>
    (Object.hasOwn(table, key) ? table[key] : undefined) ?? key;

  const base = resolve("/(app)/protokoll");
</script>

<PageHeader title="Protokoll" subtitle="Wer wann was geändert hat, die neuesten Einträge zuerst" />

<nav class="views" aria-label="Ansicht">
  <a href={base} aria-current={data.view === "changes" ? "page" : undefined}>Sperren und Konten</a>
  <a href="{base}?ansicht=anmeldungen" aria-current={data.view === "logins" ? "page" : undefined}>Anmeldungen</a>
</nav>

<Card>
  {#if data.entries.length === 0}
    <p>Keine Einträge.</p>
  {:else}
    <RecordList>
      {#each data.entries as entry (entry.id)}
        <RecordItem>
          {#snippet title()}
            {lookup(LABELS, entry.action)}{entry.target === null ? "" : `: ${entry.target}`}
          {/snippet}
          <!-- A user can be named "cli": only entries without an account are translated. -->
          <p>{formatDateTime(entry.at)} · {entry.system ? lookup(ACTORS, entry.actor) : entry.actor}</p>
          {#if entry.pages !== null}
            <p>Seiten: {entry.pages}</p>
          {/if}
          {#if entry.reason !== null}
            <p>Grund: {entry.reason}</p>
          {/if}
        </RecordItem>
      {/each}
    </RecordList>
  {/if}
  <div class="pages">
    {#if !data.firstPage}
      {#if data.view === "logins"}
        <a href="{base}?ansicht=anmeldungen">Neueste Einträge</a>
      {:else}
        <a href={base}>Neueste Einträge</a>
      {/if}
    {/if}
    {#if data.nextBefore !== null}
      {#if data.view === "logins"}
        <a href="{base}?ansicht=anmeldungen&vor={data.nextBefore}">Ältere Einträge</a>
      {:else}
        <a href="{base}?vor={data.nextBefore}">Ältere Einträge</a>
      {/if}
    {/if}
  </div>
</Card>

<style>
  .views {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .views [aria-current="page"] {
    color: var(--text-primary);
    font-weight: var(--font-weight-strong);
    text-decoration: none;
  }

  .pages {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    justify-content: space-between;
  }
</style>
