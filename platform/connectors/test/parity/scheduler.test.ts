/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Startup order of the scheduler. A connector that serves a public endpoint
 * starts right away: in the stagger, abfahrten-on-demand came last and
 * /abfahrten answered 503 for five minutes after every restart (observed in a
 * production installation).
 * refireOnRestart: false still wins — it protects rate-limited sources.
 */

import assert from "node:assert/strict";

import { connector as abfahrtenOnDemand } from "../../src/connectors/abfahrten-on-demand.js";
import { connector as warnungenBw } from "../../src/connectors/warnungen-bw.js";
import { connector as pegelBw } from "../../src/connectors/pegel-bw.js";
import {
  DEFAULT_STARTUP_DELAY_SECONDS,
  DEFAULT_STARTUP_STEP_SECONDS,
  MAX_STARTUP_DELAY_SECONDS,
  RESTART_DELAY_SECONDS,
  ROUTE_STARTUP_DELAY_SECONDS,
  createScheduler,
  scheduleOf,
} from "../../src/kernel/scheduler.js";
import { parseRegistry } from "../../src/kernel/registry.js";
import { recordingLog } from "../harness/kernel.js";
import { registryEntry } from "../harness/g-transport.js";

function routeConnectorsStartFirst(): void {
  // The real modules decide, not a flag in the test: both endpoint connectors
  // expose routes, a plain ingestion connector does not.
  assert.notEqual(abfahrtenOnDemand.routes, undefined);
  assert.notEqual(warnungenBw.routes, undefined);
  assert.equal(pegelBw.routes, undefined);

  const late = 20;
  const endpoint = scheduleOf(registryEntry("abfahrten-on-demand"), late, true);
  assert.equal(endpoint.startupDelaySeconds, ROUTE_STARTUP_DELAY_SECONDS);

  const plain = scheduleOf(registryEntry("pegel-bw"), late, false);
  assert.equal(
    plain.startupDelaySeconds,
    Math.min(DEFAULT_STARTUP_DELAY_SECONDS + late * DEFAULT_STARTUP_STEP_SECONDS, MAX_STARTUP_DELAY_SECONDS),
  );
}

function refireOnRestartFalseStillWins(): void {
  const guarded = scheduleOf(registryEntry("pegel-bw", { refireOnRestart: false }), 0, true);
  assert.equal(guarded.startupDelaySeconds, RESTART_DELAY_SECONDS);
}

async function intervalCountsFromTheFirstRun(): Promise<void> {
  // Startup delay equal to the interval, as efa-abfahrten has in the registry
  // (300 s each), scaled down to 1 s. Before, the first interval tick came right
  // on top of the delayed first run and was skipped with a [warn].
  const log = recordingLog();
  const scheduler = createScheduler(log);
  const started: number[] = [];
  const t0 = Date.now();
  scheduler.add(
    "demo",
    { kind: "interval", intervalSeconds: 1, cron: null, fireOnStart: true, startupDelaySeconds: 1 },
    () => {
      started.push(Date.now() - t0);
      return new Promise((resolve) => setTimeout(resolve, 300));
    },
  );
  scheduler.start();
  // Keeps the event loop alive while only the scheduler's timers are pending.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  scheduler.stop();
  assert.equal(started.length, 2, `runs started at ${started.join(", ")} ms`);
  const [first = 0, second = 0] = started;
  assert.ok(
    second - first >= 900,
    `second run ${String(second - first)} ms after the first, expected about one interval`,
  );
  assert.deepEqual(
    log.lines.filter((line) => line.level === "warn"),
    [],
    "no skipped-trigger warning after the start",
  );
}

function nightlyJobsDoNotFireOnStart(): void {
  // Both nightly jobs: their cron is their only trigger. A restart must not
  // start a database maintenance pass or ~1,500 MaStR requests.
  for (const id of ["troe-retention", "mastr-bw"]) {
    const schedule = scheduleOf(registryEntry(id), 0, false);
    assert.equal(schedule.kind, "cron", id);
    assert.equal(schedule.fireOnStart, false, `${id} fires on start`);
  }
  // Missing means true, as before.
  assert.equal(scheduleOf(registryEntry("pegel-bw"), 0, false).fireOnStart, true);
  assert.equal(scheduleOf(registryEntry("pegel-bw", { refireOnRestart: false }), 0, false).fireOnStart, true);

  // The registry refuses what would never run, and anything but a boolean.
  const entry = (extra: Record<string, unknown>): unknown => ({
    connectors: [{ id: "x", name: "X", scope: "land", ...extra }],
  });
  assert.equal(parseRegistry(entry({ cron: "40 03 * * *", fireOnStart: false }))[0]?.fireOnStart, false);
  assert.equal(parseRegistry(entry({ intervalSeconds: 60, fireOnStart: false }))[0]?.fireOnStart, false);
  assert.equal(parseRegistry(entry({ intervalSeconds: 60 }))[0]?.fireOnStart, true);
  assert.throws(() => parseRegistry(entry({ fireOnStart: false })), /would never run/);
  assert.throws(
    () => parseRegistry(entry({ intervalSeconds: 0, cron: "", fireOnStart: false })),
    /would never run/,
  );
  assert.throws(() => parseRegistry(entry({ intervalSeconds: 60, fireOnStart: "no" })), /expected boolean/);
}

async function noStartRunWithoutFireOnStart(): Promise<void> {
  const log = recordingLog();
  const scheduler = createScheduler(log);
  const t0 = Date.now();
  const started: number[] = [];
  scheduler.add(
    "nightly",
    { kind: "interval", intervalSeconds: 1, cron: null, fireOnStart: false, startupDelaySeconds: 0 },
    () => {
      started.push(Date.now() - t0);
      return Promise.resolve();
    },
  );
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(started.length, 0, "fired on start");
  await new Promise((resolve) => setTimeout(resolve, 800));
  scheduler.stop();
  assert.equal(started.length, 1, `runs started at ${started.join(", ")} ms`);
  assert.ok((started[0] ?? 0) >= 900, "the first run is the first interval tick");
}

export {
  nightlyJobsDoNotFireOnStart as "scheduler: fireOnStart false (troe-retention, mastr-bw) skips the start run; the registry refuses it without a schedule",
  noStartRunWithoutFireOnStart as "scheduler: a job without fireOnStart runs first on its schedule, not on start",
  intervalCountsFromTheFirstRun as "scheduler: the interval counts from the first run, so a delay equal to it causes no skip",
  routeConnectorsStartFirst as "scheduler: connectors serving public endpoints start right away, not in the stagger",
  refireOnRestartFalseStillWins as "scheduler: refireOnRestart false keeps its 600 s delay even for an endpoint connector",
};
