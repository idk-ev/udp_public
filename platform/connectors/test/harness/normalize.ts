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
  /**
   * The project test runner prints only the FIRST line of an error message
   * (`tests/run.js`). Without this the listing would never be seen. Off only
   * where a failure is the expected outcome — see the harness self-test.
   */
  readonly printDiff?: boolean;
}

/**
 * Throws when the two entity arrays differ after normalisation. The message
 * begins with a one-line summary naming the first differing path, because the
 * runner shows nothing more than that; the full listing goes to stderr.
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
  const listing = formatDifferences(differences, labels);
  if (options?.printDiff !== false) {
    process.stderr.write(`\n${summary}\n\n${listing}\n`);
  }
  throw new Error(`${summary}\n\n${listing}`);
}
