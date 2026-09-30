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
 * ## …and not again within the interval
 *
 * A restart shortly after a run still sent the source a full extra run, 600 s
 * later — for the Open-Meteo pair a day's worth of headroom per restart. So
 * these connectors persist the start of their last completed run
 * (src/kernel/run-log.ts), and the start run consults it ({@link planStart}):
 *
 *  * interval: the start run waits until the interval since the last run is
 *    over (at least the 600 s) — the tick the restart swallowed, not an extra;
 *  * cron: no start run while the last run is younger than a day (the
 *    registry's reading of a cron's interval); the cron comes next anyway;
 *  * wall-clock slots (below): no start run if the current slot already had
 *    its run, nor if the next slot comes soon after the delayed start run.
 *
 * Unknown (never ran, database down): delayed start run as before. Nothing
 * starves: a connector restarted more often than its interval still runs
 * once the interval since its last run is over.
 *
 * ## Wall-clock slots
 *
 * `intervalOffsetSeconds` in the registry puts an interval on fixed slots —
 * every multiple of the interval since 00:00 UTC plus the offset — instead of
 * counting from the first run. Two connectors sharing a provider keep their
 * distance that way however often the service restarts (`wetter-bw` at 00:10,
 * 06:10, 12:10, 18:10 UTC, `vorhersage-bw` three hours later); counted from
 * the start they started in the same second after every restart and stayed
 * in lockstep. A missed slot is caught up once, unless the next slot comes
 * soon ({@link planStart}); a run up to {@link SLOT_TOLERANCE_MS} before a
 * slot counts for it.
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

import { REAL_CLOCK } from "./rate-limit.js";
import type { ClockTimer, LimiterClock } from "./rate-limit.js";
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
  const startupDelaySeconds = resumesAfterRestart(entry) ? RESTART_DELAY_SECONDS : staggered;

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
    offsetSeconds: kind === "interval" ? entry.intervalOffsetSeconds : null,
    resume: resumesAfterRestart(entry),
  };
}

/** `refireOnRestart: false`: the start run consults the persisted last run. */
export function resumesAfterRestart(entry: RegistryEntry): boolean {
  return entry.refireOnRestart === false;
}

const DAY_MS = 86_400_000;

/** Start of the slot `nowMs` lies in, and of the next one. */
export function slotBounds(
  nowMs: number,
  intervalMs: number,
  offsetMs: number,
): { readonly current: number; readonly next: number } {
  const current = Math.floor((nowMs - offsetMs) / intervalMs) * intervalMs + offsetMs;
  return { current, next: current + intervalMs };
}

/** The start run of one job. */
export interface StartPlan {
  /** Milliseconds from start to the start run; `null` = no start run. */
  readonly startRunInMs: number | null;
  /** Why the start run is left out or later than the startup delay, for the log. */
  readonly note: string | null;
}

/**
 * A run this shortly before a slot counts for the slot: a timer of hours may
 * fire a little early against the wall clock (clock slew), and a slot run
 * recorded at 06:09:59.9 must not look like a missed 06:10 slot.
 */
export const SLOT_TOLERANCE_MS = 5 * 60_000;

/**
 * A missed slot is caught up only if the catch-up run leaves this much of
 * the slot before the next one — otherwise two full runs would follow each
 * other closely. Half the interval when the last run is known; when it is
 * not (first start, database down) at most an hour, so a new installation
 * gets its data soon.
 */
function catchUpGapMs(intervalMs: number, lastKnown: boolean): number {
  return lastKnown ? intervalMs / 2 : Math.min(intervalMs / 2, 3_600_000);
}

/**
 * When the start run fires, if at all (see the module comment). `lastRunMs`
 * is only consulted with {@link Schedule.resume}; one in the future (a clock
 * set back) counts as unknown.
 */
export function planStart(schedule: Schedule, nowMs: number, lastRunMs: number | null): StartPlan {
  if (!schedule.fireOnStart) return { startRunInMs: null, note: null };
  const delayMs = schedule.startupDelaySeconds * 1000;
  const last = schedule.resume === true && lastRunMs !== null && lastRunMs <= nowMs ? lastRunMs : null;
  const age = last === null ? "" : `last run ${String(Math.round((nowMs - last) / 60_000))} min ago`;
  const intervalMs = schedule.intervalSeconds === null ? null : schedule.intervalSeconds * 1000;
  const offset = schedule.offsetSeconds;

  if (schedule.kind === "interval" && intervalMs !== null && offset !== undefined && offset !== null) {
    const slot = slotBounds(nowMs, intervalMs, offset * 1000);
    if (last !== null && last >= slot.current - SLOT_TOLERANCE_MS) {
      return { startRunInMs: null, note: `no start run, ${age} is in the current slot` };
    }
    if (slot.next - (nowMs + delayMs) < catchUpGapMs(intervalMs, last !== null)) {
      return { startRunInMs: null, note: "no start run, the next slot comes soon enough" };
    }
    return { startRunInMs: delayMs, note: null };
  }

  const windowMs = schedule.kind === "interval" ? intervalMs : schedule.kind === "cron" ? DAY_MS : null;
  if (last !== null && windowMs !== null && nowMs - last < windowMs) {
    if (schedule.kind === "cron") {
      return { startRunInMs: null, note: `no start run, ${age}; the cron comes next` };
    }
    const waitMs = Math.max(delayMs, last + windowMs - nowMs);
    return {
      startRunInMs: waitMs,
      note: `${age}, start run in ${String(Math.round(waitMs / 1000))} s when its interval is over`,
    };
  }
  return { startRunInMs: delayMs, note: null };
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

/** Longest delay Node's timers take (2^31 - 1 ms, ~24.8 days); longer ones fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/** How often the cron jobs are checked. A minute is the resolution of cron. */
const CRON_TICK_MS = 20_000;

class TimerScheduler implements Scheduler {
  readonly #log: Log;
  readonly #jobs = new Map<ConnectorId, Job>();
  /** `setInterval`s: plain intervals and the cron tick. */
  readonly #timers = new Set<NodeJS.Timeout>();
  /** One-shot timers of {@link #clock}: start runs and wall-clock slots. */
  readonly #oneShots = new Set<ClockTimer>();
  readonly #nowMs: () => number;
  readonly #clock: LimiterClock;
  #started = false;

  constructor(log: Log, nowMs: () => number, clock: LimiterClock) {
    this.#log = log;
    this.#nowMs = nowMs;
    this.#clock = clock;
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

  start(lastRunMs?: (id: ConnectorId) => number | null): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#nowMs();

    for (const job of this.#jobs.values()) {
      const last = job.schedule.resume === true ? this.#lastRun(job, lastRunMs) : null;
      const plan = planStart(job.schedule, now, last);
      if (plan.note !== null) this.#log.info(`${job.id}: ${plan.note}`);
      const intervalSeconds = job.schedule.intervalSeconds;
      const offsetSeconds = job.schedule.offsetSeconds;
      if (intervalSeconds !== null && offsetSeconds !== undefined && offsetSeconds !== null) {
        // Wall-clock slots: independent of the start run.
        this.#armSlot(job, intervalSeconds * 1000, offsetSeconds * 1000);
        if (plan.startRunInMs !== null) {
          this.#once(() => {
            this.#fire(job, "start");
          }, plan.startRunInMs);
        }
        continue;
      }
      const startInterval = (): void => {
        if (intervalSeconds === null) return;
        this.#track(
          setInterval(() => {
            this.#fire(job, "interval");
          }, intervalSeconds * 1000),
        );
      };
      if (plan.startRunInMs !== null) {
        // The interval counts from the first run, not from service start.
        // Node-RED's inject node counted from deploy: with a startup delay
        // equal to the interval (efa-abfahrten, 300 s) the first tick hit one
        // second after the first run and was skipped with a [warn] after
        // every restart (observed in a production installation). Deliberate
        // deviation.
        this.#once(() => {
          this.#fire(job, "start");
          startInterval();
        }, plan.startRunInMs);
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
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.clear();
    for (const timer of this.#oneShots) timer.cancel();
    this.#oneShots.clear();
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
    this.#timers.add(timer);
  }

  /**
   * A one-shot timer, forgotten once it fired; unref'd like the others. A
   * delay beyond Node's timer range is chained in steps: Node would clamp it
   * to 1 ms and fire at once.
   */
  #once(task: () => void, ms: number): void {
    const step = Math.min(Math.max(0, ms), MAX_TIMER_MS);
    const timer = this.#clock.setTimeout(() => {
      this.#oneShots.delete(timer);
      if (ms > MAX_TIMER_MS) this.#once(task, ms - MAX_TIMER_MS);
      else task();
    }, step);
    timer.unref();
    this.#oneShots.add(timer);
  }

  /**
   * The next wall-clock slot, re-armed from the clock at every slot rather
   * than a `setInterval`, so timer drift does not accumulate. After a slot:
   * the one after it; after a suspended process: the next one ahead, not
   * every one missed.
   */
  #armSlot(job: Job, intervalMs: number, offsetMs: number, after?: number): void {
    const now = this.#nowMs();
    const next = Math.max(slotBounds(now, intervalMs, offsetMs).next, (after ?? 0) + intervalMs);
    this.#armAt(job, intervalMs, offsetMs, next);
  }

  #armAt(job: Job, intervalMs: number, offsetMs: number, at: number): void {
    this.#once(
      () => {
        if (!this.#started) return;
        const now = this.#nowMs();
        // The wall clock was set back: plan from where it is now, not towards
        // a slot that may be days away.
        if (now < at - SLOT_TOLERANCE_MS) {
          this.#armSlot(job, intervalMs, offsetMs);
          return;
        }
        // A timer of hours can fire early against the wall clock: wait for
        // the slot, so the run is recorded in it and not in the one before.
        if (now < at) {
          this.#armAt(job, intervalMs, offsetMs, at);
          return;
        }
        this.#fire(job, "interval");
        this.#armSlot(job, intervalMs, offsetMs, at);
      },
      Math.max(0, at - this.#nowMs()),
    );
  }

  #lastRun(job: Job, lastRunMs: ((id: ConnectorId) => number | null) | undefined): number | null {
    if (lastRunMs === undefined) return null;
    try {
      return lastRunMs(job.id);
    } catch (error) {
      this.#log.warn(`${job.id}: last run not readable (${String(error)}), treated as unknown`);
      return null;
    }
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

/**
 * @param nowMs Clock of the trigger cooldown and the start plan; injected for tests.
 * @param clock Timers of the start runs and slots; a simulated one in tests.
 */
export function createScheduler(
  log: Log,
  nowMs: () => number = Date.now,
  clock: LimiterClock = REAL_CLOCK,
): Scheduler {
  return new TimerScheduler(log, nowMs, clock);
}
