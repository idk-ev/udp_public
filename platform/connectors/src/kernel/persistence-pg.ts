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
 * Connections: a pool of at most two for loads and writes, plus one dedicated
 * connection that holds the session advisory lock for the lifetime of the
 * process (`pg_try_advisory_lock(1969516643, 1)`, "udpc"). The lock is what
 * makes this the single writer; it goes with that connection, so a crashed
 * process releases it by itself. Nothing connects before the first connector
 * that needs state is prepared: with no scheduled connector the service never
 * opens a connection.
 */

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
);`;

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

class PgStateBackend implements StateBackend {
  readonly description: string;
  readonly #settings: ConnectionSettings;
  readonly #log: Log;
  #pool: pg.Pool | null = null;
  #lock: pg.Client | null = null;
  #locked = false;

  constructor(settings: ConnectionSettings, log: Log) {
    this.#settings = settings;
    this.#log = log;
    this.description = `postgres ${settings.host}:${String(settings.port)}/${settings.database}, schema ${STATE_SCHEMA}`;
  }

  get locked(): boolean {
    return this.#locked;
  }

  async acquire(): Promise<boolean> {
    if (this.#locked) return true;
    await this.#releaseLock();
    const client = new pg.Client({
      ...this.#settings,
      application_name: "udp-connectors-lock",
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
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
    try {
      await client.connect();
      const result = await client.query<Record<string, unknown>>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [...LOCK_KEYS],
      );
      if (result.rows[0]?.locked !== true) {
        await client.end();
        return false;
      }
      await client.query(SCHEMA_SQL);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.#lock = client;
    this.#locked = true;
    return true;
  }

  async stillHeld(): Promise<boolean> {
    const lock = this.#lock;
    if (!this.#locked || lock === null) return false;
    try {
      await lock.query("SELECT 1");
    } catch {
      this.#locked = false;
    }
    return this.#locked;
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
    if (lock !== null) await lock.end().catch(() => undefined);
  }
}

export function createPgStateBackend(env: Env, log: Log): StateBackend {
  return new PgStateBackend(connectionSettings(env), log);
}
