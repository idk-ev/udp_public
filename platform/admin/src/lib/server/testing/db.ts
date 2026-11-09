/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import type { Row } from "../db/rows.ts";

interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}

function wrap(client: PgliteLike): Queryable {
  return {
    async query(text, params = []) {
      const { rows } = await client.query(text, [...params]);
      return rows.filter(isRow);
    },
    async exec(sql) {
      await client.exec(sql);
    },
  };
}

/** A real PostgreSQL in this process, with the panel's schema. */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    ...wrap(pg),
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      // PGlite types its result as "T | undefined" for a rolled-back transaction.
      const result = await pg.transaction(async (tx) => ({ value: await work(wrap(tx)) }));
      return result.value;
    },
    async close() {
      await pg.close();
    },
  };
  await migrate(db);
  return db;
}
