/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Narrowing building blocks for foreign data.
 *
 * The binding rule of the service reads: external data enters as `unknown` and
 * is NARROWED, never ASSERTED. 29 sources each need such a parse function, and
 * the migration plan names the temptation by its name — "die Versuchung, sie
 * durch ein `as` zu ersetzen, ist groß". Lint blocks the shortcut technically;
 * this module is the other half of the deal: the honest way has to be the short
 * one, or the ban is merely a nuisance.
 *
 * Everything here is the same check the old function nodes opened with —
 * `if (!msg.payload || !Array.isArray(msg.payload.gemeinden)) return null;` —
 * only in one place and with a type as the result.
 */

/** Thrown by the `require*` helpers; carries the path to the offending field. */
export class ParseError extends Error {
  readonly path: string;

  constructor(path: string, expected: string, got: unknown) {
    super(`${path === "" ? "value" : path}: expected ${expected}, got ${describe(got)}`);
    this.name = "ParseError";
    this.path = path;
  }
}

/** Short, safe rendering of an unknown value for error messages. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  if (typeof value === "string") return `string(${String(value.length)})`;
  const kind = typeof value;
  return kind === "object" ? "object" : kind;
}

/* ------------------------------------------------------------------ Guards */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Finite numbers only: `NaN` and `Infinity` are malformed data, not values. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * JavaScript truthiness of a foreign value — for porting `a || b`, `x && x.id`
 * or `if (e.modifiedAt)` faithfully. `strict-boolean-expressions` rightly
 * refuses `unknown` in a condition; this makes the old semantics explicit
 * instead of approximating them with `!== undefined` (which lets `""`, `0` and
 * `null` through where the old node did not).
 */
export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

/* ------------------------------------------------------------------ Optional readers */

/** Property of a record, or `undefined` if the container is not a record. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Walks a path, e.g. `path(payload, "data", 0, "value")`. */
export function path(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof key === "number") {
      if (!isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[key];
    }
  }
  return current;
}

export function optString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

export function optNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/**
 * Number from a value that may arrive as a string — several sources deliver
 * measured values as text (HVZ, sensor.community). `parseFloat` semantics as in
 * the old nodes: leading number wins, trailing junk is ignored.
 */
export function looseNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (isString(value)) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function optBoolean(value: unknown): boolean | undefined {
  return isBoolean(value) ? value : undefined;
}

export function optArray(value: unknown): readonly unknown[] | undefined {
  return isArray(value) ? value : undefined;
}

export function optRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/* ------------------------------------------------------------------ Required readers */

export function requireString(value: unknown, at = ""): string {
  if (!isString(value)) throw new ParseError(at, "string", value);
  return value;
}

export function requireNumber(value: unknown, at = ""): number {
  if (!isFiniteNumber(value)) throw new ParseError(at, "finite number", value);
  return value;
}

export function requireArray(value: unknown, at = ""): readonly unknown[] {
  if (!isArray(value)) throw new ParseError(at, "array", value);
  return value;
}

export function requireRecord(value: unknown, at = ""): Record<string, unknown> {
  if (!isRecord(value)) throw new ParseError(at, "object", value);
  return value;
}

/**
 * Maps an array field, skipping entries the item parser rejects with a
 * {@link ParseError}. That is the behaviour of the old nodes, which quietly
 * `continue`d on unusable rows rather than dropping the whole run — a single
 * broken station must not cost the other 1,102 municipalities their update.
 * The number of skipped entries is reported so the loss stays visible.
 */
export function mapLenient<T>(
  items: readonly unknown[],
  item: (raw: unknown, index: number) => T,
): { readonly values: T[]; readonly skipped: number } {
  const values: T[] = [];
  let skipped = 0;
  for (let i = 0; i < items.length; i += 1) {
    try {
      values.push(item(items[i], i));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      skipped += 1;
    }
  }
  return { values, skipped };
}

/* ------------------------------------------------------------------ Domain shapes */

/**
 * NGSI-LD entity ids are a template literal type in the contract, so a string
 * has to be checked before it may be used as one. A type predicate, not an
 * assertion — `as` is blocked and would be the wrong tool anyway: this actually
 * verifies the prefix.
 */
export function isEntityId(value: unknown): value is `urn:ngsi-ld:${string}` {
  return isString(value) && value.startsWith("urn:ngsi-ld:");
}

/** Official municipality key: eight digits. */
export function isAgs(value: unknown): value is string {
  return isString(value) && /^\d{8}$/.test(value);
}

/* ------------------------------------------------------------------ Dictionaries */

/**
 * An empty object WITHOUT a prototype, for dictionaries filled from foreign
 * keys. On a plain `{}`, `out["__proto__"] = x` does not store a key — it
 * replaces the prototype, and every later lookup of a missing key falls
 * through to `x`; `out["constructor"]` answers a function. Here both are
 * ordinary keys. `JSON.stringify` and `Object.entries` treat it as any object.
 */
export function nullPrototypeRecord<T>(): Record<string, T> {
  const out: Record<string, T> = {};
  Object.setPrototypeOf(out, null);
  return out;
}
