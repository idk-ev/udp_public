/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Top-level attributes with `value: null` — for ungated writes.
 *
 * Orion-LD 1.6 refuses such an attribute in a batch upsert, and with it the
 * whole ENTITY (207, "The use of NULL value is not recommended for JSON-LD").
 * The old flows sent them anyway, so every entity with one unknown value was
 * silently not written at all. {@link withdrawNulls} leaves the attribute out
 * instead and removes a value still in the broker, so that an unknown value
 * does not keep showing the last known one.
 *
 * The removal is remembered per process ({@link WITHDRAWN}): one DELETE per
 * entity and attribute while it stays unknown, not one per run; after a
 * restart it is sent once more (a 404 is cheap and writes nothing). Gated
 * connectors with their own signature tables use their own bookkeeping
 * (`efa-abfahrten`: the signature `null`).
 */

import { stateKey } from "./state.js";
import type { Ctx, NgsiEntity } from "./types.js";

/** `<entity id> <attribute>` already withdrawn in this process. */
export const WITHDRAWN = stateKey("withdrawnNullAttributes", () => new Set<string>());

function isNullAttribute(attribute: unknown): boolean {
  return (
    typeof attribute === "object" && attribute !== null && "value" in attribute && attribute.value === null
  );
}

/** The entity without its null-valued attributes, and their names. Pure. */
export function splitNulls(entity: NgsiEntity): { readonly entity: NgsiEntity; readonly cleared: string[] } {
  const cleared = Object.keys(entity).filter((name) => isNullAttribute(entity[name]));
  if (cleared.length === 0) return { entity, cleared };
  const kept = Object.entries(entity).filter(([name]) => !cleared.includes(name));
  return {
    entity: { ...Object.fromEntries(kept), id: entity.id, type: entity.type, "@context": entity["@context"] },
    cleared,
  };
}

/**
 * `entities` without null-valued attributes; a value of such an attribute
 * still in the broker is withdrawn first (once per process, see the header).
 * Call it right before an ungated upsert.
 */
export async function withdrawNulls(
  ctx: Ctx,
  entities: readonly NgsiEntity[],
  label: string,
): Promise<NgsiEntity[]> {
  const withdrawn = ctx.state.slot(WITHDRAWN).get();
  const out: NgsiEntity[] = [];
  for (const original of entities) {
    const { entity, cleared } = splitNulls(original);
    // A value again: the next unknown has to be withdrawn again.
    for (const name of Object.keys(entity)) withdrawn.delete(`${entity.id} ${name}`);
    for (const name of cleared) {
      const key = `${entity.id} ${name}`;
      if (withdrawn.has(key) || ctx.signal.aborted) continue;
      if (await ctx.orion.deleteAttribute(entity.id, name, label)) withdrawn.add(key);
    }
    out.push(entity);
  }
  return out;
}
