/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Cadence of the connectors — the replacement for the inject nodes.
 *
 * Three cases, exactly as in the flows: a repeat interval (`repeat`), a
 * five-field cron (`crontab`), and firing once at start (`once` with
 * `onceDelay`). They combine: every inject node in flows.json has `once: true`
 * on top of its interval or cron.
 *
 * ## refireOnRestart: false means DELAYED, not SKIPPED
 *
 * This is the smallest decision in the whole migration and the one most easily
 * botched. The generator's own comment says why:
 *
 *   > Seltene Quellen (Overpass u. a.) sollen nicht sofort bei jedem Neustart
 *   > feuern — sonst laufen Entwicklungs-Restarts in die Rate-Limits der
 *   > Anbieter. Sie ganz vom Start auszunehmen war aber der falsche Schluss:
 *   > Wer öfter neu startet als das Abrufintervall lang ist, lässt den
 *   > Konnektor verhungern (wetter-bw stand nach einem Abend mit vielen
 *   > Neustarts 11 h ohne Daten da). Deshalb: verzögert feuern statt gar nicht.
 *
 * The occasion was 21.07.2026, when several restarts in a row drove Open-Meteo
 * and Overpass into HTTP 429 — eight batch requests leave per wetter-bw run.
 * The answer was 600 s of delay, not silence. Reading the flag as "does not fire
 * on start" starves `rathaus-bw`, `ausflug-bw`, `wetter-bw` and `vorhersage-bw`.
 *
 * ## Startup delay of the remaining connectors
 *
 * In flows.json every inject node carries a hand-picked `onceDelay` between 8
 * and 900 s, spreading the start over a quarter of an hour. Those numbers live
 * in the generated file, not in the registry, and the registry is the only
 * input this service has. They are therefore replaced by a deterministic stagger
 * along the registry order (DEFAULT_STARTUP_STEP_SECONDS apart, capped). The
 * intent — do not send every source a request in the same second after a
 * restart — is preserved; the exact seconds are not. That is a deviation, and
 * the only one in this module.
 *
 * ## fireOnStart: false means SKIPPED
 *
 * The registry's `"fireOnStart": false` takes the start run away completely:
 * the interval or cron is the only trigger. Meant for nightly jobs whose cron
 * is enough and whose run is expensive — `troe-retention` (index checks,
 * deletes and a VACUUM of the TRoE tables on every restart) and `mastr-bw`
 * (~1,500 MaStR requests per run). The registry refuses it on an entry that
 * has neither, so it cannot starve a connector the way reading
 * `refireOnRestart: false` as "skip" would.
 */

import type {
  ConnectorId,
  Log,
  RegistryEntry,
  Schedule,
  ScheduledJob,
  Scheduler,
  TriggerResult,
} from "./types.js";

/** The delay the generator gives connectors with `refireOnRestart: false`. */
export const RESTART_DELAY_SECONDS = 600;

/** First connector fires this many seconds after start. */
export const DEFAULT_STARTUP_DELAY_SECONDS = 15;

/** Each further connector is pushed out by this much. */
export const DEFAULT_STARTUP_STEP_SECONDS = 20;

/**
 * Ceiling for the stagger. Kept below RESTART_DELAY_SECONDS so that a rate
 * limited source never ends up firing EARLIER than a well-behaved one.
 */
export const MAX_STARTUP_DELAY_SECONDS = 300;

/**
 * Derives the schedule of one connector.
 *
 * @param position Index within the connectors this service runs; drives the
 *                 stagger only.
 */
/**
 * First run of a connector that serves public endpoints (`routes`): right after
 * start, not in the stagger. Such a connector loads what its endpoint answers
 * from (the stop directory behind /abfahrten); in the stagger it came last and
 * the endpoint answered 503 for five minutes after every restart (observed in a
 * production installation).
 */
export const ROUTE_STARTUP_DELAY_SECONDS = 1;

export function scheduleOf(entry: RegistryEntry, position: number, servesRoutes = false): Schedule {
  const staggered = servesRoutes
    ? ROUTE_STARTUP_DELAY_SECONDS
    : Math.min(
        DEFAULT_STARTUP_DELAY_SECONDS + position * DEFAULT_STARTUP_STEP_SECONDS,
        MAX_STARTUP_DELAY_SECONDS,
      );
  const startupDelaySeconds = entry.refireOnRestart === false ? RESTART_DELAY_SECONDS : staggered;

  const kind: Schedule["kind"] =
    entry.cron !== null && entry.cron !== ""
      ? "cron"
      : entry.intervalSeconds !== null && entry.intervalSeconds > 0
        ? "interval"
        : "manual";

  return {
    kind,
    // Cron wins over the interval, as in the generator: it sets `crontab` and
    // clears `repeat`, never both.
    intervalSeconds: kind === "interval" ? entry.intervalSeconds : null,
    cron: kind === "cron" ? entry.cron : null,
    // Every inject node in the flows had once: true. The single exception,
    // poi-bw (once: false), was set by hand in the former generator and never
    // reached the registry; poi-bw carries refireOnRestart: false, so it
    // starts 600 s delayed instead of not at all, which is the safe direction.
    // `"fireOnStart": false` in the registry skips the start run (see above).
    fireOnStart: entry.fireOnStart,
    startupDelaySeconds,
  };
}

/* ------------------------------------------------------------------ Cron */

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

function expandField(field: string, min: number, max: number, at: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart = "", stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${at}: bad step in "${part}"`);

    let from = min;
    let to = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      const start = Number.parseInt(bounds[0] ?? "", 10);
      if (!Number.isInteger(start)) throw new Error(`cron ${at}: bad value in "${part}"`);
      from = start;
      to = bounds.length > 1 ? Number.parseInt(bounds[1] ?? "", 10) : start;
      if (!Number.isInteger(to)) throw new Error(`cron ${at}: bad range in "${part}"`);
    }
    if (from < min || to > max || from > to) throw new Error(`cron ${at}: "${part}" out of range`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/**
 * Five-field cron: minute hour day-of-month month day-of-week.
 *
 * Supports `*`, lists, ranges and steps — everything the registry uses
 * (`"15 07,12 * * *"`, `"30 04 * * 1"`, `"40 03 * * *"`) and a little more.
 * Sunday is both 0 and 7, as in cron. No `@daily`-style aliases and no seconds
 * field: neither occurs in the registry, and silently accepting a six-field
 * expression would shift every subsequent field by one.
 */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${expression}": expected 5 fields, got ${String(fields.length)}`);
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const week = expandField(dayOfWeek, 0, 7, "day-of-week");
  if (week.has(7)) week.add(0);
  return {
    minute: expandField(minute, 0, 59, "minute"),
    hour: expandField(hour, 0, 23, "hour"),
    dayOfMonth: expandField(dayOfMonth, 1, 31, "day-of-month"),
    month: expandField(month, 1, 12, "month"),
    dayOfWeek: week,
    dayOfMonthRestricted: dayOfMonth !== "*",
    dayOfWeekRestricted: dayOfWeek !== "*",
  };
}

/**
 * Local time, not UTC — the image sets `TZ=Europe/Berlin`, and the registry's
 * "40 03 * * *" means half past three in the morning in Baden-Württemberg, not
 * in Greenwich.
 *
 * Day-of-month and day-of-week are OR'd when both are restricted, which is what
 * cron does and what surprises everyone once.
 */
export function cronMatches(fields: CronFields, when: Date): boolean {
  if (!fields.minute.has(when.getMinutes())) return false;
  if (!fields.hour.has(when.getHours())) return false;
  if (!fields.month.has(when.getMonth() + 1)) return false;

  const dayOfMonthHit = fields.dayOfMonth.has(when.getDate());
  const dayOfWeekHit = fields.dayOfWeek.has(when.getDay());
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dayOfMonthHit || dayOfWeekHit;
  if (fields.dayOfMonthRestricted) return dayOfMonthHit;
  if (fields.dayOfWeekRestricted) return dayOfWeekHit;
  return true;
}

/* ------------------------------------------------------------------ Scheduler */

interface Job {
  readonly id: ConnectorId;
  readonly schedule: Schedule;
  readonly task: () => Promise<void>;
  readonly cron: CronFields | null;
  running: boolean;
  lastCronMinute: number;
  /** Time of the last accepted manual trigger, for the cooldown. */
  lastTriggerMs: number | null;
}

/** How often the cron jobs are checked. A minute is the resolution of cron. */
const CRON_TICK_MS = 20_000;

class TimerScheduler implements Scheduler {
  readonly #log: Log;
  readonly #jobs = new Map<ConnectorId, Job>();
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #nowMs: () => number;
  #started = false;

  constructor(log: Log, nowMs: () => number) {
    this.#log = log;
    this.#nowMs = nowMs;
  }

  add(id: ConnectorId, schedule: Schedule, task: () => Promise<void>): void {
    if (this.#started) throw new Error(`scheduler already started, cannot add ${id}`);
    this.#jobs.set(id, {
      id,
      schedule,
      task,
      cron: schedule.cron === null ? null : parseCron(schedule.cron),
      running: false,
      lastCronMinute: -1,
      lastTriggerMs: null,
    });
  }

  jobs(): readonly ScheduledJob[] {
    return [...this.#jobs.values()].map(({ id, schedule }) => ({ id, schedule }));
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    for (const job of this.#jobs.values()) {
      const intervalSeconds = job.schedule.intervalSeconds;
      const startInterval = (): void => {
        if (intervalSeconds === null) return;
        this.#track(
          setInterval(() => {
            this.#fire(job, "interval");
          }, intervalSeconds * 1000),
        );
      };
      if (job.schedule.fireOnStart) {
        // The interval counts from the first run, not from service start.
        // Node-RED's inject node counted from deploy: with a startup delay
        // equal to the interval (efa-abfahrten, 300 s) the first tick hit one
        // second after the first run and was skipped with a [warn] after
        // every restart (observed in a production installation). Deliberate
        // deviation.
        this.#track(
          setTimeout(() => {
            this.#fire(job, "start");
            startInterval();
          }, job.schedule.startupDelaySeconds * 1000),
        );
      } else {
        startInterval();
      }
    }

    const cronJobs = [...this.#jobs.values()].filter((job) => job.cron !== null);
    if (cronJobs.length > 0) {
      this.#track(
        setInterval(() => {
          this.#tickCron(cronJobs);
        }, CRON_TICK_MS),
      );
    }
  }

  stop(): void {
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers.length = 0;
    this.#started = false;
  }

  /**
   * Checked before firing, so a refused trigger is an answer to the caller
   * (429 on the admin port), not a `[warn]` about a skipped run.
   */
  trigger(id: ConnectorId, cooldownMs: number): TriggerResult {
    const job = this.#jobs.get(id);
    if (job === undefined) return { outcome: "unknown" };
    if (job.running) return { outcome: "running" };
    const now = this.#nowMs();
    if (job.lastTriggerMs !== null && now - job.lastTriggerMs < cooldownMs) {
      return {
        outcome: "cooldown",
        retryAfterSeconds: Math.ceil((cooldownMs - (now - job.lastTriggerMs)) / 1000),
      };
    }
    job.lastTriggerMs = now;
    this.#fire(job, "trigger");
    return { outcome: "started" };
  }

  #track(timer: NodeJS.Timeout): void {
    // The service is a daemon; a pending timer must not be the reason the
    // process stays alive during shutdown, hence unref().
    timer.unref();
    this.#timers.push(timer);
  }

  #tickCron(jobs: readonly Job[]): void {
    const now = new Date();
    // Minute of the epoch: the tick is faster than a minute, so a match must not
    // fire twice within the same minute.
    const minute = Math.floor(now.getTime() / 60_000);
    for (const job of jobs) {
      if (job.cron === null || job.lastCronMinute === minute) continue;
      if (!cronMatches(job.cron, now)) continue;
      job.lastCronMinute = minute;
      this.#fire(job, "cron");
    }
  }

  #fire(job: Job, reason: string): void {
    if (job.running) {
      // Node-RED would have queued a second message and run both passes over the
      // same source concurrently. Skipping with a word is the safer reading:
      // a run that outlasts its own interval is a fault to be seen, not to be
      // doubled.
      this.#log.warn(`${job.id}: previous run still active, skipping ${reason} trigger`);
      return;
    }
    job.running = true;
    const started = Date.now();
    void job.task().then(
      () => {
        job.running = false;
        this.#log.debug(`${job.id}: ${reason} run finished in ${String(Date.now() - started)} ms`);
      },
      (error: unknown) => {
        job.running = false;
        this.#log.error(`${job.id}: ${reason} run failed`, error);
      },
    );
  }
}

/** @param nowMs Clock of the trigger cooldown; injected for tests. */
export function createScheduler(log: Log, nowMs: () => number = Date.now): Scheduler {
  return new TimerScheduler(log, nowMs);
}
