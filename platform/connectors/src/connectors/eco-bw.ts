/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `eco-bw` — bicycle counters of all municipalities (Eco-Counter, via MobiData BW).
 *
 * Port of `udp-rt-be-fn` ("→ Radzähler BW") in the former Node-RED flow generator (see git history).
 * Once a day the daily totals of every counter site in the feed: per site the
 * newest day of its `ALL` channel as `TrafficFlowObserved:bw-eco-<site id>`,
 * per municipality the sum over its sites as `…:bw-<ags>-summary`. Sites are
 * assigned STRICTLY to a municipality polygon; a site outside every BW polygon
 * is skipped, and the run is skipped while the boundaries are missing.
 *
 * `dateObserved` here is DATA, not the run time: the day the count belongs to
 * (`iso_timestamp` of the channel, midnight UTC of that day for the sums). The
 * parity test therefore compares it verbatim instead of neutralising it.
 *
 * No change gate (the old flow had none: one write a day), and a prune after a
 * complete run: own counters and municipal sums not confirmed for 60 h (2.5
 * runs), e.g. sums of a municipality that only had counters by centroid
 * proximity before the strict lookup.
 *
 * ## Deviations, all for input the feed does not carry
 *
 *  * Coordinates given as numeric strings would have gone into `location`
 *    as strings; they are written as numbers here (`GeoJsonPoint`). The feed
 *    has one site with empty-string coordinates, which both skip.
 *  * A channel without numeric `counts` is written without `dailyTotal`, and a
 *    value still in the broker is withdrawn (kernel/null-values.ts). The old
 *    node sent `value: null`, which Orion-LD 1.6 refuses for the whole entity
 *    (207): such a counter was never written. A non-string `iso_timestamp` or a
 *    `null` channel is skipped (the old node threw).
 *  * The prune runs after the upsert instead of concurrently before it; it
 *    keeps every id of the run, so both touch disjoint ids.
 */

import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import { withdrawNulls } from "../kernel/null-values.js";
import { isArray, isRecord, isString, isTruthy } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  JsonResponse,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "eco-bw";

export const SOURCE_URL = "https://mobidata-bw.de/daten/eco-counter/v2/fahrradzaehler_tageswerten.json";

/** Log prefix, as the old warnings read. */
const LABEL = "Eco-BW";

/** As the old node: `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

/** One channel of a site, as far as the node reads it. */
export interface CounterChannel {
  readonly direction: unknown;
  /** `iso_timestamp`, e.g. `"2026-09-26T00:00:00+02:00"`; only strings are usable. */
  readonly isoTimestamp: string | undefined;
  readonly counts: number | null;
}

export interface CounterSite {
  /** `counter_site_id` as it goes into the entity id (string concatenation). */
  readonly siteId: string;
  readonly name: string;
  /** Raw `latitude`/`longitude`: the node tested their truthiness and `Number()`ed them. */
  readonly latitude: number | string | null;
  readonly longitude: number | string | null;
  readonly channels: readonly CounterChannel[];
}

interface Base extends NgsiEntity {
  readonly id: `urn:ngsi-ld:TrafficFlowObserved:bw-${string}`;
  readonly type: "TrafficFlowObserved";
  readonly ags: Property<string>;
  readonly vehicleType: Property<"bicycle">;
  readonly dailyTotal: Property<number | null>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly "@context": string;
}

export interface SiteEntity extends Base {
  readonly name: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
}

export interface SummaryEntity extends Base {
  readonly siteCount: Property<number>;
}

export type EcoEntity = SiteEntity | SummaryEntity;

export interface EcoResult {
  readonly entities: readonly EcoEntity[];
  readonly municipalities: number;
}

/* ------------------------------------------------------------------ parse */

/** JavaScript's `String(x)` for a foreign value. */
function jsString(value: unknown): string {
  return String(value);
}

function coordinate(value: unknown): number | string | null {
  return typeof value === "number" || isString(value) ? value : null;
}

function parseChannel(raw: unknown): CounterChannel | null {
  if (!isRecord(raw)) return null;
  const iso = raw.iso_timestamp;
  const counts = raw.counts;
  return {
    direction: raw.direction,
    isoTimestamp: isString(iso) ? iso : undefined,
    counts: typeof counts === "number" ? counts : null,
  };
}

function parseSite(raw: unknown): CounterSite | null {
  if (!isRecord(raw)) return null;
  const channels: CounterChannel[] = [];
  // `s.channels || []`
  const list = raw.channels;
  if (isArray(list)) {
    for (const entry of list) {
      const channel = parseChannel(entry);
      if (channel !== null) channels.push(channel);
    }
  }
  const name = raw.counter_site;
  return {
    siteId: jsString(raw.counter_site_id),
    // `clean(s.counter_site)`: `String(s == null ? '' : s)`.
    name: name === null || name === undefined ? "" : jsString(name),
    latitude: coordinate(raw.latitude),
    longitude: coordinate(raw.longitude),
    channels,
  };
}

/** Narrows the feed. Not an array is loud; unusable sites are dropped as the loop skipped them. */
export function parse(raw: unknown): readonly CounterSite[] {
  if (!isArray(raw)) throw new Error(`${LABEL}: response is not an array`);
  const sites: CounterSite[] = [];
  for (const entry of raw) {
    const site = parseSite(entry);
    if (site !== null) sites.push(site);
  }
  return sites;
}

/* ------------------------------------------------------------------ build */

interface Sum {
  total: number;
  sites: number;
  readonly day: string;
}

/**
 * Pure. Per site the newest `ALL` channel, strict assignment, sums per
 * municipality in the order the municipalities first appear.
 */
export function summarize(raw: readonly CounterSite[], geo: GeoIndex | null, now: IsoTime): EcoResult {
  const entities: EcoEntity[] = [];
  const byMunicipality = new Map<Ags, Sum>();
  for (const site of raw) {
    if (!isTruthy(site.latitude) || !isTruthy(site.longitude)) continue;
    const all = site.channels.filter(
      (channel): channel is CounterChannel & { readonly isoTimestamp: string } =>
        channel.direction === "ALL" && isTruthy(channel.isoTimestamp),
    );
    if (all.length === 0) continue;
    // The comparator of the old node, verbatim: it never returns 0, and the
    // engine's sort is the same on both sides, so equal stamps land alike.
    all.sort((a, b) => (a.isoTimestamp < b.isoTimestamp ? -1 : 1));
    const latest = all[all.length - 1];
    if (latest === undefined) continue;
    const lat = Number(site.latitude);
    const lon = Number(site.longitude);
    const municipality = geo === null ? null : geo.municipalityAt(lat, lon);
    if (municipality === null) continue; // outside every BW municipality polygon
    const ags = municipality[0];
    let sum = byMunicipality.get(ags);
    if (sum === undefined) {
      sum = { total: 0, sites: 0, day: latest.isoTimestamp.slice(0, 10) };
      byMunicipality.set(ags, sum);
    }
    sum.total += latest.counts ?? 0;
    sum.sites += 1;
    entities.push({
      id: `urn:ngsi-ld:TrafficFlowObserved:bw-eco-${site.siteId}`,
      type: "TrafficFlowObserved",
      ags: { type: "Property", value: ags },
      name: { type: "Property", value: cleanText(site.name) },
      vehicleType: { type: "Property", value: "bicycle" },
      dailyTotal: observed(latest.counts, "C62", now),
      dateObserved: dateObserved(latest.isoTimestamp),
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
    });
  }
  for (const [ags, sum] of byMunicipality) {
    entities.push({
      id: `urn:ngsi-ld:TrafficFlowObserved:bw-${ags}-summary`,
      type: "TrafficFlowObserved",
      ags: { type: "Property", value: ags },
      vehicleType: { type: "Property", value: "bicycle" },
      siteCount: observed(sum.sites, "C62", now),
      dailyTotal: observed(sum.total, "C62", now),
      dateObserved: dateObserved(`${sum.day}T00:00:00Z`),
      "@context": NGSI_CONTEXT,
    });
  }
  return { entities, municipalities: byMunicipality.size };
}

/** Pure — this is what the parity harness diffs against the old node. */
export function build(raw: readonly CounterSite[], geo: GeoIndex | null, now: IsoTime): readonly EcoEntity[] {
  return summarize(raw, geo, now).entities;
}

/* ------------------------------------------------------------------ run */

export async function run(ctx: Ctx): Promise<void> {
  let response: JsonResponse;
  try {
    response = await ctx.fetch.json(SOURCE_URL);
  } catch (error) {
    ctx.log.warn(`${LABEL}: no data (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (!response.ok || !isArray(response.body)) {
    ctx.log.warn(`${LABEL}: no data (${String(response.status)})`);
    return;
  }
  const geo = ctx.geo.forRun(LABEL);
  if (geo === null) return;

  const result = summarize(parse(response.body), geo, ctx.now());
  if (result.entities.length === 0) return;
  const status = `${String(result.entities.length)} objects (${String(result.municipalities)} municipalities)`;
  ctx.log.status(status);

  // Written in full once a day, as before: the old flow had no gate here.
  const entities = await withdrawNulls(ctx, result.entities, LABEL);
  await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });

  // Daily run over the complete feed: remove own counters and municipal sums
  // not confirmed for 60 h (2.5 runs).
  await ctx.prune.stale({
    label: LABEL,
    type: "TrafficFlowObserved",
    pattern: "^urn:ngsi-ld:TrafficFlowObserved:bw-(eco-[A-Za-z0-9_-]+|[0-9]{8}-summary)$",
    attrs: ["ags", "dateObserved", "dailyTotal"],
    keep: new Set(result.entities.map((entity) => entity.id)),
    graceMs: 60 * 3_600_000,
    intervalMs: ctx.intervalMs(),
    status,
  });
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly CounterSite[], readonly EcoEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
