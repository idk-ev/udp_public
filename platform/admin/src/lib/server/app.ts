/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { prepareDummyHash } from "./auth/password.ts";
import { loadCatalog, type CityCatalog } from "./cities/catalog.ts";
import { createKubernetesPublisher, podNamespace, podRequest } from "./cities/kubernetes.ts";
import { publishBlocks } from "./cities/publish.ts";
import { createDirectoryPublisher, type Publisher } from "./cities/publisher.ts";
import { createPgDb, type Db } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { parseEnv, type AdminEnv } from "./env.ts";
import { purgeExpired } from "./maintenance.ts";

export interface App {
  env: AdminEnv;
  db: Db;
  catalog: CityCatalog;
  publisher: Publisher;
}

/** Short, because the throttle table is meant to stay small during a flood. */
const PURGE_INTERVAL_MS = 5 * 60 * 1000;
/** A failed publish repairs itself within this time. */
const PUBLISH_INTERVAL_MS = 60 * 1000;

let app: App | undefined;

function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[admin] ${context}: ${message}`);
}

function createPublisher(config: AdminEnv["cityPublish"]): Publisher {
  return config.kind === "kubernetes"
    ? createKubernetesPublisher(config.configMap, podRequest(process.env), podNamespace)
    : createDirectoryPublisher(config.directory);
}

/** Environment and pool, created once. Used by the panel and the operator CLI. */
export function getApp(): App {
  if (app === undefined) {
    const env = parseEnv(process.env);
    app = {
      env,
      db: createPgDb(env.db, (error) => {
        logError("database connection lost", error);
      }),
      catalog: loadCatalog(env.cityCatalog),
      publisher: createPublisher(env.cityPublish),
    };
  }
  return app;
}

/** Server start: nothing is answered before the schema is current. */
export async function startApp(): Promise<void> {
  const current = getApp();
  const { db } = current;
  const applied = await migrate(db);
  if (applied.length > 0) console.log(`[admin] applied migrations: ${applied.join(", ")}`);
  await prepareDummyHash();
  const purge = (): void => {
    purgeExpired(db).catch((error: unknown) => {
      logError("purge failed", error);
    });
  };
  purge();
  setInterval(purge, PURGE_INTERVAL_MS).unref();
  // Not awaited: a Kubernetes API that does not answer must not hold up the panel.
  // publishBlocks reports its own failures and never rejects.
  const publish = (): void => {
    void publishBlocks(current);
  };
  publish();
  setInterval(publish, PUBLISH_INTERVAL_MS).unref();
}
