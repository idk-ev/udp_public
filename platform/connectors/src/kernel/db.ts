/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * TimescaleDB access for the two connectors that talk SQL — `troe-stats` and
 * `troe-retention`, the function nodes that loaded `pg` through their `libs`.
 *
 * Same connection as theirs: host `TROE_DB_HOST` (default `timescale`), port
 * 5432, database `orion`, user `TROE_DB_USER` (default `udp`), password
 * `TROE_DB_PASSWORD`. One `pg.Client` per session, connected when the session
 * starts and ended when its work settles, as the old nodes connected once per
 * run. Nothing connects before a connector asks: the other 27 connectors never
 * open a database connection, and a missing password only matters to the two
 * that need it.
 *
 * `statement_timeout` is passed as well as `query_timeout`, with the reasoning
 * of the old node: the first cancels on the SERVER, the second only makes the
 * client give up and would leave the query running — a statistics scan that
 * outlives its run is how the database ended up at its CPU limit.
 */

import pg from "pg";

import type { Db, DbQueryResult, DbSession, DbSessionOptions, Env, SqlParam } from "./types.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** `env.get(name) || fallback` of the old nodes: an empty value counts as unset. */
function orDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

class PgDb implements Db {
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  async session<T>(options: DbSessionOptions, work: (session: DbSession) => Promise<T>): Promise<T> {
    const password = this.#env.get("TROE_DB_PASSWORD");
    const client = new pg.Client({
      host: orDefault(this.#env.get("TROE_DB_HOST"), "timescale"),
      port: 5432,
      database: "orion",
      user: orDefault(this.#env.get("TROE_DB_USER"), "udp"),
      ...(password === undefined ? {} : { password }),
      application_name: options.applicationName,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      statement_timeout: options.statementTimeoutMs,
      query_timeout: options.queryTimeoutMs,
    });
    await client.connect();
    try {
      return await work({
        query: async (sql: string, params?: readonly SqlParam[]): Promise<DbQueryResult> => {
          const result = await client.query<Record<string, unknown>>(
            sql,
            params === undefined ? [] : [...params],
          );
          return { rows: result.rows, rowCount: result.rowCount };
        },
      });
    } finally {
      await client.end();
    }
  }
}

export function createDb(env: Env): Db {
  return new PgDb(env);
}
