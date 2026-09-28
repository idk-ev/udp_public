/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Entity building blocks that eleven function nodes each defined for
 * themselves: `clean`, `P` and the `dateObserved` literal. One definition here
 * instead of a copy per connector — the copies had already begun to drift
 * (two of them truncate to 80 characters, which is kept as a parameter).
 */

import type { IsoTime, NgsiDateTime, NgsiValue, Property } from "./types.js";

/**
 * The apostrophe swap of the old nodes: `String(s == null ? '' : s).replace(/'/g,
 * '’')`, optionally cut to `maxLength` (`.slice(0, 80)` in `carsharing-bw` and
 * `ladesaeulen-bw`).
 *
 * It exists because a straight quote once broke the SQL insert of TRoE ("TRoE-
 * Bug: Apostroph bricht SQL-Insert") and, earlier still, closed a string in
 * generated JavaScript. The typographic apostrophe is part of the stored data
 * by now, so it stays — dropping it would rewrite every affected name and
 * produce a diff against the old runtime on the first run.
 */
export function cleanText(value: string | number | boolean | null | undefined, maxLength?: number): string {
  const text = (value ?? "").toString().replace(/'/g, "’");
  return maxLength === undefined ? text : text.slice(0, maxLength);
}

/**
 * `P(v, u)` of the old prelude: a measured Property stamped with the run time.
 * `unitCode` is present even when `undefined`, exactly as the old literal —
 * `JSON.stringify` drops it on the wire, and the parity harness sees the same
 * key set on both sides.
 */
export function observed<T extends NgsiValue>(
  value: T,
  unitCode: string | undefined,
  observedAt: IsoTime,
): Property<T> {
  return { type: "Property", value, unitCode, observedAt };
}

/** `{ type: 'Property', value: { '@type': 'DateTime', '@value': now } }`. */
export function dateObserved(now: IsoTime): Property<NgsiDateTime> {
  return { type: "Property", value: { "@type": "DateTime", "@value": now } };
}
