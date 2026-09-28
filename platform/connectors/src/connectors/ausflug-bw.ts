/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `ausflug-bw` — tourist destinations from OpenStreetMap, the top 25 per
 * municipality.
 *
 * Port of FN_AUSFLUG_REQ, FN_AUSFLUG_WRAP and FN_AUSFLUG_BUILD from
 * scripts/generate-nodered-flows.py. The original request node says why it is
 * built the way it is:
 *
 *   > 4 Overpass-Abfragen (je Quadrant alle Zielarten), streng serialisiert.
 *   > Overpass erlaubt nur wenige Slots je IP und quittiert Überlast mit 504.
 *   > Daher: BW in 4 Quadranten, alle Arten je Quadrant in EINER Abfrage,
 *   > 90 s Abstand (> Antwortzeit). Teilausfälle sind unkritisch — Entitäten
 *   > früherer Läufe bleiben in Orion bestehen.
 *   > Erweiterte Zielarten (hebt datenarme Gemeinden ohne klassische
 *   > Attraktion) und nwr statt node — auch Ways/Relations (Parks, Ruinen,
 *   > Naturschutzgebiete).
 *
 * Pacing, serialisation and the decision on the join timeout (900 s in the
 * flow) are in overpass.ts, shared with `poi-bw`.
 *
 * The selection is load-bearing and kept exactly: per municipality the hits in
 * the order the quadrants were requested and Overpass listed them, names cut to
 * 60 UTF-16 units AFTER the apostrophe swap, de-duplicated by that cut name
 * (first one wins), then the first 25. `zielCount` counts every hit, duplicates
 * included. Written in full every run, ungated and without a prune, as before.
 *
 * Deviations:
 *
 *  * The type label comes from a `Map`, not an object literal — `TYP[t.tourism]`
 *    on an object would find `Object.prototype` members for a tag value like
 *    `constructor`. No OSM value the query can return reaches that.
 *  * The geo context is checked before the four requests as well as after
 *    them, so no Overpass slot is spent on a run whose result the old build
 *    node would have discarded ("Grenzen-Cache fehlt").
 */

import { cleanText, dateObserved } from "../kernel/ngsi.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoRequirements,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import { fetchTiles, okKinds, overpassUrl, parseParts, reportSkipped } from "./overpass.js";
import type { OverpassPart, OverpassQuery } from "./overpass.js";

export const ID = "ausflug-bw";

/** SEL of FN_AUSFLUG_REQ, verbatim: every destination type in ONE query per quadrant. */
const SELECTOR =
  'nwr["tourism"~"^(attraction|viewpoint|museum|artwork|gallery|theme_park|zoo|aquarium)$"]["name"];' +
  'nwr["historic"~"^(castle|monument|ruins|memorial|archaeological_site|fort|tower)$"]["name"];' +
  'nwr["leisure"~"^(nature_reserve|garden)$"]["name"];' +
  'nwr["natural"~"^(peak|waterfall|cave_entrance)$"]["name"];';

type Box = readonly [south: number, west: number, north: number, east: number];

/** QUADS of FN_AUSFLUG_REQ: north-west, north-east, south-west, south-east. */
const QUADRANTS: readonly Box[] = [
  [48.7, 7.4, 49.9, 9.0],
  [48.7, 9.0, 49.9, 10.6],
  [47.5, 7.4, 48.7, 9.0],
  [47.5, 9.0, 48.7, 10.6],
];

/** The four requests, `Q1`…`Q4`, byte for byte the URLs of the old request node. */
export const QUERIES: readonly OverpassQuery[] = QUADRANTS.map((box, index) => ({
  kind: `Q${String(index + 1)}`,
  url: overpassUrl(`[out:json][timeout:120][bbox:${box.join(",")}];(${SELECTOR});out tags center;`),
}));

/** `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

/** Top N per municipality. */
const MAX_DESTINATIONS = 25;

/** `.slice(0, 60)` on the cleaned name. */
const MAX_NAME_LENGTH = 60;

const LABEL = "Overpass tourist destinations";

/** PIP_ONLY: boundaries required, master data rows not read. */
const GEO: GeoRequirements = { municipalities: "optional" };

const DATA_PROVIDER = "© OpenStreetMap contributors (ODbL)";

/**
 * TYP of the old node. German on purpose: attribute values shown on the
 * municipality pages. Only four of the queried values have a label; the rest
 * are "Ziel".
 */
const TYPE_LABEL: ReadonlyMap<string, string> = new Map([
  ["attraction", "Sehenswürdigkeit"],
  ["viewpoint", "Aussichtspunkt"],
  ["museum", "Museum"],
  ["castle", "Burg/Schloss"],
]);

/** One destination, as the old node's position array — the tuple names used to be nowhere. */
export type Destination = readonly [name: string, kind: string, lat: number, lon: number];

export interface TouristDestinationEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:TouristDestination:bw-${string}`;
  readonly type: "TouristDestination";
  readonly ags: Property<string>;
  readonly zielCount: Property<number>;
  readonly ziele: Property<readonly Destination[]>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
}

/**
 * The joined parts as the old build node received them behind the join
 * (`[{ kind, elements }, …]`). Loud on a shape FN_AUSFLUG_WRAP never
 * produces; malformed elements are skipped and counted per part.
 */
export function parse(raw: unknown): readonly OverpassPart[] {
  return parseParts(raw);
}

/** `TYP[t.tourism] || TYP[t.historic] || TYP[t.leisure] || TYP[t.natural] || 'Ziel'`. */
function typeLabel(tags: ReadonlyMap<string, string>): string {
  for (const key of ["tourism", "historic", "leisure", "natural"]) {
    const value = tags.get(key);
    const label = value === undefined ? undefined : TYPE_LABEL.get(value);
    if (label !== undefined) return label;
  }
  return "Ziel";
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(
  raw: readonly OverpassPart[],
  geo: GeoIndex | null,
  now: IsoTime,
): readonly TouristDestinationEntity[] {
  if (geo === null) return [];
  const byAgs = new Map<string, Destination[]>();
  for (const part of raw) {
    for (const element of part.elements) {
      const name = element.tags.get("name");
      const { lat, lon } = element;
      // `if (!t.name || lat == null) continue;` — a lon of null fails the lookup.
      if (name === undefined || name === "" || lat === null || lon === null) continue;
      const ags = geo.agsAt(lat, lon);
      if (ags === null) continue;
      // The computed coordinates, not el.lat: ways and relations only have a center.
      const destination: Destination = [cleanText(name, MAX_NAME_LENGTH), typeLabel(element.tags), lat, lon];
      const list = byAgs.get(ags);
      if (list === undefined) byAgs.set(ags, [destination]);
      else list.push(destination);
    }
  }
  return [...byAgs].map(([ags, all]) => {
    const seen = new Set<string>();
    const top = all
      .filter((destination) => {
        if (seen.has(destination[0])) return false;
        seen.add(destination[0]);
        return true;
      })
      .slice(0, MAX_DESTINATIONS);
    return {
      id: `urn:ngsi-ld:TouristDestination:bw-${ags}`,
      type: "TouristDestination",
      ags: { type: "Property", value: ags },
      zielCount: { type: "Property", value: all.length, unitCode: "C62" },
      ziele: { type: "Property", value: top, observedAt: now },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      "@context": NGSI_CONTEXT,
    };
  });
}

export async function run(ctx: Ctx): Promise<void> {
  if (ctx.geo.forRun(LABEL, GEO) === null) return; // logged; no Overpass slots spent on a discarded result

  const tiles = await fetchTiles(ctx, QUERIES);
  if (tiles === null) return; // shutdown
  const geo = ctx.geo.forRun(LABEL, GEO);
  if (geo === null) return;

  const parts = parse(tiles);
  reportSkipped(
    ctx,
    LABEL,
    parts.reduce((sum, part) => sum + part.skipped, 0),
  );
  const entities = build(parts, geo, ctx.now());
  const sources = okKinds(parts).join(",");
  if (entities.length === 0) {
    ctx.log.warn(`${LABEL}: no entities (sources ok: ${sources})`);
    return;
  }
  ctx.log.status(`${String(entities.length)} municipalities · sources: ${sources}`);

  // Ungated, as the old flow: `upsert`, not `upsert_commit`.
  const written = await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });
  ctx.log.info(
    `${String(written.entities)} municipalities with destinations upserted in ` +
      `${String(written.chunks)} chunks (${String(written.failedChunks)} failed)`,
  );
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly OverpassPart[], readonly TouristDestinationEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
