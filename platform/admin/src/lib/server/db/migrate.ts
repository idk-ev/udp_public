/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Db } from "./client.ts";
import { text } from "./rows.ts";

/** Any fixed number: it only has to be the same in every instance of the panel. */
const MIGRATION_LOCK = 7_301_942;

export interface Migration {
  name: string;
  sql: string;
}

function bundled(): readonly Migration[] {
  const files = import.meta.glob("./migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  return Object.entries(files)
    .map(([path, sql]) => {
      if (typeof sql !== "string") throw new TypeError(`migration ${path}: not text`);
      return { name: path.replace(/^.*\//, ""), sql };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/**
 * Applies the numbered SQL files that have not run yet. One transaction under an
 * advisory lock: several instances starting together wait for each other, and a
 * failing migration leaves the schema as it was.
 */
export async function migrate(db: Db, migrations: readonly Migration[] = bundled()): Promise<readonly string[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await tx.query("SELECT name FROM schema_migrations")).map((row) => text(row, "name")));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      applied.push(migration.name);
    }
    return applied;
  });
}
