/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Entry point of the UDP connector service.
 *
 * Wires registry, scheduler and the two HTTP servers together and starts the
 * connectors the registry marks as `"runtime": "app"`.
 *
 * Two ports, deliberately (src/kernel/admin.ts):
 *
 *  * public — UDP_CONNECTORS_PORT, default 1880: only the routes connectors
 *    register (`/abfahrten`, `/warnungen.ics`). The cockpit's nginx proxies to
 *    it, so it faces the internet. `/trigger` does not exist here.
 *  * admin — UDP_CONNECTORS_ADMIN_PORT, default 1881, bound to
 *    UDP_CONNECTORS_ADMIN_HOST (default 0.0.0.0): `GET /healthz` and
 *    `POST /trigger/:id`, the latter answering loopback peers only (403
 *    otherwise). Never to be mapped by nginx, APISIX or an ingress;
 *    in Compose published on the host at most on 127.0.0.1. Phase 5 points
 *    `scripts/trigger-connector.sh` here.
 *
 * State: change signatures, prune bookkeeping and persisted `ctx.state`
 * keys live in PostgreSQL (schema `udp_connectors`, src/kernel/persistence.ts).
 * They are loaded before the first run — a connector that needs them does not
 * run until they are — and written back as they change; shutdown writes the
 * rest. The service must run as ONE replica: a second instance does not get
 * the writer lock and runs nothing that needs state.
 *
 * **Nothing runs yet.** Not because the wiring is missing — it is complete
 * below — but because no entry in platform/config/connectors.json carries the
 * field yet. That file is not touched here; the cutover is phase 4, one group of
 * connectors at a time with an observation window in between, and the way back
 * is to turn the field around. Until then the service starts, reports what it
 * WOULD run, and leaves the ingestion entirely to Node-RED.
 */

import { CONNECTORS } from "./connectors/index.js";
import { adminRoutes, DEFAULT_ADMIN_HOST, DEFAULT_ADMIN_PORT, triggerCooldownMs } from "./kernel/admin.js";
import { createCtx, createKernel, runConnector } from "./kernel/context.js";
import type { Kernel } from "./kernel/context.js";
import { DEFAULT_PORT } from "./kernel/http.js";
import { sanitizeLogText } from "./kernel/log.js";
import { loadRegistry, resolveRegistryPath, runtimeOf, REGISTRY_PATH_ENV } from "./kernel/registry.js";
import { scheduleOf } from "./kernel/scheduler.js";
import type { RegistryEntry } from "./kernel/types.js";

const VERSION = "1.0.0";

/** One log line per registry entry: what runs here, what stays in Node-RED, why. */
function reportPlan(kernel: Kernel, scheduled: readonly RegistryEntry[]): void {
  const log = kernel.log;
  const total = kernel.registry.entries.length;
  log.info(`registry: ${String(total)} connectors, ${String(scheduled.length)} with runtime=app`);

  for (const entry of kernel.registry.entries) {
    if (!entry.active) {
      log.debug(`${entry.id}: inactive, skipped`);
      continue;
    }
    if (runtimeOf(entry) !== "app") {
      log.debug(`${entry.id}: runtime=nodered — stays in the flows`);
      continue;
    }
    if (!CONNECTORS.has(entry.id)) {
      // Registry and code disagree. Loud, because it means the cutover switched
      // a connector over that has not been ported — it would then run nowhere.
      log.warn(`${entry.id}: runtime=app but no module is implemented — connector runs NOWHERE`);
    }
  }

  if (scheduled.length === 0) {
    log.info(
      "no connector carries runtime=app — ingestion stays entirely in Node-RED " +
        `(set the field per connector in the registry, see ${REGISTRY_PATH_ENV})`,
    );
    for (const [id] of CONNECTORS) log.info(`${id}: ported and ready, waiting for runtime=app`);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const registryPath = resolveRegistryPath(process.env[REGISTRY_PATH_ENV]);
  const registry = loadRegistry(registryPath);
  const kernel = createKernel(registry);

  kernel.log.info(`udp-connectors ${VERSION} — registry ${registryPath}`);

  const scheduled = kernel.registry.appEntries().filter((entry) => CONNECTORS.has(entry.id));
  reportPlan(kernel, kernel.registry.appEntries());

  scheduled.forEach((entry, position) => {
    const module = CONNECTORS.get(entry.id);
    if (module === undefined) return;
    const schedule = scheduleOf(entry, position);
    const ctx = createCtx(kernel, entry);
    kernel.scheduler.add(entry.id, schedule, () => runConnector(kernel, ctx, module));
    // Built with the connector's own ctx: its log, its limiter share, its Orion.
    for (const route of module.routes?.(ctx) ?? []) kernel.publicHttp.register(route);
    kernel.log.info(
      `${entry.id}: ${schedule.kind}` +
        (schedule.cron === null ? "" : ` "${schedule.cron}"`) +
        (schedule.intervalSeconds === null ? "" : ` every ${String(schedule.intervalSeconds)} s`) +
        `, first run in ${String(schedule.startupDelaySeconds)} s`,
    );
  });

  // Load before the first run. Without a scheduled connector nothing is
  // bound, and the state store is never even connected.
  if (scheduled.length > 0) await kernel.persistence?.prepareAll();

  for (const route of adminRoutes(kernel, {
    version: VERSION,
    started,
    cooldownMs: triggerCooldownMs(kernel.env),
  })) {
    kernel.adminHttp.register(route);
  }
  await kernel.publicHttp.listen(kernel.env.number("UDP_CONNECTORS_PORT", DEFAULT_PORT));
  await kernel.adminHttp.listen(
    kernel.env.number("UDP_CONNECTORS_ADMIN_PORT", DEFAULT_ADMIN_PORT),
    kernel.env.get("UDP_CONNECTORS_ADMIN_HOST") ?? DEFAULT_ADMIN_HOST,
  );
  kernel.scheduler.start();

  const stop = (signal: string): void => {
    kernel.log.info(`${signal} received, shutting down`);
    kernel.shutdown.abort();
    kernel.scheduler.stop();
    // The state store last: its close writes what is still marked and
    // releases the writer lock for the next instance.
    void Promise.all([kernel.publicHttp.close(), kernel.adminHttp.close()])
      .then(() => kernel.persistence?.close())
      .catch((error: unknown) => {
        kernel.log.error("state store: close failed", error);
      })
      .then(() => {
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    stop("SIGINT");
  });
}

main().catch((error: unknown) => {
  // Before the logger exists there is no component name to group by, so the
  // marker is written by hand — scripts/healthcheck.sh counts [error] lines and
  // a startup failure is exactly what it must not miss.
  process.stderr.write(`${new Date().toISOString()} [error] [udp-connectors] startup failed\n`);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const line of detail.split(/\r?\n/)) process.stderr.write(`    ${sanitizeLogText(line)}\n`);
  process.exit(1);
});
