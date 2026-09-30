/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `puls-bw` — the city pulse: the aggregates of the other connectors condensed
 * per municipality into one index 0–100 (`CityPulse:bw-<ags>`).
 *
 * Port of `udp-rt-bz-build` ("→ CityPulse je Gemeinde") and the commit node
 * behind its upsert in the former Node-RED flow generator (see git history). It fetches no source:
 * it reads what the other connectors wrote to Orion-LD. The method is
 * documented in docs/framework-dashboards.md ("Gemeinde-Puls") and is ported
 * byte for byte — the scoring below must produce the same numbers as before:
 *
 *  * every query is paginated (count + limit/offset, deduplicated by id); a
 *    failed or incomplete query skips the whole run instead of silently
 *    scoring on a partial picture (`limit=1000` used to cut off
 *    ChargingSummary, ~1,100 entities);
 *  * feinstaub: citizen sensor median, only if observed within 2 h (as the
 *    dashboard), and not above the plausibility limit of 400; luftindex: UBA;
 *    laden: share of free live charge points; oepnv: median delay (only if
 *    observed within 2 h); br: free share of realtime bike parking of any
 *    connector (observed within 6 h);
 *  * sharing: free-floating vehicles per 1,000 inhabitants (5 or more = 100),
 *    so a small town is not scored against the raw count of a city — and no
 *    sharing component without a population figure;
 *  * baustellen: the SVZ roadworks feed covers the whole state, so a
 *    municipality without roadworks scores 100 — but only if the feed is alive
 *    (a roadwork observed within 24 h); otherwise the component is left out
 *    everywhere instead of rating every municipality "no roadworks";
 *  * warnungen: warning level of the district. It exists for every
 *    municipality, so it is weighted in but does not count towards the
 *    minimum: a pulse needs at least 3 OTHER components.
 *
 * Municipalities below the minimum get no pulse, and their old one is pruned
 * after 24 h.
 *
 * ## Deviations
 *
 *  * The listing requests carry `attrs=ags%2C…` where the old node sent the
 *    commas unescaped; Orion decodes both to the same query (the kernel's
 *    listing encodes every parameter, as the prune's pager did).
 *  * A failed query's reason reads as the kernel reports it (`HTTP 503`,
 *    `incomplete (900/1200)`, …); the old node also said `more than 50 pages`
 *    where the kernel says `incomplete (…)`. The listing keeps the fetcher's
 *    read retries.
 *  * A numeric attribute that arrives as a non-number (a string, say) counts
 *    as absent or 0 here; the old node would have concatenated strings.
 *    `keyValues` renders the numbers of the other connectors as numbers.
 *  * The prune runs after the upsert instead of concurrently before it; it
 *    keeps every pulse of the run, so both touch disjoint ids.
 */

import { isArray, isRecord, isString, isTruthy } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  OrionQuery,
  Property,
} from "../kernel/types.js";

export const ID = "puls-bw";

/** Log prefix, as the old warnings read. */
const LABEL = "Puls-BW";

/** As the old node: `emitChunks(node, msg, geaendert, 100)`. */
const CHUNK_SIZE = 100;

/** Store key of the change gate, unchanged from the flow. */
export const GATE_KEY = "pulseSig";

/** `alle()` read at most 50 pages of 1,000. */
const MAX_PAGES = 50;

const HOUR_MS = 3_600_000;

/** Components needed besides the warning level. */
const MINIMUM_COMPONENTS = 3;

/** Score of the district warning level 0–4. */
const WARNING_SCORES: readonly number[] = [100, 80, 60, 30, 0];

/** `[name, score 0–100, weight]` — one entry of `components`. */
export type PulseComponent = readonly [component: string, score: number, weight: number];

/* ------------------------------------------------------------------ the queries */

/** The seven listings, in the order the old node awaited them. */
export const LISTINGS = [
  ["pt", "PublicTransportStop", undefined, ["ags", "avgDelayMinutes", "dateObserved"]],
  // all BikeParking (ParkAPI and municipal connectors); the 6 h age check
  // below leaves out legacy and static entities
  ["br", "BikeParking", undefined, ["ags", "availableSpotNumber", "totalSpotNumber", "dateObserved"]],
  [
    "aq",
    "AirQualityObserved",
    "^urn:ngsi-ld:AirQualityObserved:bw-(sc|uba)-",
    ["ags", "pm25", "pm10", "airQualityIndex", "dateObserved"],
  ],
  ["sh", "SharingSummary", undefined, ["ags", "availableVehicles"]],
  ["ch", "ChargingSummary", undefined, ["ags", "liveEvse", "availableEvse"]],
  ["rw", "RoadWork", "^urn:ngsi-ld:RoadWork:bw-svz-", ["ags", "dateObserved"]],
  ["al", "Alert", "^urn:ngsi-ld:Alert:bw-kreis-", ["ags", "maxSeverity"]],
] as const;

export type ListingKey = (typeof LISTINGS)[number][0];

/** The query of one listing, `options=keyValues` as the old `alle()` sent. */
export function queryOf(type: string, idPattern: string | undefined, attrs: readonly string[]): OrionQuery {
  return { type, idPattern, attrs, options: "keyValues" };
}

/* ------------------------------------------------------------------ parse */

/** `e.ags` as the node used it: truthy, then an object key (`String(ags)`); else `null`. */
type AgsKey = string | null;

interface Observed {
  readonly ags: AgsKey;
  /** `zeit(e)`: `dateObserved` as string or `{ "@value" }`, parsed; 0 if none. */
  readonly observedMs: number;
}

export interface StopRecord extends Observed {
  readonly delay: number | undefined;
}

export interface BikeParkingRecord extends Observed {
  readonly available: number | undefined;
  readonly total: number;
}

export interface AirRecord extends Observed {
  /** `String(e.id).includes(':AirQualityObserved:bw-sc-')` — a citizen sensor median. */
  readonly median: boolean;
  /** `e.pm25 ?? e.pm10`, if a number. */
  readonly pm: number | undefined;
  readonly index: number | undefined;
}

export interface SharingRecord {
  readonly ags: AgsKey;
  readonly vehicles: number;
}

export interface ChargingRecord {
  readonly ags: AgsKey;
  /** `e.liveEvse` if a non-zero number (the node divided by it only then). */
  readonly live: number | undefined;
  readonly available: number;
}

export interface AlertRecord {
  readonly ags: AgsKey;
  /** `e.maxSeverity || 0` as `Math.max` coerces it. */
  readonly severity: number;
}

/** The seven listings, narrowed to what the scoring reads. */
export interface PulseListings {
  readonly pt: readonly StopRecord[];
  readonly br: readonly BikeParkingRecord[];
  readonly aq: readonly AirRecord[];
  readonly sh: readonly SharingRecord[];
  readonly ch: readonly ChargingRecord[];
  readonly rw: readonly Observed[];
  readonly al: readonly AlertRecord[];
}

/** JavaScript's `String(x)` for a foreign value. */
function jsString(value: unknown): string {
  return String(value);
}

function agsOf(record: Record<string, unknown>): AgsKey {
  const ags = record.ags;
  return isTruthy(ags) ? jsString(ags) : null;
}

/** `zeit(e)` of the old node. keyValues renders a DateTime as a string or as `{ '@type', '@value' }`. */
function observedMsOf(record: Record<string, unknown>): number {
  const value = record.dateObserved;
  const raw = isRecord(value) ? value["@value"] : value;
  // Date.parse(undefined) and friends are NaN; only strings can parse.
  const time = isString(raw) ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** `x || 0` for a numeric attribute; see the header for non-numbers. */
function orZero(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : 0;
}

function records(raw: unknown, key: string): Record<string, unknown>[] {
  if (!isArray(raw)) throw new Error(`${LABEL}: listing ${key} is not an array`);
  // `if (e && e.id)` of `alle()`: only records with an id made it into a listing.
  return raw.filter((entry): entry is Record<string, unknown> => isRecord(entry) && isTruthy(entry.id));
}

/**
 * Narrows the seven listings (`{ pt, br, aq, sh, ch, rw, al }`, each the array
 * `alle()` returned). Loud if one is missing; records without an id are
 * dropped, as the old pager dropped them.
 */
export function parse(raw: unknown): PulseListings {
  if (!isRecord(raw)) throw new Error(`${LABEL}: listings are not an object`);
  return {
    pt: records(raw.pt, "pt").map((e) => ({
      ags: agsOf(e),
      observedMs: observedMsOf(e),
      delay: numberOf(e.avgDelayMinutes),
    })),
    br: records(raw.br, "br").map((e) => ({
      ags: agsOf(e),
      observedMs: observedMsOf(e),
      available: numberOf(e.availableSpotNumber),
      total: orZero(e.totalSpotNumber),
    })),
    aq: records(raw.aq, "aq").map((e) => {
      // `e.pm25 ?? e.pm10`: only null/undefined fall through to PM10.
      const pm = e.pm25 ?? e.pm10;
      return {
        ags: agsOf(e),
        observedMs: observedMsOf(e),
        median: jsString(e.id).includes(":AirQualityObserved:bw-sc-"),
        pm: numberOf(pm),
        index: numberOf(e.airQualityIndex),
      };
    }),
    sh: records(raw.sh, "sh").map((e) => ({ ags: agsOf(e), vehicles: orZero(e.availableVehicles) })),
    ch: records(raw.ch, "ch").map((e) => {
      const live = numberOf(e.liveEvse);
      return {
        ags: agsOf(e),
        live: live === 0 || Number.isNaN(live) ? undefined : live,
        available: orZero(e.availableEvse),
      };
    }),
    rw: records(raw.rw, "rw").map((e) => ({ ags: agsOf(e), observedMs: observedMsOf(e) })),
    al: records(raw.al, "al").map((e) => {
      const severity = e.maxSeverity;
      // `Math.max(…, e.maxSeverity || 0)` converts with ToNumber.
      return { ags: agsOf(e), severity: isTruthy(severity) ? Number(severity) : 0 };
    }),
  };
}

/* ------------------------------------------------------------------ build */

interface Aggregates {
  delay?: number;
  bikeFree?: number;
  bikeCapacity?: number;
  pm25?: number;
  aqi?: number;
  sharing?: number;
  charging?: number;
}

export interface PulseEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:CityPulse:bw-${string}`;
  readonly type: "CityPulse";
  readonly ags: Property<string>;
  readonly pulseIndex: Property<number>;
  readonly components: Property<readonly PulseComponent[]>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly "@context": string;
}

export interface PulseResult {
  readonly entities: readonly PulseEntity[];
  /** Municipalities with fewer than three components (`unterMinimum`). */
  readonly belowMinimum: number;
  /** A roadwork observed within 24 h (`rwAktiv`). */
  readonly roadworksLive: boolean;
}

const clamp = (x: number): number => Math.max(0, Math.min(100, x));

/** `n || 0` for a number that may be undefined or NaN. */
function orZeroNumber(value: number | undefined): number {
  return value === undefined || Number.isNaN(value) ? 0 : value;
}

/**
 * Pure. The scoring of the old node, operation for operation — the order of
 * the components, the rounding and the left-to-right sums decide the bytes of
 * `components` and `pulseIndex`, and with them the change signature.
 */
export function summarize(raw: PulseListings, geo: GeoIndex | null, now: IsoTime): PulseResult {
  const nowMs = Date.parse(now);
  const fresh = (observedMs: number, maxAgeMs: number): boolean => nowMs - observedMs <= maxAgeMs;
  const byAgs = new Map<string, Aggregates>();
  const at = (ags: string): Aggregates => {
    let aggregates = byAgs.get(ags);
    if (aggregates === undefined) {
      aggregates = {};
      byAgs.set(ags, aggregates);
    }
    return aggregates;
  };

  for (const e of raw.pt) {
    if (e.ags !== null && e.delay !== undefined && fresh(e.observedMs, 2 * HOUR_MS))
      at(e.ags).delay = e.delay;
  }
  for (const e of raw.br) {
    if (e.ags === null || !fresh(e.observedMs, 6 * HOUR_MS) || e.available === undefined) continue;
    const aggregates = at(e.ags);
    aggregates.bikeFree = orZeroNumber(aggregates.bikeFree) + e.available;
    aggregates.bikeCapacity = orZeroNumber(aggregates.bikeCapacity) + e.total;
  }
  for (const e of raw.aq) {
    if (e.ags === null) continue;
    if (e.median) {
      // Same plausibility limit as on ingest (an SDS011 in saturation reports
      // ~500 µg/m³); only current medians (the dashboard uses 2 h too).
      if (e.pm !== undefined && e.pm <= 400 && fresh(e.observedMs, 2 * HOUR_MS)) at(e.ags).pm25 = e.pm;
    } else if (e.index !== undefined) at(e.ags).aqi = e.index;
  }
  for (const e of raw.sh) {
    if (e.ags === null) continue;
    const aggregates = at(e.ags);
    aggregates.sharing = orZeroNumber(aggregates.sharing) + e.vehicles;
  }
  for (const e of raw.ch) {
    if (e.ags !== null && e.live !== undefined) at(e.ags).charging = e.available / e.live;
  }
  const roadworksLive = raw.rw.some((e) => fresh(e.observedMs, 24 * HOUR_MS));
  const roadworks = new Map<string, number>();
  for (const e of raw.rw) if (e.ags !== null) roadworks.set(e.ags, orZeroNumber(roadworks.get(e.ags)) + 1);
  const warnings = new Map<string, number>();
  for (const e of raw.al) {
    if (e.ags !== null) warnings.set(e.ags, Math.max(orZeroNumber(warnings.get(e.ags)), e.severity));
  }

  const entities: PulseEntity[] = [];
  let belowMinimum = 0;
  for (const row of geo?.municipalities ?? []) {
    const ags: Ags = row[0];
    const population = row[6];
    const x = byAgs.get(ags) ?? {};
    const components: PulseComponent[] = [];
    if (x.pm25 !== undefined) components.push(["feinstaub", Math.round(clamp(100 - x.pm25 * 4)), 0.3]);
    if (x.aqi !== undefined) components.push(["luftindex", Math.round(clamp((5 - x.aqi) * 25)), 0.2]);
    if (x.sharing !== undefined && population !== null && population > 0) {
      components.push(["sharing", Math.round(clamp((x.sharing / population) * 1000 * 20)), 0.1]);
    }
    if (x.charging !== undefined) components.push(["laden", Math.round(x.charging * 100), 0.15]);
    if (roadworksLive) {
      components.push(["baustellen", Math.round(clamp(100 - orZeroNumber(roadworks.get(ags)) * 5)), 0.15]);
    }
    if (x.delay !== undefined) components.push(["oepnv", Math.round(clamp(100 - x.delay * 8)), 0.2]);
    const capacity = x.bikeCapacity;
    if (capacity !== undefined && capacity !== 0 && !Number.isNaN(capacity)) {
      components.push(["br", Math.round(clamp((orZeroNumber(x.bikeFree) / capacity) * 100)), 0.05]);
    }
    // warnungen does not count towards the minimum
    if (components.length < MINIMUM_COMPONENTS) {
      belowMinimum += 1;
      continue;
    }
    const level = orZeroNumber(warnings.get(ags.slice(0, 5)));
    components.push(["warnungen", WARNING_SCORES[level] ?? 0, 0.2]);
    const weights = components.reduce((sum, component) => sum + component[2], 0);
    const index = Math.round(
      components.reduce((sum, component) => sum + component[1] * component[2], 0) / weights,
    );
    entities.push({
      id: `urn:ngsi-ld:CityPulse:bw-${ags}`,
      type: "CityPulse",
      ags: { type: "Property", value: ags },
      pulseIndex: { type: "Property", value: index, observedAt: now },
      components: { type: "Property", value: components, observedAt: now },
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
      "@context": NGSI_CONTEXT,
    });
  }
  return { entities, belowMinimum, roadworksLive };
}

/** Pure — this is what the parity harness diffs against the old node. */
export function build(raw: PulseListings, geo: GeoIndex | null, now: IsoTime): readonly PulseEntity[] {
  return summarize(raw, geo, now).entities;
}

/**
 * Hourly run, but most components change less often — without the gate every
 * run wrote all municipal pulses into the TRoE history again (~38k rows a
 * day; the registry budgets 100,000 CityPulse rows). Unchanged pulses only
 * refresh `dateObserved` (one row per pulse and run).
 */
export function signatureOf(entity: PulseEntity): string {
  return `${String(entity.pulseIndex.value)}|${JSON.stringify(entity.components.value)}`;
}

export function statusText(result: PulseResult): string {
  return (
    `${String(result.entities.length)} municipalities with pulse · ` +
    `${String(result.belowMinimum)} below 3 components` +
    (result.roadworksLive ? "" : " · roadworks feed without current data")
  );
}

/* ------------------------------------------------------------------ run */

export async function run(ctx: Ctx): Promise<void> {
  // Master data required (the pulse is per municipality); the boundaries only
  // matter to the prune's plausibility check, which the kernel does itself.
  const geo = ctx.geo.forRun(LABEL, { boundaries: "optional" });
  if (geo === null) return;
  // Taken before the queries, as the old node took NOW and `jetzt`.
  const now = ctx.now();

  // Offset paging has no stable order while other connectors write: an entity
  // can show up on two pages. Deduplicated by id; a skipped one fails the count
  // check, and any failed or incomplete listing skips the whole run.
  const listings: Record<string, readonly unknown[]> = {};
  for (const [key, type, idPattern, attrs] of LISTINGS) {
    const listing = await ctx.orion.list(queryOf(type, idPattern, attrs), {
      maxPages: MAX_PAGES,
      dedupe: true,
    });
    if (!listing.ok) {
      ctx.log.warn(`${LABEL}: query failed, run skipped (${type}: ${listing.reason})`);
      return;
    }
    listings[key] = listing.entities;
  }

  const result = summarize(parse(listings), geo, now);
  const status = statusText(result);
  if (result.entities.length === 0) {
    ctx.log.warn(`${LABEL}: no municipality with 3 components`);
    return;
  }

  // replace: this run sees every pulse there is, so the table holds exactly
  // the current ones — merging would keep dropped municipalities forever.
  await ctx.orion.upsertChanged(GATE_KEY, result.entities, signatureOf, {
    replace: true,
    chunkSize: CHUNK_SIZE,
  });
  ctx.log.status(status);

  // Municipalities no longer reaching the minimum (or no longer in the master
  // data) lose their pulse. Every pulse produced is refreshed each run, so an
  // age of 24 h means "not produced for 24 runs".
  // Share limit 80 % instead of 30 %: a change of the method (like the stricter
  // minimum) can legitimately drop more than 30 % at once, and a prune that
  // skips forever would leave frozen pulses behind. CityPulse is derived data
  // (recomputed every hour, history stays in TRoE), and a run whose queries
  // failed or were incomplete never gets here.
  await ctx.prune.stale({
    label: LABEL,
    type: "CityPulse",
    pattern: "^urn:ngsi-ld:CityPulse:bw-[0-9]{8}$",
    attrs: ["ags", "dateObserved"],
    maxFraction: 0.8,
    keep: new Set(result.entities.map((entity) => entity.id)),
    graceMs: 24 * HOUR_MS,
    signatureKey: GATE_KEY,
    intervalMs: ctx.intervalMs(),
    status,
  });
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<PulseListings, readonly PulseEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
