/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The two HTTP servers: `/trigger` exists on the admin port only, the trigger
 * refuses a second run within the cooldown or while one is active, a malformed
 * path is a 400 on both ports — plus the kernel wiring of `ctx.intervalMs`.
 *
 * Real servers on ephemeral ports of 127.0.0.1; only the clock is scripted.
 */

import assert from "node:assert/strict";
import { adminRoutes } from "../../src/kernel/admin.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { StateStore } from "../../src/kernel/state.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createCtx } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createFetcher } from "../../src/kernel/fetcher.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer, textResponse } from "../../src/kernel/http.js";
import type { HttpServer } from "../../src/kernel/http.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { createRegistry, parseRegistry } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import { recordingLog } from "../harness/kernel.js";
import type { RecordedLog } from "../harness/kernel.js";

const COOLDOWN_MS = 60_000;

interface Rig {
  readonly kernel: Kernel;
  readonly log: RecordedLog;
  readonly clock: { now: number };
  /** Resolves the currently running task of "demo". */
  finishRun(): void;
  runs(): number;
  url(server: HttpServer, path: string): string;
  close(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const log = recordingLog();
  const clock = { now: Date.parse("2026-09-01T00:00:00Z") };
  const env = createEnv();
  const limiter = createRateLimiter(log);
  const registry = createRegistry(
    parseRegistry({
      connectors: [
        { id: "demo", name: "Demo", scope: "land", intervalSeconds: 900, runtime: "app" },
        { id: "nightly", name: "Nightly", scope: "land", cron: "20 02 * * *", runtime: "app" },
      ],
    }),
  );
  const kernel: Kernel = {
    log,
    env,
    limiter,
    fetch: createFetcher(log, limiter),
    orionUrl: "http://orion-ld:1026",
    signatures: new SignatureStore(),
    state: new StateStore(),
    geo: createSharedGeo(log),
    registry,
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log, () => clock.now),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: () => clock.now,
  };

  let runs = 0;
  let finish: () => void = () => undefined;
  kernel.scheduler.add(
    "demo",
    { kind: "manual", intervalSeconds: null, cron: null, fireOnStart: false, startupDelaySeconds: 0 },
    () => {
      runs += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  for (const route of adminRoutes(kernel, { version: "test", started: clock.now, cooldownMs: COOLDOWN_MS })) {
    kernel.adminHttp.register(route);
  }
  // A connector route with a path parameter, as /abfahrten will have.
  kernel.publicHttp.register({
    method: "GET",
    path: "/echo/:value",
    handle: (request) => Promise.resolve(textResponse(200, request.params.value ?? "")),
  });
  await kernel.publicHttp.listen(0, "127.0.0.1");
  await kernel.adminHttp.listen(0, "127.0.0.1");

  return {
    kernel,
    log,
    clock,
    finishRun: () => {
      finish();
    },
    runs: () => runs,
    url: (server, path) => `http://127.0.0.1:${String(server.port() ?? 0)}${path}`,
    close: async () => {
      await Promise.all([kernel.publicHttp.close(), kernel.adminHttp.close()]);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function triggerLivesOnTheAdminPortOnly(): Promise<void> {
  const r = await rig();
  try {
    const onPublic = await fetch(r.url(r.kernel.publicHttp, "/trigger/demo"), { method: "POST" });
    assert.equal(onPublic.status, 404, "/trigger must not exist on the public port");
    assert.equal((await fetch(r.url(r.kernel.publicHttp, "/healthz"))).status, 404);
    assert.equal(r.runs(), 0);

    const onAdmin = await fetch(r.url(r.kernel.adminHttp, "/trigger/demo"), { method: "POST" });
    assert.equal(onAdmin.status, 202);
    assert.equal((await fetch(r.url(r.kernel.adminHttp, "/healthz"))).status, 200);
    assert.equal(r.runs(), 1);
    assert.equal((await fetch(r.url(r.kernel.adminHttp, "/trigger/nobody"), { method: "POST" })).status, 404);
  } finally {
    r.finishRun();
    await r.close();
  }
}

async function secondTriggerIsRefusedWith429(): Promise<void> {
  const r = await rig();
  const trigger = (): Promise<Response> =>
    fetch(r.url(r.kernel.adminHttp, "/trigger/demo"), { method: "POST" });
  try {
    assert.equal((await trigger()).status, 202);

    // The run is still active.
    const running = await trigger();
    assert.equal(running.status, 429);
    assert.match(await running.text(), /still active/);

    // Run finished, but within the cooldown.
    r.finishRun();
    await settle();
    r.clock.now += 10_000;
    const cooling = await trigger();
    assert.equal(cooling.status, 429);
    assert.equal(cooling.headers.get("retry-after"), "50");

    // After the cooldown it runs again.
    r.clock.now += COOLDOWN_MS;
    assert.equal((await trigger()).status, 202);
    assert.equal(r.runs(), 2, "refused triggers did not start runs");
    assert.deepEqual(
      r.log.lines.filter((line) => line.level === "error" || line.level === "warn"),
      [],
      "a refused trigger is not a fault",
    );
  } finally {
    r.finishRun();
    await r.close();
  }
}

async function malformedPercentEncodingIs400(): Promise<void> {
  const r = await rig();
  try {
    const admin = await fetch(r.url(r.kernel.adminHttp, "/trigger/%E0%A4%A"), { method: "POST" });
    assert.equal(admin.status, 400);
    const pub = await fetch(r.url(r.kernel.publicHttp, "/echo/%E0%A4%A"));
    assert.equal(pub.status, 400);
    assert.equal(await (await fetch(r.url(r.kernel.publicHttp, "/echo/K%C3%B6ln"))).text(), "Köln");
    assert.deepEqual(
      r.log.lines.filter((line) => line.level === "error"),
      [],
      "a client's malformed request is no [error] of the service",
    );
  } finally {
    await r.close();
  }
}

async function intervalMsComesFromTheRegistry(): Promise<void> {
  const r = await rig();
  try {
    const demo = r.kernel.registry.byId("demo");
    const nightly = r.kernel.registry.byId("nightly");
    assert.ok(demo !== undefined && nightly !== undefined);
    assert.equal(createCtx(r.kernel, demo).intervalMs(), 900_000);
    assert.equal(createCtx(r.kernel, demo).intervalMs(4), 3_600_000, "feinstaub-bw: four runs");
    assert.equal(createCtx(r.kernel, nightly).intervalMs(), 86_400_000, "a cron connector counts as daily");
    assert.equal(
      createCtx(r.kernel, demo).intervalMs(0),
      900_000,
      "a nonsensical multiplier falls back to 1",
    );
  } finally {
    await r.close();
  }
}

export {
  triggerLivesOnTheAdminPortOnly as "servers: /trigger and /healthz exist on the admin port only",
  secondTriggerIsRefusedWith429 as "servers: a second trigger while running or within the cooldown gets 429",
  malformedPercentEncodingIs400 as "servers: malformed percent-encoding is a 400 on both ports, no [error]",
  intervalMsComesFromTheRegistry as "kernel: ctx.intervalMs(runs) follows interval_ms of the generator",
};
