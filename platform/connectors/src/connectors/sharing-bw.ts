/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `sharing-bw` — free-floating sharing vehicles per municipality and system
 * (GBFS `free_bike_status`, MobiData BW).
 *
 * Port of the system list node (`udp-rt-bg-msgs`), the per-system build node
 * FN_GBFS_FF (`udp-rt-bg-fn`) and the signature commit behind its upsert
 * (`udp-rt-bg-commit`, now inside `Orion.upsert`). Writes one
 * `SharingSummary` per municipality and system: the number of available
 * vehicles, the same number split by form factor, and their positions
 * (rounded to ~1 m, at most 400 per municipality so the entity does not
 * bloat in the big cities).
 *
 * ## Form factors and docked vehicles
 *
 * `free_bike_status` mixes vehicle kinds (one system lists mopeds, e-scooters
 * and bikes) and, for station-based systems like RegioRad or nextbike, also
 * lists the bikes standing in a station. So:
 *
 *  * A vehicle with a `station_id` is docked. In a system whose prevailing
 *    form factor is `bicycle`, `cargo_bicycle` or `car` ({@link STATION_SIDE})
 *    it is not counted here: `carsharing-bw` counts it per station, and the
 *    municipality page shows those fleets as "Leihräder" / "Carsharing". In
 *    any other system (e-scooters parked at a virtual station) it stays in,
 *    or it would be counted nowhere. `reported` counts every entry (outage
 *    detection only).
 *  * Each counted vehicle gets a form factor from the system's
 *    `vehicle_types` feed (by `vehicle_type_id`); without one, the prevailing
 *    form factor of the system; without that, `other`. GBFS 2.x `scooter` and
 *    3.x `scooter_standing` are one key. The split is written as
 *    `vehiclesByFormFactor` ({@link FORM_FACTORS}, all keys, zeros included);
 *    `availableVehicles` stays the total. One attribute more per write, i.e.
 *    one TRoE row more per summary and run.
 *  * `vehicle_types` is fetched only for a system with vehicles in BW and
 *    kept per process for {@link TYPES_MAX_AGE_MS} ({@link VEHICLE_TYPES}).
 *    An empty or failed answer, or a type id missing from the kept list,
 *    fetches it again after {@link TYPES_RETRY_MS} at the earliest; a failed
 *    fetch keeps the old list. Without any list the vehicles count as
 *    `other`.
 *
 * ## Strict geo
 *
 * Every vehicle is assigned by the strict lookup — polygon or nothing:
 *
 *   > Strict lookup: vehicles of Basel, Kaiserslautern or Swiss systems are no
 *   > longer counted in the nearest BW municipality.
 *
 * Without boundaries every system run is skipped with a warning, as before.
 *
 * ## The zero tables `ffLast:<system>`
 *
 * No change gate here: every summary a system run produces is written in full
 * each hour. What the connector does keep is one table per system, AGS ->
 * vehicle count at the last CONFIRMED write:
 *
 *   > Municipalities this system had vehicles in at the last confirmed write
 *   > but not now: write 0 (and no positions) once, instead of showing the old
 *   > count until the 24 h prune removes the summary. […] A feed without any
 *   > vehicle at all is taken as an outage of the provider, not as "all gone":
 *   > no zeros then.
 *
 * The table entries ride on the upsert as pending signatures; a confirmed zero
 * is committed as `null`, which REMOVES the entry, so the zero goes out once.
 * Tables of systems that left the list are dropped at the start of a run
 * (`ctx.gate.keys()` + `ctx.gate.retain(key, () => false)`), so they neither
 * grow nor zero a returning system's old municipalities.
 *
 * ## Prune
 *
 * The per-system runs never see the complete inventory, so the summaries are
 * pruned by age: one not refreshed for 24 h (24 hourly runs) is no longer
 * confirmed — the system left the list, or its vehicles are outside BW and
 * were assigned to a border municipality before the strict lookup. Skipped if
 * no summary at all was written within 3 h (connector down).
 *
 * ## Deliberate deviations
 *
 *  * The systems run one after the other (fetch, build, upsert), paced by the
 *    fetcher's 1 request/s — the old flow fanned them out through a delay node
 *    and upserted each as its answer came in. Same requests, same writes.
 *  * The prune is awaited before the systems; the old node started it
 *    fire-and-forget alongside the fan-out. It keeps nothing of this run
 *    (`graceMs`), so the order does not change what it deletes.
 *  * A vehicle whose `lat`/`lon` is a numeric STRING is placed by
 *    `Number(…)`; the old node assigned it the same way and then threw on
 *    `b.lat.toFixed`, losing the whole system's run. A vehicle that is not an
 *    object is skipped (old: TypeError). Neither occurs in GBFS 2.x.
 *  * Docked vehicles of station-based systems are no longer counted, and every summary
 *    carries `vehiclesByFormFactor` (see above). The old node counted every
 *    rentable vehicle as one number.
 *  * Feed URLs from the system list are fetched only under the URL policy of
 *    src/connectors/gbfs.ts (https, no private IP literal, no internal host
 *    name, the same for every redirect hop); refused feeds are skipped and
 *    counted in one `[warn]` per run. The old node fetched them as given.
 *  * Systems matching the registry's `excludeSystems` (licence terms, see
 *    src/connectors/gbfs.ts) are dropped from the list before the run: never
 *    fetched, their zero tables dropped, their summaries removed by the
 *    age-based prune after 24 h like those of a system that left the list.
 *  * Log texts are English.
 */

import { isArray, isRecord, isString, isTruthy, ParseError, requireRecord } from "../kernel/parse.js";
import { observed } from "../kernel/ngsi.js";
import { stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  JsonValue,
  NgsiEntity,
  PendingSignature,
  Property,
  SignatureValue,
  UpsertPlan,
} from "../kernel/types.js";
import type { GbfsSystem } from "./gbfs.js";
import {
  prevailingFormFactor,
  FEED_FETCH,
  feedAllowed,
  feedUrl,
  parseSystems,
  SkippedFeeds,
  SYSTEMS_URL,
  systemKey,
  withoutExcluded,
} from "./gbfs.js";

export const ID = "sharing-bw";

/** Prefix of the per-system zero tables, unchanged from the flow context. */
export const LAST_PREFIX = "ffLast:";
/** Positions kept per municipality and system. */
const MAX_POSITIONS = 400;
const HOUR_MS = 3_600_000;

/** Form factors of the split, in display order. GBFS `scooter` counts as `scooter_standing`. */
export const FORM_FACTORS = [
  "scooter_standing",
  "bicycle",
  "cargo_bicycle",
  "moped",
  "car",
  "other",
] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

/** Vehicles per form factor, every key present. */
export type FormFactorCounts = Readonly<Record<FormFactor, number>>;

/** A GBFS `form_factor` (2.x or 3.x) as a key of the split. */
export function formFactorKey(raw: unknown): FormFactor {
  switch (raw) {
    case "scooter":
    case "scooter_standing":
      return "scooter_standing";
    case "bicycle":
    case "cargo_bicycle":
    case "moped":
    case "car":
      return raw;
    default:
      return "other";
  }
}

/** A system's `vehicle_types`, narrowed: form factor per type id, and the most common one. */
export interface VehicleTypes {
  readonly byId: ReadonlyMap<string, FormFactor>;
  readonly prevailing: FormFactor | null;
}

export const NO_TYPES: VehicleTypes = { byId: new Map(), prevailing: null };

/** Lenient: entries without a string id are skipped; no list at all is {@link NO_TYPES}. */
export function parseVehicleTypes(raw: unknown): VehicleTypes {
  const data = isRecord(raw) ? raw.data : undefined;
  const types = isRecord(data) ? data.vehicle_types : undefined;
  if (!isArray(types)) return NO_TYPES;
  const byId = new Map<string, FormFactor>();
  for (const type of types) {
    if (!isRecord(type) || !isString(type.vehicle_type_id)) continue;
    byId.set(type.vehicle_type_id, formFactorKey(type.form_factor));
  }
  // Decided on the raw strings, as carsharing-bw decides its FleetStatus type,
  // then mapped: both agree on which docked vehicles the station side counts.
  const top = prevailingFormFactor(types);
  return { byId, prevailing: top === null ? null : formFactorKey(top) };
}

/** Form factors whose docked vehicles the station side counts (see the module header). */
export const STATION_SIDE: ReadonlySet<FormFactor> = new Set(["bicycle", "cargo_bicycle", "car"]);

/**
 * One vehicle: position, whether it can be rented (not disabled, not
 * reserved), its `vehicle_type_id` if it has one, and whether it carries a
 * `station_id`.
 */
export type Vehicle = readonly [
  lat: number,
  lon: number,
  available: boolean,
  typeId: string | null,
  docked: boolean,
];

/** One system's `free_bike_status`, narrowed. */
export interface FreeBikeFeed {
  /** {@link systemKey} of the system id. */
  readonly system: string;
  readonly vehicles: readonly Vehicle[];
  /**
   * `msg.payload.data.bikes.length` — every entry, disabled, reserved or
   * docked. Zero means the provider is taken to be down, not that all
   * vehicles are gone.
   */
  readonly reported: number;
  /** Entries with a `station_id`. */
  readonly docked: number;
  /** The system's `vehicle_types`; {@link NO_TYPES} unless the message carried them. */
  readonly types: VehicleTypes;
}

/** Form factor of one vehicle: by its type, else the system's prevailing one, else `other`. */
export function formFactorOf(vehicle: Vehicle, types: VehicleTypes): FormFactor {
  const typeId = vehicle[3];
  return (typeId === null ? undefined : types.byId.get(typeId)) ?? types.prevailing ?? "other";
}

export interface SharingSummaryEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:SharingSummary:bw-${string}`;
  readonly type: "SharingSummary";
  readonly ags: Property<string>;
  readonly system: Property<string>;
  readonly availableVehicles: Property<number>;
  readonly vehiclesByFormFactor: Property<FormFactorCounts>;
  readonly vehiclePositions: Property<JsonValue>;
  readonly "@context": string;
}

/**
 * The message the old build node got: `{ system, payload }`, `payload` the
 * `free_bike_status` body, plus an optional `vehicleTypes` (the body of the
 * system's `vehicle_types`). Throws {@link ParseError} where the old node
 * returned quietly (`!msg.payload.data || !Array.isArray(…bikes)`); `run`
 * skips such a system without a word, as it did.
 */
export function parse(raw: unknown): FreeBikeFeed {
  const message = requireRecord(raw, "message");
  const system = message.system;
  if (typeof system !== "string") throw new ParseError("message.system", "string", system);
  const data = isRecord(message.payload) ? message.payload.data : undefined;
  const bikes = isRecord(data) ? data.bikes : undefined;
  if (!isArray(bikes)) throw new ParseError("payload.data.bikes", "array", bikes);
  const vehicles: Vehicle[] = [];
  let docked = 0;
  for (const bike of bikes) {
    if (!isRecord(bike)) continue;
    const atStation = isTruthy(bike.station_id);
    if (atStation) docked += 1;
    vehicles.push([
      Number(bike.lat),
      Number(bike.lon),
      !isTruthy(bike.is_disabled) && !isTruthy(bike.is_reserved),
      isString(bike.vehicle_type_id) ? bike.vehicle_type_id : null,
      atStation,
    ]);
  }
  const types = message.vehicleTypes === undefined ? NO_TYPES : parseVehicleTypes(message.vehicleTypes);
  return { system: systemKey(system), vehicles, reported: bikes.length, docked, types };
}

function zeroCounts(): Record<FormFactor, number> {
  return { scooter_standing: 0, bicycle: 0, cargo_bicycle: 0, moped: 0, car: 0, other: 0 };
}

function summary(
  feed: FreeBikeFeed,
  ags: Ags,
  count: number,
  byForm: FormFactorCounts,
  positions: readonly (readonly [number, number])[],
  now: IsoTime,
): SharingSummaryEntity {
  return {
    id: `urn:ngsi-ld:SharingSummary:bw-${ags}-ff-${feed.system}`,
    type: "SharingSummary",
    ags: { type: "Property", value: ags },
    system: { type: "Property", value: feed.system },
    availableVehicles: observed(count, "C62", now),
    vehiclesByFormFactor: { type: "Property", value: byForm, observedAt: now },
    vehiclePositions: { type: "Property", value: positions },
    "@context": NGSI_CONTEXT,
  };
}

/**
 * The summaries of the municipalities the system has vehicles in. Pure; no
 * zeros — those need the system's table, see {@link planSystem}. `geo` null
 * (never in `run`, which skips first) assigns nothing.
 */
export function build(
  feed: FreeBikeFeed,
  geo: GeoIndex | null,
  now: IsoTime,
): readonly SharingSummaryEntity[] {
  const counts = new Map<Ags, number>();
  const byForm = new Map<Ags, Record<FormFactor, number>>();
  const positions = new Map<Ags, (readonly [number, number])[]>();
  const stationSide = feed.types.prevailing !== null && STATION_SIDE.has(feed.types.prevailing);
  for (const vehicle of feed.vehicles) {
    const [lat, lon, available, , docked] = vehicle;
    if (!available || (docked && stationSide)) continue;
    const municipality = geo?.municipalityAt(lat, lon) ?? null;
    if (municipality === null) continue;
    const ags = municipality[0];
    counts.set(ags, (counts.get(ags) ?? 0) + 1);
    let forms = byForm.get(ags);
    if (forms === undefined) {
      forms = zeroCounts();
      byForm.set(ags, forms);
    }
    forms[formFactorOf(vehicle, feed.types)] += 1;
    let list = positions.get(ags);
    if (list === undefined) {
      list = [];
      positions.set(ags, list);
    }
    if (list.length < MAX_POSITIONS) list.push([Number(lat.toFixed(5)), Number(lon.toFixed(5))]);
  }
  return [...counts].map(([ags, count]) =>
    summary(feed, ags, count, byForm.get(ags) ?? zeroCounts(), positions.get(ags) ?? [], now),
  );
}

/** The zero table of a system. */
export function lastKey(system: string): string {
  return `${LAST_PREFIX}${system}`;
}

/**
 * The write of one system run: the summaries of {@link build}, the confirmed
 * zeros for municipalities that lost all vehicles since the last confirmed
 * write, and the new table entries as pending signatures (count, or `null`
 * for a zero, which removes the entry once confirmed). Pure over a COPY of
 * the table.
 */
export function planSystem(
  feed: FreeBikeFeed,
  summaries: readonly SharingSummaryEntity[],
  last: ReadonlyMap<string, SignatureValue>,
  geo: GeoIndex | null,
  now: IsoTime,
): UpsertPlan {
  const entities: SharingSummaryEntity[] = [...summaries];
  const present = new Set(summaries.map((entity) => entity.ags.value));
  if (feed.reported > 0) {
    for (const [ags, count] of last) {
      if (present.has(ags) || !(typeof count === "number" && count > 0) || geo?.byAgs(ags) === undefined) {
        continue;
      }
      entities.push(summary(feed, ags, 0, zeroCounts(), [], now));
    }
  }
  const key = lastKey(feed.system);
  const pending: PendingSignature[] = entities.map((entity) => {
    const count = entity.availableVehicles.value;
    return [key, entity.ags.value, count > 0 ? count : null, entity.id];
  });
  return { entities, pending };
}

/**
 * Drops the zero tables of systems that left the list. Only when the list is
 * not empty — an empty list is an outage, not the end of every system.
 */
export function dropVanishedTables(ctx: Ctx, activeSystems: readonly string[]): void {
  if (activeSystems.length === 0) return;
  const active = new Set(activeSystems.map((system) => lastKey(systemKey(system))));
  for (const key of ctx.gate.keys()) {
    if (key.startsWith(LAST_PREFIX) && !active.has(key)) ctx.gate.retain(key, () => false);
  }
}

/** What one system's run wrote: summaries sent to the broker, of them zeroed ones. */
interface SystemResult {
  readonly written: number;
  readonly zeroed: number;
}

const NOTHING: SystemResult = { written: 0, zeroed: 0 };

/** How long a system's `vehicle_types` is kept before it is fetched again. */
export const TYPES_MAX_AGE_MS = 24 * HOUR_MS;
/** Earliest new fetch after an empty or failed answer, or for an unknown type id. */
export const TYPES_RETRY_MS = 6 * HOUR_MS;

/** A system's `vehicle_types` as last read, and when. */
export interface KeptTypes {
  readonly types: VehicleTypes;
  readonly fetchedMs: number;
  /** `false` after an empty or failed answer (the types then are the older ones, if any). */
  readonly complete: boolean;
}

/** Per system key: the last `vehicle_types` read. Process lifetime, not persisted. */
export const VEHICLE_TYPES = stateKey("shVehicleTypes", () => new Map<string, KeptTypes>());

/**
 * Whether kept types are missing or too old — or, after {@link TYPES_RETRY_MS},
 * empty or lacking a type id the feed uses.
 */
export function typesStale(kept: KeptTypes | undefined, feed: FreeBikeFeed, nowMs: number): boolean {
  if (kept === undefined) return true;
  const age = nowMs - kept.fetchedMs;
  if (age > TYPES_MAX_AGE_MS) return true;
  if (age <= TYPES_RETRY_MS) return false;
  if (!kept.complete || kept.types.byId.size === 0) return true;
  return feed.vehicles.some(([, , , typeId]) => typeId !== null && !kept.types.byId.has(typeId));
}

/** The system's form factors: kept ones while fresh, else fetched; an empty or failed fetch keeps the old ones. */
async function vehicleTypes(
  ctx: Ctx,
  system: GbfsSystem,
  feed: FreeBikeFeed,
  skipped: SkippedFeeds,
): Promise<VehicleTypes> {
  const kept = ctx.state.slot(VEHICLE_TYPES).get();
  const old = kept.get(feed.system);
  const nowMs = Date.parse(ctx.now());
  if (old !== undefined && !typesStale(old, feed, nowMs)) return old.types;
  const url = feedUrl(system, "vehicle_types");
  if (!feedAllowed(url)) {
    skipped.note(url);
    return old?.types ?? NO_TYPES;
  }
  let types = NO_TYPES;
  try {
    const response = await ctx.fetch.json(url, FEED_FETCH);
    if (response.status < 400) types = parseVehicleTypes(response.body);
  } catch (error) {
    skipped.noteRefusal(error);
  }
  // Kept even when empty or failed (then with the older types, if any), so it
  // is asked again after TYPES_RETRY_MS, neither every run nor only in a day.
  const complete = types.byId.size > 0;
  if (!complete && old !== undefined) types = old.types;
  kept.set(feed.system, { types, fetchedMs: nowMs, complete });
  return types;
}

async function runSystem(ctx: Ctx, system: GbfsSystem, skipped: SkippedFeeds): Promise<SystemResult> {
  const url = feedUrl(system, "free_bike_status");
  if (!feedAllowed(url)) {
    skipped.note(url);
    return NOTHING;
  }
  let body: unknown;
  try {
    const response = await ctx.fetch.json(url, FEED_FETCH);
    // `msg.statusCode >= 400 || !msg.payload …` -> return null, no warning.
    if (response.status >= 400) return NOTHING;
    body = response.body;
  } catch (error) {
    // The http request node handed a transport error on as a string payload,
    // which failed the same check silently. A redirect the URL policy
    // refused is counted instead.
    skipped.noteRefusal(error);
    return NOTHING;
  }
  let feed: FreeBikeFeed;
  try {
    feed = parse({ system: system.id, payload: body });
  } catch (error) {
    if (error instanceof ParseError) return NOTHING;
    throw error;
  }
  // Checked per system run, as the old build node did.
  const geo = ctx.geo.forRun("GBFS-BW");
  if (geo === null) return NOTHING;
  const now = ctx.now();
  let summaries = build(feed, geo, now);
  // Form factors only for a system with vehicles in BW: one request fewer for the others.
  if (summaries.length > 0) {
    feed = { ...feed, types: await vehicleTypes(ctx, system, feed, skipped) };
    summaries = build(feed, geo, now);
  }
  const plan = planSystem(feed, summaries, ctx.gate.table(lastKey(feed.system)), geo, now);
  if (plan.entities.length === 0) return NOTHING;
  // One request per system, as the single message of the old node.
  const result = await ctx.orion.upsert(plan, { chunkSize: plan.entities.length });
  // A zeroed summary is the one whose signature is removed (`null`, see planSystem).
  const zeroed = plan.pending.filter(([, , value]) => value === null).length;
  return { written: result.entities, zeroed: result.failedChunks === 0 ? zeroed : 0 };
}

export async function run(ctx: Ctx): Promise<void> {
  let listed: ReturnType<typeof parseSystems> = null;
  try {
    const response = await ctx.fetch.json(SYSTEMS_URL);
    if (response.status < 400) listed = parseSystems(response.body);
  } catch {
    listed = null;
  }
  if (listed === null) {
    ctx.log.warn("GBFS-BW: system list not loadable");
    return;
  }
  // Systems excluded by the registry (licence terms) count as not listed: no
  // request, no write, their zero tables go, and their summaries age out
  // through the prune below.
  const { kept: systems, excluded } = withoutExcluded(listed, ctx.entry.excludeSystems);
  if (systems.length === 0 && listed.length > 0) {
    ctx.log.warn("GBFS-BW: every listed system is excluded by the registry — nothing to do");
    return;
  }

  // Zero tables (FN_GBFS_FF) of systems that left the list are dropped.
  dropVanishedTables(
    ctx,
    systems.map((system) => system.id),
  );
  const status = `${String(systems.length)} systems`;
  ctx.log.status(status);

  // `if (PRUNE_OK) pruneStale(…)` — the plausibility check is inside stale().
  const pruned = await ctx.prune.stale({
    label: "GBFS-BW",
    type: "SharingSummary",
    pattern: "^urn:ngsi-ld:SharingSummary:bw-[0-9]{8}-ff-[A-Za-z0-9_-]+$",
    attrs: ["ags", "availableVehicles"],
    graceMs: 24 * HOUR_MS,
    liveMs: 3 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
    status,
  });

  const skipped = new SkippedFeeds();
  let written = 0;
  let zeroed = 0;
  for (const system of systems) {
    const result = await runSystem(ctx, system, skipped);
    written += result.written;
    zeroed += result.zeroed;
  }
  skipped.report(ctx.log, "GBFS-BW");
  // The one line that confirms a run in the log; the old node logged nothing.
  ctx.log.info(
    `GBFS-BW: ${String(systems.length)} systems` +
      (excluded.length > 0 ? ` (${String(excluded.length)} excluded by the registry)` : "") +
      `, ${String(written)} summaries written ` +
      `(${String(zeroed)} of them zeroed), prune: ` +
      (pruned.skipped === null ? `${String(pruned.deleted)} deleted` : `skipped (${pruned.skipped})`),
  );
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<FreeBikeFeed, readonly SharingSummaryEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
