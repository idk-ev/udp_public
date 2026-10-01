/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `rathaus-bw` — town halls from OpenStreetMap, the best one per municipality.
 *
 * Port of FN_RATHAUS_REQ and FN_RATHAUS_BUILD from
 * the former Node-RED flow generator (see git history). One Overpass query for the whole state
 * (`amenity=townhall`, nodes, ways and relations, `out tags center`), weekly,
 * every hit assigned by the strict municipality lookup and reduced to one
 * `CivicStructure:bw-<ags>-rathaus` per municipality — the one {@link score}
 * and {@link beats} rank highest. Municipalities keep the order in which their
 * first hit appeared (`Object.keys(best)`), and so do the entities.
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
 *
 * Deliberate deviation (audit): which town hall wins. The old score was two
 * points for opening hours and one for a name matching Rathaus/Bürger…/
 * …verwaltung, the first element winning a tie, and relations were not
 * queried — Stuttgart's own town hall is one. So a city got whichever
 * district office carried opening hours ("Bezirksrathaus Botnang" for
 * Stuttgart, "Ortsverwaltung Haueneberstein" for Baden-Baden). Now:
 *
 *  * relations are queried too;
 *  * {@link score} marks district and village offices down by name
 *    (Bezirksrathaus, Bezirksamt, Ortsverwaltung, Ortschaftsverwaltung,
 *    Verwaltungsstelle, Ortsamt, "Bürgerbüro <Ortsteil>", Landratsamt) and
 *    by `townhall:type` (district, county, …; village only in a Stadt, where
 *    it is a part of the town), rewards `townhall:type`
 *    city/town/municipality and a name that carries the municipality's name,
 *    and marks annexes (Technisches/Altes/Historisches Rathaus) down; opening
 *    hours and the old name test stay as secondary signals ({@link SCORE});
 *  * a tie goes to the candidate nearer the municipality's centre (master
 *    data row); without master data, or at equal distance, the first element
 *    still wins. Limitation: that centre is the polygon centroid of
 *    `bw-gemeinden.json`, not the town centre; the generator of the stop
 *    directory has a better reference (Wikidata), the geo context does not.
 *    Of a double name ("Villingen-Schwenningen") one half counts only
 *    {@link SCORE}.municipalityPart: which one is the main town is not known.
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

/**
 * FN_RATHAUS_REQ: BW bounding box, 90 s server timeout — plus relations
 * (deliberate deviation, module header).
 */
export const QUERY =
  '[out:json][timeout:90][bbox:47.5,7.4,49.9,10.6];(node["amenity"="townhall"];way["amenity"="townhall"];relation["amenity"="townhall"];);out tags center;';
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

/** The old score's name test, verbatim — including the case-insensitive `ü`. */
const TOWN_HALL_NAME = /rathaus|bürger|stadtverwaltung|gemeindeverwaltung/i;

/**
 * Offices of a district or village — or of the district authority — rather
 * than the municipality's seat. Word start only ("Sportverwaltung" is none).
 */
const SUB_OFFICE_NAME =
  /(?<![\p{L}])(?:bezirks(?:rat)?haus|bezirksamt|ort(?:s|schafts)?verwaltung|verwaltungsstelle|ortsamt|ortschaftsamt|landratsamt|kreisverwaltung)/iu;

/**
 * "Bürgerbüro Möhringen": a district office, unless the rest names the
 * municipality itself. A bare "Bürgerbüro" stays neutral, and so does one
 * that says where it sits ("Bürgerbüro im Rathaus", "Bürgeramt (Rathaus)").
 */
const CITIZENS_OFFICE_NAME = /bürger(?:büro|amt)\s+(\S.*)$/i;
const AT_THE_SEAT = /^(?:im|in|am|an|\(|\/|-)|rathaus|stadtverwaltung|gemeindeverwaltung/i;

/** Buildings of the administration that are not its seat. */
const ANNEX_NAME = /\b(?:technisches|altes|historisches)\s+rathaus|kulturforum|museum/i;

/** `townhall:type` of the municipality's own seat resp. of a part of it or another level. */
const MAIN_TYPES: ReadonlySet<string> = new Set(["city", "town", "municipality"]);
const SUB_TYPES: ReadonlySet<string> = new Set([
  "district",
  "borough",
  "quarter",
  "suburb",
  "county",
  "state",
]);
/** `village` is the seat of a village municipality, but a part of a town. */
const VILLAGE = "village";

/** Weights of {@link score}; opening hours and the old name test stay secondary. */
export const SCORE = {
  openingHours: 2,
  townHallName: 1,
  municipalityName: 4,
  municipalityPart: 2,
  mainType: 5,
  subType: -5,
  annex: -3,
  subOffice: -10,
} as const;

/** "Wendlingen am Neckar" → "wendlingen"; "Weil der Stadt" stays whole. */
function coreName(municipality: string): string {
  const [core = ""] = municipality
    .toLowerCase()
    .split(/\s+(?:am|an der|an den|im|in|bei|ob|unter)\s+|\s*[(,]/);
  return core.trim();
}

/** Letter or digit: what a name word is made of. */
const WORD = /[\p{L}\p{N}]/u;

/**
 * The municipality's name as a word of `text`, or one part of a double name:
 * "Stuttgarter Rathaus" for Stuttgart, "Rathaus Villingen" for
 * Villingen-Schwenningen — but not "Rathaus" or "Rathaus Aufeld" for Au.
 */
function namesMunicipality(text: string, municipality: string | undefined): boolean {
  return nameMatch(text, municipality) !== null;
}

/**
 * `"full"`: the name (core) itself; `"part"`: only one half of a double name.
 * Which half is the main town ("Villingen" or "Schwenningen") the master data
 * do not say, so a half counts less ({@link SCORE}).
 */
function nameMatch(text: string, municipality: string | undefined): "full" | "part" | null {
  const core = municipality === undefined ? "" : coreName(municipality);
  if (core === "") return null;
  if (wordAt(text, core)) return "full";
  const parts = core.includes("-") ? core.split("-").filter((part) => part.length >= 4) : [];
  return parts.some((part) => wordAt(text, part)) ? "part" : null;
}

/** `part` as a word of `text` (an adjective or genitive ending allowed). */
function wordAt(text: string, part: string): boolean {
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(part); at >= 0; at = lower.indexOf(part, at + 1)) {
    const before = at === 0 ? "" : lower.charAt(at - 1);
    const after = lower.slice(at + part.length);
    // An adjective or genitive ending is fine: "Stuttgarter", "Neckarsulms".
    const ending = after === "" || !WORD.test(after.charAt(0)) || /^(?:er|s)(?![\p{L}\p{N}])/u.test(after);
    if (!WORD.test(before) && ending) return true;
  }
  return false;
}

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

/**
 * How much a townhall element looks like the seat of `municipality` (its
 * master data name; without it there is no name bonus). `town`: the
 * municipality is a Stadt (or unknown), where `townhall:type=village` marks
 * a part of it; in a village municipality it is the seat. Rule in the module
 * header, weights in {@link SCORE}.
 */
export function score(tags: ReadonlyMap<string, string>, municipality?: string, town = true): number {
  const name = tags.get("name") ?? "";
  const type = (tags.get("townhall:type") ?? "").toLowerCase();
  const rest = CITIZENS_OFFICE_NAME.exec(name)?.[1];
  const subOffice =
    SUB_OFFICE_NAME.test(name) ||
    (rest !== undefined && !AT_THE_SEAT.test(rest) && !namesMunicipality(rest, municipality));
  const annex = ANNEX_NAME.test(name);
  let points = 0;
  if (present(tags.get("opening_hours"))) points += SCORE.openingHours;
  if (TOWN_HALL_NAME.test(name)) points += SCORE.townHallName;
  // Not for an annex either: "Technisches Rathaus Göppingen" is not the seat.
  const named = subOffice || annex ? null : nameMatch(name, municipality);
  if (named === "full") points += SCORE.municipalityName;
  if (named === "part") points += SCORE.municipalityPart;
  if (MAIN_TYPES.has(type)) points += SCORE.mainType;
  if (SUB_TYPES.has(type) || (town && type === VILLAGE)) points += SCORE.subType;
  if (annex) points += SCORE.annex;
  if (subOffice) points += SCORE.subOffice;
  return points;
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

export interface Ranked extends Candidate {
  readonly score: number;
  /** Squared distance to the municipality centre in degrees², `null` without master data. */
  readonly distance: number | null;
}

function rank(found: Candidate, ags: string, geo: GeoIndex): Ranked {
  const row = geo.byAgs(ags);
  const distance =
    row === undefined
      ? null
      : (found.lat - row[2]) ** 2 + ((found.lon - row[3]) * Math.cos((row[2] * Math.PI) / 180)) ** 2;
  return { ...found, score: score(found.tags, row?.[1], row === undefined || row[5] === "S"), distance };
}

/**
 * Whether `challenger` replaces the current best: a higher score; on a tie a
 * shorter distance to the municipality's centre; otherwise the first stays.
 */
export function beats(challenger: Ranked, current: Ranked): boolean {
  if (challenger.score !== current.score) return challenger.score > current.score;
  if (challenger.distance === null || current.distance === null) return false;
  return challenger.distance < current.distance;
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: OverpassResult, geo: GeoIndex | null, now: IsoTime): readonly TownHallEntity[] {
  // Without boundaries the old node returned before the loop; every strict
  // lookup answers null then, so nothing would be built anyway.
  if (geo === null) return [];
  const best = new Map<string, Ranked>();
  for (const element of raw.elements) {
    const candidate = locate(element, geo);
    if (candidate === null) continue;
    const [ags, found] = candidate;
    const challenger = rank(found, ags, geo);
    const current = best.get(ags);
    // Map.set on an existing key keeps its position, as the assignment to
    // `best[ags]` did.
    if (current === undefined || beats(challenger, current)) best.set(ags, challenger);
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
