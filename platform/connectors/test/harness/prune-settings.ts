/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The prune SETTINGS of a connector, old against new.
 *
 * A prune test that deletes the same ids on both sides only shows that the
 * settings agree for the entities that test seeds. A grace period of 1 h
 * instead of 24 h deletes the same entity that is three days old. So the
 * option objects themselves are compared: every `pruneStale({ … })` of the
 * old node is cut out of `flows.json` and evaluated in a vm (the code is what
 * Node-RED ran, not a copy in this file), and every `ctx.prune.stale(options)`
 * of the port is recorded by a wrapper around the kernel's pruner.
 *
 * Both sides are RESOLVED before the comparison — the defaults of the old
 * PRUNE_HELPER (`o.maxFraction || 0.3`, `o.confirmMs || 24 h`, `o.attrs ||
 * 'ags'`) and of the kernel (src/kernel/prune.ts: the fraction clamp, the
 * registry interval when none is given) — so leaving out a value the old node
 * spelled out is not a difference, and changing its effect is.
 *
 * Not compared: the label (a log prefix, English in the port), `keep` and
 * `accept` by content (functions and per-run sets; only their presence) and
 * `status`.
 */

import { assertEntitiesEqual, isRecord } from "./normalize.js";
import { evaluateSnippet, loadFunctionNode } from "./vm-runner.js";
import type { Ctx, PruneOptions, Pruner } from "../../src/kernel/types.js";

const HOUR = 3_600_000;
/** PRUNE_HELPER: `o.confirmMs || 24 * 3600e3`; the kernel's DEFAULT_CONFIRM_MS. */
const DEFAULT_CONFIRM_MS = 24 * HOUR;
/** PRUNE_HELPER: `o.maxFraction || 0.3`; the kernel's DEFAULT_MAX_FRACTION. */
const DEFAULT_MAX_FRACTION = 0.3;

/** One prune, resolved. `null` = not set (the guard is off). */
export interface PruneSetting {
  readonly type: string;
  readonly pattern: string;
  readonly attrs: readonly string[];
  readonly exclude: string | null;
  readonly graceMs: number | null;
  readonly confirmKey: string | null;
  readonly confirmMs: number | null;
  readonly liveMs: number | null;
  readonly maxFraction: number;
  readonly intervalMs: number;
  readonly signatureKey: string | null;
  readonly keep: boolean;
  readonly accept: boolean;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** An option object of the old `pruneStale`, as PRUNE_HELPER reads it. */
export function legacySetting(raw: unknown): PruneSetting {
  if (!isRecord(raw)) throw new Error("pruneStale option object is not an object");
  const type = raw.type;
  const pattern = raw.pattern;
  if (typeof type !== "string" || typeof pattern !== "string") {
    throw new Error("pruneStale option object without type or pattern");
  }
  const confirmKey = text(raw.confirmKey);
  const attrs = text(raw.attrs) ?? "ags";
  const intervalMs = positive(raw.intervalMs);
  if (intervalMs === null) throw new Error(`${type}: an old prune without intervalMs — not expected`);
  return {
    type,
    pattern,
    attrs: attrs.split(","),
    exclude: text(raw.exclude),
    graceMs: positive(raw.graceMs),
    confirmKey,
    confirmMs: confirmKey === null ? null : (positive(raw.confirmMs) ?? DEFAULT_CONFIRM_MS),
    liveMs: positive(raw.liveMs),
    maxFraction: positive(raw.maxFraction) ?? DEFAULT_MAX_FRACTION,
    intervalMs,
    signatureKey: text(raw.sigKey),
    keep: raw.keep !== undefined,
    accept: typeof raw.accept === "function",
  };
}

/** A `ctx.prune.stale` call of the port, resolved as src/kernel/prune.ts does. */
export function portSetting(options: PruneOptions, ctx: Ctx): PruneSetting {
  const fraction = options.maxFraction;
  const confirmKey = options.confirmKey ?? null;
  return {
    type: options.type,
    pattern: options.pattern,
    attrs: [...(options.attrs ?? ["ags"])],
    exclude: options.exclude ?? null,
    graceMs: positive(options.graceMs),
    confirmKey,
    confirmMs: confirmKey === null ? null : (positive(options.confirmMs) ?? DEFAULT_CONFIRM_MS),
    liveMs: positive(options.liveMs),
    maxFraction: fraction === undefined || !(fraction > 0) ? DEFAULT_MAX_FRACTION : Math.min(fraction, 1),
    intervalMs: positive(options.intervalMs) ?? ctx.intervalMs(),
    signatureKey: options.signatureKey ?? null,
    keep: options.keep !== undefined,
    accept: options.accept !== undefined,
  };
}

/** Index of the `)` closing the `(` at `open`, skipping quoted strings. */
function closingParen(body: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced pruneStale( call");
}

/**
 * Identifiers the old call sites hand their prune — per-run values whose
 * content is not compared (see the header). A call site naming anything else
 * fails with a ReferenceError that names it.
 */
const CALL_SITE_GLOBALS: Readonly<Record<string, unknown>> = {
  entities: [],
  ids: new Set(),
  summenIds: new Set(),
  stationIds: new Set(),
  statusText: "",
  ownGbfs: () => true,
  legacyParkApi: () => true,
};

/**
 * Every `pruneStale({ … })` literal of the old node `nodeId`, evaluated, in
 * source order. Calls with a variable (`pruneStale(legacySite)`) are not
 * literals; see {@link legacySettingsOf} for those.
 */
export function legacyPruneSettings(nodeId: string): PruneSetting[] {
  const body = loadFunctionNode(nodeId).func;
  const found: PruneSetting[] = [];
  const marker = "pruneStale({";
  for (let at = body.indexOf(marker); at >= 0; at = body.indexOf(marker, at + marker.length)) {
    const open = at + "pruneStale".length;
    const literal = body.slice(open + 1, closingParen(body, open));
    found.push(legacySetting(evaluateSnippet("", CALL_SITE_GLOBALS, `(${literal})`)));
  }
  if (found.length === 0) throw new Error(`${nodeId}: no pruneStale({ … }) call found`);
  return found;
}

/**
 * Option objects built by a helper inside the old node (`const legacy = typ =>
 * ({ … })` of parken-bw): `code` (cut out of the node with `extractSnippet`) is
 * run and `expression` evaluated after it.
 */
export function legacySettingsOf(nodeId: string, code: string, expression: string): PruneSetting[] {
  const value = evaluateSnippet(code, CALL_SITE_GLOBALS, expression);
  if (!Array.isArray(value)) throw new Error(`${nodeId}: ${expression} is not an array`);
  return value.map(legacySetting);
}

/** A pruner that records every `stale` call and passes it on to `inner`. */
export function recordingPruner(inner: Pruner, calls: PruneOptions[]): Pruner {
  return {
    masterDataPlausible: () => inner.masterDataPlausible(),
    stale: (options) => {
      calls.push(options);
      return inner.stale(options);
    },
    resetConfirmations: (key) => {
      inner.resetConfirmations(key);
    },
  };
}

/** `ctx` with its pruner wrapped by {@link recordingPruner}. */
export function recordPrunes(ctx: Ctx): { readonly ctx: Ctx; readonly calls: PruneOptions[] } {
  const calls: PruneOptions[] = [];
  return { ctx: { ...ctx, prune: recordingPruner(ctx.prune, calls) }, calls };
}

function keyOf(setting: PruneSetting): string {
  return `${setting.type} ${setting.pattern}`;
}

/**
 * The port's calls (deduplicated: the same prune in several runs must carry
 * the same settings every time) against the old option objects, matched by
 * type and pattern.
 */
export function assertPruneSettings(
  label: string,
  legacy: readonly PruneSetting[],
  calls: readonly PruneOptions[],
  ctx: Ctx,
): void {
  const port = new Map<string, PruneSetting>();
  for (const call of calls) {
    const setting = portSetting(call, ctx);
    const seen = port.get(keyOf(setting));
    if (seen !== undefined) {
      assertEntitiesEqual(seen, setting, {
        volatileKeys: [],
        labels: { left: `${label}: earlier call`, right: `${label}: later call` },
      });
    }
    port.set(keyOf(setting), setting);
  }
  const legacyKeys = legacy.map(keyOf);
  if (new Set(legacyKeys).size !== legacyKeys.length) {
    throw new Error(`${label}: two old prunes share type and pattern — match them some other way`);
  }
  // Keyed by type and pattern, so a difference names the prune it is in.
  const byKey = (settings: Iterable<PruneSetting>): Record<string, PruneSetting> =>
    Object.fromEntries([...settings].map((setting) => [keyOf(setting), setting]));
  assertEntitiesEqual(byKey(legacy), byKey(port.values()), {
    volatileKeys: [],
    labels: { left: `old pruneStale options (${label})`, right: `ctx.prune.stale options (${label})` },
  });
}
