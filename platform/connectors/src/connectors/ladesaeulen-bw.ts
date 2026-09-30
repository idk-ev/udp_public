/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `ladesaeulen-bw` — charging stations in Baden-Württemberg (OCPDB of
 * MobiData BW, Bundesnetzagentur register plus DATEX II live status).
 *
 * Port of the count request and page fan-out (`udp-rt-bo-count`,
 * `udp-rt-bo-msgs`), the per-page slimming FN_OC_WRAP (`udp-rt-bo-wrap`), the
 * join, the build node (`udp-rt-bo-build`) and the signature commit behind
 * the upsert (`udp-rt-bo-commit`, now inside `Orion.upsert`). Writes one
 * `ChargingSummary` per municipality and one `EVChargingStation` per location
 * in a BW municipality.
 *
 * ## Completeness is what everything else hangs on
 *
 * The radius query (190 km around 48.65 N / 9.0 E) announces its
 * `total_count`; all pages of 1,000 are requested (capped at 60 with a
 * warning), and a failed page is MARKED, not dropped. A run is complete only
 * if every page arrived and answered and together they hold what
 * `total_count` announced (2 % tolerance — the stock can move between the
 * page requests). Only a complete run
 *
 *  * replaces the signature tables (`replace: built.complete` — an incomplete
 *    run merges, so the signatures of stations on a missing page survive), and
 *  * prunes stations and sums it no longer contains; an incomplete one clears
 *    the confirmation tables instead ("consecutive" means consecutive).
 *
 * ## Master data apart from live counters, freshness and row budget
 *
 * Stations and municipal sums are written through the split gate
 * (src/kernel/split-gate.ts): master data (name, operator, address,
 * location, socket count, AGS; for a sum AGS and the two counts) in one
 * signature, the four live counters in another. A station whose status moved
 * — about 46 % of the ~6,100 live stations per hour — sends only the changed
 * counters and `dateObserved`, not all twelve attributes; only new stations
 * and changed master data go out in full.
 *
 * Stations with live status carry `dateObserved`; an unchanged one refreshes
 * it every third run (`freshEvery: 3`), and so do the sums. Register entries
 * without live status have no observation and get no `dateObserved`: a pure
 * register entry must not show as "0 free" but as "no live data".
 *
 * Empty tables (fresh install, lost state, the switch from the former single
 * tables `ocSig`/`ocSumSig`) are seeded from the broker ({@link SEED}).
 * Estimate and budget: docs/betrieb.md, "Zeilenbudget".
 *
 * Station ids carry the municipality slug `g[8]` (official, stable — a field,
 * not slugged free text) and the OCPDB location id.
 *
 * ## Dead migration, not ported
 *
 * The old build node dropped a former table `ocSignatur` (keyed by OCPDB id)
 * once, rewriting all stations. This service never had that table.
 *
 * ## Deliberate deviations
 *
 *  * The pages are fetched one after the other, 1 per 3 s as the delay node
 *    did, and ALL are awaited; the old join gave up after 420 s and passed
 *    what it had, which then failed the completeness check. The outcome for
 *    a slow source is the same (incomplete, no prune), only without a timer.
 *    A page that fails after the fetcher's retries counts as failed, as the
 *    `http request` node's error message did.
 *  * The prunes are awaited after the upsert instead of fire-and-forget.
 *  * Narrowing: an item that is not an object, an `evses` that is not an
 *    array, a non-string EVSE status are skipped or read as empty (old:
 *    TypeError, run lost). None occurs in the OCPDB schema.
 *  * Log texts are English.
 */

import { mergePlans } from "../kernel/change-gate.js";
import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import {
  applySplit,
  dynamicSignature,
  pointOf,
  propertyValue,
  reportSplit,
  staticSignatureOf,
  totalsOf,
} from "../kernel/split-gate.js";
import type { SplitResult } from "../kernel/split-gate.js";
import {
  isArray,
  isBoolean,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  looseNumber,
  requireArray,
  requireNumber,
  requireRecord,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ChangeGate,
  ConnectorModule,
  Ctx,
  EntityId,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
  SeedOptions,
  UpsertPlan,
} from "../kernel/types.js";

export const ID = "ladesaeulen-bw";

const QUERY = "https://api.mobidata-bw.de/ocpdb/api/public/v1/locations?lat=48.65&lon=9.0&radius=190000";
/** The `http request` node "OCPDB Anzahl". */
export const COUNT_URL = `${QUERY}&limit=1&offset=0`;
export const PAGE_SIZE = 1000;
/** `OC_MAX_SEITEN`. */
export const MAX_PAGES = 60;
/**
 * Body cap per page (security review; the node read without a limit). A page
 * of 1,000 locations measured 1.5 MB decompressed (2026-09); 32 MiB is ~20
 * times that.
 */
export const PAGE_MAX_BYTES = 32 * 1024 * 1024;
/** The delay node "1 Anfrage/3s" in front of the page requests. */
export const PAGE_INTERVAL_MS = 3000;
/** As the old build node: `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;
const HOUR_MS = 3_600_000;

/** Master data and live counters of the stations and sums, each in a table of its own. */
export const STATION_STATIC = "ocStatic";
export const STATION_LIVE = "ocLive";
export const SUMMARY_STATIC = "ocSumStatic";
export const SUMMARY_LIVE = "ocSumLive";
/** The single tables of the plain gate before the split; dropped by every run. */
export const LEGACY_GATES = ["ocSig", "ocSumSig"] as const;
export const CONFIRM_KEYS = ["ocPruneStation", "ocPruneSummary"] as const;
export const PROVIDER = "MobiData BW OCPDB / Bundesnetzagentur";
const STATION_PATTERN = "^urn:ngsi-ld:EVChargingStation:[a-z0-9-]+-ocpdb-[A-Za-z0-9_-]+$";
const SUMMARY_PATTERN = "^urn:ngsi-ld:ChargingSummary:bw-[0-9]{8}$";

export function pageUrl(page: number): string {
  return `${QUERY}&limit=${String(PAGE_SIZE)}&offset=${String(page * PAGE_SIZE)}`;
}

/* ------------------------------------------------------------------ pages */

/**
 * One location as FN_OC_WRAP slims it — the column meaning of its positional
 * array, carried by the compiler instead of a comment.
 */
export type ChargingRow = readonly [
  id: string,
  lat: number,
  lon: number,
  evses: number,
  live: number,
  free: number,
  defect: number,
  /** Cleaned, 80 characters. */
  name: string,
  operator: string,
  address: string,
  charging: number,
];

/** `{ ok, items, rows }` of the wrap step: a failed page is marked, not dropped. */
export interface PagePart {
  readonly ok: boolean;
  /** Items on the page (all of them, in the box or not). */
  readonly items: number;
  readonly rows: readonly ChargingRow[];
}

/** A whole run as the join handed it to the build node. */
export interface OcpdbRun {
  /** Pages requested (`ocSeiten`). */
  readonly expectedPages: number;
  /** `total_count` of the count request (`ocGesamt`). */
  readonly announced: number;
  readonly pages: readonly PagePart[];
}

const FREE = ["AVAILABLE"];
const CHARGING = ["CHARGING", "BLOCKED", "RESERVED"];
const DEFECT = ["INOPERATIVE", "OUTOFORDER", "REMOVED"];

/** `String(x)` of a truthy scalar, else `fallback` — the `x || fallback` of the original. */
function textOr(value: unknown, fallback: string): string {
  if (!isTruthy(value)) return fallback;
  if (isString(value)) return value;
  if (isFiniteNumber(value) || isBoolean(value)) return String(value);
  return fallback;
}

function rowOf(item: Record<string, unknown>): ChargingRow | null {
  const coordinates = item.coordinates;
  if (!isTruthy(coordinates)) return null;
  const lat = isRecord(coordinates) ? looseNumber(coordinates.latitude) : undefined;
  const lon = isRecord(coordinates) ? looseNumber(coordinates.longitude) : undefined;
  // DO NOT filter on item.state. Exactly the locations with live status (the
  // DATEX II suppliers) carry no state field — the former text filter dropped
  // all of them, which is why no sum statewide ever had live data. The coarse
  // filter is the BW box; the exact assignment is the polygon lookup in build.
  if (lat === undefined || lon === undefined || lat < 47.4 || lat > 49.9 || lon < 7.3 || lon > 10.7)
    return null;
  const evses = isArray(item.evses) ? item.evses : [];
  let live = 0;
  let free = 0;
  let charging = 0;
  let defect = 0;
  for (const evse of evses) {
    const raw = isRecord(evse) ? evse.status : undefined;
    const status = (isString(raw) ? raw : "").toUpperCase();
    if (status === "STATIC" || status === "") continue;
    live += 1;
    if (FREE.includes(status)) free += 1;
    else if (CHARGING.includes(status)) charging += 1;
    else if (DEFECT.includes(status)) defect += 1;
  }
  const id = textOr(item.id, "");
  const operator = isRecord(item.operator) ? item.operator.name : undefined;
  // Apostrophes break the TRoE SQL insert (known Orion-LD bug) -> swapped.
  return [
    id,
    lat,
    lon,
    evses.length,
    live,
    free,
    defect,
    cleanText(textOr(item.name, textOr(item.address, `Ladestation ${textOr(item.id, "undefined")}`)), 80),
    cleanText(textOr(operator, "unbekannt"), 80),
    cleanText(`${textOr(item.address, "")}, ${textOr(item.postal_code, "")} ${textOr(item.city, "")}`, 80),
    charging,
  ];
}

/**
 * FN_OC_WRAP for one page: `statusCode` `null` means no response at all
 * (network error or timeout after the retries).
 */
export function wrapPage(statusCode: number | null, payload: unknown): PagePart {
  const items = isRecord(payload) ? payload.items : undefined;
  if (statusCode === null || statusCode >= 400 || !isArray(items)) return { ok: false, items: 0, rows: [] };
  const rows: ChargingRow[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const row = rowOf(item);
    if (row !== null) rows.push(row);
  }
  return { ok: true, items: items.length, rows };
}

/**
 * A run's raw answers: `{ expectedPages, announced, pages: [{ statusCode,
 * payload }] }` in page order — the count, and every page as the `http
 * request` node would have put it into `msg`.
 */
export function parse(raw: unknown): OcpdbRun {
  const envelope = requireRecord(raw, "run");
  const pages = requireArray(envelope.pages, "run.pages").map((page, index) => {
    const answer = requireRecord(page, `run.pages[${String(index)}]`);
    const status = answer.statusCode;
    return wrapPage(isFiniteNumber(status) ? status : null, answer.payload);
  });
  return {
    expectedPages: requireNumber(envelope.expectedPages, "run.expectedPages"),
    announced: requireNumber(envelope.announced, "run.announced"),
    pages,
  };
}

/* ------------------------------------------------------------------ build */

export interface ChargingSummaryEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:ChargingSummary:bw-${string}`;
  readonly type: "ChargingSummary";
  readonly ags: Property<string>;
  readonly locationCount: Property<number>;
  readonly evseCount: Property<number>;
  readonly liveEvse?: Property<number> | undefined;
  readonly availableEvse?: Property<number> | undefined;
  readonly chargingEvse?: Property<number> | undefined;
  readonly defectEvse?: Property<number> | undefined;
  readonly dateObserved?: Property<NgsiDateTime> | undefined;
  readonly "@context": string;
}

export interface ChargingStationEntity extends NgsiEntity {
  readonly id: EntityId;
  readonly type: "EVChargingStation";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly operator: Property<string>;
  readonly address: Property<string>;
  readonly socketNumber: Property<number>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly liveEvse?: Property<number> | undefined;
  readonly availableEvse?: Property<number> | undefined;
  readonly chargingEvse?: Property<number> | undefined;
  readonly defectEvse?: Property<number> | undefined;
  readonly dateObserved?: Property<NgsiDateTime> | undefined;
  readonly "@context": string;
}

export interface ChargingBuild {
  readonly summaries: readonly ChargingSummaryEntity[];
  readonly stations: readonly ChargingStationEntity[];
  /** Every page arrived and answered, and together they hold ≥ 98 % of `total_count`. */
  readonly complete: boolean;
  readonly okPages: number;
  readonly items: number;
  /** Distinct locations over all pages. */
  readonly locations: number;
}

/**
 * The old node deduplicated by location id into a plain object and walked
 * `Object.keys` of it — which lists integer-like keys ("73344") first, in
 * ascending numeric order, and only then the others in insertion order. The
 * OCPDB ids are integer-like, so the order of the written entities (and of
 * the chunks) depends on exactly that rule; reproduced here instead of
 * relying on Map order.
 */
export function objectKeyOrder(keys: Iterable<string>): string[] {
  const indices: string[] = [];
  const others: string[] = [];
  for (const key of keys) {
    if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4_294_967_295) indices.push(key);
    else others.push(key);
  }
  indices.sort((a, b) => Number(a) - Number(b));
  return [...indices, ...others];
}

interface Sum {
  n: number;
  evse: number;
  live: number;
  free: number;
  charging: number;
  defect: number;
}

/** Pure: dedupe, completeness, strict assignment, sums and stations. */
export function build(run: OcpdbRun, geo: GeoIndex | null, now: IsoTime): ChargingBuild {
  const seen = new Map<string, ChargingRow>();
  let okPages = 0;
  let items = 0;
  for (const part of run.pages) {
    if (part.ok) {
      okPages += 1;
      items += part.items;
    }
    for (const row of part.rows) seen.set(row[0], row);
  }
  const expected = run.pages.length > 0 && run.expectedPages !== 0 ? run.expectedPages : null;
  const total = run.pages.length > 0 && run.announced !== 0 ? run.announced : null;
  const complete =
    expected !== null &&
    okPages === expected &&
    run.pages.length === expected &&
    total !== null &&
    items >= total * 0.98;

  const order = objectKeyOrder(seen.keys());
  // Strict assignment: real polygon hits only. The box of the wrap step also
  // pulls in Bavaria, Hesse and Switzerland; the centroid fallback would have
  // silently given them to the nearest BW municipality.
  const byMunicipality = new Map<Ags, Sum>();
  const stations: ChargingStationEntity[] = [];
  const assigned: {
    readonly id: string;
    readonly row: ChargingRow;
    readonly ags: Ags;
    readonly slug: string;
  }[] = [];
  for (const id of order) {
    const row = seen.get(id);
    if (row === undefined) continue;
    const municipality = geo?.municipalityAt(row[1], row[2]) ?? null;
    if (municipality === null) continue;
    const ags = municipality[0];
    let sum = byMunicipality.get(ags);
    if (sum === undefined) {
      sum = { n: 0, evse: 0, live: 0, free: 0, charging: 0, defect: 0 };
      byMunicipality.set(ags, sum);
    }
    sum.n += 1;
    sum.evse += row[3];
    sum.live += row[4];
    sum.free += row[5];
    sum.charging += row[10];
    sum.defect += row[6];
    assigned.push({ id, row, ags, slug: municipality[8] });
  }

  const summaries = [...byMunicipality].map(([ags, sum]): ChargingSummaryEntity => ({
    id: `urn:ngsi-ld:ChargingSummary:bw-${ags}`,
    type: "ChargingSummary",
    ags: { type: "Property", value: ags },
    locationCount: observed(sum.n, "C62", now),
    evseCount: observed(sum.evse, "C62", now),
    "@context": NGSI_CONTEXT,
    ...(sum.live > 0
      ? {
          liveEvse: observed(sum.live, "C62", now),
          availableEvse: observed(sum.free, "C62", now),
          chargingEvse: observed(sum.charging, "C62", now),
          defectEvse: observed(sum.defect, "C62", now),
          // Freshness of the live sum (like ParkingSummary): unchanged sums
          // only refresh dateObserved, ~900 × 24 ≈ 22,000 rows/day.
          dateObserved: dateObserved(now),
        }
      : {}),
  }));

  // Single stations for EVERY municipality (building blocks "laden-detail" /
  // "laden-live"): the snapshot contains them anyway; dropping them would be
  // the real waste.
  for (const { id, row, ags, slug } of assigned) {
    if (slug === "") continue;
    const [, lat, lon, evses, live, free, defect, name, operator, address, charging] = row;
    stations.push({
      id: `urn:ngsi-ld:EVChargingStation:${slug}-ocpdb-${id}`,
      type: "EVChargingStation",
      ags: { type: "Property", value: ags },
      name: { type: "Property", value: name },
      operator: { type: "Property", value: operator },
      address: { type: "Property", value: address },
      socketNumber: observed(evses, "C62", now),
      dataProvider: { type: "Property", value: PROVIDER },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
      // Live values only where they exist — otherwise a pure register entry
      // would wrongly stand as "0 free" instead of "no live data".
      ...(live > 0
        ? {
            liveEvse: observed(live, "C62", now),
            availableEvse: observed(free, "C62", now),
            chargingEvse: observed(charging, "C62", now),
            defectEvse: observed(defect, "C62", now),
            dateObserved: dateObserved(now),
          }
        : {}),
    });
  }
  return { summaries, stations, complete, okPages, items, locations: seen.size };
}

/** The measured attributes of stations and sums, in the order of their dynamic signature. */
export const LIVE_ATTRIBUTES = ["liveEvse", "availableEvse", "chargingEvse", "defectEvse"] as const;

/**
 * Master data of a station — also of one as the broker returns it (seeding),
 * hence over a plain record; `null` when an attribute is missing there.
 */
export function stationStatic(entity: Readonly<Record<string, unknown>>): string | null {
  return staticSignatureOf([
    propertyValue(entity, "ags"),
    propertyValue(entity, "name"),
    propertyValue(entity, "operator"),
    propertyValue(entity, "address"),
    propertyValue(entity, "socketNumber"),
    propertyValue(entity, "dataProvider"),
    pointOf(entity),
  ]);
}

/** Master data of a municipal sum; `null` as {@link stationStatic}. */
export function summaryStatic(entity: Readonly<Record<string, unknown>>): string | null {
  return staticSignatureOf([
    propertyValue(entity, "ags"),
    propertyValue(entity, "locationCount"),
    propertyValue(entity, "evseCount"),
  ]);
}

/** A built entity always has its master data. */
function builtStatic(signature: string | null): string {
  return signature ?? "";
}

/**
 * Seeds the four tables from the broker when they are empty (fresh install,
 * lost state, and the switch from the former single tables): the next run
 * then writes what changed, not all ~13,000 entities in full.
 */
export const SEED: SeedOptions = {
  label: "OCPDB",
  queries: [
    { type: "EVChargingStation", pattern: STATION_PATTERN },
    { type: "ChargingSummary", pattern: SUMMARY_PATTERN },
  ],
  attrs: [
    "ags",
    "name",
    "operator",
    "address",
    "socketNumber",
    "dataProvider",
    "location",
    "locationCount",
    "evseCount",
    ...LIVE_ATTRIBUTES,
  ],
  // Stations carry this connector's provider; sums carry none.
  accept: (_id, entity) =>
    entity.type === "ChargingSummary" || propertyValue(entity, "dataProvider") === PROVIDER,
  tables: {
    [STATION_STATIC]: (entity) => (entity.type === "EVChargingStation" ? stationStatic(entity) : null),
    [STATION_LIVE]: (entity) =>
      entity.type === "EVChargingStation" && stationStatic(entity) !== null
        ? dynamicSignature(entity, LIVE_ATTRIBUTES)
        : null,
    [SUMMARY_STATIC]: (entity) => (entity.type === "ChargingSummary" ? summaryStatic(entity) : null),
    [SUMMARY_LIVE]: (entity) =>
      entity.type === "ChargingSummary" && summaryStatic(entity) !== null
        ? dynamicSignature(entity, LIVE_ATTRIBUTES)
        : null,
  },
};

/**
 * The write of one run: master data and live counters apart
 * (src/kernel/split-gate.ts). A station whose status moved sends the changed
 * counters and `dateObserved`, not all twelve attributes. Replace mode only
 * after a complete run; an incomplete one merges, so the signatures of
 * stations on a missing page survive.
 */
export function planWrite(
  gate: ChangeGate,
  built: ChargingBuild,
  nowMs: number,
): { readonly plan: UpsertPlan; readonly stations: SplitResult; readonly summaries: SplitResult } {
  // The single tables before the split: gone, their entries are covered by the seeding.
  for (const key of LEGACY_GATES) gate.retain(key, () => false);
  const summaries = applySplit(
    gate,
    built.summaries,
    {
      staticKey: SUMMARY_STATIC,
      dynamicKey: SUMMARY_LIVE,
      staticSignature: (entity) => builtStatic(summaryStatic(entity)),
      dynamic: LIVE_ATTRIBUTES,
      replace: built.complete,
      freshEvery: 3,
      periodMs: HOUR_MS,
    },
    nowMs,
  );
  const stations = applySplit(
    gate,
    built.stations,
    {
      staticKey: STATION_STATIC,
      dynamicKey: STATION_LIVE,
      staticSignature: (entity) => builtStatic(stationStatic(entity)),
      dynamic: LIVE_ATTRIBUTES,
      replace: built.complete,
      freshEvery: 3,
      periodMs: HOUR_MS,
    },
    nowMs,
  );
  return { plan: mergePlans(summaries, stations), stations, summaries };
}

/* ------------------------------------------------------------------ run */

/** Count and pages; `null` after the warning of the count node. */
export async function fetchRun(ctx: Ctx): Promise<OcpdbRun | null> {
  let status: number | null = null;
  let total: unknown;
  try {
    const response = await ctx.fetch.json(COUNT_URL);
    status = response.status;
    total = isRecord(response.body) ? response.body.total_count : undefined;
  } catch {
    total = undefined;
  }
  if (status !== 200 || typeof total !== "number") {
    ctx.log.warn(`OCPDB: total_count not readable (${String(status)}) — run skipped`);
    return null;
  }
  let pages = Math.ceil(total / PAGE_SIZE);
  if (pages > MAX_PAGES) {
    ctx.log.warn(
      `OCPDB: ${String(total)} locations need ${String(pages)} pages, capped at ${String(MAX_PAGES)} — raise OC_MAX_SEITEN`,
    );
    pages = MAX_PAGES;
  }
  if (!(pages > 0)) {
    ctx.log.warn("OCPDB: total_count 0 — run skipped");
    return null;
  }
  ctx.log.status(`${String(total)} locations, ${String(pages)} pages`);
  const parts: PagePart[] = [];
  for (let page = 0; page < pages; page += 1) {
    try {
      const response = await ctx.fetch.json(pageUrl(page), {
        minIntervalMs: PAGE_INTERVAL_MS,
        maxBytes: PAGE_MAX_BYTES,
      });
      parts.push(wrapPage(response.status, response.body));
    } catch {
      parts.push(wrapPage(null, undefined));
    }
  }
  return { expectedPages: pages, announced: total, pages: parts };
}

export async function run(ctx: Ctx): Promise<void> {
  const fetched = await fetchRun(ctx);
  if (fetched === null) return;
  const geo = ctx.geo.forRun("OCPDB");
  if (geo === null) return;

  const now = ctx.now();
  const built = build(fetched, geo, now);
  if (!built.complete) {
    const expected = fetched.pages.length > 0 ? String(fetched.expectedPages) : "null";
    ctx.log.warn(
      `OCPDB: incomplete run (${String(built.okPages)}/${expected} pages, ` +
        `${String(built.items)}/${String(fetched.announced)} locations) — no prune`,
    );
  }

  await ctx.orion.seedSignatures(SEED);
  const { plan, stations, summaries } = planWrite(ctx.gate, built, Date.parse(now));
  reportSplit(ctx.log, "OCPDB ChargingSummary", totalsOf(summaries));
  reportSplit(ctx.log, "OCPDB EVChargingStation", totalsOf(stations));
  const status =
    `${String(built.locations)} locations → ${String(built.summaries.length)} municipalities · ` +
    `${String(built.stations.length)} stations`;
  ctx.log.status(status);
  await ctx.orion.upsert(plan, { chunkSize: CHUNK_SIZE });

  // Complete inventory: remove stations and municipal sums it no longer
  // contains. Register entries and sums without live data are never
  // refreshed, so an id must be missing in consecutive complete runs for
  // 24 h (confirmKey).
  const [stationKey, summaryKey] = CONFIRM_KEYS;
  if (built.complete && built.stations.length > 0 && (await ctx.prune.masterDataPlausible())) {
    await ctx.prune.stale({
      label: "OCPDB EVChargingStation",
      type: "EVChargingStation",
      pattern: "^urn:ngsi-ld:EVChargingStation:[a-z0-9-]+-ocpdb-[A-Za-z0-9_-]+$",
      keep: new Set(built.stations.map((entity) => entity.id)),
      confirmKey: stationKey,
      confirmMs: 24 * HOUR_MS,
      signatureKey: STATION_STATIC,
      signatureKeys: [STATION_LIVE],
      intervalMs: ctx.intervalMs(),
      status,
    });
    await ctx.prune.stale({
      label: "OCPDB ChargingSummary",
      type: "ChargingSummary",
      pattern: "^urn:ngsi-ld:ChargingSummary:bw-[0-9]{8}$",
      keep: new Set(built.summaries.map((entity) => entity.id)),
      confirmKey: summaryKey,
      confirmMs: 24 * HOUR_MS,
      intervalMs: ctx.intervalMs(),
      status,
    });
  } else {
    ctx.prune.resetConfirmations(stationKey);
    ctx.prune.resetConfirmations(summaryKey);
  }
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<OcpdbRun, ChargingBuild> = { id: ID, parse, build, run };
