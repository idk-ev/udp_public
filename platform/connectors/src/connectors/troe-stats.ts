/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `troe-stats` — TimescaleDB statistics as `PlatformStatus:udp-troe`, and the
 * row budget check.
 *
 * Port of FN_TROE (`udp-rt-db-fn`) from the former Node-RED flow generator (see git history). It
 * replaces the former Grafana datasource API: the main dashboard reads this
 * entity instead of speaking SQL itself (no public SQL path any more).
 *
 * ## The row budget — the standing safeguard
 *
 * After the ParkAPI incident of 24.08.2026 — one connector wrote ~1.04 M
 * rows/day for a month, half of the whole time-series database, without
 * anything raising an alarm — this is the standing safeguard: whoever exceeds
 * its expected daily volume (`rowBudget24h` in platform/config/connectors.json)
 * ends up in the log as a `[warn]`, which scripts/healthcheck.sh counts. Types
 * without a budget are only counted, never flagged. The migration plan
 * (docs/migration-konnektoren.md, risk "Zeilenbudget") says it must never be
 * switched off, not even briefly during the cutover.
 *
 * The generator summed the budgets of ALL registry entries (active or not) per
 * type and baked the sum into the node as `const BUDGET = {…}`. Here the same
 * sum is `ctx.rowBudget`, which the kernel computes with `sumRowBudgets()`
 * over the registry it loaded at startup (a registry that cannot be read
 * stops the service before any run, so the fuse cannot be silently off). The
 * warning text
 * is kept byte for byte, German included — it is the alarm operators know and
 * search for, and keeping it lets the parity test compare it verbatim.
 *
 * ## Staying cheap
 *
 * Runs every 10 minutes, so it must stay CHEAP: `attributes` has tens of
 * millions of rows and no hypertable. Only the last 24 h are scanned (range
 * over `attributes_ts_idx`); totals per type come from `udp_troe_type_stats`,
 * which the nightly `troe-retention` run fills with a single full scan.
 * Earlier versions counted the whole table here — each run took minutes, the
 * client timeout did not stop the server query, and the runs piled up until
 * TimescaleDB sat at its CPU limit around the clock. Hence the server-side
 * `statement_timeout` below the client's `query_timeout`, and the check for a
 * previous run that is still busy. The SQL below is byte-identical to the old
 * node's, and so is the application name the busy check looks for: it sees any
 * run still active on the server, including one whose client is gone.
 */

import {
  isFiniteNumber,
  isString,
  isTruthy,
  ParseError,
  requireArray,
  requireRecord,
  requireString,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  DbSession,
  DbSessionOptions,
  EntityType,
  GeoIndex,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
  RowBudget,
} from "../kernel/types.js";

export const ID = "troe-stats";

/**
 * The old `pg.Client` settings: `statement_timeout` cancels on the SERVER;
 * `query_timeout` only makes the client give up and would leave the query
 * running — so both, the server one shorter.
 */
export const SESSION: DbSessionOptions = {
  applicationName: "udp-troe-stats",
  statementTimeoutMs: 50_000,
  queryTimeoutMs: 60_000,
  connectionTimeoutMs: 10_000,
};

/** A previous run still busy (slow disk, restore, …): skip instead of stacking another scan on top of it. */
export const SQL_BUSY =
  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'udp-troe-stats' " +
  "AND state = 'active' AND pid <> pg_backend_pid()";

export const SQL_BASE =
  "SELECT pg_database_size('orion') AS db, " +
  // Planner estimate (refreshed by autovacuum/ANALYZE) instead of count(*).
  "(SELECT reltuples::bigint FROM pg_class WHERE oid = 'attributes'::regclass) AS rows, " +
  "(SELECT count(*) FROM attributes WHERE ts > (now() AT TIME ZONE 'utc') - interval '1 hour') AS r1";

/** ONE pass over the 24 h window feeds the hourly chart, the 24 h counts per type and the row budget check. */
export const SQL_WINDOW =
  "SELECT to_char(date_trunc('hour', ts), 'HH24') AS h, date_trunc('hour', ts) AS hs, " +
  "split_part(entityid, ':', 3) AS typ, count(*) AS n FROM attributes " +
  "WHERE ts > (now() AT TIME ZONE 'utc') - interval '24 hours' GROUP BY 1, 2, 3";

export const SQL_HAS_TOTALS = "SELECT to_regclass('udp_troe_type_stats') AS t";

export const SQL_TOTALS = "SELECT typ, n, e, computed_at FROM udp_troe_type_stats";

/** At most this many types in `rowsByType` (`.slice(0, 14)`). */
const MAX_TYPES = 14;

/* ------------------------------------------------------------------ Raw */

export interface BaseRow {
  /** `pg_database_size('orion')`, bytes. */
  readonly db: number;
  /** Planner estimate of `attributes`; -1 before the first ANALYZE. */
  readonly rows: number;
  /** Rows written in the last hour. */
  readonly r1: number;
}

/** One group of the 24 h window: hour × entity type. */
export interface WindowRow {
  /** `'HH24'` label of the hour. */
  readonly h: string;
  /** Start of the hour, epoch ms — the grouping and sort key. */
  readonly hourMs: number;
  /** Entity type, `split_part(entityid, ':', 3)`. */
  readonly typ: EntityType;
  readonly n: number;
}

/** One row of `udp_troe_type_stats`, written by the nightly retention run. */
export interface TotalRow {
  readonly typ: EntityType;
  readonly n: number;
  /** Distinct entities. */
  readonly e: number;
  readonly computedAtMs: number;
}

export interface TroeStatsInput {
  readonly base: BaseRow;
  readonly window: readonly WindowRow[];
  /** Empty when the nightly table does not exist yet. */
  readonly totals: readonly TotalRow[];
  /** Summed `rowBudget24h` of the registry — `ctx.rowBudget`. */
  readonly budget: RowBudget;
}

/**
 * A bigint column: node-postgres hands int8 over as a string, int4 as a
 * number. `Number(…)` as in the old node, but a value that is not a number at
 * all is malformed rather than NaN.
 */
function count(value: unknown, at: string): number {
  const parsed = isString(value) || isFiniteNumber(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new ParseError(at, "a number or a numeric string", value);
  return parsed;
}

/** A timestamp column — node-postgres hands it over as a `Date`. `new Date(x).getTime()` as in the old node. */
function epochMs(value: unknown, at: string): number {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : isString(value) || isFiniteNumber(value)
        ? new Date(value).getTime()
        : NaN;
  if (Number.isNaN(parsed)) throw new ParseError(at, "a timestamp", value);
  return parsed;
}

function parseBudget(raw: unknown): RowBudget {
  const record = requireRecord(raw, "budget");
  const budget: Record<EntityType, number> = {};
  for (const [type, rows] of Object.entries(record)) {
    if (!isFiniteNumber(rows) || !Number.isInteger(rows) || rows < 0) {
      throw new ParseError(`budget.${type}`, "a whole, non-negative number of rows", rows);
    }
    budget[type] = rows;
  }
  return budget;
}

/**
 * Narrows what {@link run} gathered: `{ base, window, totals }` as the query
 * rows came from the database, plus the summed `budget`.
 */
export function parse(raw: unknown): TroeStatsInput {
  const input = requireRecord(raw, "input");
  const base = requireRecord(input.base, "base");
  const window = requireArray(input.window, "window").map((item, index): WindowRow => {
    const at = `window[${String(index)}]`;
    const row = requireRecord(item, at);
    return {
      h: requireString(row.h, `${at}.h`),
      hourMs: epochMs(row.hs, `${at}.hs`),
      typ: requireString(row.typ, `${at}.typ`),
      n: count(row.n, `${at}.n`),
    };
  });
  const totals = requireArray(input.totals, "totals").map((item, index): TotalRow => {
    const at = `totals[${String(index)}]`;
    const row = requireRecord(item, at);
    return {
      typ: requireString(row.typ, `${at}.typ`),
      n: count(row.n, `${at}.n`),
      e: count(row.e, `${at}.e`),
      computedAtMs: epochMs(row.computed_at, `${at}.computed_at`),
    };
  });
  return {
    base: {
      db: count(base.db, "base.db"),
      rows: count(base.rows, "base.rows"),
      r1: count(base.r1, "base.r1"),
    },
    window,
    totals,
    budget: parseBudget(input.budget),
  };
}

/* ------------------------------------------------------------------ Build */

/** `[hour label, rows]`, oldest hour first. */
export type HourBucket = readonly [hour: string, rows: number];

/**
 * `[type, total rows, rows in 24 h, distinct entities]`. -1 marks "no nightly
 * figure yet" (new type, or before the first night) — NGSI-LD values cannot
 * carry null.
 */
export type TypeRow = readonly [type: EntityType, total: number, last24h: number, entities: number];

type Stat<T extends number | string | readonly HourBucket[] | readonly TypeRow[]> = Property<T> & {
  readonly observedAt: IsoTime;
};

export interface TroeStatusEntity extends NgsiEntity {
  readonly id: "urn:ngsi-ld:PlatformStatus:udp-troe";
  readonly type: "PlatformStatus";
  readonly name: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dbSizeBytes: Stat<number>;
  readonly troeRows: Stat<number>;
  readonly troeRows24h: Stat<number>;
  readonly troeRows1h: Stat<number>;
  readonly ingestByHour: Stat<readonly HourBucket[]>;
  readonly rowsByType: Stat<readonly TypeRow[]>;
  /** Omitted until the first retention run produced the nightly table. */
  readonly troeEntities?: Stat<number> | undefined;
  readonly rowsByTypeAsOf?: Stat<IsoTime> | undefined;
  readonly "@context": string;
}

export interface TroeStats {
  readonly entity: TroeStatusEntity;
  /** The `[warn]` line for types over budget, or `null`. */
  readonly budgetWarning: string | null;
}

/**
 * Budget of a type, own keys only: the old node looked up `BUDGET[t]` on an
 * object literal, where a type called `constructor` found a function and the
 * comparison `n > fn` was false — no own key, no budget, same outcome.
 */
function budgetOf(budget: RowBudget, type: EntityType): number | undefined {
  return Object.hasOwn(budget, type) ? budget[type] : undefined;
}

/**
 * The row budget check. `BUDGET[t] && n > BUDGET[t]` in the old node — a
 * budget of 0 is no budget. Order: first appearance of the type in the window.
 */
export function budgetWarning(last24h: ReadonlyMap<EntityType, number>, budget: RowBudget): string | null {
  const exceeded: string[] = [];
  for (const [type, rows] of last24h) {
    const max = budgetOf(budget, type);
    if (max === undefined || max === 0 || rows <= max) continue;
    exceeded.push(`${type}: ${String(rows)} statt max. ${String(max)}`);
  }
  // Verbatim, German included: see the module header.
  return exceeded.length === 0 ? null : `TRoE-Zeilenbudget (24 h) überschritten — ${exceeded.join(" · ")}`;
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(input: TroeStatsInput, _geo: GeoIndex | null, now: IsoTime): TroeStats {
  const byHour = new Map<number, HourBucket>();
  const last24h = new Map<EntityType, number>();
  let rows24h = 0;
  for (const row of input.window) {
    rows24h += row.n;
    byHour.set(row.hourMs, [row.h, (byHour.get(row.hourMs)?.[1] ?? 0) + row.n]);
    last24h.set(row.typ, (last24h.get(row.typ) ?? 0) + row.n);
  }
  const ingest = [...byHour.entries()].sort((x, y) => x[0] - y[0]).map((entry) => entry[1]);

  // Per type: totals from the nightly table, the 24 h count live. Types that
  // only exist on one side still show up.
  const totals = new Map(input.totals.map((row) => [row.typ, row]));
  const types = new Set([...totals.keys(), ...last24h.keys()]);
  const rowsByType = [...types]
    .map((type): TypeRow => {
      const total = totals.get(type);
      return [
        type,
        total === undefined ? -1 : total.n,
        last24h.get(type) ?? 0,
        total === undefined ? -1 : total.e,
      ];
    })
    .sort((x, y) => Math.max(y[1], y[2]) - Math.max(x[1], x[2]));
  const asOf =
    input.totals.length === 0
      ? null
      : new Date(Math.min(...input.totals.map((row) => row.computedAtMs))).toISOString();
  const entities = input.totals.length === 0 ? null : input.totals.reduce((sum, row) => sum + row.e, 0);

  const stat = <T extends number | string | readonly HourBucket[] | readonly TypeRow[]>(
    value: T,
  ): Stat<T> => ({
    type: "Property",
    value,
    observedAt: now,
  });
  const entity: TroeStatusEntity = {
    id: "urn:ngsi-ld:PlatformStatus:udp-troe",
    type: "PlatformStatus",
    // German on purpose: an attribute VALUE shown on the dashboard, not log text.
    name: { type: "Property", value: "TRoE-Statistiken (TimescaleDB)" },
    dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
    dbSizeBytes: stat(input.base.db),
    troeRows: stat(Math.max(0, input.base.rows)),
    troeRows24h: stat(rows24h),
    troeRows1h: stat(input.base.r1),
    ingestByHour: stat(ingest),
    rowsByType: stat(rowsByType.slice(0, MAX_TYPES)),
    "@context": NGSI_CONTEXT,
    // NGSI-LD has no null property value — omit the nightly figures until the
    // first retention run has produced them.
    ...(entities === null ? {} : { troeEntities: stat(entities) }),
    ...(asOf === null ? {} : { rowsByTypeAsOf: stat(asOf) }),
  };
  return { entity, budgetWarning: budgetWarning(last24h, input.budget) };
}

/* ------------------------------------------------------------------ Run */

function firstRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  at: string,
): Readonly<Record<string, unknown>> {
  const row = rows[0];
  if (row === undefined) throw new ParseError(at, "one row", rows);
  return row;
}

/** The query rows of one run, or `null` when a previous run is still busy. */
async function querySnapshot(db: DbSession): Promise<Record<string, unknown> | null> {
  const busy = firstRow((await db.query(SQL_BUSY)).rows, "busy check").n;
  if (isTruthy(busy)) return null;
  const base = firstRow((await db.query(SQL_BASE)).rows, "base");
  const window = (await db.query(SQL_WINDOW)).rows;
  let totals: readonly unknown[] = [];
  if (isTruthy(firstRow((await db.query(SQL_HAS_TOTALS)).rows, "to_regclass").t)) {
    totals = (await db.query(SQL_TOTALS)).rows;
  }
  return { base, window, totals };
}

export async function run(ctx: Ctx): Promise<void> {
  const snapshot = await ctx.db.session(SESSION, querySnapshot);
  if (snapshot === null) {
    ctx.log.status("previous run still active – skipped");
    return;
  }
  // `ROW_BUDGET` of the generator, summed by the kernel over the whole registry.
  const input = parse({ ...snapshot, budget: ctx.rowBudget });
  const stats = build(input, null, ctx.now());
  if (stats.budgetWarning !== null) ctx.log.warn(stats.budgetWarning);
  ctx.log.status(`≈${String(input.base.rows)} rows · +${String(input.base.r1)}/h`);
  await ctx.orion.upsert(ctx.gate.ungated([stats.entity]));
}

export const connector: ConnectorModule<TroeStatsInput, TroeStats> = {
  id: ID,
  parse,
  build,
  run,
};
