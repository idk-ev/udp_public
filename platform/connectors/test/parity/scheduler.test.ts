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
import { runConnector } from "../../src/kernel/context.js";
import { lastRunOf } from "../../src/kernel/run-log.js";
import {
  DEFAULT_STARTUP_DELAY_SECONDS,
  DEFAULT_STARTUP_STEP_SECONDS,
  MAX_STARTUP_DELAY_SECONDS,
  RESTART_DELAY_SECONDS,
  ROUTE_STARTUP_DELAY_SECONDS,
  createScheduler,
  planStart,
  scheduleOf,
  slotBounds,
} from "../../src/kernel/scheduler.js";
import { parseRegistry } from "../../src/kernel/registry.js";
import { recordingLog } from "../harness/kernel.js";
import { registryEntry } from "../harness/g-transport.js";
import { weatherCtx, weatherFetcher } from "../harness/weather-ctx.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

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

/* ── restarts and wall-clock slots ─────────────────────────────────────────────*/

function forecastOffsetSurvivesRestarts(): void {
  const weather = scheduleOf(registryEntry("wetter-bw"), 5, false);
  const forecast = scheduleOf(registryEntry("vorhersage-bw"), 6, false);
  assert.equal(weather.intervalSeconds, 6 * 3600);
  assert.equal(forecast.intervalSeconds, 6 * 3600);
  assert.equal(
    (forecast.offsetSeconds ?? 0) - (weather.offsetSeconds ?? 0),
    3 * 3600,
    "the forecast runs half an interval after the weather",
  );
  const slotsOf = (offset: number | null | undefined, restart: number): number[] => {
    const out: number[] = [];
    let at = restart;
    for (let i = 0; i < 8; i += 1) {
      at = slotBounds(at, 6 * HOUR, (offset ?? 0) * 1000).next;
      out.push(at);
    }
    return out;
  };
  const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
  // Restarts at odd instants over two days, DST change included: the slots
  // never move, and weather and forecast stay 3 h apart.
  for (
    let restart = Date.parse("2026-10-24T00:00:00Z");
    restart < Date.parse("2026-10-26T00:00:00Z");
    restart += 37 * MINUTE + 13_000
  ) {
    const w = slotsOf(weather.offsetSeconds, restart);
    const f = slotsOf(forecast.offsetSeconds, restart);
    for (const at of w) assert.ok(["00:10", "06:10", "12:10", "18:10"].includes(utc(at)), utc(at));
    for (const at of f) assert.ok(["03:10", "09:10", "15:10", "21:10"].includes(utc(at)), utc(at));
    const merged = [...w, ...f].sort((a, b) => a - b);
    for (let i = 1; i < merged.length; i += 1)
      assert.equal((merged[i] ?? 0) - (merged[i - 1] ?? 0), 3 * HOUR);
  }
}

function noExtraRunWithinTheInterval(): void {
  const weather = scheduleOf(registryEntry("wetter-bw"), 0, false);
  assert.equal(weather.resume, true);
  const slot = Date.parse("2026-09-30T12:10:00Z");
  const delay = RESTART_DELAY_SECONDS * 1000;
  // The slot had its run: a restart adds none, whenever it happens in the slot.
  for (const restart of [slot + MINUTE, slot + 2 * HOUR, slot + 5 * HOUR]) {
    assert.equal(
      planStart(weather, restart, slot + 30_000).startRunInMs,
      null,
      `restart at +${String((restart - slot) / MINUTE)} min`,
    );
  }
  // A manual run later in the slot counts as well.
  assert.equal(planStart(weather, slot + 4 * HOUR, slot + 3 * HOUR).startRunInMs, null);
  // The slot's run was missed (service down at 12:10): catch it up, delayed.
  assert.equal(planStart(weather, slot + HOUR, slot - 6 * HOUR + 30_000).startRunInMs, delay);
  // … unless the next slot comes first.
  assert.equal(planStart(weather, slot + 6 * HOUR - 5 * MINUTE, slot - 6 * HOUR).startRunInMs, null);
  // Unknown last run (first start, database down): delayed start run as before.
  assert.equal(planStart(weather, slot + HOUR, null).startRunInMs, delay);
  // A last run "in the future" (clock set back) counts as unknown.
  assert.equal(planStart(weather, slot + HOUR, slot + 2 * HOUR).startRunInMs, delay);

  // Plain interval (refireOnRestart false): the start run waits for the interval.
  const station = scheduleOf(registryEntry("wetter-dwd-station"), 0, false);
  const now = Date.parse("2026-09-30T12:00:00Z");
  assert.equal(planStart(station, now, now - 1000 * 1000).startRunInMs, 2600 * 1000);
  assert.equal(planStart(station, now, now - 3500 * 1000).startRunInMs, delay, "never earlier than 600 s");
  assert.equal(planStart(station, now, now - 2 * HOUR).startRunInMs, delay);
  // Cron (weekly, refireOnRestart false): no start run within a day of the last.
  const townHalls = scheduleOf(registryEntry("rathaus-bw"), 0, false);
  assert.equal(planStart(townHalls, now, now - 2 * HOUR).startRunInMs, null);
  assert.equal(planStart(townHalls, now, now - 3 * 24 * HOUR).startRunInMs, delay);
  // Without refireOnRestart false the last run is not consulted.
  const gauges = scheduleOf(registryEntry("pegel-bw"), 0, false);
  assert.equal(gauges.resume, false);
  assert.equal(planStart(gauges, now, now - MINUTE).startRunInMs, gauges.startupDelaySeconds * 1000);
}

async function slotsAreWallClockAndRestartsAddNoRun(): Promise<void> {
  // Scaled down: slots of 1 s at offsets 0 and 0.5 s; job "a" ran just now.
  const log = recordingLog();
  const scheduler = createScheduler(log);
  const fired: Record<string, number[]> = { a: [], b: [] };
  const job = (id: string, offsetSeconds: number): void => {
    scheduler.add(
      id,
      {
        kind: "interval",
        intervalSeconds: 1,
        cron: null,
        fireOnStart: true,
        startupDelaySeconds: 0.1,
        offsetSeconds,
        resume: true,
      },
      () => {
        fired[id]?.push(Date.now());
        return Promise.resolve();
      },
    );
  };
  job("a", 0);
  job("b", 0.5);
  const started = Date.now();
  scheduler.start((id) => (id === "a" ? started : null));
  await new Promise((resolve) => setTimeout(resolve, 2300));
  scheduler.stop();
  const a = fired.a ?? [];
  const b = fired.b ?? [];
  assert.ok(a.length >= 2 && a.length <= 3, `a fired ${String(a.length)} times`);
  for (const at of a) {
    const phase = at % 1000;
    assert.ok(phase < 150 || phase > 950, `a off its slot: ${String(phase)} ms`);
  }
  // b had no last run: a start run (unless its slot came first), then its slots.
  for (const at of b.slice(-2)) {
    const phase = at % 1000;
    assert.ok(phase > 450 && phase < 650, `b off its slot: ${String(phase)} ms`);
  }
  assert.ok(
    log.lines.some((line) => line.text.startsWith("a: no start run")),
    "the skip is logged",
  );
}

async function runConnectorRecordsTheLastRun(): Promise<void> {
  const { fetcher } = weatherFetcher(() => ({ response: new Error("no network") }));
  const resumed = weatherCtx("wetter-bw", fetcher);
  const before = Date.now();
  await runConnector(resumed.kernel, resumed.ctx, { id: "wetter-bw", run: () => Promise.resolve() });
  const last = lastRunOf(resumed.ctx.state);
  assert.ok(last !== null && last >= before && last <= Date.now(), "the run's start is recorded");

  // A failed run is not recorded.
  const failing = weatherCtx("vorhersage-bw", fetcher);
  await assert.rejects(
    runConnector(failing.kernel, failing.ctx, {
      id: "vorhersage-bw",
      run: () => Promise.reject(new Error("boom")),
    }),
  );
  assert.equal(lastRunOf(failing.ctx.state), null);

  // Connectors that do not resume after a restart record nothing.
  const plain = weatherCtx("pegel-bw", fetcher);
  await runConnector(plain.kernel, plain.ctx, { id: "pegel-bw", run: () => Promise.resolve() });
  assert.equal(lastRunOf(plain.ctx.state), null);
}

function registryChecksTheOffset(): void {
  const entry = (extra: Record<string, unknown>): unknown => ({
    connectors: [{ id: "x", name: "X", scope: "land", ...extra }],
  });
  assert.equal(
    parseRegistry(entry({ intervalSeconds: 600, intervalOffsetSeconds: 60 }))[0]?.intervalOffsetSeconds,
    60,
  );
  assert.equal(parseRegistry(entry({ intervalSeconds: 600 }))[0]?.intervalOffsetSeconds, null);
  assert.throws(() => parseRegistry(entry({ intervalOffsetSeconds: 60 })), /needs an intervalSeconds/);
  assert.throws(
    () => parseRegistry(entry({ intervalSeconds: 600, cron: "* * * * *", intervalOffsetSeconds: 60 })),
    /needs an intervalSeconds and no cron/,
  );
  assert.throws(
    () => parseRegistry(entry({ intervalSeconds: 600, intervalOffsetSeconds: 600 })),
    /0 <= offset/,
  );
  assert.throws(
    () => parseRegistry(entry({ intervalSeconds: 600, intervalOffsetSeconds: -1 })),
    /0 <= offset/,
  );
}

export {
  forecastOffsetSurvivesRestarts as "scheduler: wall-clock slots keep the forecast 3 h after the weather across any restart",
  noExtraRunWithinTheInterval as "scheduler: refireOnRestart false adds no start run within the interval of the persisted last run",
  slotsAreWallClockAndRestartsAddNoRun as "scheduler: slot jobs fire on their wall-clock phase; a fresh last run skips the start run",
  runConnectorRecordsTheLastRun as "scheduler: runConnector persists the start of a completed run for resuming connectors only",
  registryChecksTheOffset as "scheduler: the registry checks intervalOffsetSeconds",
  nightlyJobsDoNotFireOnStart as "scheduler: fireOnStart false (troe-retention, mastr-bw) skips the start run; the registry refuses it without a schedule",
  noStartRunWithoutFireOnStart as "scheduler: a job without fireOnStart runs first on its schedule, not on start",
  intervalCountsFromTheFirstRun as "scheduler: the interval counts from the first run, so a delay equal to it causes no skip",
  routeConnectorsStartFirst as "scheduler: connectors serving public endpoints start right away, not in the stagger",
  refireOnRestartFalseStillWins as "scheduler: refireOnRestart false keeps its 600 s delay even for an endpoint connector",
};
