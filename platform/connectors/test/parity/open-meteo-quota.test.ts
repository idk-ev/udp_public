/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Open-Meteo quota (src/connectors/open-meteo-batches.ts, "Quota"): the
 * per-minute bound of the shared bucket, HTTP 429 with `Retry-After`, the
 * daily budget with the weather's priority, the persisted counter per UTC
 * day, and the weight of both connectors' calls.
 *
 * The pacing tests run both connectors through the REAL rate limiter on a
 * simulated clock: 20 s per call would otherwise make a run 140 s long.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_DAILY_CAP,
  MAX_BATCH_COORDINATES,
  MINUTE_LIMIT,
  OPEN_METEO_HOST,
  REQUEST_INTERVAL_MS,
  callWeight,
  forecastDays,
  retryAfterMs,
  sliceBatches,
  variableCount,
  weatherReserve,
} from "../../src/connectors/open-meteo-batches.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import * as vorhersage from "../../src/connectors/vorhersage-bw.js";
import * as wetter from "../../src/connectors/wetter-bw.js";
import { isArray, isRecord } from "../../src/kernel/parse.js";
import { QUOTA_STATE_KEY, QuotaBook } from "../../src/kernel/quota.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { storedLastRuns, recordRun, LAST_RUN_STATE_KEY } from "../../src/kernel/run-log.js";
import { StateStore, StateUnavailableError, persisted, stateKey } from "../../src/kernel/state.js";
import type { StateHooks } from "../../src/kernel/state.js";
import type { MunicipalityRow, RateLimiter } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { recordingLog } from "../harness/kernel.js";
import { VirtualClock } from "../harness/virtual-clock.js";
import {
  MUNICIPALITIES_URL,
  OPEN_METEO_PREFIX,
  jsonAnswer,
  recordingLimiter,
  upsertedBatches,
  weatherCtx,
  weatherFetcher,
  type ScriptedAnswer,
  type SeenCall,
} from "../harness/weather-ctx.js";

const MINUTE = 60_000;

function forecastEntry(): {
  readonly intervalSeconds: number | null;
  readonly intervalOffsetSeconds: number | null;
} {
  const { fetcher } = weatherFetcher(() => ({ response: new Error("no network") }));
  return weatherCtx("vorhersage-bw", fetcher).ctx.entry;
}
const HOUR = 3_600_000;
/** Municipalities of Baden-Württemberg: 7 batches of 138 and one of 137. */
const MUNICIPALITIES = 1103;

/* ------------------------------------------------------------------ simulated time */

/* ------------------------------------------------------------------ network */

/** `n` municipalities in the format of bw-gemeinden.json. */
function municipalities(n: number): Record<string, unknown> {
  const payload = readFixture("stammdaten-bw").payload;
  assert.ok(isRecord(payload) && isArray(payload.gemeinden));
  const template: unknown = payload.gemeinden[0];
  assert.ok(isArray(template));
  const gemeinden = Array.from({ length: n }, (_, i) => {
    const row = [...template];
    row[0] = `08${String(i).padStart(6, "0")}`;
    row[1] = `Gemeinde ${String(i)}`;
    row[2] = 47.6 + (i % 100) / 100;
    row[3] = 7.6 + Math.floor(i / 100) / 10;
    row[8] = `gemeinde-${String(i)}`;
    return row;
  });
  return { ...payload, gemeinden };
}

function coordinatesOf(url: string): number {
  return (new URL(url).searchParams.get("latitude") ?? "").split(",").length;
}

/** A location answer good for both connectors. */
const LOCATION = {
  current: {
    temperature_2m: 12,
    wind_speed_10m: 5,
    wind_direction_10m: 180,
    precipitation: 0,
    apparent_temperature: 11,
    uv_index: 2,
  },
  daily: {
    time: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"],
    temperature_2m_max: [15, 16, 17, 18],
    temperature_2m_min: [5, 6, 7, 8],
    precipitation_sum: [0, 1, 0, 0],
    wind_speed_10m_max: [10, 12, 8, 9],
    uv_index_max: [3, 3, 2, 2],
    weather_code: [1, 2, 3, 1],
    sunrise: ["2026-09-30T07:15", "2026-10-01T07:16", "2026-10-02T07:18", "2026-10-03T07:19"],
    sunset: ["2026-09-30T19:05", "2026-10-01T19:03", "2026-10-02T19:01", "2026-10-03T18:59"],
  },
};

interface Sent {
  readonly at: number;
  readonly url: string;
  readonly coordinates: number;
}

/**
 * The network of both connectors: the municipalities, Open-Meteo (answered by
 * `answer`, 200 with one location per coordinate unless it says otherwise)
 * and the upserts. Every Open-Meteo call is recorded at the simulated time.
 */
function network(
  now: () => number,
  answer?: (call: SeenCall, index: number, at: number) => ScriptedAnswer | undefined,
): {
  readonly fetcher: ReturnType<typeof weatherFetcher>["fetcher"];
  readonly seen: SeenCall[];
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const payload = municipalities(MUNICIPALITIES);
  const { fetcher, seen } = weatherFetcher((call) => {
    if (call.url === MUNICIPALITIES_URL) return jsonAnswer(200, payload);
    if (call.url.startsWith(OPEN_METEO_PREFIX)) {
      const coordinates = coordinatesOf(call.url);
      sent.push({ at: now(), url: call.url, coordinates });
      return (
        answer?.(call, sent.length - 1, now()) ??
        jsonAnswer(
          200,
          Array.from({ length: coordinates }, () => LOCATION),
        )
      );
    }
    if (call.method === "POST") return { response: { status: 204, ok: true, headers: {}, body: "" } };
    return { response: new Error(`unexpected call ${call.url}`) };
  });
  return { fetcher, seen, sent };
}

/** Coordinates and starts in the busiest CLOSED 60 s window `[t, t + 60 s]`. */
function busiestMinute(sent: readonly Sent[]): { readonly coordinates: number; readonly starts: number } {
  let coordinates = 0;
  let starts = 0;
  for (const first of sent) {
    const inside = sent.filter((s) => s.at >= first.at && s.at <= first.at + MINUTE);
    coordinates = Math.max(
      coordinates,
      inside.reduce((sum, s) => sum + s.coordinates, 0),
    );
    starts = Math.max(starts, inside.length);
  }
  return { coordinates, starts };
}

const JOIN = { count: 8, timeoutMs: 1_000_000_000 };
const T0 = Date.parse("2026-09-30T00:10:00Z");

function simulated(start = T0): {
  readonly clock: VirtualClock;
  readonly limiter: RateLimiter;
  readonly state: StateStore;
} {
  const clock = new VirtualClock(start);
  return { clock, limiter: createRateLimiter(recordingLog(), clock), state: new StateStore() };
}

/* ------------------------------------------------------------------ minute */

async function perMinuteBoundHolds(): Promise<void> {
  const rows: readonly MunicipalityRow[] = parseMunicipalities(municipalities(MUNICIPALITIES)).gemeinden;
  assert.deepEqual(
    sliceBatches(rows).map((batch) => batch.length),
    [138, 138, 138, 138, 138, 138, 138, 137],
  );
  assert.ok(sliceBatches(rows).every((batch) => batch.length <= MAX_BATCH_COORDINATES));

  const { clock, limiter, state } = simulated();
  const net = network(() => clock.time);
  const weather = weatherCtx("wetter-bw", net.fetcher, { limiter, state });
  const forecast = weatherCtx("vorhersage-bw", net.fetcher, { limiter, state });
  const now = (): number => clock.time;

  // Two cycles as scheduled: weather, forecast 3 h later, weather, forecast.
  for (const [runner, ctx, offset] of [
    [wetter, weather.ctx, 0],
    [vorhersage, forecast.ctx, 3 * HOUR],
    [wetter, weather.ctx, 6 * HOUR],
    [vorhersage, forecast.ctx, 9 * HOUR],
  ] as const) {
    clock.time = Math.max(clock.time, T0 + offset);
    await clock.run(runner.runWith(ctx, JOIN, now));
  }
  // The edge case the offset removes but a manual trigger can bring back:
  // both connectors at the same instant, their calls interleaved in the bucket.
  clock.time = T0 + 12 * HOUR;
  await clock.run(
    Promise.all([wetter.runWith(weather.ctx, JOIN, now), vorhersage.runWith(forecast.ctx, JOIN, now)]),
  );

  assert.equal(net.sent.length, 6 * 8, "six runs of eight calls, nothing skipped");
  const busiest = busiestMinute(net.sent);
  assert.ok(busiest.coordinates <= MINUTE_LIMIT, `${String(busiest.coordinates)} coordinates in one minute`);
  assert.equal(busiest.starts, 4, "t, t+20, t+40, t+60: four starts in a closed minute");
  assert.equal(busiest.coordinates, 4 * 138);
  for (let i = 1; i < net.sent.length; i += 1) {
    const gap = (net.sent[i]?.at ?? 0) - (net.sent[i - 1]?.at ?? 0);
    assert.ok(
      gap >= REQUEST_INTERVAL_MS,
      `calls ${String(i)} and ${String(i + 1)} only ${String(gap)} ms apart`,
    );
  }
  // The flow's 15 s would have fitted five starts: 690 coordinates.
  assert.ok(5 * 138 > MINUTE_LIMIT);
  assert.equal(weather.ctx.quota.used(OPEN_METEO_HOST), 6 * MUNICIPALITIES, "every coordinate charged once");
  assert.deepEqual(weather.log.warnings(), []);
  assert.deepEqual(forecast.log.warnings(), []);
}

/* ------------------------------------------------------------------ 429 */

function retryAfterIsParsed(): void {
  const now = Date.parse("2026-09-30T12:00:00Z");
  assert.equal(retryAfterMs("120", now), 120_000);
  assert.equal(retryAfterMs(" 0 ", now), 0);
  assert.equal(retryAfterMs("Wed, 30 Sep 2026 12:02:30 GMT", now), 150_000);
  assert.equal(retryAfterMs("Wed, 30 Sep 2026 11:00:00 GMT", now), 0, "a date in the past: no pause");
  assert.equal(retryAfterMs("soon", now), null);
  assert.equal(retryAfterMs("1.5", now), null, "no lenient date parsing");
  assert.equal(retryAfterMs("2026-09-30T12:05:00Z", now), null, "only the HTTP date format");
  assert.equal(retryAfterMs(undefined, now), null);
}

/** A 429 on the second call with the given header; everything else answers. */
async function retryAfter429(header: (at: number) => string, pauseMs: number): Promise<void> {
  const { clock, limiter, state } = simulated();
  const net = network(
    () => clock.time,
    (_call, index, at) =>
      index === 1
        ? { response: { status: 429, ok: false, headers: { "Retry-After": header(at) }, body: "" } }
        : undefined,
  );
  const { ctx, log } = weatherCtx("wetter-bw", net.fetcher, { limiter, state });
  await clock.run(wetter.runWith(ctx, JOIN, () => clock.time));

  const times = net.sent.map((s) => s.at - T0);
  const refused = net.sent[1];
  assert.ok(refused !== undefined);
  assert.equal(times[1], REQUEST_INTERVAL_MS);
  // The pause holds every call of the host; then the queue resumes at its pace.
  assert.equal(
    times[2],
    REQUEST_INTERVAL_MS + pauseMs,
    `first call after the pause at ${String(times[2])} ms`,
  );
  assert.equal(net.sent.length, 9, "eight batches and ONE retry");
  const retry = net.sent[8];
  assert.equal(retry?.url, refused.url, "the retry is the refused batch");
  assert.equal(net.sent.filter((s) => s.url === refused.url).length, 2);
  for (let i = 3; i < net.sent.length; i += 1) {
    assert.equal((times[i] ?? 0) - (times[i - 1] ?? 0), REQUEST_INTERVAL_MS);
  }
  assert.equal(upsertedBatches(net.seen).flat().length, MUNICIPALITIES, "nothing lost");
  assert.deepEqual(log.warnings(), [
    `BW weather: batch 2/8 (138 municipalities): HTTP 429, Open-Meteo asks for a pause of ` +
      `${String(pauseMs / 1000)} s — all Open-Meteo calls wait, then this batch is retried once`,
  ]);
  assert.ok(
    log.lines.some((line) =>
      line.text.endsWith("batch 2/8 (138 municipalities): retry after HTTP 429 succeeded"),
    ),
  );
}

async function retryAfterSeconds(): Promise<void> {
  await retryAfter429(() => "90", 90_000);
}

async function retryAfterHttpDate(): Promise<void> {
  await retryAfter429((at) => new Date(at + 120_000).toUTCString(), 120_000);
}

async function missingRetryAfterPausesAMinute(): Promise<void> {
  const limiter = recordingLimiter();
  let calls = 0;
  const net = network(Date.now, () => {
    calls += 1;
    return calls === 1 ? { response: { status: 429, ok: false, headers: {}, body: "" } } : undefined;
  });
  const { ctx } = weatherCtx("wetter-bw", net.fetcher, { limiter });
  await wetter.runWith(ctx, JOIN);
  assert.deepEqual(limiter.paused, [{ host: OPEN_METEO_HOST, ms: 60_000 }]);
  assert.equal(net.sent.length, 9);
}

async function second429EndsTheRun(): Promise<void> {
  const { clock, limiter, state } = simulated();
  const net = network(
    () => clock.time,
    () => ({ response: { status: 429, ok: false, headers: { "retry-after": "30" }, body: "" } }),
  );
  const { ctx, log } = weatherCtx("wetter-bw", net.fetcher, { limiter, state });
  await clock.run(wetter.runWith(ctx, JOIN, () => clock.time));

  assert.equal(net.sent.length, 2, "the first 429 is retried once, the second ends the run");
  assert.equal((net.sent[1]?.at ?? 0) - T0, 30_000, "after the pause");
  assert.deepEqual(upsertedBatches(net.seen), []);
  const warnings = log.warnings();
  assert.match(
    warnings[1] ?? "",
    /batch 2\/8 \(138 municipalities\): HTTP 429, Open-Meteo asks for a pause of 30 s — the rest of the run is not sent/,
  );
  assert.match(
    warnings.at(-1) ?? "",
    /^BW weather: batches 1, 3, 4, 5, 6, 7, 8 of 8 skipped, 965 municipalities keep their previous values — HTTP 429/,
  );
}

async function longPauseSkipsInsteadOfWaiting(): Promise<void> {
  const { clock, limiter, state } = simulated();
  let calls = 0;
  const net = network(
    () => clock.time,
    () => {
      calls += 1;
      return calls === 1
        ? { response: { status: 429, ok: false, headers: { "Retry-After": "3600" }, body: "" } }
        : undefined;
    },
  );
  const weather = weatherCtx("wetter-bw", net.fetcher, { limiter, state });
  await clock.run(wetter.runWith(weather.ctx, JOIN, () => clock.time));
  assert.equal(net.sent.length, 1, "an hour's pause is not waited for: no retry, rest skipped");
  assert.deepEqual(upsertedBatches(net.seen), []);

  // The next run (the other connector, same host) does not queue for an hour.
  const forecast = weatherCtx("vorhersage-bw", net.fetcher, { limiter, state });
  const start = clock.time;
  await clock.run(vorhersage.runWith(forecast.ctx, JOIN, () => clock.time));
  assert.equal(net.sent.length, 1);
  assert.ok(clock.time - start < MINUTE, "skipped at once");
  assert.match(
    forecast.log.warnings().at(-1) ?? "",
    /^BW forecast: batches 1, 2, 3, 4, 5, 6, 7, 8 of 8 skipped, 1103 municipalities keep their previous values — Open-Meteo asked for a pause until /,
  );
}

/* ------------------------------------------------------------------ day */

async function dailyCapWithWeatherPriority(): Promise<void> {
  const state = new StateStore();
  const limiter = recordingLimiter();
  const net = network(Date.now);
  const weather = weatherCtx("wetter-bw", net.fetcher, { limiter, state });
  const forecast = weatherCtx("vorhersage-bw", net.fetcher, { limiter, state });
  // Earlier today: 50 short of room for one more run of each.
  const earlier = DEFAULT_DAILY_CAP - MUNICIPALITIES - 50;
  weather.ctx.quota.charge(OPEN_METEO_HOST, earlier);

  // The forecast of 15:10 UTC yields: the weather of 18:10 must still fit.
  const at1510 = (): number => Date.parse("2026-09-30T15:10:00Z");
  await vorhersage.runWith(forecast.ctx, JOIN, at1510);
  assert.equal(net.sent.length, 0);
  assert.match(
    forecast.log.warnings().join("\n"),
    new RegExp(
      `batches 1, 2, 3, 4, 5, 6, 7, 8 of 8 skipped, 1103 municipalities keep their previous values — ` +
        `daily Open-Meteo budget: ${String(earlier)} calls today \\(UTC\\), 138 more would pass ` +
        `${String(DEFAULT_DAILY_CAP - MUNICIPALITIES)} \\(cap ${String(DEFAULT_DAILY_CAP)} less 1103 kept for the ` +
        `weather runs due today\\)`,
    ),
  );
  // The weather still fits.
  await wetter.runWith(weather.ctx, JOIN);
  assert.equal(net.sent.length, 8);
  assert.equal(weather.ctx.quota.used(OPEN_METEO_HOST), DEFAULT_DAILY_CAP - 50);
  assert.deepEqual(weather.log.warnings(), []);
  // The next one would pass the cap: refused before it is sent.
  await wetter.runWith(weather.ctx, JOIN);
  assert.equal(net.sent.length, 8);
  assert.match(weather.log.warnings().at(-1) ?? "", /daily Open-Meteo budget/);
  assert.equal(weather.ctx.quota.used(OPEN_METEO_HOST), DEFAULT_DAILY_CAP - 50, "nothing charged for skips");
}

function forecastReservesTheWeatherRunsStillDue(): void {
  const entry = forecastEntry();
  const reserve = (utc: string): number => weatherReserve(Date.parse(utc), entry, MUNICIPALITIES);
  assert.equal(reserve("2026-09-30T00:05:00Z"), 4 * MUNICIPALITIES, "00:10, 06:10, 12:10, 18:10 ahead");
  assert.equal(reserve("2026-09-30T03:10:00Z"), 3 * MUNICIPALITIES);
  assert.equal(reserve("2026-09-30T09:10:00Z"), 2 * MUNICIPALITIES);
  assert.equal(reserve("2026-09-30T15:10:00Z"), MUNICIPALITIES);
  assert.equal(reserve("2026-09-30T21:10:00Z"), 0, "the day's weather is done: nothing to keep");
  // Normal day: 8 runs of 1,103 = 8,824 — each forecast run fits below its cap.
  let used = MUNICIPALITIES; // 00:10 weather
  for (const utc of ["03:10", "09:10", "15:10", "21:10"]) {
    const cap = DEFAULT_DAILY_CAP - reserve(`2026-09-30T${utc}:00Z`);
    assert.ok(
      used + MUNICIPALITIES <= cap,
      `forecast of ${utc} would be cut: ${String(used)} used, cap ${String(cap)}`,
    );
    used += 2 * MUNICIPALITIES; // the forecast and the next weather run
  }
  assert.equal(used - MUNICIPALITIES, 8 * MUNICIPALITIES);
  // A fork without slots keeps one run.
  assert.equal(weatherReserve(0, { intervalSeconds: 21_600, intervalOffsetSeconds: null }, 7), 7);
}

const HOOKS: StateHooks = {
  assertUsable: () => undefined,
  changed: () => undefined,
  invalid: () => undefined,
};

function counterResetsPerUtcDayAndSurvivesARestart(): void {
  const host = OPEN_METEO_HOST;
  let now = Date.parse("2026-09-30T22:30:00Z"); // 00:30 in Berlin — still 30 Sep in UTC
  const store = new StateStore();
  const book = new QuotaBook(store, () => now);
  book.charge("wetter-bw", store.scope("wetter-bw"), host, 1103);
  book.charge("vorhersage-bw", store.scope("vorhersage-bw"), host, 1103);
  assert.equal(book.used(host), 2206);

  // Restart: what the persistence would write, loaded into a new process.
  const restarted = new StateStore();
  for (const id of ["wetter-bw", "vorhersage-bw"]) {
    const written = store.attach(id, HOOKS).snapshot();
    assert.ok(written.has(QUOTA_STATE_KEY));
    restarted.attach(id, HOOKS).restore(written);
  }
  const after = new QuotaBook(restarted, () => now);
  assert.equal(after.used(host), 2206, "counted before either connector ran again");
  after.charge("wetter-bw", restarted.scope("wetter-bw"), host, 138);
  assert.equal(after.used(host), 2206 + 138, "continues from the stored share, not from zero, not twice");

  // 00:00 UTC resets the day.
  now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(after.used(host), 0);
  after.charge("vorhersage-bw", restarted.scope("vorhersage-bw"), host, 10);
  assert.equal(after.used(host), 10);
  const stored = restarted.attach("vorhersage-bw", HOOKS).snapshot().get(QUOTA_STATE_KEY);
  assert.deepEqual(stored, { [host]: { day: "2026-10-01", units: 10 } }, "the old day is dropped");
  // An unreadable stored value counts as nothing rather than failing.
  const broken = new StateStore();
  broken.attach("wetter-bw", HOOKS).restore(new Map([[QUOTA_STATE_KEY, { [host]: { day: 1 } }]]));
  assert.equal(new QuotaBook(broken, () => now).used(host), 0);
}

/* ------------------------------------------------------------------ weight */

function bothConnectorsStayAtWeightOne(): void {
  const rows = parseMunicipalities(municipalities(MUNICIPALITIES)).gemeinden;
  for (const [id, urls] of [
    ["wetter-bw", wetter.planBatches(rows).map((batch) => batch.url)],
    ["vorhersage-bw", vorhersage.planBatches(rows).map((batch) => batch.url)],
  ] as const) {
    for (const url of urls) {
      assert.ok(variableCount(url) <= 10, `${id}: ${String(variableCount(url))} variables, weight above 1`);
      assert.ok(forecastDays(url) <= 14, `${id}: ${String(forecastDays(url))} days, weight above 1`);
      assert.equal(callWeight(url), 1, id);
    }
  }
  assert.equal(variableCount(vorhersage.planBatches(rows)[0]?.url ?? ""), 10, "the forecast is at the limit");
  // One more variable, or three weeks, would cost more than one call per coordinate.
  const base = "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1";
  assert.equal(callWeight(`${base}&daily=a,b,c,d,e,f,g,h,i&current=j,k`), 1.1);
  assert.equal(callWeight(`${base}&daily=a&forecast_days=16`), 16 / 14);
  assert.equal(forecastDays(base), 7, "Open-Meteo's default");
}

/* ------------------------------------------------------------------ bucket */

async function pauseHoldsTheSharedBucket(): Promise<void> {
  const clock = new VirtualClock(0);
  const limiter = createRateLimiter(recordingLog(), clock);
  const granted: number[] = [];
  const take = async (): Promise<void> => {
    const release = await limiter.acquire("host", { minIntervalMs: 20_000 });
    granted.push(clock.time);
    release();
  };
  await clock.run(take());
  limiter.pause("host", 90_000);
  limiter.pause("host", 10_000); // shorter: changes nothing
  await clock.run(Promise.all([take(), take(), take()]));
  assert.deepEqual(granted, [0, 90_000, 110_000, 130_000]);
}

/* ------------------------------------------------------------------ state */

function bestEffortKeysDoNotNeedTheState(): void {
  // Hooks of a connector whose state is NOT loaded: every regular persisted key refuses.
  let asserted = 0;
  let changed = 0;
  const hooks: StateHooks = {
    assertUsable: () => {
      asserted += 1;
      throw new StateUnavailableError("not loaded");
    },
    changed: () => {
      changed += 1;
    },
    invalid: () => undefined,
  };
  const store = new StateStore();
  const snapshotter = store.attach("wetter-bw", hooks);
  const state = store.scope("wetter-bw");
  const regular = stateKey("test.regular", () => 0, persisted.number);
  assert.throws(() => state.slot(regular), StateUnavailableError);
  assert.equal(asserted, 1);

  // Best effort (the quota and the last run): readable and writable, without
  // asking whether the state is usable — which is what marks a connector as
  // needing its state (src/kernel/persistence.ts).
  const book = new QuotaBook(store, () => Date.parse("2026-09-30T12:00:00Z"));
  book.charge("wetter-bw", state, OPEN_METEO_HOST, 138);
  recordRun(state, 1_000);
  assert.equal(asserted, 1, "no usability check for best-effort keys");
  assert.equal(changed, 2, "changes are reported; the persistence ignores them while unloaded");
  assert.equal(book.used(OPEN_METEO_HOST), 138);

  // The load replaces the cells with what the store holds.
  snapshotter.restore(
    new Map<string, unknown>([
      [QUOTA_STATE_KEY, { [OPEN_METEO_HOST]: { day: "2026-09-30", units: 2000 } }],
      [LAST_RUN_STATE_KEY, 5_000],
    ]),
  );
  assert.deepEqual(snapshotter.snapshot().get(LAST_RUN_STATE_KEY), 5_000);
  assert.equal(book.used(OPEN_METEO_HOST), 2000, "the larger share wins (documented in quota.ts)");
  // The scheduler reads the stored value without creating a cell.
  const fresh = new StateStore();
  const loaded = fresh.attach("vorhersage-bw", hooks);
  loaded.restore(new Map<string, unknown>([[LAST_RUN_STATE_KEY, 7_000]]));
  const lastRuns = storedLastRuns(fresh);
  assert.equal(lastRuns("vorhersage-bw"), 7_000);
  assert.equal(lastRuns("wetter-bw"), null);
  assert.equal(loaded.snapshot().size, 0, "no state row for merely reading");
}

async function dailyCapFromTheEnvironment(): Promise<void> {
  const previous = process.env.UDP_OPEN_METEO_DAILY_CAP;
  try {
    // 7 × 138 = 966 fit into 1,000, the eighth batch (137) does not.
    process.env.UDP_OPEN_METEO_DAILY_CAP = "1000";
    const small = network(Date.now);
    const capped = weatherCtx("wetter-bw", small.fetcher);
    await wetter.runWith(capped.ctx, JOIN);
    assert.equal(small.sent.length, 7);
    assert.match(capped.log.warnings().at(-1) ?? "", /^BW weather: batch 8 of 8 skipped, 137 municipalities/);

    // Not a positive number: warned, and the default applies.
    process.env.UDP_OPEN_METEO_DAILY_CAP = "0";
    const net = network(Date.now);
    const fallback = weatherCtx("wetter-bw", net.fetcher);
    await wetter.runWith(fallback.ctx, JOIN);
    assert.equal(net.sent.length, 8);
    assert.deepEqual(fallback.log.warnings(), [
      `UDP_OPEN_METEO_DAILY_CAP=0 is not a positive number, using ${String(DEFAULT_DAILY_CAP)}`,
    ]);
  } finally {
    if (previous === undefined) delete process.env.UDP_OPEN_METEO_DAILY_CAP;
    else process.env.UDP_OPEN_METEO_DAILY_CAP = previous;
  }
}

export {
  bestEffortKeysDoNotNeedTheState as "state: best-effort keys (quota, last run) work without a loaded state and yield to the load",
  dailyCapFromTheEnvironment as "open-meteo: UDP_OPEN_METEO_DAILY_CAP sets the cap; a non-positive value falls back with a warning",
  perMinuteBoundHolds as "open-meteo: two cycles of both connectors (and both at once) never exceed 600 coordinates in a closed 60 s window",
  retryAfterIsParsed as "open-meteo: Retry-After as seconds or HTTP date",
  retryAfterSeconds as "open-meteo: HTTP 429 with Retry-After in seconds pauses the shared bucket, then retries the batch once",
  retryAfterHttpDate as "open-meteo: HTTP 429 with Retry-After as HTTP date pauses the shared bucket, then retries the batch once",
  missingRetryAfterPausesAMinute as "open-meteo: HTTP 429 without Retry-After pauses 60 s",
  second429EndsTheRun as "open-meteo: a second 429 in a run ends it; the rest is not sent and reported with indices",
  longPauseSkipsInsteadOfWaiting as "open-meteo: a pause longer than 5 min is not waited for; later runs skip while it lasts",
  dailyCapWithWeatherPriority as "open-meteo: the daily soft cap refuses batches; the forecast yields to the weather",
  forecastReservesTheWeatherRunsStillDue as "open-meteo: the forecast keeps the weather runs still due today free; a normal day fits",
  counterResetsPerUtcDayAndSurvivesARestart as "quota: the per-host counter survives a restart, sums all connectors and resets at 00:00 UTC",
  bothConnectorsStayAtWeightOne as "open-meteo: both connectors stay at ≤ 10 variables and ≤ 14 days (weight 1)",
  pauseHoldsTheSharedBucket as "rate limit: pause() holds every waiter of the host and never shortens",
};
