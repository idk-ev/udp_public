/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `ausflug-bw` — tourist destinations from OpenStreetMap, the top 25 per
 * municipality, with the uncapped count in total and per type.
 *
 * Port of FN_AUSFLUG_REQ, FN_AUSFLUG_WRAP and FN_AUSFLUG_BUILD from
 * the former Node-RED flow generator (see git history). The original request node says why it is
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
 * Two of those sentences did not hold: the quadrants were refused with 504
 * week after week, and a failed quadrant was not harmless — every
 * municipality on its border was rewritten from the quadrants that answered
 * (Stuttgart with one destination instead of ~1,600). See the deviations.
 *
 * Pacing, serialisation, retries, the write guards and the decision on the
 * join timeout (900 s in the flow) are in overpass.ts, shared with `poi-bw`.
 *
 * The selection is load-bearing and kept exactly: per municipality the hits in
 * the order the tiles were requested and Overpass listed them, names cut to
 * 60 UTF-16 units AFTER the apostrophe swap, de-duplicated by that cut name
 * (first one wins), then the first 25. `zielCount` counts every distinct hit
 * (see the deviations). Written every run, ungated and without a prune, as
 * before — where the write guards let it.
 *
 * Deviations:
 *
 *  * DELIBERATE DEVIATION: 15 tiles instead of 4 quadrants ({@link TILES}),
 *    each declaring `[timeout:60][maxsize:128 MiB]` instead of `[timeout:120]`
 *    and the default 512 MiB ({@link MAXSIZE_BYTES}). Every quadrant is cut
 *    into its four quarters; the north-western quarter of the north-western
 *    quadrant holds no municipality of the state and is not requested
 *    ({@link OUTSIDE}). Refused tiles are retried (overpass.ts). The hits of a
 *    municipality now arrive in tile order, not quadrant order, so where more
 *    than 25 compete the listed 25 can differ from the old ones; the selection
 *    rule itself is unchanged.
 *  * DELIBERATE DEVIATION: a tile with a `remark` (truncated answer), or with
 *    no element at all (every tile holds land of the state and hundreds of
 *    destinations), counts as failed, and a run with failed tiles writes only the municipalities whose
 *    area lies wholly in tiles that answered; a municipality whose
 *    `zielCount` falls by more than 80 % from at least 20 is not written
 *    either (overpass.ts, `guardWrites`). The flows wrote whatever arrived.
 *  * DELIBERATE DEVIATION: `counts` — the distinct hits per type label
 *    (`{"Museum": 12, …}`), uncapped like `zielCount` and summing up to it.
 *    The municipality page built its breakdown from the 25 listed ones.
 *  * `zielCount` counts an object once: a hit whose OSM id, or whose cut name
 *    and position (5 decimals, ~1 m), was already counted is a duplicate. A
 *    way crossing a tile border comes back in both answers; the old node
 *    counted it twice, and the page showed that count as the total.
 *  * The type label comes from a `Map`, not an object literal — `TYP[t.tourism]`
 *    on an object would find `Object.prototype` members for a tag value like
 *    `constructor`. No OSM value the query can return reaches that.
 *  * The geo context is checked before the requests as well as after them, so
 *    no Overpass slot is spent on a run whose result the old build node would
 *    have discarded ("Grenzen-Cache fehlt").
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
import {
  fetchTiles,
  guardWrites,
  MIB,
  okKinds,
  overpassSettings,
  overpassUrl,
  parseParts,
  reportSkipped,
} from "./overpass.js";
import type { Box, OverpassPart, OverpassQuery } from "./overpass.js";

export const ID = "ausflug-bw";

/** SEL of FN_AUSFLUG_REQ, verbatim: every destination type in ONE query per tile. */
export const SELECTOR =
  'nwr["tourism"~"^(attraction|viewpoint|museum|artwork|gallery|theme_park|zoo|aquarium)$"]["name"];' +
  'nwr["historic"~"^(castle|monument|ruins|memorial|archaeological_site|fort|tower)$"]["name"];' +
  'nwr["leisure"~"^(nature_reserve|garden)$"]["name"];' +
  'nwr["natural"~"^(peak|waterfall|cave_entrance)$"]["name"];';

/** QUADS of FN_AUSFLUG_REQ: north-west, north-east, south-west, south-east. */
export const QUADRANTS: readonly Box[] = [
  [48.7, 7.4, 49.9, 9.0],
  [48.7, 9.0, 49.9, 10.6],
  [47.5, 7.4, 48.7, 9.0],
  [47.5, 9.0, 48.7, 10.6],
];

/**
 * The north-western quarter of the north-western quadrant: north of 49.3°
 * the state ends at the Rhine, east of 8.2°, so this tile holds no
 * municipality of it (checked against `bw-grenzen.json` in the tests).
 */
export const OUTSIDE: Box = [49.3, 7.4, 49.9, 8.2];

/**
 * The quadrants of the old node, each cut into its quarters (north-west,
 * north-east, south-west, south-east), in the old quadrant order — so the hits
 * keep roughly the order the top-25 selection saw before — without
 * {@link OUTSIDE}. A quarter is 0.6° × 0.8°; the one around Stuttgart, the
 * densest, answered 4,855 elements (2.1 MB) in 13.4 s (2026-10).
 */
export const TILES: readonly Box[] = [
  // Q1, north-west (its north-western quarter is OUTSIDE)
  [49.3, 8.2, 49.9, 9.0],
  [48.7, 7.4, 49.3, 8.2],
  [48.7, 8.2, 49.3, 9.0],
  // Q2, north-east
  [49.3, 9.0, 49.9, 9.8],
  [49.3, 9.8, 49.9, 10.6],
  [48.7, 9.0, 49.3, 9.8],
  [48.7, 9.8, 49.3, 10.6],
  // Q3, south-west
  [48.1, 7.4, 48.7, 8.2],
  [48.1, 8.2, 48.7, 9.0],
  [47.5, 7.4, 48.1, 8.2],
  [47.5, 8.2, 48.1, 9.0],
  // Q4, south-east
  [48.1, 9.0, 48.7, 9.8],
  [48.1, 9.8, 48.7, 10.6],
  [47.5, 9.0, 48.1, 9.8],
  [47.5, 9.8, 48.1, 10.6],
];

/**
 * `[maxsize:128 MiB]`. Measured on the Stuttgart quarter (2026-10): the query
 * runs out of memory with 32 MiB ("would need at least 32 MB") and answers
 * with 64 MiB. 128 MiB is twice what is known to suffice and a quarter of the
 * default 512 MiB that the busy server refused to reserve.
 */
export const MAXSIZE_BYTES = 128 * MIB;

/** The fifteen requests, `T1`…`T15`. */
export const QUERIES: readonly OverpassQuery[] = TILES.map((box, index) => ({
  kind: `T${String(index + 1)}`,
  url: overpassUrl(
    `${overpassSettings(MAXSIZE_BYTES)}[bbox:${box.join(",")}];(${SELECTOR});out tags center;`,
  ),
  box,
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
  /** Distinct hits per type label; the values sum up to `zielCount`. */
  readonly counts: Property<Readonly<Record<string, number>>>;
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

/** Distinct hits of one municipality, in total and per type label. */
interface Tally {
  total: number;
  /** Type labels are fixed words, never array-index-like keys: insertion order holds on the wire. */
  readonly counts: Record<string, number>;
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(
  raw: readonly OverpassPart[],
  geo: GeoIndex | null,
  now: IsoTime,
): readonly TouristDestinationEntity[] {
  if (geo === null) return [];
  const byAgs = new Map<string, Destination[]>();
  const distinct = new Map<string, Tally>();
  const seen = new Set<string>();
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
      const place = `${destination[0]}@${lat.toFixed(5)},${lon.toFixed(5)}`;
      const id = element.osmId === null ? null : `osm:${element.osmId}`;
      if (seen.has(place) || (id !== null && seen.has(id))) continue;
      seen.add(place);
      if (id !== null) seen.add(id);
      let tally = distinct.get(ags);
      if (tally === undefined) {
        tally = { total: 0, counts: {} };
        distinct.set(ags, tally);
      }
      tally.total += 1;
      tally.counts[destination[1]] = (tally.counts[destination[1]] ?? 0) + 1;
    }
  }
  return [...byAgs].map(([ags, all]) => {
    const names = new Set<string>();
    const top = all
      .filter((destination) => {
        if (names.has(destination[0])) return false;
        names.add(destination[0]);
        return true;
      })
      .slice(0, MAX_DESTINATIONS);
    // The first hit of a municipality is always counted (its position is its own).
    const tally = distinct.get(ags) ?? { total: all.length, counts: {} };
    return {
      id: `urn:ngsi-ld:TouristDestination:bw-${ags}`,
      type: "TouristDestination",
      ags: { type: "Property", value: ags },
      zielCount: { type: "Property", value: tally.total, unitCode: "C62" },
      counts: { type: "Property", value: tally.counts, observedAt: now },
      ziele: { type: "Property", value: top, observedAt: now },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      "@context": NGSI_CONTEXT,
    };
  });
}

export async function run(ctx: Ctx): Promise<void> {
  if (ctx.geo.forRun(LABEL, GEO) === null) return; // logged; no Overpass slots spent on a discarded result

  const tiles = await fetchTiles(ctx, QUERIES, { emptyIsFailure: true });
  if (tiles === null) return; // shutdown
  const geo = ctx.geo.forRun(LABEL, GEO);
  if (geo === null) return;

  const parts = parse(tiles.parts);
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
  const writable = await guardWrites(ctx, entities, {
    label: LABEL,
    type: "TouristDestination",
    attribute: "zielCount",
    idOf: (entity) => entity.id,
    agsOf: (entity) => entity.ags.value,
    countOf: (entity) => entity.zielCount.value,
    failed: tiles.failed,
    geo,
  });
  if (writable === null) return; // logged, nothing written
  ctx.log.status(
    `${String(writable.length)} of ${String(entities.length)} municipalities · sources: ${sources}`,
  );
  if (writable.length === 0) return;

  // Ungated, as the old flow: `upsert`, not `upsert_commit`.
  const written = await ctx.orion.upsert(ctx.gate.ungated(writable), { chunkSize: CHUNK_SIZE });
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
