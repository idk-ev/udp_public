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
 * vehicles and their positions (rounded to ~1 m, at most 400 per
 * municipality so the entity does not bloat in the big cities).
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
 *  * Log texts are English.
 */

import { isArray, isRecord, isTruthy, ParseError, requireRecord } from "../kernel/parse.js";
import { observed } from "../kernel/ngsi.js";
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
import { feedUrl, parseSystems, SYSTEMS_URL, systemKey } from "./gbfs.js";

export const ID = "sharing-bw";

/** Prefix of the per-system zero tables, unchanged from the flow context. */
export const LAST_PREFIX = "ffLast:";
/** Positions kept per municipality and system. */
const MAX_POSITIONS = 400;
const HOUR_MS = 3_600_000;

/** One vehicle: position, and whether it can be rented (not disabled, not reserved). */
export type Vehicle = readonly [lat: number, lon: number, available: boolean];

/** One system's `free_bike_status`, narrowed. */
export interface FreeBikeFeed {
  /** {@link systemKey} of the system id. */
  readonly system: string;
  readonly vehicles: readonly Vehicle[];
  /**
   * `msg.payload.data.bikes.length` — every entry, disabled or not. Zero means
   * the provider is taken to be down, not that all vehicles are gone.
   */
  readonly reported: number;
}

export interface SharingSummaryEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:SharingSummary:bw-${string}`;
  readonly type: "SharingSummary";
  readonly ags: Property<string>;
  readonly system: Property<string>;
  readonly availableVehicles: Property<number>;
  readonly vehiclePositions: Property<JsonValue>;
  readonly "@context": string;
}

/**
 * The message the old build node got: `{ system, payload }`, `payload` the
 * `free_bike_status` body. Throws {@link ParseError} where the old node
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
  for (const bike of bikes) {
    if (!isRecord(bike)) continue;
    vehicles.push([
      Number(bike.lat),
      Number(bike.lon),
      !isTruthy(bike.is_disabled) && !isTruthy(bike.is_reserved),
    ]);
  }
  return { system: systemKey(system), vehicles, reported: bikes.length };
}

function summary(
  feed: FreeBikeFeed,
  ags: Ags,
  count: number,
  positions: readonly (readonly [number, number])[],
  now: IsoTime,
): SharingSummaryEntity {
  return {
    id: `urn:ngsi-ld:SharingSummary:bw-${ags}-ff-${feed.system}`,
    type: "SharingSummary",
    ags: { type: "Property", value: ags },
    system: { type: "Property", value: feed.system },
    availableVehicles: observed(count, "C62", now),
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
  const positions = new Map<Ags, (readonly [number, number])[]>();
  for (const [lat, lon, available] of feed.vehicles) {
    if (!available) continue;
    const municipality = geo?.municipalityAt(lat, lon) ?? null;
    if (municipality === null) continue;
    const ags = municipality[0];
    counts.set(ags, (counts.get(ags) ?? 0) + 1);
    let list = positions.get(ags);
    if (list === undefined) {
      list = [];
      positions.set(ags, list);
    }
    if (list.length < MAX_POSITIONS) list.push([Number(lat.toFixed(5)), Number(lon.toFixed(5))]);
  }
  return [...counts].map(([ags, count]) => summary(feed, ags, count, positions.get(ags) ?? [], now));
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
      entities.push(summary(feed, ags, 0, [], now));
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

async function runSystem(ctx: Ctx, system: string, url: string): Promise<void> {
  let body: unknown;
  try {
    const response = await ctx.fetch.json(url);
    // `msg.statusCode >= 400 || !msg.payload …` -> return null, no warning.
    if (response.status >= 400) return;
    body = response.body;
  } catch {
    // The http request node handed a transport error on as a string payload,
    // which failed the same check silently.
    return;
  }
  let feed: FreeBikeFeed;
  try {
    feed = parse({ system, payload: body });
  } catch (error) {
    if (error instanceof ParseError) return;
    throw error;
  }
  // Checked per system run, as the old build node did.
  const geo = ctx.geo.forRun("GBFS-BW");
  if (geo === null) return;
  const now = ctx.now();
  const plan = planSystem(feed, build(feed, geo, now), ctx.gate.table(lastKey(feed.system)), geo, now);
  if (plan.entities.length === 0) return;
  // One request per system, as the single message of the old node.
  await ctx.orion.upsert(plan, { chunkSize: plan.entities.length });
}

export async function run(ctx: Ctx): Promise<void> {
  let systems: ReturnType<typeof parseSystems> = null;
  try {
    const response = await ctx.fetch.json(SYSTEMS_URL);
    if (response.status < 400) systems = parseSystems(response.body);
  } catch {
    systems = null;
  }
  if (systems === null) {
    ctx.log.warn("GBFS-BW: system list not loadable");
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
  await ctx.prune.stale({
    label: "GBFS-BW",
    type: "SharingSummary",
    pattern: "^urn:ngsi-ld:SharingSummary:bw-[0-9]{8}-ff-[A-Za-z0-9_-]+$",
    attrs: ["ags", "availableVehicles"],
    graceMs: 24 * HOUR_MS,
    liveMs: 3 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
    status,
  });

  for (const system of systems) {
    await runSystem(ctx, system.id, feedUrl(system, "free_bike_status"));
  }
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<FreeBikeFeed, readonly SharingSummaryEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
