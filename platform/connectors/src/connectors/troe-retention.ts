/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `troe-retention` — deletes TRoE time series older than 12 months (single
 * sites: 3 months) and fills the nightly per-type totals.
 *
 * Port of FN_TROE_RETENTION (`udp-rt-rt-fn`) of the former Node-RED flow
 * generator (see git history; docs/betrieb.md, Sprint 1.6). Only
 * `attributes`/`subattributes` are cut — they drive the volume; the small
 * `entities` table stays complete so Mintaka can reconstruct entity metadata.
 * Nothing is written to Orion: the old node's result went to a debug node.
 *
 * The DELETEs and the nightly totals of the retention session ({@link SESSION})
 * are byte-identical to the old node's, in the same order, on one connection
 * with the same server-side limit (an aborted client never leaves a query
 * behind). The run is I/O from start to end; the pure part is small — the
 * wording of the warnings and the summary.
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
 *
 * ## Deliberate deviation: vacuum and analyse (the old node did neither)
 *
 * `attributes` is a plain table, tens of gigabytes with millions of inserts a
 * day in a state-wide installation. In a production installation it had
 * never been vacuumed or analysed: every CloudNativePG switchover (each chart
 * release) resets the table's statistics counters, and autovacuum on an
 * insert-mostly table this size only triggers after millions more inserts
 * (`autovacuum_vacuum_insert_scale_factor` defaults to 0.2). Without a vacuum
 * the visibility map stays empty, so index-only scans fetch every heap row
 * (millions for one day): `troe-stats`' 24 h aggregation outlasted its 50 s
 * statement timeout on every run. So the port
 *
 *  * first sets per-table autovacuum thresholds on `attributes` and
 *    `subattributes` ({@link AUTOVACUUM_SETTINGS}) — only where
 *    `pg_class.reloptions` differ, since the ALTER TABLE takes a (brief)
 *    lock — in a short session of its own ({@link TUNING_SESSION});
 *  * and after the night's work runs `VACUUM (ANALYZE)` on both tables in a
 *    long session of its own ({@link VACUUM_SESSION}, 45 min on the server),
 *    paced like autovacuum ({@link SQL_VACUUM_PACING}): VACUUM cannot run in
 *    a transaction block and can take many minutes on a large table. It runs
 *    only as the table owner (or a superuser); otherwise the server skips the
 *    table with a WARNING and reports success — that WARNING is passed on as
 *    a `[warn]`.
 *
 * Either failing is one `[warn]`; the night's deletes, totals and summary
 * stand.
 *
 * ## Deliberate deviation: never stall the broker's writes
 *
 * Orion-LD inserts into `attributes` around the clock. A statement of this
 * connector that QUEUES for a conflicting lock makes every later insert queue
 * behind it: `CREATE INDEX IF NOT EXISTS` takes its ShareLock before it
 * notices the index exists, and behind a running manual `VACUUM` (which does
 * not yield) or a DELETE of an earlier run whose client died (the server
 * keeps running it) it would hold up every NGSI-LD write for up to the
 * statement timeout. The old node did exactly that. The port
 *
 *  * runs the tuning and retention sessions with a short `lock_timeout`
 *    ({@link LOCK_TIMEOUT_MS}; the vacuum session, whose waiting blocks no
 *    insert, a longer one). A step whose lock is not granted in time is one
 *    `[warn]` and skipped; the night goes on with the next step;
 *  * creates an index only when it is missing ({@link SQL_PRESENT_INDEXES}) —
 *    on a normal night no CREATE INDEX is sent at all;
 *  * skips the whole night (one `[info]`) while another `udp-troe-retention*`
 *    session is still at work, or a VACUUM of `attributes`/`subattributes`
 *    that does not yield is running ({@link SQL_OVERLAP}). What the guard
 *    cannot see — the progress row of another database user's VACUUM hides
 *    its table — the lock timeout still catches.
 *
 * The scheduler does not fire this connector on service start (`"fireOnStart":
 * false` in the registry): its cron is its only trigger.
 */

import {
  isFiniteNumber,
  isRecord,
  ParseError,
  requireArray,
  requireRecord,
  requireString,
} from "../kernel/parse.js";
import type {
  ConnectorModule,
  Ctx,
  Db,
  DbQueryResult,
  DbSession,
  DbSessionOptions,
  GeoIndex,
  IsoTime,
  Log,
} from "../kernel/types.js";

export const ID = "troe-retention";

/**
 * How long a statement of the tuning and retention sessions may wait for a
 * lock before the server cancels it: Orion-LD's inserts queue behind any
 * statement that waits for a conflicting lock.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/** A VACUUM waiting for its lock blocks no insert; a minute is still the ceiling. */
export const VACUUM_LOCK_TIMEOUT_MS = 60_000;

/** SQLSTATE of a statement cancelled by `lock_timeout` (lock_not_available). */
export const LOCK_NOT_AVAILABLE = "55P03";

/** The old `pg.Client` settings — 30 min on the server, the client a little longer — plus the lock timeout. */
export const SESSION: DbSessionOptions = {
  applicationName: "udp-troe-retention",
  statementTimeoutMs: 1_800_000,
  queryTimeoutMs: 1_900_000,
  connectionTimeoutMs: 10_000,
  lockTimeoutMs: LOCK_TIMEOUT_MS,
};

/** The overlap guard, the autovacuum check and ALTER: small statements, a lock wait is cut short. */
export const TUNING_SESSION: DbSessionOptions = {
  applicationName: "udp-troe-retention-tuning",
  statementTimeoutMs: 60_000,
  queryTimeoutMs: 70_000,
  connectionTimeoutMs: 10_000,
  lockTimeoutMs: LOCK_TIMEOUT_MS,
};

/** VACUUM (ANALYZE) of a large table takes many minutes: 45 min on the server, the client a little longer. */
export const VACUUM_SESSION: DbSessionOptions = {
  applicationName: "udp-troe-retention-vacuum",
  statementTimeoutMs: 2_700_000,
  queryTimeoutMs: 2_820_000,
  connectionTimeoutMs: 10_000,
  lockTimeoutMs: VACUUM_LOCK_TIMEOUT_MS,
};

/**
 * Another retention session still at work (`active`, or holding a
 * transaction open — the server may still be running a statement whose
 * client is gone), and a VACUUM of the two tables that does not yield to lock
 * waiters: a manual one, or an anti-wraparound autovacuum. A regular
 * autovacuum is not counted — it cancels itself when it blocks someone. Rows
 * of other database users show neither state nor table; see the module
 * header.
 */
export const SQL_OVERLAP =
  "SELECT (SELECT count(*)::int FROM pg_stat_activity" +
  " WHERE application_name LIKE 'udp-troe-retention%' AND state <> 'idle' AND pid <> pg_backend_pid())" +
  " AS retention," +
  " (SELECT count(*)::int FROM pg_stat_progress_vacuum p LEFT JOIN pg_stat_activity a ON a.pid = p.pid" +
  " WHERE p.relid IN (to_regclass('attributes'), to_regclass('subattributes'))" +
  " AND (a.backend_type IS DISTINCT FROM 'autovacuum worker' OR a.query LIKE '%to prevent wraparound%'))" +
  " AS vacuum";

/** Autovacuum's own pacing (`autovacuum_vacuum_cost_delay`); a manual VACUUM runs unthrottled by default. */
export const SQL_VACUUM_PACING = "SET vacuum_cost_delay = '2ms'";

/** The tables the retention cuts — and therefore tunes and vacuums. */
export const VACUUMED_TABLES = ["attributes", "subattributes"] as const;
export type VacuumedTable = (typeof VACUUMED_TABLES)[number];

/**
 * Per-table autovacuum thresholds: vacuum and analyse after 1 % new or changed
 * rows instead of the defaults (20 % inserted / 10 % changed) — at today's
 * volume about daily, whatever a switchover did to the counters.
 */
export const AUTOVACUUM_SETTINGS = [
  ["autovacuum_vacuum_insert_scale_factor", 0.01],
  ["autovacuum_analyze_scale_factor", 0.01],
] as const;

/** A table's storage parameters (`text[]` of `name=value`, `NULL` when none are set). */
export const SQL_RELOPTIONS = "SELECT reloptions FROM pg_class WHERE oid = $1::regclass";

export function sqlAutovacuumTuning(table: VacuumedTable): string {
  const settings = AUTOVACUUM_SETTINGS.map(([name, value]) => `${name} = ${String(value)}`).join(", ");
  return `ALTER TABLE ${table} SET (${settings})`;
}

/** Sent on its own, outside any transaction block — VACUUM refuses to run in one. */
export function sqlVacuum(table: VacuumedTable): string {
  return `VACUUM (ANALYZE) ${table}`;
}

// ts indexes (idempotent): they carry the retention AND the 10-minute statistics queries.
export const SQL_INDEX_ATTRIBUTES_TS = "CREATE INDEX IF NOT EXISTS attributes_ts_idx ON attributes (ts)";
export const SQL_INDEX_SUBATTRIBUTES_TS =
  "CREATE INDEX IF NOT EXISTS subattributes_ts_idx ON subattributes (ts)";
// (entityid, ts) with text_pattern_ops: carries Mintaka's temporal queries per
// entity (a seq scan over the whole table before) and the LIKE tiers below.
export const SQL_INDEX_ATTRIBUTES_ENTITYID_TS =
  "CREATE INDEX IF NOT EXISTS attributes_entityid_ts_idx ON attributes (entityid text_pattern_ops, ts)";

/** The three indexes by name, in the order the old node created them. */
export const TROE_INDEXES = [
  ["attributes_ts_idx", SQL_INDEX_ATTRIBUTES_TS],
  ["subattributes_ts_idx", SQL_INDEX_SUBATTRIBUTES_TS],
  ["attributes_entityid_ts_idx", SQL_INDEX_ATTRIBUTES_ENTITYID_TS],
] as const;

/**
 * Which of the names exist, resolved as the CREATE INDEX resolves them (the
 * search path). A catalog read: it takes no lock on the tables, unlike
 * `CREATE INDEX IF NOT EXISTS`, which takes its ShareLock before it notices
 * the index is there.
 */
export const SQL_PRESENT_INDEXES =
  "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL";

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

/** `pg_class.reloptions` (`name=value` entries) as a map; `null` means none are set. */
export function parseReloptions(value: unknown, at: string): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  if (value === null) return options;
  requireArray(value, at).forEach((item, index) => {
    const entry = requireString(item, `${at}[${String(index)}]`);
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new ParseError(`${at}[${String(index)}]`, "a name=value entry", entry);
    options.set(entry.slice(0, eq), entry.slice(eq + 1));
  });
  return options;
}

/** Whether every {@link AUTOVACUUM_SETTINGS} value is already in place (compared as numbers). */
export function autovacuumTuned(options: ReadonlyMap<string, string>): boolean {
  return AUTOVACUUM_SETTINGS.every(([name, value]) => {
    const set = options.get(name);
    return set !== undefined && Number(set) === value;
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function tuningWarning(error: unknown): string {
  return `Retention: autovacuum thresholds could not be checked or set (${errorText(error)})`;
}

export function vacuumWarning(failures: readonly string[]): string {
  return `Retention: VACUUM (ANALYZE) failed, the night's deletes and totals stand (${failures.join("; ")})`;
}

/**
 * The server's WARNINGs during the VACUUMs. The usual one: the database user
 * does not own the table — PostgreSQL then skips it ("permission denied to
 * vacuum", before 16 "only table or database owner can vacuum it") and still
 * reports success.
 */
export function vacuumNoticeWarning(messages: readonly string[]): string {
  const notOwner = messages.some((text) => /permission denied to vacuum|owner can vacuum/.test(text));
  return (
    `Retention: the server warned during VACUUM (ANALYZE) (${messages.join("; ")})` +
    (notOwner ? " — VACUUM runs only as the table owner: TROE_DB_USER must own attributes/subattributes" : "")
  );
}

/** A step whose lock was not granted within {@link LOCK_TIMEOUT_MS}. */
export function lockWarning(step: string, error: unknown): string {
  return (
    `Retention: ${step} skipped, lock not granted within ${String(LOCK_TIMEOUT_MS / 1000)} s ` +
    `(${errorText(error)}) — the night goes on`
  );
}

/** Why the night is skipped, or `null` when nothing overlaps. */
export function overlapReason(retention: number, vacuum: number): string | null {
  if (retention > 0) {
    return `Retention skipped: ${String(retention)} other udp-troe-retention session(s) still at work`;
  }
  if (vacuum > 0) return "Retention skipped: a VACUUM of attributes/subattributes is running";
  return null;
}

/** A statement the server cancelled because its lock was not granted in time. */
export function isLockTimeout(error: unknown): boolean {
  return isRecord(error) && error.code === LOCK_NOT_AVAILABLE;
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

/**
 * One step of the retention session: a lock not granted in time is one
 * `[warn]` and `fallback`; every other error ends the night as before.
 */
async function lockStep<T>(log: Log, step: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isLockTimeout(error)) throw error;
    log.warn(lockWarning(step, error));
    return fallback;
  }
}

/** Creates the indexes that are missing; an existing one is never touched (see the module header). */
async function ensureIndexes(db: DbSession, log: Log): Promise<void> {
  const names = TROE_INDEXES.map(([name]) => name);
  const present = new Set(
    (await db.query(SQL_PRESENT_INDEXES, [names])).rows.map((row, index) =>
      requireString(row.name, `present indexes[${String(index)}].name`),
    ),
  );
  for (const [name, sql] of TROE_INDEXES) {
    if (present.has(name)) continue;
    await lockStep(log, `CREATE INDEX ${name}`, null, async () => {
      await db.query(sql);
      return null;
    });
  }
}

function deleteRows(db: DbSession, log: Log, step: string, sql: string): Promise<number> {
  return lockStep(log, step, 0, async () => deleted(await db.query(sql)));
}

async function retain(db: DbSession, log: Log): Promise<RetentionCounts> {
  await ensureIndexes(db, log);
  let attributes = await deleteRows(db, log, "12-month cut of attributes", SQL_DELETE_ATTRIBUTES_12M);
  const subattributes = await deleteRows(
    db,
    log,
    "12-month cut of subattributes",
    SQL_DELETE_SUBATTRIBUTES_12M,
  );

  // Each warning is logged the moment its step is done, as in the old node:
  // a later statement that fails must not swallow what was already deleted.
  const shortTier = await deleteRows(db, log, "3-month tier", SQL_DELETE_SHORT_TIER);
  attributes += shortTier;
  const shortTierText = shortTierWarning(shortTier);
  if (shortTierText !== null) log.warn(shortTierText);

  // A lock timeout stops the loop; what was deleted up to then is counted.
  const old = { ids: 0, rows: 0, done: 0 };
  await lockStep(log, "old-scheme cleanup", null, async () => {
    const candidates = (await db.query(SQL_OLD_SCHEME_IDS)).rows.map((row, index) =>
      requireString(row.id, `old scheme ids[${String(index)}].id`),
    );
    const oldIds = await legacyOwnIds(db, candidates, log);
    old.ids = oldIds.length;
    while (old.done < oldIds.length && old.rows < OLD_SCHEME_CAP) {
      const batch = oldIds.slice(old.done, old.done + OLD_SCHEME_BATCH);
      old.rows += deleted(await db.query(SQL_DELETE_BY_IDS, [batch]));
      old.done += OLD_SCHEME_BATCH;
    }
    return null;
  });
  const oldSchemeText = oldSchemeWarning(old.rows, old.done, old.ids);
  if (oldSchemeText !== null) log.warn(oldSchemeText);
  attributes += old.rows;

  // A lock timeout inside the transaction rolls it back: yesterday's totals stay.
  await lockStep(log, "nightly totals", null, async () => {
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
    return null;
  });
  return { attributes, subattributes };
}

/** `null` when the night may run; otherwise why it is skipped. */
async function overlap(db: DbSession): Promise<string | null> {
  const result = await db.query(SQL_OVERLAP);
  const [row] = result.rows;
  if (row === undefined || result.rows.length !== 1) {
    throw new ParseError("overlap check", "exactly one row", result.rows);
  }
  return overlapReason(rowsOf(row.retention, "overlap.retention"), rowsOf(row.vacuum, "overlap.vacuum"));
}

/** Sets {@link AUTOVACUUM_SETTINGS} where they are not in place yet; a failure is one `[warn]`. */
async function tuneAutovacuum(session: DbSession, log: Log): Promise<void> {
  try {
    for (const table of VACUUMED_TABLES) {
      const result = await session.query(SQL_RELOPTIONS, [table]);
      const [row] = result.rows;
      if (row === undefined || result.rows.length !== 1) {
        throw new ParseError(`reloptions of ${table}`, "exactly one pg_class row", result.rows);
      }
      if (!autovacuumTuned(parseReloptions(row.reloptions, `reloptions of ${table}`))) {
        await session.query(sqlAutovacuumTuning(table));
      }
    }
  } catch (error) {
    log.warn(tuningWarning(error));
  }
}

/**
 * One short session before the night: the overlap guard first — an error
 * there fails the run, a busy database skips it — then the autovacuum
 * thresholds.
 */
function prepare(db: Db, log: Log): Promise<string | null> {
  return db.session(TUNING_SESSION, async (session) => {
    const busy = await overlap(session);
    if (busy !== null) return busy;
    await tuneAutovacuum(session, log);
    return null;
  });
}

/**
 * `VACUUM (ANALYZE)` of both tables in a session of its own: no transaction
 * block, its own long timeouts, autovacuum's pacing. Each table is tried; all
 * failures together are one `[warn]`, the server's WARNINGs (a table the user
 * does not own is skipped with one) another — never a failed run.
 */
async function vacuum(db: Db, log: Log): Promise<void> {
  const failures: string[] = [];
  const warnings: string[] = [];
  try {
    await db.session(VACUUM_SESSION, async (session) => {
      await session.query(SQL_VACUUM_PACING);
      for (const table of VACUUMED_TABLES) {
        try {
          const result = await session.query(sqlVacuum(table));
          for (const notice of result.notices ?? []) {
            if (notice.severity === "WARNING") warnings.push(notice.message);
          }
        } catch (error) {
          failures.push(`${table}: ${errorText(error)}`);
        }
      }
    });
  } catch (error) {
    failures.push(errorText(error));
  }
  if (warnings.length > 0) log.warn(vacuumNoticeWarning(warnings));
  if (failures.length > 0) log.warn(vacuumWarning(failures));
}

export async function run(ctx: Ctx): Promise<void> {
  const busy = await prepare(ctx.db, ctx.log);
  if (busy !== null) {
    ctx.log.status("skipped – another run or a VACUUM is active");
    ctx.log.info(busy);
    return;
  }
  const counts = await ctx.db.session(SESSION, (db) => retain(db, ctx.log));
  const summary = build(parse(counts), null, ctx.now());
  const text =
    `deleted: ${String(summary.deletedAttributes)} attributes / ` +
    `${String(summary.deletedSubattributes)} subattributes`;
  ctx.log.status(text);
  // The old node sent this to a debug node; a daily line in the log is its equivalent.
  ctx.log.info(text);
  // Only after a successful night: a failed one has thrown above, as the old node's did.
  await vacuum(ctx.db, ctx.log);
}

export const connector: ConnectorModule<RetentionCounts, RetentionSummary> = {
  id: ID,
  parse,
  build,
  run,
};
