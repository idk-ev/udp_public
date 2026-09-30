/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Comparison of NGSI-LD entity arrays for the parity harness.
 *
 * Two sides meet here that are typed very differently: what the old Node-RED
 * function node returns from `node:vm` is `unknown` and stays that way — no
 * assertion is punched into the typing for it. `deepStrictEqual(unknown,
 * unknown)` does not need a type, and neither does the walker below.
 *
 * Two things have to happen before the comparison:
 *
 *  1. NEUTRALISE THE CLOCK. Both sides stamp the moment of their run into the
 *     entities. `dateObserved` and `observedAt` therefore differ by a few
 *     milliseconds on every run and would drown every real difference. Only
 *     timestamp-shaped STRINGS UNDERNEATH a volatile key are replaced, not the
 *     key itself: a missing `dateObserved`, a changed structure or a changed
 *     `@type` still fails. And an ISO string that is genuine data — the start
 *     of a roadwork, the target hour of a forecast — is not touched, because it
 *     does not sit under one of those keys.
 *
 *     Deliberately NOT done instead: freezing `Date` inside the sandbox. That
 *     would make the vm side deterministic but silently unfaithful to the
 *     runtime being replicated, and it would still not cover a new module that
 *     reads its own clock. Normalising is the honest place for this.
 *
 *     Known residual blind spot: if a module were to write two DIFFERENT
 *     timestamps into `dateObserved` and `observedAt` where the old node wrote
 *     one and the same, the comparison would not notice.
 *
 *     Blanking alone would also hide a STALE clock — a port stamping a fixed
 *     date instead of `ctx.now()`. {@link assertClockStamps} closes that: the
 *     run() tests check the stamps blanked here against the window the run
 *     happened in, and their format against the old node's.
 *
 *  2. LEAVE THE VM REALM. `vm.createContext()` gives the sandbox its own
 *     intrinsics, so an object literal created inside the function node has a
 *     different `Object.prototype` than one from this file.
 *     `assert.deepStrictEqual` compares prototypes and would report every
 *     single entity as unequal. Normalisation rebuilds both sides as plain
 *     values of this realm, which settles that as a side effect. Rebuilt is
 *     exactly what a JSON body carries — which is what actually reaches Orion.
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Placeholder that replaces a wall-clock stamp. Visible in the diff as such. */
export const TIMESTAMP_PLACEHOLDER = "<timestamp>";

/**
 * Keys whose subtree carries the run time rather than data. Extendable per
 * connector via `NormalizeOptions.volatileKeys`; extending is a decision that
 * belongs in the module header of the connector concerned.
 */
export const VOLATILE_KEYS: readonly string[] = [
  "dateObserved",
  "observedAt",
  "dateModified",
  "modifiedAt",
  "dateCreated",
  "createdAt",
];

export interface NormalizeOptions {
  /** Replaces the default list, it does not extend it. */
  readonly volatileKeys?: readonly string[];
}

/** True for a plain object — arrays and null excluded, across realms. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `instanceof Date` is useless here: a `Date` from the vm realm is not an
 * instance of the `Date` of this realm.
 */
function isDate(value: unknown): boolean {
  return Object.prototype.toString.call(value) === "[object Date]";
}

function dateToIso(value: unknown): string {
  return new Date(Number(value)).toISOString();
}

function normalizeValue(value: unknown, volatile: ReadonlySet<string>, underVolatile: boolean): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      out.push(normalizeValue(element, volatile, underVolatile));
    }
    return out;
  }
  if (isDate(value)) {
    return underVolatile ? TIMESTAMP_PLACEHOLDER : dateToIso(value);
  }
  if (isRecord(value)) {
    // Sorted keys: the order of the keys does not matter to the comparison, but
    // it does to the legibility of the diff.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeValue(value[key], volatile, underVolatile || volatile.has(key));
    }
    return out;
  }
  if (underVolatile && typeof value === "string" && TIMESTAMP.test(value)) {
    return TIMESTAMP_PLACEHOLDER;
  }
  return value;
}

/**
 * Rebuilds `value` as plain values of this realm and blanks the wall-clock
 * stamps underneath the volatile keys.
 */
export function normalize(value: unknown, options?: NormalizeOptions): unknown {
  const keys = options?.volatileKeys ?? VOLATILE_KEYS;
  return normalizeValue(value, new Set(keys), false);
}

export interface Difference {
  /** Access path, e.g. `[1].arten.value[3][2]`. */
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
  readonly presence: "both" | "left-only" | "right-only";
}

const MAX_RENDER = 220;

function render(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return String(value);
  }
  const text = JSON.stringify(value);
  return text.length > MAX_RENDER ? `${text.slice(0, MAX_RENDER)}…` : text;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return typeof value;
}

function walk(left: unknown, right: unknown, path: string, found: Difference[]): void {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      found.push({ path: `${path}.length`, left: left.length, right: right.length, presence: "both" });
    }
    const count = Math.max(left.length, right.length);
    for (let i = 0; i < count; i++) {
      const at = `${path}[${String(i)}]`;
      if (i >= left.length) {
        found.push({ path: at, left: undefined, right: right[i], presence: "right-only" });
      } else if (i >= right.length) {
        found.push({ path: at, left: left[i], right: undefined, presence: "left-only" });
      } else {
        walk(left[i], right[i], at, found);
      }
    }
    return;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const at = `${path}.${key}`;
      const inLeft = Object.hasOwn(left, key);
      const inRight = Object.hasOwn(right, key);
      if (!inLeft) {
        found.push({ path: at, left: undefined, right: right[key], presence: "right-only" });
      } else if (!inRight) {
        found.push({ path: at, left: left[key], right: undefined, presence: "left-only" });
      } else {
        walk(left[key], right[key], at, found);
      }
    }
    return;
  }
  if (!Object.is(left, right)) {
    found.push({ path, left, right, presence: "both" });
  }
}

/** Differences between two ALREADY NORMALISED values, deepest first per path. */
export function diff(left: unknown, right: unknown): Difference[] {
  const found: Difference[] = [];
  walk(left, right, "", found);
  return found;
}

export interface DiffLabels {
  readonly left: string;
  readonly right: string;
}

const DEFAULT_LABELS: DiffLabels = { left: "old (Node-RED function node)", right: "new (build)" };
const MAX_LISTED = 25;

/** Multi-line, readable listing — path, both sides, one block per difference. */
export function formatDifferences(differences: readonly Difference[], labels: DiffLabels): string {
  const lines: string[] = [];
  for (const d of differences.slice(0, MAX_LISTED)) {
    const at = d.path === "" ? "<root>" : d.path;
    lines.push(`  ${at}   (${kindOf(d.left)} vs ${kindOf(d.right)})`);
    lines.push(`      ${labels.left}: ${d.presence === "right-only" ? "<absent>" : render(d.left)}`);
    lines.push(`      ${labels.right}: ${d.presence === "left-only" ? "<absent>" : render(d.right)}`);
    lines.push("");
  }
  if (differences.length > MAX_LISTED) {
    lines.push(`  … and ${String(differences.length - MAX_LISTED)} more difference(s).`);
  }
  return lines.join("\n");
}

export interface ParityOptions extends NormalizeOptions {
  readonly labels?: DiffLabels;
}

/**
 * Throws when the two entity arrays differ after normalisation. The message
 * begins with a one-line summary naming the first differing path, followed by
 * the full listing; `tests/run.js` prints the whole message, indented.
 */
export function assertEntitiesEqual(left: unknown, right: unknown, options?: ParityOptions): void {
  const labels = options?.labels ?? DEFAULT_LABELS;
  const normalizeOptions: NormalizeOptions =
    options?.volatileKeys === undefined ? {} : { volatileKeys: options.volatileKeys };
  const normalizedLeft = normalize(left, normalizeOptions);
  const normalizedRight = normalize(right, normalizeOptions);
  const differences = diff(normalizedLeft, normalizedRight);
  if (differences.length === 0) return;

  const first = differences[0];
  const where = first === undefined || first.path === "" ? "<root>" : first.path;
  const leftText = first === undefined || first.presence === "right-only" ? "<absent>" : render(first.left);
  const rightText = first === undefined || first.presence === "left-only" ? "<absent>" : render(first.right);
  const summary =
    `Entity parity mismatch: ${String(differences.length)} difference(s), ` +
    `first at ${where} — ${labels.left} ${leftText} vs ${labels.right} ${rightText}`;
  throw new Error(`${summary}\n\n${formatDifferences(differences, labels)}`);
}

/* ------------------------------------------------------------------ clock stamps */

/**
 * The span of wall-clock time a run happened in, in epoch milliseconds, both
 * ends included. A run on a fixed test clock (`ctx.now()` answering one
 * instant) has `startMs === endMs`.
 */
export interface ClockWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/** A window from now until `close()` — taken right before and right after a run. */
export function openClock(): { close(): ClockWindow } {
  const startMs = Date.now();
  return { close: () => ({ startMs, endMs: Date.now() }) };
}

/** The window of a fixed test clock: exactly one instant. */
export function fixedClock(at: number | string): ClockWindow {
  const ms = typeof at === "number" ? at : Date.parse(at);
  return { startMs: ms, endMs: ms };
}

/** One window spanning several — e.g. the runs of one test on the real clock. */
export function spanOf(...windows: readonly ClockWindow[]): ClockWindow {
  return {
    startMs: Math.min(...windows.map((window) => window.startMs)),
    endMs: Math.max(...windows.map((window) => window.endMs)),
  };
}

/** One timestamp-shaped value underneath a volatile key. */
interface Stamp {
  readonly path: string;
  /** The volatile key it sits under (`dateObserved`, `observedAt`, …). */
  readonly key: string;
  readonly value: string;
}

/**
 * The format of a stamp, digits masked: `2026-09-28T10:00:00.123Z` becomes
 * `9999-99-99T99:99:99.999Z`. Precision, separator and zone designator stay
 * visible, the instant does not.
 */
function stampFormat(value: string): string {
  return value.replace(/\d/g, "9");
}

function inWindow(value: string, window: ClockWindow): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= window.startMs && ms <= window.endMs;
}

function renderWindow(window: ClockWindow): string {
  return window.startMs === window.endMs
    ? new Date(window.startMs).toISOString()
    : `${new Date(window.startMs).toISOString()} … ${new Date(window.endMs).toISOString()}`;
}

/** Stamps of an ALREADY REBUILT value (see {@link rebuild}), in walk order. */
function collectStamps(
  value: unknown,
  volatile: ReadonlySet<string>,
  path: string,
  key: string | null,
  into: Stamp[],
): void {
  if (Array.isArray(value)) {
    value.forEach((element: unknown, index) => {
      collectStamps(element, volatile, `${path}[${String(index)}]`, key, into);
    });
    return;
  }
  if (isRecord(value)) {
    for (const name of Object.keys(value)) {
      const under = key ?? (volatile.has(name) ? name : null);
      collectStamps(value[name], volatile, `${path}.${name}`, under, into);
    }
    return;
  }
  if (key !== null && typeof value === "string" && TIMESTAMP.test(value)) {
    into.push({ path, key, value });
  }
}

/** Plain values of this realm, `Date`s as ISO strings, nothing blanked. */
function rebuild(value: unknown): unknown {
  return normalizeValue(value, new Set(), false);
}

function volatileSet(options?: NormalizeOptions): ReadonlySet<string> {
  return new Set(options?.volatileKeys ?? VOLATILE_KEYS);
}

function failStamps(problems: readonly string[]): void {
  if (problems.length === 0) return;
  throw new Error(
    `Clock stamp mismatch: ${String(problems.length)} problem(s), first ${problems[0]?.trim() ?? ""}\n\n` +
      problems.slice(0, MAX_LISTED).join("\n"),
  );
}

export interface ClockStampOptions extends NormalizeOptions {
  /** The window the old node ran in. Its stamps inside it are clock readings. */
  readonly legacy: ClockWindow;
  /** The window the port ran in, or its fixed test clock. */
  readonly ported: ClockWindow;
}

/**
 * The half of the stamp comparison that {@link normalize} blanks. Walks both
 * sides (call it after {@link assertEntitiesEqual}, so the structure is known
 * to agree) and, for every timestamp underneath a volatile key:
 *
 *  * the FORMAT must be the old node's (ms precision, `Z`, …);
 *  * a stamp the old node took from its clock (inside `legacy`) must be a
 *    clock reading of the port as well — inside `ported`. A port stamping
 *    `2020-01-01T00:00:00.000Z`, or a value carried over from an earlier run,
 *    fails here;
 *  * a stamp the old node did NOT take from its clock is data after all, and
 *    must be equal.
 */
export function assertClockStamps(legacy: unknown, ported: unknown, options: ClockStampOptions): void {
  const volatile = volatileSet(options);
  const left: Stamp[] = [];
  const right: Stamp[] = [];
  collectStamps(rebuild(legacy), volatile, "", null, left);
  collectStamps(rebuild(ported), volatile, "", null, right);
  const rightByPath = new Map(right.map((stamp) => [stamp.path, stamp]));
  const problems: string[] = [];
  if (left.length === 0) problems.push("  the old side carries no timestamp underneath a volatile key");
  for (const old of left) {
    const now = rightByPath.get(old.path);
    rightByPath.delete(old.path);
    if (now === undefined) {
      problems.push(`  ${old.path}: old ${old.value}, new <no timestamp>`);
    } else if (stampFormat(old.value) !== stampFormat(now.value)) {
      problems.push(
        `  ${old.path}: format differs — old ${old.value} (${stampFormat(old.value)}), ` +
          `new ${now.value} (${stampFormat(now.value)})`,
      );
    } else if (inWindow(old.value, options.legacy)) {
      if (!inWindow(now.value, options.ported)) {
        problems.push(
          `  ${old.path}: new ${now.value} is not a reading of the run's clock ` +
            `(${renderWindow(options.ported)})`,
        );
      }
    } else if (old.value !== now.value) {
      problems.push(`  ${old.path}: data stamp differs — old ${old.value}, new ${now.value}`);
    }
  }
  for (const extra of rightByPath.values()) {
    problems.push(`  ${extra.path}: old <no timestamp>, new ${extra.value}`);
  }
  failStamps(problems);
}

/**
 * One-sided form, for writes without an old counterpart in the test (a
 * freshness-only second run): every stamp underneath a volatile key lies in
 * `window`, and its key and format occur among the stamps of `reference` —
 * the old node's output of the same connector.
 */
export function assertStampsWithin(
  values: unknown,
  window: ClockWindow,
  reference: unknown,
  options?: NormalizeOptions,
): void {
  const volatile = volatileSet(options);
  const known: Stamp[] = [];
  collectStamps(rebuild(reference), volatile, "", null, known);
  const formats = new Set(known.map((stamp) => `${stamp.key} ${stampFormat(stamp.value)}`));
  const seen: Stamp[] = [];
  collectStamps(rebuild(values), volatile, "", null, seen);
  const problems: string[] = [];
  if (seen.length === 0) problems.push("  no timestamp underneath a volatile key");
  for (const stamp of seen) {
    if (!formats.has(`${stamp.key} ${stampFormat(stamp.value)}`)) {
      problems.push(
        `  ${stamp.path}: ${stamp.key} ${stamp.value} has a format the old node never wrote ` +
          `(${[...formats].join(", ")})`,
      );
    } else if (!inWindow(stamp.value, window)) {
      problems.push(
        `  ${stamp.path}: ${stamp.value} is not a reading of the run's clock (${renderWindow(window)})`,
      );
    }
  }
  failStamps(problems);
}
