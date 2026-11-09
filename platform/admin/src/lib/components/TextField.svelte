<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  import type { FullAutoFill } from "svelte/elements";

  interface Props {
    label: string;
    name: string;
    type?: "text" | "password";
    autocomplete: FullAutoFill;
    hint?: string;
    value?: string;
  }

  const { label, name, type = "text", autocomplete, hint, value = "" }: Props = $props();
  const id = $derived(`field-${name}`);
</script>

<div class="field">
  <label for={id}>{label}</label>
  <input
    {id}
    {name}
    {type}
    {autocomplete}
    {value}
    required
    spellcheck="false"
    autocapitalize="none"
    aria-describedby={hint === undefined ? undefined : `${id}-hint`}
  />
  {#if hint !== undefined}
    <p class="hint" id="{id}-hint">{hint}</p>
  {/if}
</div>

<style>
  .field {
    display: grid;
    gap: var(--space-1);
  }

  label {
    font-weight: var(--font-weight-strong);
  }

  input {
    background: var(--surface-1);
    border: var(--border-width) solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--font-size-body);
    padding: var(--space-2) var(--space-3);
    width: 100%;
  }

  .hint {
    color: var(--text-secondary);
    font-size: var(--font-size-small);
  }
</style>
