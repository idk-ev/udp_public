/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import pg from "pg";
import type { Row } from "./rows.ts";

/** What the service modules need of a connection or an open transaction. */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<readonly Row[]>;
  /** Runs a script of several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

const STATEMENT_TIMEOUT_MS = 10_000;

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query(text, params = []) {
      const result = await client.query<Record<string, unknown>>(text, [...params]);
      return result.rows;
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

export function createPgDb(config: DbConfig, onError: (error: Error) => void): Db {
  const pool = new pg.Pool({
    ...config,
    application_name: "udp-admin",
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // An idle client losing its connection (database failover) must not end the
  // process; the next query takes a new connection.
  pool.on("error", onError);
  return {
    ...wrap(pool),
    async transaction(work) {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await work(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release(failure);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
