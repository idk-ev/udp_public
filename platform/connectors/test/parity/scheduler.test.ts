/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Startup order of the scheduler. A connector that serves a public endpoint
 * starts right away: in the stagger, abfahrten-on-demand came last and
 * /abfahrten answered 503 for five minutes after every restart (seen live).
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
  // Startup delay equal to the interval, as efa-abfahrten has in production
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

export {
  intervalCountsFromTheFirstRun as "scheduler: the interval counts from the first run, so a delay equal to it causes no skip",
  routeConnectorsStartFirst as "scheduler: connectors serving public endpoints start right away, not in the stagger",
  refireOnRestartFalseStillWins as "scheduler: refireOnRestart false keeps its 600 s delay even for an endpoint connector",
};
