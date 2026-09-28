/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * A scripted database for the two SQL connectors (`troe-stats`,
 * `troe-retention`), served to BOTH sides of a parity test from one responder:
 *
 *  * {@link fakePgModule} stands in for the `pg` module the old function nodes
 *    load through their `libs` — `new pg.Client(config)`, `connect`, `query`,
 *    `end` — and records the client config and every statement.
 *  * {@link scriptedDb} implements the contract's `Db` for the port and records
 *    the session options and every statement the same way.
 *
 * SQL cannot run offline, so what is compared is what each side SENDS (the
 * statements, byte for byte, with their parameters, in order) and what each
 * side makes of the same answers. The rows a responder returns should look the
 * way node-postgres delivers them: int8 columns as strings, timestamps as
 * `Date`.
 */

import type { Db, DbQueryResult, DbSession, DbSessionOptions, SqlParam } from "../../src/kernel/types.js";

/** One statement as a side sent it. Params stay `unknown`: the old node's come from the vm realm. */
export interface SqlCall {
  readonly sql: string;
  readonly params: unknown;
}

export interface SqlAnswer {
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount?: number | null;
}

/** Answers a statement; an `Error` makes the query reject with it. */
export type SqlResponder = (sql: string, params: unknown) => SqlAnswer | Error;

interface Recorder {
  readonly calls: SqlCall[];
  /** `connect`, `end` — to prove the connection is closed on every path. */
  readonly events: string[];
}

function answer(
  respond: SqlResponder,
  recorder: Recorder,
  sql: string,
  params: unknown,
): Promise<DbQueryResult> {
  recorder.calls.push({ sql, params });
  const result = respond(sql, params);
  if (result instanceof Error) return Promise.reject(result);
  return Promise.resolve({ rows: result.rows ?? [], rowCount: result.rowCount ?? null });
}

export interface FakePg extends Recorder {
  /** Pass as `runFunctionNode(id, { modules: { pg: fake.module } })`. */
  readonly module: Record<string, unknown>;
  /** The config objects handed to `new Client(…)`. */
  readonly configs: unknown[];
}

export function fakePgModule(respond: SqlResponder): FakePg {
  const calls: SqlCall[] = [];
  const events: string[] = [];
  const configs: unknown[] = [];
  const recorder: Recorder = { calls, events };
  class Client {
    constructor(config: unknown) {
      configs.push(config);
    }
    connect(): Promise<void> {
      events.push("connect");
      return Promise.resolve();
    }
    query(sql: unknown, params?: unknown): Promise<DbQueryResult> {
      return answer(respond, recorder, String(sql), params);
    }
    end(): Promise<void> {
      events.push("end");
      return Promise.resolve();
    }
  }
  return { module: { Client }, calls, events, configs };
}

export interface ScriptedDb extends Recorder {
  readonly db: Db;
  readonly sessions: DbSessionOptions[];
}

export function scriptedDb(respond: SqlResponder): ScriptedDb {
  const calls: SqlCall[] = [];
  const events: string[] = [];
  const sessions: DbSessionOptions[] = [];
  const recorder: Recorder = { calls, events };
  const db: Db = {
    async session<T>(options: DbSessionOptions, work: (session: DbSession) => Promise<T>): Promise<T> {
      sessions.push(options);
      events.push("connect");
      const session: DbSession = {
        query: (sql: string, params?: readonly SqlParam[]) => answer(respond, recorder, sql, params),
      };
      try {
        return await work(session);
      } finally {
        events.push("end");
      }
    },
  };
  return { db, calls, events, sessions };
}
