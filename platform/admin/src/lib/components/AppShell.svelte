<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import { resolve } from "$app/paths";
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";

  interface Props {
    username: string;
    /** While a generated password is in use, only the account page is open. */
    restricted: boolean;
    children: Snippet;
  }

  const { username, restricted, children }: Props = $props();
</script>

<div class="shell">
  <header class="topbar">
    <div class="inner">
      <strong class="brand">UDP-Verwaltung</strong>
      <nav aria-label="Hauptnavigation">
        {#if !restricted}
          <a href={resolve("/(app)")}>Übersicht</a>
        {/if}
        <a href={resolve("/(app)/konto")}>Konto</a>
      </nav>
      <div class="session">
        <span class="user">{username}</span>
        <form method="POST" action={resolve("/logout")}>
          <Button variant="secondary">Abmelden</Button>
        </form>
      </div>
    </div>
  </header>
  <main class="content">
    {@render children()}
  </main>
</div>

<style>
  .topbar {
    background: var(--surface-1);
    border-bottom: var(--border-width) solid var(--border);
  }

  .inner {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    margin: 0 auto;
    max-width: var(--width-content);
    padding: var(--space-3) var(--space-4);
  }

  .brand {
    font-size: var(--font-size-large);
  }

  nav {
    display: flex;
    flex: 1;
    gap: var(--space-4);
  }

  .session {
    align-items: center;
    display: flex;
    gap: var(--space-3);
  }

  .user {
    color: var(--text-secondary);
    font-size: var(--font-size-small);
  }

  .content {
    display: grid;
    gap: var(--space-5);
    margin: 0 auto;
    max-width: var(--width-content);
    padding: var(--space-5) var(--space-4);
  }
</style>
