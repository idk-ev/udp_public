/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `rathaus-bw` — town halls from OpenStreetMap, the best one per municipality.
 *
 * Port of FN_RATHAUS_REQ and FN_RATHAUS_BUILD from
 * scripts/generate-nodered-flows.py. One Overpass query for the whole state
 * (`amenity=townhall`, nodes and ways, `out tags center`), weekly, every hit
 * assigned by the strict municipality lookup and reduced to one
 * `CivicStructure:bw-<ags>-rathaus` per municipality.
 *
 * "Best" is the old score, and its tie-break is load-bearing: two points for
 * opening hours, one for a name that says Rathaus/Bürger…/…verwaltung; the
 * FIRST element in Overpass order wins a tie, because only a strictly higher
 * score replaces it. Municipalities keep the order in which their first hit
 * appeared (`Object.keys(best)`), and so do the entities.
 *
 * Written in full every run, without a change gate and without a prune — as
 * the old flow did (`upsert`, not `upsert_commit`). A town hall that vanishes
 * from OSM stays in the broker until someone removes it.
 *
 * Deviations, both on the polite side of the old flow:
 *
 *  * The geo context is checked BEFORE the request: without boundaries the
 *    result would be thrown away (PIP_ONLY: "Grenzen-Cache fehlt"), so the
 *    Overpass slot is not spent. It is looked up again after the answer, so the
 *    build sees the boundaries current at that time, as the old node did.
 *  * The request is paced by the shared Overpass bucket (one per 90 s, see
 *    overpass.ts); the old flow had no delay node in front of this request.
 */

import { cleanText, dateObserved } from "../kernel/ngsi.js";
import { ParseError } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  GeoRequirements,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import { fetchOverpass, hasElements, overpassUrl, parseElements, reportSkipped } from "./overpass.js";
import type { OverpassElement, OverpassResult } from "./overpass.js";

export const ID = "rathaus-bw";

/** FN_RATHAUS_REQ, verbatim: BW bounding box, nodes and ways, 90 s server timeout. */
export const QUERY =
  '[out:json][timeout:90][bbox:47.5,7.4,49.9,10.6];(node["amenity"="townhall"];way["amenity"="townhall"];);out tags center;';

export const REQUEST_URL = overpassUrl(QUERY);

/** `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

const LABEL = "Overpass town halls";

/**
 * PIP_ONLY: boundaries required (no centroid fallback), the master data rows
 * are not read at all.
 */
const GEO: GeoRequirements = { municipalities: "optional" };

const DATA_PROVIDER = "© OpenStreetMap contributors (ODbL)";

/** The score's name test, verbatim — including the case-insensitive `ü`. */
const TOWN_HALL_NAME = /rathaus|bürger|stadtverwaltung|gemeindeverwaltung/i;

export interface TownHallEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:CivicStructure:bw-${string}-rathaus`;
  readonly type: "CivicStructure";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
  readonly openingHours?: Property<string> | undefined;
  readonly telephone?: Property<string> | undefined;
  readonly url?: Property<string> | undefined;
}

/** `a || b` on tag values: a missing or empty tag falls through. */
function either(value: string | undefined, fallback: string | undefined): string | undefined {
  return value === undefined || value === "" ? fallback : value;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** `(t.opening_hours ? 2 : 0) + (/…/i.test(t.name || '') ? 1 : 0)`. */
export function score(tags: ReadonlyMap<string, string>): number {
  return (present(tags.get("opening_hours")) ? 2 : 0) + (TOWN_HALL_NAME.test(tags.get("name") ?? "") ? 1 : 0);
}

/**
 * The Overpass answer. Throws when it carries no `elements` array — `run`
 * checks that first and warns as the old node did; a caller handing anything
 * else in gets a loud error. Malformed elements are skipped and counted.
 */
export function parse(raw: unknown): OverpassResult {
  if (!hasElements(raw)) throw new ParseError("payload.elements", "array", raw);
  return parseElements(raw.elements);
}

interface Candidate {
  readonly tags: ReadonlyMap<string, string>;
  readonly lat: number;
  readonly lon: number;
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: OverpassResult, geo: GeoIndex | null, now: IsoTime): readonly TownHallEntity[] {
  // Without boundaries the old node returned before the loop; every strict
  // lookup answers null then, so nothing would be built anyway.
  if (geo === null) return [];
  const best = new Map<string, Candidate>();
  for (const element of raw.elements) {
    const candidate = locate(element, geo);
    if (candidate === null) continue;
    const [ags, found] = candidate;
    const current = best.get(ags);
    // Strictly greater: on a tie the element seen first stays. Map.set on an
    // existing key keeps its position, as the assignment to `best[ags]` did.
    if (current === undefined || score(found.tags) > score(current.tags)) best.set(ags, found);
  }
  return [...best].map(([ags, { tags, lat, lon }]) => {
    const openingHours = tags.get("opening_hours");
    const telephone = either(tags.get("phone"), tags.get("contact:phone"));
    const url = either(tags.get("website"), tags.get("contact:website"));
    return {
      id: `urn:ngsi-ld:CivicStructure:bw-${ags}-rathaus`,
      type: "CivicStructure",
      ags: { type: "Property", value: ags },
      name: { type: "Property", value: cleanText(either(tags.get("name"), "Rathaus")) },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      // GeoJSON order: longitude first.
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
      ...(present(openingHours)
        ? { openingHours: { type: "Property", value: cleanText(openingHours) } }
        : {}),
      ...(present(telephone) ? { telephone: { type: "Property", value: cleanText(telephone) } } : {}),
      ...(present(url) ? { url: { type: "Property", value: cleanText(url) } } : {}),
    };
  });
}

/** `if (lat == null) continue; const ags = agsOf(lat, lon); if (!ags) continue;` */
function locate(element: OverpassElement, geo: GeoIndex): [ags: string, found: Candidate] | null {
  const { lat, lon } = element;
  if (lat === null || lon === null) return null;
  const ags = geo.agsAt(lat, lon);
  return ags === null ? null : [ags, { tags: element.tags, lat, lon }];
}

export async function run(ctx: Ctx): Promise<void> {
  if (ctx.geo.forRun(LABEL, GEO) === null) return; // logged; no Overpass slot spent on a discarded result

  const response = await fetchOverpass(ctx, REQUEST_URL);
  if (response.status === null || response.status >= 400 || !hasElements(response.body)) {
    ctx.log.warn(`${LABEL}: no data (${response.detail})`);
    return;
  }
  const geo = ctx.geo.forRun(LABEL, GEO);
  if (geo === null) return;

  const result = parse(response.body);
  reportSkipped(ctx, LABEL, result.skipped);
  const entities = build(result, geo, ctx.now());
  // The old node returned null here without a word.
  if (entities.length === 0) {
    ctx.log.status("0 town halls");
    return;
  }
  const withHours = entities.filter((entity) => entity.openingHours !== undefined).length;
  ctx.log.status(`${String(entities.length)} town halls (${String(withHours)} with opening hours)`);

  // Ungated, as the old flow: `upsert`, not `upsert_commit`.
  const written = await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });
  ctx.log.info(
    `${String(written.entities)} town halls upserted in ${String(written.chunks)} chunks ` +
      `(${String(written.failedChunks)} failed)`,
  );
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<OverpassResult, readonly TownHallEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
