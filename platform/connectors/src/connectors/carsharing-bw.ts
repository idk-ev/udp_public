/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `carsharing-bw` — station-based car sharing in Baden-Württemberg (GBFS,
 * MobiData BW provider feeds).
 *
 * Port of two flows that ran under one registry entry:
 *
 *  * master data (`udp-rt-cs-msgs`, `udp-rt-cs-fn`): per system
 *    `station_information` — the stations inside BW, assigned by the strict
 *    lookup, into a cache — and `vehicle_types` — the prevailing form factor
 *    of the provider, because RegioRad and Call a Bike stand in the same list
 *    as stadtmobil and must not count as car sharing;
 *  * status (`udp-rt-cz-msgs`, `udp-rt-cz-fn`, `udp-rt-cz-commit`): per system
 *    `station_status` against that cache — one `CarSharingStation` per
 *    station, one `FleetStatus` per municipality and system.
 *
 * Both flows fired hourly (the master data 120 s, the status 900 s after a
 * start); one `run` now does both in that order, master data first, so the
 * status always sees the stations of the same hour.
 *
 * ## Which function is which
 *
 * `parse` narrows a `station_information` message (`{ system, payload }`),
 * `build` assigns its stations by the strict lookup — the geo step, hence
 * the `(raw, geo, now)` shape — and returns the new cache entries of that
 * system. {@link parseStatus} / {@link buildStatus} are the status step:
 * pure over the cache and the form factors, no geo.
 *
 * ## Change gate, freshness, ids
 *
 *   > Wie bei den Ladesäulen: Nur schreiben, was sich geändert hat. Eine
 *   > Station auf dem Land steht Stunden unverändert da — ihr
 *   > Zeitreihen-Eintrag wäre reine Datenmenge ohne Aussage.
 *
 * MERGE mode: this runs once per GBFS system and only sees that system's
 * stations; replacing would shrink the table to one system each time and
 * disable the gate. Freshness: an unchanged station refreshes its
 * `dateObserved` every third run (`freshEvery: 3`), about every 3 h: ~4,000
 * stations × 8 ≈ 32,000 rows/day instead of ~96,000 (row budget
 * `CarSharingStation`: 200,000). Fleets are written in full every run.
 *
 * Station and fleet ids carry the municipality slug (`g[8]` of
 * bw-gemeinden.json, stored in the cache as `slug`). That is the official,
 * stable municipality slug — a field, not a slug of free text — followed by
 * the system key and the provider's own station id.
 *
 * ## Dead migration, deliberately not ported
 *
 * The old status node seeded `csSig` from a former table `csStand` and marked
 * the seeded entries in `csSigSeeded`, to be dropped again spread over 24
 * runs (`freshTurn(id, 24, 3600e3)`). That migrated the Node-RED flow
 * context of the time; this service's tables start empty and have no
 * `csStand` to migrate, so the path can never run here and is left out.
 *
 * ## Deliberate deviations
 *
 *  * One system list request per run instead of two (one per flow); an
 *    unreadable list warns once. The old status flow skipped it silently.
 *  * The systems are processed one after the other, paced by the fetcher
 *    (1 request/s), instead of through the delay node; the prunes are
 *    awaited before the status requests instead of fire-and-forget.
 *  * The cache and the form factors (`csStationen`, `csBauform`) are not
 *    signatures; they live in `ctx.state` ({@link STATIONS},
 *    {@link FORM_FACTORS}) as process-lifetime caches, not persisted: every
 *    run reloads both before it writes anything.
 *  * Narrowing of malformed entries the old code would have taken verbatim or
 *    crashed on: a station id that is neither string nor number is skipped
 *    (old: `sys::undefined`); a non-numeric capacity counts 0, a non-numeric
 *    `num_bikes_available` counts 0 (old: string arithmetic); a vehicle type
 *    that is not an object is skipped (old: TypeError). None occurs in GBFS.
 *  * Log texts are English.
 */

import { mergePlans } from "../kernel/change-gate.js";
import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import {
  isArray,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  looseNumber,
  ParseError,
  requireRecord,
} from "../kernel/parse.js";
import { stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
  UpsertPlan,
} from "../kernel/types.js";
import { feedUrl, parseSystems, SYSTEMS_URL, systemKey } from "./gbfs.js";
import type { GbfsSystem } from "./gbfs.js";

export const ID = "carsharing-bw";

/** Gate table, keyed by entity id so the prune can forget deleted stations. */
export const GATE_KEY = "csSig";
export const PROVIDER = "MobiData BW GBFS";
const HOUR_MS = 3_600_000;

/* ------------------------------------------------------------------ master data */

/** One station of the cache (`csStationen`), keyed by `<system>::<station_id>`. */
export interface StationInfo {
  readonly ags: Ags;
  /** Official municipality slug, `g[8]`. */
  readonly slug: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly kap: number;
  readonly sys: string;
}

export type StationCache = ReadonlyMap<string, StationInfo>;

/** A raw station of `station_information`, narrowed as far as the old node looked. */
export interface InfoStation {
  readonly stationId: string;
  readonly name: string | number | boolean | null | undefined;
  readonly lat: number | undefined;
  readonly lon: number | undefined;
  readonly capacity: number;
}

export interface StationInfoFeed {
  /** {@link systemKey} of the system. */
  readonly system: string;
  readonly stations: readonly InfoStation[];
}

/** `String(st.station_id)` for the ids that can be one. */
function idText(value: unknown): string | null {
  if (isString(value)) return value;
  if (isFiniteNumber(value)) return String(value);
  return null;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (isString(value) || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/** The `data` object of a feed message, or `null` (`!msg.payload || !msg.payload.data`). */
function dataOf(raw: unknown): { readonly system: string; readonly data: Record<string, unknown> } {
  const message = requireRecord(raw, "message");
  const system = message.system;
  if (!isString(system)) throw new ParseError("message.system", "string", system);
  const data = isRecord(message.payload) ? message.payload.data : undefined;
  if (!isTruthy(data)) throw new ParseError("payload.data", "object", data);
  return { system: systemKey(system), data: isRecord(data) ? data : {} };
}

/**
 * A `station_information` message. Throws {@link ParseError} where the old
 * node returned quietly: no data, or no non-empty station list (providers
 * without stations — free floating — answer with an empty one).
 */
export function parse(raw: unknown): StationInfoFeed {
  const { system, data } = dataOf(raw);
  const stations = data.stations;
  if (!isArray(stations) || stations.length === 0) {
    throw new ParseError("payload.data.stations", "non-empty array", stations);
  }
  const out: InfoStation[] = [];
  for (const station of stations) {
    if (!isRecord(station)) continue;
    const stationId = idText(station.station_id);
    if (stationId === null) continue;
    out.push({
      stationId,
      name: scalar(station.name),
      lat: looseNumber(station.lat),
      lon: looseNumber(station.lon),
      capacity: isFiniteNumber(station.capacity) ? station.capacity : 0,
    });
  }
  return { system, stations: out };
}

/**
 * Strict assignment, as for the charging stations: no centroid fallback,
 * otherwise stations from Bavaria or Switzerland land in BW municipalities.
 * Returns this system's cache entries; empty means "no station in BW", which
 * the caller must NOT take as "all gone" (feed error, or a system outside BW).
 */
export function build(
  feed: StationInfoFeed,
  geo: GeoIndex | null,
  _now: IsoTime,
): readonly (readonly [key: string, info: StationInfo])[] {
  const out: (readonly [string, StationInfo])[] = [];
  for (const station of feed.stations) {
    const { lat, lon } = station;
    if (lat === undefined || lon === undefined) continue;
    const municipality = geo?.municipalityAt(lat, lon) ?? null;
    if (municipality === null) continue;
    const name = isTruthy(station.name) ? station.name : station.stationId;
    out.push([
      `${feed.system}::${station.stationId}`,
      {
        ags: municipality[0],
        slug: municipality[8],
        name: cleanText(name, 80),
        lat,
        lon,
        kap: station.capacity,
        sys: feed.system,
      },
    ]);
  }
  return out;
}

/**
 * This response is the complete station list of the system: its entries are
 * REPLACED, so vanished stations leave the cache, are no longer written, and
 * the age-based prune removes them from the broker.
 */
export function replaceSystem(
  cache: StationCache,
  system: string,
  entries: readonly (readonly [string, StationInfo])[],
): StationCache {
  const next = new Map(cache);
  for (const key of cache.keys()) if (key.startsWith(`${system}::`)) next.delete(key);
  for (const [key, info] of entries) next.set(key, info);
  return next;
}

/**
 * Prevailing form factor of a provider (`car`, `bicycle`, `cargo_bicycle`, …)
 * from a `vehicle_types` message, or `null` (`if (top)` of the original).
 */
export function formFactorOf(raw: unknown): { readonly system: string; readonly formFactor: string | null } {
  const { system, data } = dataOf(raw);
  const types = data.vehicle_types;
  const counts = new Map<string, number>();
  for (const type of isArray(types) ? types : []) {
    if (!isRecord(type)) continue;
    const form = isTruthy(type.form_factor) && isString(type.form_factor) ? type.form_factor : "unbekannt";
    counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  // Stable sort by count, descending: ties keep the order of first sighting.
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return { system, formFactor: top === undefined ? null : top[0] };
}

/* ------------------------------------------------------------------ status */

export interface StatusStation {
  readonly stationId: string;
  readonly available: number;
}

export interface StationStatusFeed {
  readonly system: string;
  readonly stations: readonly StatusStation[];
}

/** A `station_status` message; {@link ParseError} where the old node returned quietly. */
export function parseStatus(raw: unknown): StationStatusFeed {
  const { system, data } = dataOf(raw);
  const stations = data.stations;
  if (!isArray(stations) || stations.length === 0) {
    throw new ParseError("payload.data.stations", "non-empty array", stations);
  }
  const out: StatusStation[] = [];
  for (const station of stations) {
    if (!isRecord(station)) continue;
    const stationId = idText(station.station_id);
    if (stationId === null) continue;
    const available = station.num_bikes_available;
    out.push({ stationId, available: isFiniteNumber(available) ? available : 0 });
  }
  return { system, stations: out };
}

export interface CarSharingStationEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:CarSharingStation:${string}`;
  readonly type: "CarSharingStation";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly operator: Property<string>;
  readonly vehicleType: Property<string>;
  readonly availableVehicles: Property<number>;
  readonly capacity: Property<number>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
}

export interface FleetStatusEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:FleetStatus:${string}`;
  readonly type: "FleetStatus";
  readonly ags: Property<string>;
  readonly operator: Property<string>;
  readonly vehicleType: Property<string>;
  readonly availableVehicles: Property<number>;
  readonly totalVehicles: Property<number>;
  readonly stationCount: Property<number>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
}

export interface StatusBuild {
  readonly stations: readonly CarSharingStationEntity[];
  readonly fleets: readonly FleetStatusEntity[];
}

/** Provider name made readable: `stadtmobil_rhein-neckar` -> `Stadtmobil Rhein-Neckar`… as the old node did. */
export function operatorName(system: string): string {
  return system
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface Fleet {
  free: number;
  kap: number;
  n: number;
  readonly slug: string;
}

/**
 * Stations and fleets of one system. Pure over the cache and the form
 * factors; stations outside BW or without master data are not in the cache
 * and are skipped.
 */
export function buildStatus(
  feed: StationStatusFeed,
  cache: StationCache,
  formFactors: ReadonlyMap<string, string>,
  now: IsoTime,
): StatusBuild {
  const sys = feed.system;
  const vehicleType = formFactors.get(sys) ?? "unbekannt";
  const operator = operatorName(sys);
  const stations: CarSharingStationEntity[] = [];
  const byMunicipality = new Map<Ags, Fleet>();
  for (const station of feed.stations) {
    const info = cache.get(`${sys}::${station.stationId}`);
    if (info === undefined) continue;
    const free = station.available;
    let fleet = byMunicipality.get(info.ags);
    if (fleet === undefined) {
      fleet = { free: 0, kap: 0, n: 0, slug: info.slug };
      byMunicipality.set(info.ags, fleet);
    }
    fleet.free += free;
    fleet.kap += info.kap;
    fleet.n += 1;
    stations.push({
      id: `urn:ngsi-ld:CarSharingStation:${info.slug}-${sys}-${station.stationId.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
      type: "CarSharingStation",
      ags: { type: "Property", value: info.ags },
      name: { type: "Property", value: info.name },
      operator: { type: "Property", value: operator },
      vehicleType: { type: "Property", value: vehicleType },
      availableVehicles: observed(free, "C62", now),
      capacity: { type: "Property", value: info.kap, unitCode: "C62" },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: PROVIDER },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [info.lon, info.lat] } },
      "@context": NGSI_CONTEXT,
    });
  }
  const fleets = [...byMunicipality].map(([ags, fleet]): FleetStatusEntity => ({
    id: `urn:ngsi-ld:FleetStatus:${fleet.slug}-${sys}`,
    type: "FleetStatus",
    ags: { type: "Property", value: ags },
    operator: { type: "Property", value: operator },
    vehicleType: { type: "Property", value: vehicleType },
    availableVehicles: observed(fleet.free, "C62", now),
    totalVehicles: observed(fleet.kap, "C62", now),
    stationCount: { type: "Property", value: fleet.n, unitCode: "C62" },
    dateObserved: dateObserved(now),
    dataProvider: { type: "Property", value: PROVIDER },
    "@context": NGSI_CONTEXT,
  }));
  return { stations, fleets };
}

/** Only the vehicle count changes; everything else is master data. */
export function stationSignature(entity: CarSharingStationEntity): string {
  return String(entity.availableVehicles.value);
}

/* ------------------------------------------------------------------ run */

/**
 * `csStationen` of the flow context. `null` until the first system delivered
 * stations in BW — the status step waits for that, as
 * `if (!flow.get('csStationen'))` did.
 */
export const STATIONS = stateKey<StationCache | null>("csStationen", () => null);

/** `csBauform` of the flow context: the prevailing form factor per system. */
export const FORM_FACTORS = stateKey("csBauform", () => new Map<string, string>());

/** Body of a feed request, or `null` where the old node got nothing usable. */
async function feedBody(ctx: Ctx, url: string): Promise<unknown> {
  try {
    const response = await ctx.fetch.json(url);
    return response.status >= 400 ? null : response.body;
  } catch {
    return null;
  }
}

/** Parse errors are the quiet `return null` of the old nodes. */
function quietly<T>(parseFeed: () => T): T | null {
  try {
    return parseFeed();
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}

async function masterData(ctx: Ctx, system: GbfsSystem): Promise<void> {
  const infoBody = await feedBody(ctx, feedUrl(system, "station_information"));
  const info = quietly(() => parse({ system: system.id, payload: infoBody }));
  if (info !== null) {
    const geo = ctx.geo.forRun("Carsharing");
    if (geo !== null) {
      const entries = build(info, geo, ctx.now());
      if (entries.length === 0) ctx.log.status(`${info.system}: no station in BW`);
      else {
        const stations = ctx.state.slot(STATIONS);
        stations.set(replaceSystem(stations.get() ?? new Map(), info.system, entries));
        ctx.log.status(`${info.system}: ${String(entries.length)} stations`);
      }
    }
  }
  const typesBody = await feedBody(ctx, feedUrl(system, "vehicle_types"));
  const types = quietly(() => formFactorOf({ system: system.id, payload: typesBody }));
  if (types !== null && types.formFactor !== null) {
    ctx.state.slot(FORM_FACTORS).get().set(types.system, types.formFactor);
  }
}

async function status(ctx: Ctx, cache: StationCache, system: GbfsSystem): Promise<void> {
  const body = await feedBody(ctx, feedUrl(system, "station_status"));
  const feed = quietly(() => parseStatus({ system: system.id, payload: body }));
  if (feed === null) return;
  const built = buildStatus(feed, cache, ctx.state.slot(FORM_FACTORS).get(), ctx.now());
  const plan: UpsertPlan = mergePlans(
    ctx.gate.check(GATE_KEY, built.stations, stationSignature, { freshEvery: 3, periodMs: HOUR_MS }),
    ctx.gate.ungated(built.fleets),
  );
  if (plan.entities.length === 0) return;
  ctx.log.status(`${feed.system}: ${String(plan.entities.length)} objects`);
  // One request per system, as the single message of the old node.
  await ctx.orion.upsert(plan, { chunkSize: plan.entities.length });
}

/** Only entities with this connector's dataProvider: municipal connectors may write the same types. */
export function ownGbfs(_id: string, entity: Readonly<Record<string, unknown>>): boolean {
  const provider = entity.dataProvider;
  return isTruthy(provider) && isRecord(provider) && provider.value === PROVIDER;
}

export async function run(ctx: Ctx): Promise<void> {
  let systems: readonly GbfsSystem[] | null = null;
  try {
    const response = await ctx.fetch.json(SYSTEMS_URL);
    if (response.status < 400) systems = parseSystems(response.body);
  } catch {
    systems = null;
  }
  if (systems === null) {
    ctx.log.warn("Carsharing: system list not loadable");
    return;
  }
  // Master data: two feeds per system, stations and vehicle types.
  ctx.log.status(`${String(systems.length)} systems, ${String(systems.length * 2)} requests`);
  for (const system of systems) await masterData(ctx, system);

  const cache = ctx.state.slot(STATIONS).get();
  if (cache === null) {
    ctx.log.warn("Carsharing: master data not loaded yet — run skipped");
    return;
  }

  // Like the free-floating summaries, the per-system runs never see the
  // complete inventory, so stations and fleets are pruned by age. Every
  // station in the cache is written at least every third run (change or
  // freshness rotation), every fleet in every run; one not written for 24 h
  // has left its system's station list or its system left the list. Skipped
  // if nothing was written within 3 h.
  await ctx.prune.stale({
    label: "Carsharing stations",
    type: "CarSharingStation",
    pattern: "^urn:ngsi-ld:CarSharingStation:[A-Za-z0-9_-]+$",
    attrs: ["ags", "dateObserved", "dataProvider"],
    accept: ownGbfs,
    graceMs: 24 * HOUR_MS,
    liveMs: 3 * HOUR_MS,
    signatureKey: GATE_KEY,
    intervalMs: ctx.intervalMs(),
  });
  await ctx.prune.stale({
    label: "Carsharing fleets",
    type: "FleetStatus",
    pattern: "^urn:ngsi-ld:FleetStatus:[A-Za-z0-9_-]+$",
    attrs: ["ags", "dateObserved", "dataProvider"],
    accept: ownGbfs,
    graceMs: 24 * HOUR_MS,
    liveMs: 3 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
  });

  for (const system of systems) await status(ctx, cache, system);
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<StationInfoFeed, readonly (readonly [string, StationInfo])[]> = {
  id: ID,
  parse,
  build,
  run,
};
