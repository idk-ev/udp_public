/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `troe-retention` — deletes TRoE time series older than 12 months (single
 * sites: 3 months) and fills the nightly per-type totals.
 *
 * Port of FN_TROE_RETENTION (`udp-rt-rt-fn`) from
 * scripts/generate-nodered-flows.py (docs/betrieb.md, Sprint 1.6). Only
 * `attributes`/`subattributes` are cut — they drive the volume; the small
 * `entities` table stays complete so Mintaka can reconstruct entity metadata.
 * Nothing is written to Orion: the old node's result went to a debug node.
 *
 * Every statement below is byte-identical to the old node's, in the same
 * order, on one connection with the same server-side limit (an aborted client
 * never leaves a query behind). The run is I/O from start to end; the pure
 * part is small — the wording of the warnings and the summary.
 *
 * The old node bound a JavaScript array to `$1::text[]`; so does the port
 * (`SqlParam` takes a string array), and node-postgres serialises it exactly
 * as it did for the old node.
 *
 * ## Deliberate deviations (decided with the data review; fixed in the port only)
 *
 * Two steps of the old node deleted live history every night:
 *
 *  * The old-scheme cleanup took EVERY `ParkingSite`/`BikeParking` whose id
 *    does not start with `parkapi-` — which includes the municipal B+R
 *    stations (slug-prefixed ids, own `dataProvider`) that parken-bw's Orion
 *    prune explicitly protects. Their whole TRoE history went, night after
 *    night. The port deletes only what is provably parken-bw's legacy: of the
 *    candidates, only ids that carried `dataProvider` =
 *    {@link LEGACY_PROVIDER} in a row written before the switch to
 *    `parkapi-` ids ({@link LEGACY_SWITCH}, 25.08.2026 01:28:11 UTC) — the
 *    same ownership rule as parken-bw's `legacyParkApi` (provider and
 *    creation before the switch), read from TRoE ({@link SQL_LEGACY_OWN_IDS}).
 *    If that check fails, the cleanup is skipped with a `[warn]`; the rest
 *    of the night runs.
 *  * The one-off `OffStreetParking` cleanup deleted every OffStreetParking
 *    row, whoever writes that type today. Dropped: its one intended run is
 *    long done, and every later run could only hit someone else's data.
 */

import { isFiniteNumber, ParseError, requireRecord, requireString } from "../kernel/parse.js";
import type {
  ConnectorModule,
  Ctx,
  DbQueryResult,
  DbSession,
  DbSessionOptions,
  GeoIndex,
  IsoTime,
  Log,
} from "../kernel/types.js";

export const ID = "troe-retention";

/** The old `pg.Client` settings: 30 min on the server, the client a little longer. */
export const SESSION: DbSessionOptions = {
  applicationName: "udp-troe-retention",
  statementTimeoutMs: 1_800_000,
  queryTimeoutMs: 1_900_000,
  connectionTimeoutMs: 10_000,
};

// ts indexes (idempotent): they carry the retention AND the 10-minute statistics queries.
export const SQL_INDEX_ATTRIBUTES_TS = "CREATE INDEX IF NOT EXISTS attributes_ts_idx ON attributes (ts)";
export const SQL_INDEX_SUBATTRIBUTES_TS =
  "CREATE INDEX IF NOT EXISTS subattributes_ts_idx ON subattributes (ts)";
// (entityid, ts) with text_pattern_ops: carries Mintaka's temporal queries per
// entity (a seq scan over the whole table before) and the LIKE tiers below.
export const SQL_INDEX_ATTRIBUTES_ENTITYID_TS =
  "CREATE INDEX IF NOT EXISTS attributes_entityid_ts_idx ON attributes (entityid text_pattern_ops, ts)";

export const SQL_DELETE_ATTRIBUTES_12M =
  "DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '12 months'";
export const SQL_DELETE_SUBATTRIBUTES_12M =
  "DELETE FROM subattributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '12 months'";

/**
 * Tiered: single sites (charging points, car sharing stations, citizen
 * sensors) drive the volume of the state-wide stage-3 roll-out but are never
 * evaluated over months — the dashboards show their current state on the map.
 * Aggregates per municipality keep the full 12 months; the history charts rest
 * on them.
 *
 * ParkingSite was in here until Sprint 2.9, while the connector still wrote
 * ~1.04 M rows/day. Since static and movement data are separated it is roughly
 * 6,000 — the tier saves nothing and even does harm: the static attributes of
 * a site are written exactly once, on first sight, and never again. Deleting
 * them after 3 months removes the only row there ever was, and it does not
 * grow back. The broker would stay correct (it holds the current state), but
 * the temporal API would have nothing left to deliver for parking sites.
 */
export const SQL_DELETE_SHORT_TIER =
  "DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '3 months' " +
  "AND (entityid LIKE 'urn:ngsi-ld:EVChargingStation:%' " +
  "  OR entityid LIKE 'urn:ngsi-ld:CarSharingStation:%' " +
  "  OR entityid LIKE 'urn:ngsi-ld:AirQualityObserved:bw-sensor-%')";

/**
 * Old-scheme remains of parken-bw: until Sprint 2.9 the entity id came from the
 * slugged site name, since then from the ParkAPI key (`parkapi-<id>`). The old
 * rows do not grow back — their entities are never written again — but since
 * ParkingSite left the 3-month tier they no longer age out on their own
 * either. On the reference cluster they were 23.8 M rows, 47 % of the table.
 *
 * The ids come from the SMALL entities table (101,000 rows there), not from a
 * LIKE over attributes: a `NOT LIKE` on 22 GB cannot use an index, the planner
 * picks a seq scan — every night, even long after there is nothing left to
 * do. With a concrete id list attributes_entityid_ts_idx applies (bitmap index
 * scan, measured 57 k instead of 2.9 M estimated cost). Idle, it costs a scan
 * over the small table instead of the large one.
 */
export const SQL_OLD_SCHEME_IDS =
  "SELECT DISTINCT id FROM entities" +
  " WHERE (id LIKE 'urn:ngsi-ld:ParkingSite:%' AND id NOT LIKE 'urn:ngsi-ld:ParkingSite:parkapi-%')" +
  "    OR (id LIKE 'urn:ngsi-ld:BikeParking:%' AND id NOT LIKE 'urn:ngsi-ld:BikeParking:parkapi-%')";

/** `dataProvider` of parken-bw (`PROVIDER` there). */
export const LEGACY_PROVIDER = "MobiData BW ParkAPI";

/** Switch of parken-bw to `parkapi-` ids (`LEGACY_MIGRATION_MS` there), as a TRoE timestamp (UTC). */
export const LEGACY_SWITCH = "2026-08-25 01:28:11";

/**
 * Which of the candidates are parken-bw's own legacy entities: a
 * `dataProvider` row with its provider value, written before the switch.
 * TRoE stores the attribute under its expanded name (hence the suffix match)
 * and a string value in `text`. Index: attributes_entityid_ts_idx
 * (`entityid = ANY`, `ts <`). Candidates whose rows are already gone cost an
 * index probe each.
 */
export const SQL_LEGACY_OWN_IDS =
  "SELECT DISTINCT entityid AS id FROM attributes" +
  " WHERE entityid = ANY($1::text[])" +
  `  AND ts < timestamp '${LEGACY_SWITCH}'` +
  "  AND id LIKE '%dataProvider' AND text = $2";

/** Candidates per ownership query. */
export const LEGACY_CHECK_BATCH = 500;

export const SQL_DELETE_BY_IDS = "DELETE FROM attributes WHERE entityid = ANY($1::text[])";

/**
 * Keep the batch small: on the reference cluster about 70,000 rows hung on ONE
 * site, so five ids per statement are already ~350,000 rows. The cap bounds
 * the night; the rest follows in the next one (five nights there). The
 * entities rows stay — they are small, carry the Mintaka metadata and make
 * this step idempotent on the next run.
 */
export const OLD_SCHEME_BATCH = 5;
export const OLD_SCHEME_CAP = 5_000_000;

/**
 * Totals per entity type for the 10-minute statistics (`troe-stats`). This is
 * the ONLY full scan of attributes — once a night, after the deletes, so it
 * counts what actually remains. Replaced atomically: readers see either
 * yesterday's or today's figures, and vanished types disappear.
 */
export const SQL_CREATE_TYPE_STATS =
  "CREATE TABLE IF NOT EXISTS udp_troe_type_stats (" +
  "typ text PRIMARY KEY, n bigint NOT NULL, e bigint NOT NULL, computed_at timestamptz NOT NULL)";
export const SQL_CLEAR_TYPE_STATS = "DELETE FROM udp_troe_type_stats";
export const SQL_FILL_TYPE_STATS =
  "INSERT INTO udp_troe_type_stats (typ, n, e, computed_at) " +
  "SELECT split_part(entityid, ':', 3), count(*), count(DISTINCT entityid), now() " +
  "FROM attributes GROUP BY 1";

/* ------------------------------------------------------------------ Pure part */

/** What a run deleted, as the old node reported it (`a`, `s`). */
export interface RetentionCounts {
  /** All attribute rows deleted: 12 months, short tier, old scheme. */
  readonly attributes: number;
  readonly subattributes: number;
}

/** The old node's `msg.payload`, which went to its debug node. */
export interface RetentionSummary {
  readonly deletedAttributes: number;
  readonly deletedSubattributes: number;
  readonly at: IsoTime;
}

function rowsOf(value: unknown, at: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new ParseError(at, "a whole, non-negative number of rows", value);
  }
  return value;
}

export function parse(raw: unknown): RetentionCounts {
  const counts = requireRecord(raw, "counts");
  return {
    attributes: rowsOf(counts.attributes, "counts.attributes"),
    subattributes: rowsOf(counts.subattributes, "counts.subattributes"),
  };
}

/** Pure: no network, no clock, no global state. */
export function build(counts: RetentionCounts, _geo: GeoIndex | null, now: IsoTime): RetentionSummary {
  return { deletedAttributes: counts.attributes, deletedSubattributes: counts.subattributes, at: now };
}

export function shortTierWarning(rows: number): string | null {
  return rows === 0 ? null : `Retention: ${String(rows)} rows of single sites removed (3-month tier)`;
}

export function oldSchemeWarning(rows: number, idsDone: number, idsTotal: number): string | null {
  if (rows === 0) return null;
  return (
    `Retention: ${String(rows)} rows of ${String(Math.min(idsDone, idsTotal))}/${String(idsTotal)} ` +
    `parking sites in the old id scheme removed` +
    (rows >= OLD_SCHEME_CAP ? " (cap reached, the rest follows tomorrow)" : "")
  );
}

/* ------------------------------------------------------------------ Run */

/**
 * `rowCount` of a DELETE. node-postgres always sets it for one; `null` would
 * only come from a statement without a count, and the old node's arithmetic
 * treated that as 0 (`a += null`).
 */
function deleted(result: DbQueryResult): number {
  return result.rowCount ?? 0;
}

/**
 * The candidates that are parken-bw's own legacy entities, in candidate order;
 * none (after a `[warn]`) when the check cannot be made — deleting on a
 * guess is what the old step did.
 */
async function legacyOwnIds(db: DbSession, candidates: readonly string[], log: Log): Promise<string[]> {
  const own = new Set<string>();
  try {
    for (let at = 0; at < candidates.length; at += LEGACY_CHECK_BATCH) {
      const batch = candidates.slice(at, at + LEGACY_CHECK_BATCH);
      const result = await db.query(SQL_LEGACY_OWN_IDS, [batch, LEGACY_PROVIDER]);
      result.rows.forEach((row, index) => own.add(requireString(row.id, `legacy ids[${String(index)}].id`)));
    }
  } catch (error) {
    log.warn(
      `Retention: ownership check of the old-scheme parking ids failed, cleanup skipped ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  }
  return candidates.filter((id) => own.has(id));
}

async function retain(db: DbSession, log: Log): Promise<RetentionCounts> {
  await db.query(SQL_INDEX_ATTRIBUTES_TS);
  await db.query(SQL_INDEX_SUBATTRIBUTES_TS);
  await db.query(SQL_INDEX_ATTRIBUTES_ENTITYID_TS);
  let attributes = deleted(await db.query(SQL_DELETE_ATTRIBUTES_12M));
  const subattributes = deleted(await db.query(SQL_DELETE_SUBATTRIBUTES_12M));

  // Each warning is logged the moment its step is done, as in the old node:
  // a later statement that fails must not swallow what was already deleted.
  const shortTier = deleted(await db.query(SQL_DELETE_SHORT_TIER));
  attributes += shortTier;
  const shortTierText = shortTierWarning(shortTier);
  if (shortTierText !== null) log.warn(shortTierText);

  const candidates = (await db.query(SQL_OLD_SCHEME_IDS)).rows.map((row, index) =>
    requireString(row.id, `old scheme ids[${String(index)}].id`),
  );
  const oldIds = await legacyOwnIds(db, candidates, log);
  let oldRows = 0;
  let oldIndex = 0;
  while (oldIndex < oldIds.length && oldRows < OLD_SCHEME_CAP) {
    const batch = oldIds.slice(oldIndex, oldIndex + OLD_SCHEME_BATCH);
    oldRows += deleted(await db.query(SQL_DELETE_BY_IDS, [batch]));
    oldIndex += OLD_SCHEME_BATCH;
  }
  const oldSchemeText = oldSchemeWarning(oldRows, oldIndex, oldIds.length);
  if (oldSchemeText !== null) log.warn(oldSchemeText);
  attributes += oldRows;

  await db.query(SQL_CREATE_TYPE_STATS);
  await db.query("BEGIN");
  try {
    await db.query(SQL_CLEAR_TYPE_STATS);
    await db.query(SQL_FILL_TYPE_STATS);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  return { attributes, subattributes };
}

export async function run(ctx: Ctx): Promise<void> {
  const counts = await ctx.db.session(SESSION, (db) => retain(db, ctx.log));
  const summary = build(parse(counts), null, ctx.now());
  const text =
    `deleted: ${String(summary.deletedAttributes)} attributes / ` +
    `${String(summary.deletedSubattributes)} subattributes`;
  ctx.log.status(text);
  // The old node sent this to a debug node; a daily line in the log is its equivalent.
  ctx.log.info(text);
}

export const connector: ConnectorModule<RetentionCounts, RetentionSummary> = {
  id: ID,
  parse,
  build,
  run,
};
