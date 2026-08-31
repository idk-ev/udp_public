/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Entry point of the UDP connector service.
 *
 * Wires registry, scheduler and HTTP server together and starts the connectors
 * the registry marks as `"runtime": "app"`.
 *
 * **Phase 1 runs nothing.** Not because the wiring is missing — it is complete
 * below — but because no entry in platform/config/connectors.json carries the
 * field yet. That file is not touched here; the cutover is phase 4, one group of
 * connectors at a time with an observation window in between, and the way back
 * is to turn the field around. Until then the service starts, reports what it
 * WOULD run, and leaves the ingestion entirely to Node-RED.
 */

import { CONNECTORS } from "./connectors/index.js";
import { createCtx, createKernel } from "./kernel/context.js";
import type { Kernel } from "./kernel/context.js";
import { DEFAULT_PORT, jsonResponse, textResponse } from "./kernel/http.js";
import { loadRegistry, resolveRegistryPath, runtimeOf, REGISTRY_PATH_ENV } from "./kernel/registry.js";
import { scheduleOf } from "./kernel/scheduler.js";
import type { RegistryEntry, RouteDefinition } from "./kernel/types.js";

const VERSION = "1.0.0";

/** `GET /healthz` — liveness plus what is actually scheduled. */
function healthRoute(kernel: Kernel, started: number): RouteDefinition {
  return {
    method: "GET",
    path: "/healthz",
    handle(): Promise<{ status: number; contentType: string; body: string }> {
      return Promise.resolve(
        jsonResponse(200, {
          status: "ok",
          version: VERSION,
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          connectors: kernel.scheduler.jobs().map((job) => ({
            id: job.id,
            kind: job.schedule.kind,
            intervalSeconds: job.schedule.intervalSeconds,
            cron: job.schedule.cron,
            startupDelaySeconds: job.schedule.startupDelaySeconds,
          })),
        }),
      );
    },
  };
}

/**
 * `POST /trigger/:id` — the replacement for `scripts/trigger-connector.sh`'s
 * detour over `nodePrefixes` and the Node-RED admin API. Answers immediately;
 * the run happens in the background, as posting to an inject node did.
 */
function triggerRoute(kernel: Kernel): RouteDefinition {
  return {
    method: "POST",
    path: "/trigger/:id",
    handle(request): Promise<{ status: number; contentType: string; body: string }> {
      const id = request.params.id ?? "";
      if (kernel.scheduler.trigger(id)) {
        kernel.log.info(`${id}: triggered via POST /trigger/${id}`);
        return Promise.resolve(jsonResponse(202, { id, triggered: true }));
      }
      const known = kernel.registry.byId(id);
      const reason =
        known === undefined
          ? `unknown connector "${id}"`
          : `connector "${id}" is not scheduled here (runtime: ${runtimeOf(known)}, active: ${String(known.active)})`;
      return Promise.resolve(textResponse(404, `${reason}\n`));
    },
  };
}

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
    kernel.scheduler.add(entry.id, schedule, () => module.run(ctx));
    for (const route of module.routes ?? []) kernel.http.register(route);
    kernel.log.info(
      `${entry.id}: ${schedule.kind}` +
        (schedule.cron === null ? "" : ` "${schedule.cron}"`) +
        (schedule.intervalSeconds === null ? "" : ` every ${String(schedule.intervalSeconds)} s`) +
        `, first run in ${String(schedule.startupDelaySeconds)} s`,
    );
  });

  kernel.http.register(healthRoute(kernel, started));
  kernel.http.register(triggerRoute(kernel));
  await kernel.http.listen(Number(process.env.UDP_CONNECTORS_PORT ?? DEFAULT_PORT));
  kernel.scheduler.start();

  const stop = (signal: string): void => {
    kernel.log.info(`${signal} received, shutting down`);
    kernel.shutdown.abort();
    kernel.scheduler.stop();
    void kernel.http.close().then(() => {
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
  process.stderr.write(`    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
