/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * PostgreSQL backend of the kernel's state store (src/kernel/persistence.ts).
 *
 * Same connection settings as `ctx.db` (src/kernel/db.ts: `TROE_DB_HOST`,
 * `TROE_DB_USER`, `TROE_DB_PASSWORD`, database `orion`), but a schema of its
 * own, so nothing here ever touches Orion's TRoE tables:
 *
 *     udp_connectors.signatures       connector, table_key, field -> value (jsonb: string or number)
 *                                     the change gate's tables, one row per field
 *     udp_connectors.prune_state      connector -> bookkeeping (jsonb)
 *                                     interval bookkeeping, confirmation tables,
 *                                     master data reference, one document
 *     udp_connectors.connector_state  connector, name -> value (jsonb)
 *                                     the persisted `ctx.state` keys
 *
 * Every row carries `updated_at`. The schema is created idempotently when the
 * writer lock is taken (`CREATE SCHEMA/TABLE IF NOT EXISTS`); the database
 * user needs `CREATE` on the database for that, or the schema has to exist.
 *
 *     udp_connectors.writer           one row: the writer generation, bumped by
 *                                     every instance that takes the lock
 *
 * Connections: a pool of at most two for loads and writes, plus one dedicated
 * connection that holds the session advisory lock for the lifetime of the
 * process (`pg_try_advisory_lock(1969516643, 1)`, "udpc"). The lock is what
 * makes this the single writer; it goes with that connection, so a crashed
 * process releases it by itself. Nothing connects before the first connector
 * that needs state is prepared: with no scheduled connector the service never
 * opens a connection.
 *
 * ## When the lock counts as lost
 *
 * Only when it verifiably is: the lock connection closed, or the database
 * says, asked in a session of its own, that our session does not hold it.
 * The lock connection has NO client-side query timeout: in `pg` such a
 * timeout fails the query but leaves the session (and the lock) in place,
 * and taking the lock "again" then ended that very session itself. The
 * earlier check read ANY failure of its `SELECT 1` as a lost lock — the most
 * likely source of the loss logged shortly after every start, when the first
 * staggered runs check the lock while the start is at its busiest (state
 * loads, the first full writes of every connector). Now a probe that does
 * not answer within {@link LOCK_PROBE_MS} is followed by a look at
 * `pg_locks` (retried); if that cannot answer either, the lock is kept
 * ("unknown", the next run checks again) — a lost lock also closes its
 * connection sooner or later, and a write without it fails anyway. And
 * should the lock really go, memory is no longer thrown away with it
 * (src/kernel/persistence.ts, "A lost lock keeps memory").
 */

import { randomUUID } from "node:crypto";

import pg from "pg";

import { connectionSettings } from "./db.js";
import type { ConnectionSettings } from "./db.js";
import { describe } from "./persistence.js";
import type { StateBackend, StateWrite, StoredRows } from "./persistence.js";
import type { ConnectorId, Env, Log } from "./types.js";

export const STATE_SCHEMA = "udp_connectors";

/** The two int4 keys of the writer lock: "udpc" and 1. */
const LOCK_KEYS = [1_969_516_643, 1] as const;

const CONNECTION_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 35_000;
/** The lock probe (`SELECT 1` on the lock connection) may take this long before `pg_locks` is asked. */
export const LOCK_PROBE_MS = 10_000;
/** Attempts of the `pg_locks` check, this far apart. */
export const VERIFY_ATTEMPTS = 3;
export const VERIFY_PAUSE_MS = 2_000;
/** Rows per INSERT; one write of a first run can carry tens of thousands. */
const ROWS_PER_STATEMENT = 5_000;

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS ${STATE_SCHEMA};
CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.signatures (
  connector  text        NOT NULL,
  table_key  text        NOT NULL,
  field      text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector, table_key, field)
);
CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.prune_state (
  connector   text        PRIMARY KEY,
  bookkeeping jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.connector_state (
  connector  text        NOT NULL,
  name       text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector, name)
);
CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.writer (
  id          smallint    PRIMARY KEY CHECK (id = 1),
  generation  bigint      NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now()
);`;

/** Bumped by every acquire: two tenures of one process are consecutive only if nobody took the lock in between. */
const SQL_NEXT_GENERATION =
  `INSERT INTO ${STATE_SCHEMA}.writer AS w (id, generation) VALUES (1, 1) ` +
  "ON CONFLICT (id) DO UPDATE SET generation = w.generation + 1, acquired_at = now() RETURNING generation";

/** Who holds the writer lock (session level, two int4 keys: objsubid 2). */
const SQL_LOCK_HOLDERS =
  "SELECT l.pid, a.application_name FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid " +
  "WHERE l.locktype = 'advisory' AND l.classid::bigint = $1 AND l.objid::bigint = $2 " +
  "AND l.objsubid = 2 AND l.granted";

const SQL_LOAD_SIGNATURES = `SELECT table_key, field, value FROM ${STATE_SCHEMA}.signatures WHERE connector = $1`;
const SQL_LOAD_PRUNE = `SELECT bookkeeping FROM ${STATE_SCHEMA}.prune_state WHERE connector = $1`;
const SQL_LOAD_STATE = `SELECT name, value FROM ${STATE_SCHEMA}.connector_state WHERE connector = $1`;

const SQL_DELETE_SIGNATURES =
  `DELETE FROM ${STATE_SCHEMA}.signatures s ` +
  "USING unnest($2::text[], $3::text[]) AS d(table_key, field) " +
  "WHERE s.connector = $1 AND s.table_key = d.table_key AND s.field = d.field";
const SQL_UPSERT_SIGNATURES =
  `INSERT INTO ${STATE_SCHEMA}.signatures (connector, table_key, field, value) ` +
  "SELECT $1, u.table_key, u.field, u.value::jsonb " +
  "FROM unnest($2::text[], $3::text[], $4::text[]) AS u(table_key, field, value) " +
  "ON CONFLICT (connector, table_key, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now()";
const SQL_UPSERT_PRUNE =
  `INSERT INTO ${STATE_SCHEMA}.prune_state (connector, bookkeeping) VALUES ($1, $2::jsonb) ` +
  "ON CONFLICT (connector) DO UPDATE SET bookkeeping = EXCLUDED.bookkeeping, updated_at = now()";
const SQL_UPSERT_STATE =
  `INSERT INTO ${STATE_SCHEMA}.connector_state (connector, name, value) ` +
  "SELECT $1, u.name, u.value::jsonb FROM unnest($2::text[], $3::text[]) AS u(name, value) " +
  "ON CONFLICT (connector, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()";

function slices<T>(items: readonly T[]): (readonly T[])[] {
  const out: (readonly T[])[] = [];
  for (let at = 0; at < items.length; at += ROWS_PER_STATEMENT)
    out.push(items.slice(at, at + ROWS_PER_STATEMENT));
  return out;
}

/** What {@link checkLock} needs to know about the lock connection. */
export interface LockProbe {
  /** The lock connection is still open, as far as the driver knows. */
  open(): boolean;
  /** A trivial query on the lock connection answered in time. `false` = it failed or did not answer yet. */
  probe(): Promise<boolean>;
  /**
   * Asks the database in a session of its own who holds the lock: `true` =
   * our lock session, `false` = verifiably not (nobody, or someone else),
   * `null` = the question could not be answered.
   */
  verify(): Promise<boolean | null>;
  pause(ms: number): Promise<void>;
}

export type LockVerdict = "held" | "lost" | "unknown";

/**
 * Whether the writer lock is still ours. "lost" only when that is certain:
 * the lock connection closed, or `pg_locks` does not list our session. A
 * probe that fails or takes long is not enough — see the module header.
 */
export async function checkLock(
  lock: LockProbe,
  attempts = VERIFY_ATTEMPTS,
  pauseMs = VERIFY_PAUSE_MS,
): Promise<LockVerdict> {
  if (!lock.open()) return "lost";
  if (await lock.probe()) return lock.open() ? "held" : "lost";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!lock.open()) return "lost";
    const ours = await lock.verify();
    if (ours !== null) return ours ? "held" : "lost";
    if (attempt + 1 < attempts) await lock.pause(pauseMs);
  }
  return lock.open() ? "unknown" : "lost";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** `promise`, or `fallback` once `ms` passed. The timer never keeps the process alive. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    timer.unref();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

class PgStateBackend implements StateBackend {
  readonly description: string;
  readonly #settings: ConnectionSettings;
  readonly #log: Log;
  #pool: pg.Pool | null = null;
  #lock: pg.Client | null = null;
  #locked = false;
  #generation: number | null = null;
  /** Backend pid and application name of the lock session: how `pg_locks` names it. */
  #lockSession: { readonly pid: number; readonly name: string } | null = null;
  /** The one lock probe in flight; a slow one is waited for, never stacked. */
  #probing: Promise<boolean> | null = null;
  /** A check could not tell whether the lock is ours; warned once per streak. */
  #unverified = false;

  constructor(settings: ConnectionSettings, log: Log) {
    this.#settings = settings;
    this.#log = log;
    this.description = `postgres ${settings.host}:${String(settings.port)}/${settings.database}, schema ${STATE_SCHEMA}`;
  }

  get locked(): boolean {
    return this.#locked;
  }

  get generation(): number | null {
    return this.#generation;
  }

  async acquire(): Promise<boolean> {
    if (this.#locked) return true;
    await this.#releaseLock();
    // Unique per connection, so that `pg_locks` + `pg_stat_activity` name
    // THIS session and not a namesake on another server after a failover.
    const name = `udp-connectors-lock-${randomUUID().slice(0, 8)}`;
    const client = new pg.Client({
      ...this.#settings,
      application_name: name,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // Deliberately no query_timeout: a client-side timeout leaves the
      // session and its lock alive, see the module header.
    });
    // Without a listener a dropped connection would crash the process. With
    // it, the lock is simply gone — and so is the right to write.
    client.on("error", (error: Error) => {
      if (this.#lock === client) this.#locked = false;
      this.#log.debug(`state store: lock connection error (${describe(error)})`);
    });
    client.on("end", () => {
      if (this.#lock === client) this.#locked = false;
    });
    let generation: number;
    let pid: number;
    try {
      await client.connect();
      const result = await client.query<Record<string, unknown>>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked, pg_backend_pid() AS pid",
        [...LOCK_KEYS],
      );
      const row = result.rows[0];
      if (row?.locked !== true) {
        await client.end();
        return false;
      }
      pid = Number(row.pid);
      await client.query(SCHEMA_SQL);
      const next = await client.query<Record<string, unknown>>(SQL_NEXT_GENERATION);
      generation = Number(next.rows[0]?.generation);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.#lock = client;
    this.#locked = true;
    this.#lockSession = { pid, name };
    this.#generation = Number.isSafeInteger(generation) ? generation : null;
    this.#unverified = false;
    return true;
  }

  async stillHeld(): Promise<boolean> {
    const lock = this.#lock;
    if (!this.#locked || lock === null) return false;
    const verdict = await checkLock({
      open: () => this.#locked && this.#lock === lock,
      probe: () => this.#probe(lock),
      verify: () => this.#verify(),
      pause: sleep,
    });
    if (verdict === "lost") {
      this.#locked = false;
      return false;
    }
    if (verdict === "unknown" && !this.#unverified) {
      this.#log.warn(
        "state store: the lock connection does not answer and the database could not be asked — " +
          "the writer lock is kept (a lost one closes its connection); checked again before the next run",
      );
    }
    this.#unverified = verdict === "unknown";
    return this.#locked;
  }

  #probe(lock: pg.Client): Promise<boolean> {
    this.#probing ??= lock
      .query("SELECT 1")
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        this.#probing = null;
      });
    return within(this.#probing, LOCK_PROBE_MS, false);
  }

  /** `pg_locks` from a short session of its own — not the pool, whose two connections may be busy writing. */
  async #verify(): Promise<boolean | null> {
    const session = this.#lockSession;
    if (session === null) return false;
    const client = new pg.Client({
      ...this.#settings,
      application_name: "udp-connectors-lockcheck",
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: LOCK_PROBE_MS,
      query_timeout: LOCK_PROBE_MS + 5_000,
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      const result = await client.query<Record<string, unknown>>(SQL_LOCK_HOLDERS, [...LOCK_KEYS]);
      return result.rows.some(
        (row) => Number(row.pid) === session.pid && row.application_name === session.name,
      );
    } catch (error) {
      this.#log.debug(`state store: lock check failed (${describe(error)})`);
      return null;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async load(connector: ConnectorId): Promise<StoredRows> {
    const pool = this.#poolOf();
    const signatures = await pool.query<Record<string, unknown>>(SQL_LOAD_SIGNATURES, [connector]);
    const prune = await pool.query<Record<string, unknown>>(SQL_LOAD_PRUNE, [connector]);
    const state = await pool.query<Record<string, unknown>>(SQL_LOAD_STATE, [connector]);
    return { signatures: signatures.rows, prune: prune.rows[0]?.bookkeeping ?? null, state: state.rows };
  }

  async write(connector: ConnectorId, batch: StateWrite): Promise<void> {
    if (!this.#locked) throw new Error("writer lock not held");
    const client = await this.#poolOf().connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const deletes = batch.signatures.filter((row) => row.value === null);
      for (const part of slices(deletes)) {
        await client.query(SQL_DELETE_SIGNATURES, [
          connector,
          part.map((row) => row.table),
          part.map((row) => row.field),
        ]);
      }
      const upserts = batch.signatures.filter((row) => row.value !== null);
      for (const part of slices(upserts)) {
        await client.query(SQL_UPSERT_SIGNATURES, [
          connector,
          part.map((row) => row.table),
          part.map((row) => row.field),
          part.map((row) => JSON.stringify(row.value)),
        ]);
      }
      if (batch.prune !== null)
        await client.query(SQL_UPSERT_PRUNE, [connector, JSON.stringify(batch.prune)]);
      if (batch.state.length > 0) {
        await client.query(SQL_UPSERT_STATE, [
          connector,
          batch.state.map(([name]) => name),
          batch.state.map(([, value]) => JSON.stringify(value)),
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch((rollback: unknown) => {
        broken = rollback instanceof Error ? rollback : new Error(String(rollback));
      });
      throw error;
    } finally {
      // A connection that could not even roll back is not given back to the pool.
      client.release(broken);
    }
  }

  async deleteSignatures(connector: ConnectorId, table: string, fields: readonly string[]): Promise<void> {
    if (!this.#locked) throw new Error("writer lock not held");
    for (const part of slices(fields)) {
      await this.#poolOf().query(SQL_DELETE_SIGNATURES, [connector, part.map(() => table), [...part]]);
    }
  }

  async close(): Promise<void> {
    const pool = this.#pool;
    this.#pool = null;
    await Promise.all([pool?.end().catch(() => undefined), this.#releaseLock()]);
  }

  #poolOf(): pg.Pool {
    if (this.#pool === null) {
      const pool = new pg.Pool({
        ...this.#settings,
        application_name: "udp-connectors-state",
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
      });
      // An idle client losing its connection must not crash the process; the
      // next query simply gets a new one.
      pool.on("error", (error: Error) => {
        this.#log.debug(`state store: idle connection error (${describe(error)})`);
      });
      this.#pool = pool;
    }
    return this.#pool;
  }

  async #releaseLock(): Promise<void> {
    const lock = this.#lock;
    this.#lock = null;
    this.#locked = false;
    this.#lockSession = null;
    this.#probing = null;
    if (lock !== null) await lock.end().catch(() => undefined);
  }
}

export function createPgStateBackend(env: Env, log: Log): StateBackend {
  return new PgStateBackend(connectionSettings(env), log);
}
