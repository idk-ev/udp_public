/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Entry point of the UDP connector service.
 *
 * Wires registry, scheduler and the two HTTP servers together and starts every
 * active connector of the registry (platform/config/connectors.json) that has
 * a module in src/connectors/index.ts.
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
 *    in Compose published on the host at most on 127.0.0.1.
 *    `scripts/trigger-connector.sh` calls it from inside the container.
 *
 * Geo context: loaded by the kernel itself before the first run and every
 * 6 h (src/kernel/geo-bootstrap.ts) — `bw-gemeinden.json` and
 * `bw-grenzen.json` from the cockpit, independent of the schedules of
 * `stammdaten-bw` and `grenzen-bw`, and never written to Orion.
 *
 * State: change signatures, prune bookkeeping and persisted `ctx.state`
 * keys live in PostgreSQL (schema `udp_connectors`, src/kernel/persistence.ts).
 * They are loaded before the first run — a connector that needs them does not
 * run until they are — and written back as they change; shutdown writes the
 * rest. The service must run as ONE replica: a second instance does not get
 * the writer lock and runs nothing that needs state.
 *
 * Node-RED is no longer an ingestion runtime (docs/migration-konnektoren.md):
 * it stays as the low-code building block with an example flow, and every
 * connector runs here.
 */

import { CONNECTORS, GEO_SOURCES } from "./connectors/index.js";
import { adminRoutes, DEFAULT_ADMIN_HOST, DEFAULT_ADMIN_PORT, triggerCooldownMs } from "./kernel/admin.js";
import { createCtx, createKernel, runConnector, startGeoBootstrap } from "./kernel/context.js";
import type { Kernel } from "./kernel/context.js";
import { DEFAULT_PORT } from "./kernel/http.js";
import { handleFatalErrors, sanitizeLogText } from "./kernel/log.js";
import { loadRegistry, resolveRegistryPath, REGISTRY_PATH_ENV } from "./kernel/registry.js";
import { storedLastRuns } from "./kernel/run-log.js";
import { scheduleOf } from "./kernel/scheduler.js";
import type { RegistryEntry } from "./kernel/types.js";

const VERSION = "1.0.0";

/** How long the shutdown after a fatal error may take before the process exits regardless. */
const FATAL_EXIT_DEADLINE_MS = 10_000;

/** One log line per registry entry that does not run, and why. */
function reportPlan(kernel: Kernel, scheduled: readonly RegistryEntry[]): void {
  const log = kernel.log;
  const total = kernel.registry.entries.length;
  log.info(`registry: ${String(total)} connectors, ${String(scheduled.length)} scheduled`);

  for (const entry of kernel.registry.entries) {
    if (!entry.active) {
      log.debug(`${entry.id}: inactive, skipped`);
      continue;
    }
    if (!CONNECTORS.has(entry.id)) {
      // Registry and code disagree: an active entry without a module runs
      // nowhere. Loud, because its tiles and health check go stale silently.
      log.warn(`${entry.id}: active in the registry but no module is implemented — connector runs NOWHERE`);
    }
  }
  if (scheduled.length === 0) {
    log.info(`no active connector in the registry (${REGISTRY_PATH_ENV}) — the service stays idle`);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const registryPath = resolveRegistryPath(process.env[REGISTRY_PATH_ENV]);
  const registry = loadRegistry(registryPath);
  const kernel = createKernel(registry, GEO_SOURCES);

  let stopping = false;
  const stop = (exitCode: number): void => {
    if (stopping) {
      // A fatal error during the shutdown: no second attempt.
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }
    stopping = true;
    // After a fatal error the shutdown may hang on whatever broke.
    if (exitCode !== 0) {
      setTimeout(() => {
        process.exit(exitCode);
      }, FATAL_EXIT_DEADLINE_MS).unref();
    }
    kernel.shutdown.abort();
    kernel.scheduler.stop();
    kernel.geoBootstrap?.stop();
    // The state store last: its close writes what is still marked and
    // releases the writer lock for the next instance.
    void Promise.all([kernel.publicHttp.close(), kernel.adminHttp.close()])
      .then(() => kernel.persistence?.close())
      .catch((error: unknown) => {
        kernel.log.error("state store: close failed", error);
      })
      .then(() => {
        process.exit(exitCode);
      });
  };
  // A stray rejection or exception: logged with the [error] marker, then the
  // shutdown with exit code 1 (src/kernel/log.ts).
  handleFatalErrors(kernel.log, () => {
    stop(1);
  });

  kernel.log.info(`udp-connectors ${VERSION} — registry ${registryPath}`);

  const scheduled = kernel.registry.activeEntries().filter((entry) => CONNECTORS.has(entry.id));
  reportPlan(kernel, scheduled);

  scheduled.forEach((entry, position) => {
    const module = CONNECTORS.get(entry.id);
    if (module === undefined) return;
    const schedule = scheduleOf(entry, position, module.routes !== undefined);
    const ctx = createCtx(kernel, entry);
    kernel.scheduler.add(entry.id, schedule, () => runConnector(kernel, ctx, module));
    // Built with the connector's own ctx: its log, its limiter share, its Orion.
    for (const route of module.routes?.(ctx) ?? []) kernel.publicHttp.register(route);
    kernel.log.info(
      `${entry.id}: ${schedule.kind}` +
        (schedule.cron === null ? "" : ` "${schedule.cron}"`) +
        (schedule.intervalSeconds === null ? "" : ` every ${String(schedule.intervalSeconds)} s`) +
        (schedule.offsetSeconds === null || schedule.offsetSeconds === undefined
          ? ""
          : ` on slots from 00:00 UTC + ${String(schedule.offsetSeconds)} s`) +
        (schedule.fireOnStart
          ? `, first run in ${String(schedule.startupDelaySeconds)} s` +
            (schedule.resume === true ? " unless its last run is recent" : "")
          : ", no run on start"),
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
  // The geo context before the first run (src/kernel/geo-bootstrap.ts): the
  // two files from the cockpit, wherever stammdaten-bw/grenzen-bw run. After
  // listen, so the probes answer while the cockpit is slow; with no scheduled
  // connector nothing is fetched.
  await startGeoBootstrap(kernel, scheduled.length);
  // The persisted last runs are loaded with the state above.
  kernel.scheduler.start(storedLastRuns(kernel.state));

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      kernel.log.info(`${signal} received, shutting down`);
      stop(0);
    });
  }
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
