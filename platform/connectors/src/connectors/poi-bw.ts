/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `poi-bw` — family and everyday amenities from OpenStreetMap (pharmacies,
 * doctors, day care, playgrounds, defibrillators, drinking water, recycling),
 * a balanced list of at most 50 plus counts per municipality.
 *
 * Port of FN_POI_REQ, FN_AUSFLUG_WRAP (shared "bündeln" node) and FN_POI_BUILD
 * from scripts/generate-nodered-flows.py. Why the grid is fine:
 *
 *   > Overpass-Abfragen über ein FEINES Raster (4×3=12 Kacheln). Die
 *   > Versorgungs-Arten (v. a. Spielplätze/Trinkwasser als Flächenobjekte)
 *   > sind volumenstark; über die 4 groben Quadranten kippte Overpass
 *   > reproduzierbar in 504. Kleinere Kacheln bleiben unter der
 *   > Timeout-Schwelle; fällt eine aus, retten die anderen den Lauf
 *   > (toleranter Teilausfall).
 *
 * The cron (Sunday 02:40) is offset from `ausflug-bw` (05:10) and `rathaus-bw`
 * (04:40) so the three do not compete for the scarce Overpass slots. Pacing,
 * serialisation and the decision on the join timeout (1,500 s in the flow)
 * are in overpass.ts.
 *
 * The selection is load-bearing and kept exactly: per municipality the items in
 * tile order, grouped by kind in order of first appearance; within a kind the
 * named ones first (stable sort — "unnamed" means the name equals the kind,
 * which is what `t.name || art` leaves for an unnamed object); then round-robin
 * over the kinds until 50, so the map shows a mix instead of only playgrounds.
 * `counts` counts every item. `totalCount` is the length of the SELECTED list
 * (at most 50), not the sum of `counts` — that is what the old node wrote, and
 * the port keeps it.
 *
 * Written in full every run, ungated and without a prune, as before.
 *
 * Start after a restart: the generator set `once: false` on this inject node
 * by hand, so the flow never fired on start. The service schedules it by the
 * registry (`refireOnRestart: false`), i.e. 600 s after a start — see
 * `scheduleOf` in src/kernel/scheduler.ts. Not changed here on purpose.
 *
 * Deviations:
 *
 *  * The kind labels come from a `Map`, not an object literal (`TYP[t.amenity]`
 *    would find `Object.prototype` members for a tag value like `constructor`).
 *  * The geo context is checked before the twelve requests as well as after
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
import { fetchTiles, overpassUrl, parseParts, reportSkipped } from "./overpass.js";
import type { OverpassPart, OverpassQuery } from "./overpass.js";

export const ID = "poi-bw";

/** SEL of FN_POI_REQ, verbatim. */
const SELECTOR =
  'nwr["amenity"~"^(pharmacy|doctors|kindergarten|recycling)$"];' +
  'nwr["leisure"="playground"];' +
  'nwr["emergency"="defibrillator"];' +
  'nwr["amenity"="drinking_water"];';

const LAT0 = 47.5;
const LAT1 = 49.9;
const LON0 = 7.4;
const LON1 = 10.6;
const ROWS = 3;
const COLUMNS = 4;

type Box = readonly [south: number, west: number, north: number, east: number];

/**
 * The 4×3 grid, row by row from the south. The arithmetic is the old node's,
 * operation for operation — `LAT0 + (LAT1 - LAT0) * r / NR` — because the
 * floating point results end up in the query text (`47.5,8.2,48.3,9`).
 */
function grid(): Box[] {
  const boxes: Box[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLUMNS; c++) {
      boxes.push([
        LAT0 + ((LAT1 - LAT0) * r) / ROWS,
        LON0 + ((LON1 - LON0) * c) / COLUMNS,
        LAT0 + ((LAT1 - LAT0) * (r + 1)) / ROWS,
        LON0 + ((LON1 - LON0) * (c + 1)) / COLUMNS,
      ]);
    }
  }
  return boxes;
}

/** The twelve requests, `K1`…`K12`, byte for byte the URLs of the old request node. */
export const QUERIES: readonly OverpassQuery[] = grid().map((box, index) => ({
  kind: `K${String(index + 1)}`,
  url: overpassUrl(`[out:json][timeout:90][bbox:${box.join(",")}];(${SELECTOR});out tags center;`),
}));

/** `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

/** Items per municipality. */
const MAX_ITEMS = 50;

/** `.slice(0, 50)` on the cleaned name. */
const MAX_NAME_LENGTH = 50;

const LABEL = "Overpass amenities";

/** PIP_ONLY: boundaries required, master data rows not read. */
const GEO: GeoRequirements = { municipalities: "optional" };

/** Different spelling from the other two Overpass connectors — kept, it is stored data. */
const DATA_PROVIDER = "© OpenStreetMap-Mitwirkende (ODbL)";

/** TYP of the old node. German on purpose: attribute values shown on the municipality pages. */
const KIND_LABEL: ReadonlyMap<string, string> = new Map([
  ["pharmacy", "Apotheke"],
  ["doctors", "Arztpraxis"],
  ["kindergarten", "Kita"],
  ["playground", "Spielplatz"],
  ["defibrillator", "Defibrillator"],
  ["drinking_water", "Trinkwasser"],
]);

/** One amenity, as the old node's position array. */
export type Amenity = readonly [name: string, kind: string, lat: number, lon: number];

export interface PublicAmenityEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:PublicAmenity:bw-${string}`;
  readonly type: "PublicAmenity";
  readonly ags: Property<string>;
  readonly amenities: Property<readonly Amenity[]>;
  readonly counts: Property<Readonly<Record<string, number>>>;
  readonly totalCount: Property<number>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
}

/** Joined parts, as for `ausflug-bw`; see `parseParts`. */
export function parse(raw: unknown): readonly OverpassPart[] {
  return parseParts(raw);
}

function label(value: string | undefined): string | undefined {
  return value === undefined ? undefined : KIND_LABEL.get(value);
}

/** `artOf(t)` of the old node; `null` = not an amenity this connector shows. */
export function kindOf(tags: ReadonlyMap<string, string>): string | null {
  if (tags.get("amenity") === "recycling") {
    if (tags.get("recycling_type") === "centre") return "Recyclinghof";
    if (tags.get("recycling:glass") === "yes" || tags.get("recycling:glass_bottles") === "yes")
      return "Altglas";
    return "Wertstoff-Container";
  }
  return (
    label(tags.get("amenity")) ??
    label(tags.get("leisure")) ??
    (tags.get("emergency") === "defibrillator" ? "Defibrillator" : null)
  );
}

/** `(x[0] === x[1] ? 1 : 0)`: an item whose name is its kind counts as unnamed. */
function unnamed(item: Amenity): number {
  return item[0] === item[1] ? 1 : 0;
}

/**
 * Round-robin over the kinds (in order of first appearance), named items
 * first within a kind, until `MAX_ITEMS`.
 */
function balanced(items: readonly Amenity[]): Amenity[] {
  const perKind = new Map<string, Amenity[]>();
  for (const item of items) {
    const list = perKind.get(item[1]);
    if (list === undefined) perKind.set(item[1], [item]);
    else list.push(item);
  }
  // Array.prototype.sort is stable: within "named" and "unnamed" the tile order stays.
  for (const list of perKind.values()) list.sort((x, y) => unnamed(x) - unnamed(y));
  const queues = [...perKind.values()];
  const selected: Amenity[] = [];
  while (selected.length < MAX_ITEMS && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (selected.length >= MAX_ITEMS) break;
      const next = queue.shift();
      if (next !== undefined) selected.push(next);
    }
  }
  return selected;
}

interface Bucket {
  readonly items: Amenity[];
  readonly counts: Record<string, number>;
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(
  raw: readonly OverpassPart[],
  geo: GeoIndex | null,
  now: IsoTime,
): readonly PublicAmenityEntity[] {
  if (geo === null) return [];
  const byAgs = new Map<string, Bucket>();
  for (const part of raw) {
    for (const element of part.elements) {
      const kind = kindOf(element.tags);
      if (kind === null) continue;
      const { lat, lon } = element;
      if (lat === null || lon === null) continue;
      const ags = geo.agsAt(lat, lon);
      if (ags === null) continue;
      let bucket = byAgs.get(ags);
      if (bucket === undefined) {
        bucket = { items: [], counts: {} };
        byAgs.set(ags, bucket);
      }
      // Kind labels are fixed words, never array-index-like keys, so the
      // object keeps its insertion order on the wire as the old one did.
      bucket.counts[kind] = (bucket.counts[kind] ?? 0) + 1;
      const name = tagOr(element.tags.get("name"), kind);
      bucket.items.push([cleanText(name, MAX_NAME_LENGTH), kind, lat, lon]);
    }
  }
  return [...byAgs].map(([ags, bucket]) => {
    const selected = balanced(bucket.items);
    return {
      id: `urn:ngsi-ld:PublicAmenity:bw-${ags}`,
      type: "PublicAmenity",
      ags: { type: "Property", value: ags },
      amenities: { type: "Property", value: selected, observedAt: now },
      counts: { type: "Property", value: bucket.counts, observedAt: now },
      totalCount: { type: "Property", value: selected.length, unitCode: "C62", observedAt: now },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      "@context": NGSI_CONTEXT,
    };
  });
}

/** `t.name || art`. */
function tagOr(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
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
  if (entities.length === 0) {
    ctx.log.warn(`${LABEL}: no entities (Overpass possibly overloaded)`);
    return;
  }
  ctx.log.status(`${String(entities.length)} municipalities with amenities`);

  // Ungated, as the old flow: `upsert`, not `upsert_commit`.
  const written = await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });
  ctx.log.info(
    `${String(written.entities)} municipalities with amenities upserted in ` +
      `${String(written.chunks)} chunks (${String(written.failedChunks)} failed)`,
  );
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly OverpassPart[], readonly PublicAmenityEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
