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
 * Master data apart from the vehicle count (src/kernel/split-gate.ts): name,
 * operator, vehicle type, capacity, location and AGS in one signature
 * (`csStatic`), `availableVehicles` in another (`csLive`). A station whose
 * count moved — about 29 % of the ~4,400 live stations per hour — sends
 * `availableVehicles` and `dateObserved`, not all nine attributes; only new
 * stations and changed master data go out in full.
 *
 * MERGE mode: this runs once per GBFS system and only sees that system's
 * stations; replacing would shrink the tables to one system each time and
 * disable the gate. Freshness: an unchanged station refreshes its
 * `dateObserved` every third run (`freshEvery: 3`), about every 3 h. Fleets
 * are written in full every run. Empty tables (fresh install, lost state,
 * the switch from the former single table `csSig`) are seeded from the
 * broker ({@link SEED}). Estimate and budget: docs/betrieb.md.
 *
 * ## Vanished stations
 *
 * Every run sees each system's COMPLETE `station_information`. Many stations
 * are ephemeral — free-floating "virtual stations" that get a new id per
 * parking event — so the ids of each system's list are kept
 * ({@link SYSTEM_IDS}), and an id missing from its system's list in two
 * consecutive runs is deleted ({@link diffSystems}): about two hours after it
 * vanished instead of the 24 h of the age-based prune. Never on a failed or
 * empty feed (that breaks "consecutive" for the whole system), at most half
 * of a system's previous stations per run, only ids of that system's own
 * scheme, and through `ctx.prune.remove` (master data plausible, signatures
 * out of the store first). The age-based prune stays as the safety net.
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
 *  * Feed URLs from the system list are fetched only under the URL policy of
 *    src/connectors/gbfs.ts (https, no private IP literal, no internal host
 *    name, the same for every redirect hop); refused feeds are skipped and
 *    counted in one `[warn]` per run. The old nodes fetched them as given.
 *  * Log texts are English.
 */

import { mergePlans } from "../kernel/change-gate.js";
import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import {
  isArray,
  isEntityId,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  looseNumber,
  ParseError,
  requireRecord,
} from "../kernel/parse.js";
import {
  addTotals,
  applySplit,
  dynamicSignature,
  emptyTotals,
  pointOf,
  propertyValue,
  reportSplit,
  staticSignatureOf,
} from "../kernel/split-gate.js";
import type { SplitResult, SplitTotals } from "../kernel/split-gate.js";
import { persisted, stateKey } from "../kernel/state.js";
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
import {
  FEED_FETCH,
  feedAllowed,
  feedUrl,
  parseSystems,
  SkippedFeeds,
  SYSTEMS_URL,
  systemKey,
} from "./gbfs.js";
import type { GbfsSystem } from "./gbfs.js";

export const ID = "carsharing-bw";

/** Gate tables, keyed by entity id so the prunes can forget deleted stations. */
export const STATIC_KEY = "csStatic";
export const LIVE_KEY = "csLive";
/** The single table of the plain gate before the split; dropped by every run. */
export const LEGACY_GATE = "csSig";
export const PROVIDER = "MobiData BW GBFS";
const HOUR_MS = 3_600_000;
const STATION_PATTERN = "^urn:ngsi-ld:CarSharingStation:[A-Za-z0-9_-]+$";
/** The measured attribute of a station. */
export const LIVE_ATTRIBUTES = ["availableVehicles"] as const;
/** A system may lose at most this share of its previous stations per run to the per-system diff. */
export const SYSTEM_DIFF_CAP = 0.5;

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
      id: stationEntityId(info.slug, sys, station.stationId),
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

/** Entity id of a station: official municipality slug, system key, the provider's station id. */
export function stationEntityId(
  slug: string,
  system: string,
  stationId: string,
): `urn:ngsi-ld:CarSharingStation:${string}` {
  return `urn:ngsi-ld:CarSharingStation:${slug}-${system}-${stationId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/** The anchored id scheme of ONE system's stations — what the per-system diff may delete. */
export function systemPattern(system: string): string {
  const escaped = system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^urn:ngsi-ld:CarSharingStation:[A-Za-z0-9_-]+-${escaped}-[A-Za-z0-9_-]+$`;
}

/**
 * Master data of a station — also of one as the broker returns it (seeding),
 * hence over a plain record; `null` when an attribute is missing there. Only
 * the vehicle count is measured; everything here is master data.
 */
export function stationStatic(entity: Readonly<Record<string, unknown>>): string | null {
  return staticSignatureOf([
    propertyValue(entity, "ags"),
    propertyValue(entity, "name"),
    propertyValue(entity, "operator"),
    propertyValue(entity, "vehicleType"),
    propertyValue(entity, "capacity"),
    propertyValue(entity, "dataProvider"),
    pointOf(entity),
  ]);
}

/** Seeds both tables from the broker when they are empty — see the module header. */
export const SEED: SeedOptions = {
  label: "Carsharing",
  queries: [{ type: "CarSharingStation", pattern: STATION_PATTERN }],
  attrs: [
    "ags",
    "name",
    "operator",
    "vehicleType",
    "capacity",
    "dataProvider",
    "location",
    ...LIVE_ATTRIBUTES,
  ],
  accept: (id, entity) => ownGbfs(id, entity),
  tables: {
    [STATIC_KEY]: stationStatic,
    [LIVE_KEY]: (entity) =>
      stationStatic(entity) === null ? null : dynamicSignature(entity, LIVE_ATTRIBUTES),
  },
};

/** The ids of each system's last complete station list (and those still waiting for their deletion). */
export const SYSTEM_IDS = stateKey(
  "csSystemIds",
  () => new Map<string, readonly string[]>(),
  persisted.stringListMap,
);

/** Ids missing from their system's complete list: in how many consecutive runs. */
export const MISSING_RUNS = stateKey("csMissingRuns", () => new Map<string, number>(), persisted.numberMap);

export interface SystemDiff {
  /** Per system: ids missing from its complete list in two consecutive runs, within the cap. */
  readonly remove: ReadonlyMap<string, readonly EntityId[]>;
  /** Systems over the cap in this run: `[system, would-be deletions, previous stations]`. */
  readonly capped: readonly (readonly [system: string, gone: number, previous: number])[];
  /** Next {@link SYSTEM_IDS}; ids in `remove` stay until the broker confirms their deletion. */
  readonly known: Map<string, readonly string[]>;
  /** Next {@link MISSING_RUNS}. */
  readonly missing: Map<string, number>;
}

/**
 * The per-system diff (module header, "Vanished stations"). Pure. `lists`
 * holds every system of this run: its complete list of entity ids, or `null`
 * when its feed failed or listed no station in BW — then nothing of that
 * system counts as missing, and its streaks start over.
 */
export function diffSystems(
  known: ReadonlyMap<string, readonly string[]>,
  missing: ReadonlyMap<string, number>,
  lists: ReadonlyMap<string, readonly string[] | null>,
): SystemDiff {
  const nextKnown = new Map(known);
  const nextMissing = new Map(missing);
  const remove = new Map<string, EntityId[]>();
  const capped: (readonly [string, number, number])[] = [];
  const restart = (ids: readonly string[]): void => {
    for (const id of ids) nextMissing.delete(id);
  };
  // A system that is not in this run's list was not looked at: no streak goes
  // on, and its ids are forgotten (should it return, its list is recorded
  // anew; the age-based prune takes care of what it left behind).
  for (const [system, ids] of known) {
    if (lists.has(system)) continue;
    restart(ids);
    nextKnown.delete(system);
  }
  for (const [system, list] of lists) {
    const previous = known.get(system) ?? [];
    if (list === null) {
      restart(previous);
      continue;
    }
    restart(list);
    const current = new Set(list);
    const own = new RegExp(systemPattern(system));
    const gone = previous.filter((id) => !current.has(id) && own.test(id));
    const confirmed: EntityId[] = [];
    for (const id of gone) {
      const runs = (missing.get(id) ?? 0) + 1;
      nextMissing.set(id, runs);
      if (runs >= 2 && isEntityId(id)) confirmed.push(id);
    }
    nextKnown.set(system, [...list, ...gone]);
    if (confirmed.length === 0) continue;
    if (confirmed.length > previous.length * SYSTEM_DIFF_CAP) {
      capped.push([system, confirmed.length, previous.length]);
      continue;
    }
    remove.set(system, confirmed);
  }
  return { remove, capped, known: nextKnown, missing: nextMissing };
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
async function feedBody(ctx: Ctx, url: string, skipped: SkippedFeeds): Promise<unknown> {
  if (!feedAllowed(url)) {
    skipped.note(url);
    return null;
  }
  try {
    const response = await ctx.fetch.json(url, FEED_FETCH);
    return response.status >= 400 ? null : response.body;
  } catch (error) {
    skipped.noteRefusal(error);
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

/**
 * Master data of one system. Returns the entity ids of its complete station
 * list in BW, or `null` when the feed failed or listed no station in BW.
 */
async function masterData(
  ctx: Ctx,
  system: GbfsSystem,
  skipped: SkippedFeeds,
): Promise<readonly string[] | null> {
  let ids: readonly string[] | null = null;
  const infoBody = await feedBody(ctx, feedUrl(system, "station_information"), skipped);
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
        ids = entries.map(([key, entry]) =>
          stationEntityId(entry.slug, info.system, key.slice(info.system.length + 2)),
        );
      }
    }
  }
  const typesBody = await feedBody(ctx, feedUrl(system, "vehicle_types"), skipped);
  const types = quietly(() => formFactorOf({ system: system.id, payload: typesBody }));
  if (types !== null && types.formFactor !== null) {
    ctx.state.slot(FORM_FACTORS).get().set(types.system, types.formFactor);
  }
  return ids;
}

/** Deletes what {@link diffSystems} found gone, and keeps its lists. */
async function removeVanished(ctx: Ctx, lists: ReadonlyMap<string, readonly string[] | null>): Promise<void> {
  const knownSlot = ctx.state.slot(SYSTEM_IDS);
  const missingSlot = ctx.state.slot(MISSING_RUNS);
  const diff = diffSystems(knownSlot.get(), missingSlot.get(), lists);
  for (const [system, gone, previous] of diff.capped) {
    ctx.log.warn(
      `Carsharing ${system}: ${String(gone)} of ${String(previous)} stations missing from the station ` +
        "list in two runs — over the per-system cap, not deleted here (the age-based prune decides)",
    );
  }
  for (const [system, ids] of diff.remove) {
    const result = await ctx.prune.remove({
      label: `Carsharing ${system}: vanished stations`,
      pattern: systemPattern(system),
      ids,
      signatureKeys: [STATIC_KEY, LIVE_KEY],
    });
    if (result.deleted.size === 0) continue;
    diff.known.set(
      system,
      (diff.known.get(system) ?? []).filter((id) => !(isEntityId(id) && result.deleted.has(id))),
    );
    for (const id of result.deleted) diff.missing.delete(id);
  }
  knownSlot.set(diff.known);
  missingSlot.set(diff.missing);
}

/**
 * The stations of one system through the split gate — merge mode: this call
 * sees one system only — plus its fleets, ungated.
 */
export function planStatus(
  gate: ChangeGate,
  built: StatusBuild,
  nowMs: number,
): {
  readonly plan: UpsertPlan;
  readonly stations: SplitResult;
} {
  const stations = applySplit(
    gate,
    built.stations,
    {
      staticKey: STATIC_KEY,
      dynamicKey: LIVE_KEY,
      staticSignature: (entity) => stationStatic(entity) ?? "",
      dynamic: LIVE_ATTRIBUTES,
      replace: false,
      freshEvery: 3,
      periodMs: HOUR_MS,
    },
    nowMs,
  );
  return { plan: mergePlans(stations, gate.ungated(built.fleets)), stations };
}

async function status(
  ctx: Ctx,
  cache: StationCache,
  system: GbfsSystem,
  skipped: SkippedFeeds,
  totals: SplitTotals,
): Promise<void> {
  const body = await feedBody(ctx, feedUrl(system, "station_status"), skipped);
  const feed = quietly(() => parseStatus({ system: system.id, payload: body }));
  if (feed === null) return;
  const now = ctx.now();
  const built = buildStatus(feed, cache, ctx.state.slot(FORM_FACTORS).get(), now);
  const { plan, stations } = planStatus(ctx.gate, built, Date.parse(now));
  addTotals(totals, stations);
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
  const skipped = new SkippedFeeds();
  const lists = new Map<string, readonly string[] | null>();
  for (const system of systems) lists.set(systemKey(system.id), await masterData(ctx, system, skipped));

  const cache = ctx.state.slot(STATIONS).get();
  if (cache === null) {
    skipped.report(ctx.log, "Carsharing");
    ctx.log.warn("Carsharing: master data not loaded yet — run skipped");
    return;
  }

  // Stations gone from their system's complete list in two runs.
  await removeVanished(ctx, lists);

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
    signatureKey: STATIC_KEY,
    signatureKeys: [LIVE_KEY],
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

  // Empty tables are seeded from the broker first; the former single table goes.
  await ctx.orion.seedSignatures(SEED);
  ctx.gate.retain(LEGACY_GATE, () => false);
  const storedBefore = ctx.gate.table(STATIC_KEY).size;
  const totals = emptyTotals();
  for (const system of systems) await status(ctx, cache, system, skipped, totals);
  // Judged against the tables as the run found them, not as the systems
  // before in this run filled them.
  totals.known = storedBefore > 0 && storedBefore * 2 >= totals.total;
  reportSplit(ctx.log, "Carsharing CarSharingStation", totals);
  skipped.report(ctx.log, "Carsharing");
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<StationInfoFeed, readonly (readonly [string, StationInfo])[]> = {
  id: ID,
  parse,
  build,
  run,
};
