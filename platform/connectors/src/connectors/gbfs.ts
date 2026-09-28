/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The GBFS system list of MobiData BW, shared by `sharing-bw` (free floating)
 * and `carsharing-bw` (station based). Not a connector itself.
 *
 * One list, about 110 systems — sharing providers of Baden-Württemberg plus a
 * good number from Switzerland, Alsace and Bavaria. Which of their vehicles
 * count is decided per vehicle or station by the strict municipality lookup,
 * never by the system.
 */

import { isFiniteNumber, isRecord, isString } from "../kernel/parse.js";

/** The `http request` node "GBFS-Systeme" of both flows. */
export const SYSTEMS_URL = "https://api.mobidata-bw.de/sharing/gbfs";

export interface GbfsSystem {
  /** `s.id` as the source spells it. */
  readonly id: string;
  /** `s.url`, the system's `gbfs` discovery URL. */
  readonly url: string;
}

/**
 * `msg.payload.systems`, or `null` when the answer is not a system list (the
 * old nodes' `!Array.isArray(msg.payload.systems)`). Entries without a string
 * URL or a scalar id are left out; the old nodes would have thrown on
 * `s.url.replace` and lost the whole run, and the list has never carried one.
 */
export function parseSystems(raw: unknown): readonly GbfsSystem[] | null {
  const systems = isRecord(raw) ? raw.systems : undefined;
  if (!Array.isArray(systems)) return null;
  const out: GbfsSystem[] = [];
  for (const entry of systems) {
    if (!isRecord(entry)) continue;
    const { id, url } = entry;
    if (!isString(url)) continue;
    if (isString(id)) out.push({ id, url });
    else if (isFiniteNumber(id)) out.push({ id: String(id), url });
  }
  return out;
}

/** `s.url.replace(/\/gbfs$/, '/<feed>')`. */
export function feedUrl(system: GbfsSystem, feed: string): string {
  return system.url.replace(/\/gbfs$/, `/${feed}`);
}

/**
 * `String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-')` — the system as it
 * appears in entity ids and table keys. Not a slug of free text: the GBFS
 * system id is the provider's own stable key.
 */
export function systemKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-");
}
