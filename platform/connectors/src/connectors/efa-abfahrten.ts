/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `efa-abfahrten` — live departure monitor of one central stop per
 * municipality (EFA-BW, naldo/bwegt) as a `PublicTransportStop` entity with a
 * `departures` compound.
 *
 * Port of FN_OEPNV and the per-municipality loop in
 * scripts/generate-nodered-flows.py. The generator stamped the whole pipeline
 * out once per AGS in `enabledFor` — inject, http request, function, upsert,
 * "Signaturen bestätigen", debug: 23 function plus 23 commit nodes and 46 http
 * request nodes that differed only in five substituted literals (entity id,
 * AGS, stop name, stop code, coordinates). Here that is one loop over the
 * stops from the registry's `params`, and the literals are a {@link StopConfig}.
 *
 * ## Request profile
 *
 * The 23 pipelines fired together every five minutes, i.e. 23 simultaneous
 * requests against EFA-BW. The loop caps that explicitly — see src/connectors
 * /efa.ts for the old effective rate and the new cap ({@link EFA_CONCURRENCY}
 * in flight, {@link EFA_MIN_INTERVAL_MS} between starts, shared with the
 * on-demand endpoint).
 *
 * ## Change detection per attribute
 *
 * Not the kernel's entity gate: the original drops UNCHANGED ATTRIBUTES, not
 * unchanged entities. In its own words:
 *
 *   > TRoE-Dedupe: unveränderte Attribute (Stammdaten wie name/stopCode/location,
 *   > aber auch ein konstanter avgDelayMinutes) nicht bei jedem Lauf erneut in die
 *   > Historie schreiben — Orion-LD legt bei options=update je mitgesendetem Attribut
 *   > eine TRoE-Zeile an, der Broker behält Nicht-Mitgesendetes. dateObserved bleibt
 *   > als Frischesignal immer dabei; nach Neustart ist der Kontext leer -> einmal voll.
 *
 * One signature table per stop (`oepnvSig:<entity id>`, keyed by attribute):
 * {@link trimUnchanged} decides against a copy ({@link ChangeGate.table}),
 * `ctx.gate.retain` keeps exactly the unchanged entries — the old
 * `flow.set(sigKey, table)` — and the new signatures of the changed attributes
 * ride on the plan as {@link PendingSignature}s, committed only for a stop the
 * broker confirmed.
 *
 * ## Deliberate deviations
 *
 *  * One batch upsert per run instead of one POST per stop. The entities and
 *    their attributes are identical, and so are the TRoE rows; a 207 commits
 *    per entity exactly as the 23 separate commit nodes did. Orion sees one
 *    request every five minutes instead of 23 at once.
 *  * One clock reading per run (the old nodes each read their own).
 *  * A registry entry without `params.stopId` was reported by the GENERATOR on
 *    stderr and got no pipeline; here it is skipped with one `[warn]` per
 *    process, not one per run.
 *  * Malformed registry params (coordinates that are not two numbers, an
 *    entity id without the `urn:ngsi-ld:` prefix) fall back to "no location"
 *    resp. the default id; the generator pasted them into the code verbatim.
 *  * Warning texts are English (the code language of this service).
 */

import { cleanText, dateObserved } from "../kernel/ngsi.js";
import {
  isArray,
  isEntityId,
  isFiniteNumber,
  isString,
  isTruthy,
  ParseError,
  requireArray,
  requireRecord,
  requireString,
} from "../kernel/parse.js";
import { stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  ConnectorParams,
  Ctx,
  EntityId,
  GeoIndex,
  GeoProperty,
  IsoTime,
  JsonObject,
  NgsiAttribute,
  NgsiDateTime,
  NgsiEntity,
  PendingSignature,
  Property,
  SignatureValue,
} from "../kernel/types.js";
import { EFA_CONCURRENCY, EFA_DM_URL, EFA_MIN_INTERVAL_MS, mapPool, parseDepartureMonitor } from "./efa.js";
import type { DepartureMonitor, StopEvent } from "./efa.js";
import { failureText, nodePayload, scalar } from "./http-payload.js";
import type { Scalar } from "./http-payload.js";

export const ID = "efa-abfahrten";

/** Prefix of the per-stop signature tables, unchanged from the flow. */
export const SIGNATURE_PREFIX = "oepnvSig:";

const DATA_PROVIDER = "EFA-BW (naldo/bwegt)";

/** `_pp("stopName", "Zentraler Halt")` of the generator. */
const DEFAULT_STOP_NAME = "Zentraler Halt";

/** "TRoE-Bug: Compound > ~2 KB wird still verworfen -> max. 10 Abfahrten, Ziele kürzen". */
const MAX_DEPARTURES = 10;
const MAX_DESTINATION_LENGTH = 40;

/** Attributes sent in every run: identity, context and the freshness stamp. */
const ALWAYS_SENT: ReadonlySet<string> = new Set(["id", "type", "@context", "dateObserved"]);

/** The five literals the generator substituted per municipality. */
export interface StopConfig {
  readonly ags: Ags;
  /** EFA stop id, e.g. `de:08415:22006` — `params.stopId`. */
  readonly stopId: string;
  /** `params.stopName`, apostrophes already swapped as the generator did. */
  readonly name: string;
  /** `params.entityId`, else `urn:ngsi-ld:PublicTransportStop:bw-<ags>-stop`. */
  readonly entityId: EntityId;
  /** `params.coords`, GeoJSON order; `null` = no `location` attribute. */
  readonly coords: readonly [lon: number, lat: number] | null;
}

/** One entry of the `departures` compound. */
export interface Departure extends JsonObject {
  readonly line: string;
  readonly destination: string;
  readonly planned: string;
  readonly estimated: string;
  readonly delayMinutes: number | null;
  readonly platform: string;
}

export interface StopEntity extends NgsiEntity {
  readonly id: EntityId;
  readonly type: "PublicTransportStop";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly stopCode: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly departures: Property<readonly Departure[]>;
  readonly departureCount: Property<number>;
  readonly avgDelayMinutes: Property<number | null>;
  readonly delayDataQuality: Property<string>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
  readonly location?: GeoProperty | undefined;
}

export interface StopAnswer {
  readonly stop: StopConfig;
  readonly monitor: DepartureMonitor;
}

/** Everything one run fetched: the answer of every stop that answered. */
export interface EfaRun {
  readonly answers: readonly StopAnswer[];
}

/* ------------------------------------------------------------------ Stops */

function paramOf(params: ConnectorParams, name: string, ags: Ags): unknown {
  return params[name]?.[ags];
}

function coordsOf(value: unknown): readonly [lon: number, lat: number] | null {
  if (!isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value;
  return isFiniteNumber(lon) && isFiniteNumber(lat) ? [lon, lat] : null;
}

function makeStop(ags: Ags, stopId: string, name: unknown, entityId: unknown, coords: unknown): StopConfig {
  return {
    ags,
    stopId,
    name: cleanText(scalar(name) ?? DEFAULT_STOP_NAME),
    entityId: isEntityId(entityId) ? entityId : `urn:ngsi-ld:PublicTransportStop:bw-${ags}-stop`,
    coords: coordsOf(coords),
  };
}

/** One stop from the registry params, or `null` without a stop id (`if not _sid`). */
export function stopFromParams(ags: Ags, params: ConnectorParams): StopConfig | null {
  const stopId = paramOf(params, "stopId", ags);
  if (!isString(stopId) || stopId === "") return null;
  return makeStop(
    ags,
    stopId,
    paramOf(params, "stopName", ags),
    paramOf(params, "entityId", ags),
    paramOf(params, "coords", ags),
  );
}

/**
 * The stops of a run, in `enabledFor` order as the generator iterated it.
 * `"*"` falls back to every AGS that has a stop id; `null` means none.
 */
export function stopsFromParams(
  enabledFor: Ctx["enabledFor"],
  params: ConnectorParams,
): { readonly stops: readonly StopConfig[]; readonly missing: readonly Ags[] } {
  const agsList =
    enabledFor === null ? [] : enabledFor === "*" ? Object.keys(params.stopId ?? {}) : enabledFor;
  const stops: StopConfig[] = [];
  const missing: Ags[] = [];
  for (const ags of agsList) {
    const stop = stopFromParams(ags, params);
    if (stop === null) missing.push(ags);
    else stops.push(stop);
  }
  return { stops, missing };
}

/** URL of the old `http request` node: stop id concatenated as is, 20 departures. */
export function departuresUrl(stop: StopConfig): string {
  return (
    `${EFA_DM_URL}?outputFormat=rapidJSON&type_dm=any&name_dm=${stop.stopId}` +
    "&mode=direct&useRealtime=1&limit=20"
  );
}

/* ------------------------------------------------------------------ Parse */

function parseStop(raw: unknown, at: string): StopConfig {
  const record = requireRecord(raw, at);
  const stopId = requireString(record.stopId, `${at}.stopId`);
  if (stopId === "") throw new ParseError(`${at}.stopId`, "non-empty string", stopId);
  return makeStop(
    requireString(record.ags, `${at}.ags`),
    stopId,
    record.name,
    record.entityId,
    record.coords,
  );
}

/**
 * The bundle of one run as the parity harness hands it in:
 * `{ answers: [{ stop: { ags, stopId, name?, entityId?, coords? }, payload }] }`
 * with `payload` the EFA answer of that stop. `run` does not go through here —
 * it fetches per stop and narrows each answer with {@link parseDepartureMonitor}.
 */
export function parse(raw: unknown): EfaRun {
  const answers = requireArray(requireRecord(raw, "run").answers, "run.answers");
  return {
    answers: answers.map((answer, index) => {
      const at = `run.answers[${String(index)}]`;
      const record = requireRecord(answer, at);
      return { stop: parseStop(record.stop, `${at}.stop`), monitor: parseDepartureMonitor(record.payload) };
    }),
  };
}

/* ------------------------------------------------------------------ Build */

/** `fmt` of the original: local time in Berlin, `HH:MM`. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function firstTruthy(...values: readonly (Scalar | undefined)[]): Scalar | undefined {
  return values.find((value) => isTruthy(value));
}

function departureOf(event: StopEvent, planned: string): Departure {
  // Nur wo EFA tatsächlich eine Echtzeitmeldung liefert, ist eine Aussage über
  // Verspätung möglich. Fehlt sie, war die frühere Rückfallebene auf die
  // Planzeit gleichbedeutend mit »pünktlich« — aus »unbekannt« wurde so eine
  // Pünktlichkeitsaussage, die die Daten nicht hergeben.
  const realtime = event.realtimeControlled && isTruthy(event.estimated);
  const estimated = isTruthy(event.estimated) ? (event.estimated ?? planned) : planned;
  // EFA meldet an einzelnen Halten systematisch unplausible Planzeiten
  // (3-4 h Differenz trotz isRealtimeControlled). Solche Werte sind
  // Datenartefakte, keine Verspätungen -> als unbekannt (null) führen.
  const raw = Math.round((new Date(estimated).getTime() - new Date(planned).getTime()) / 60000);
  return {
    line: cleanText(firstTruthy(event.lineNumber, event.lineName) ?? "?"),
    destination: cleanText(firstTruthy(event.destination) ?? "?"),
    planned: clock(planned),
    estimated: clock(estimated),
    delayMinutes: realtime && raw >= 0 && raw <= 60 ? raw : null,
    platform: cleanText(firstTruthy(event.platform) ?? ""),
  };
}

/** Median statt Mittelwert: robust gegen einzelne Ausreißer. One decimal. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = sorted.length / 2;
  const value =
    sorted.length % 2 === 1
      ? (sorted[(sorted.length - 1) / 2] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value * 10) / 10;
}

/**
 * FN_OEPNV up to the dedupe: the full entity of one stop, or `null` when no
 * departure is usable (the old node warned and returned; the warning is
 * `run`'s, since this function is pure).
 */
export function buildStop(stop: StopConfig, monitor: DepartureMonitor, now: IsoTime): StopEntity | null {
  const departures: Departure[] = [];
  for (const event of monitor.stopEvents) {
    if (event.cancelled) continue;
    const planned = event.planned;
    if (planned === undefined || planned === "") continue;
    departures.push(departureOf(event, planned));
  }
  if (departures.length === 0) return null;

  const valid = departures
    .map((departure) => departure.delayMinutes)
    .filter((delay): delay is number => delay !== null)
    .sort((a, b) => a - b);
  const shortened = departures.slice(0, MAX_DEPARTURES).map((departure) => ({
    ...departure,
    destination: departure.destination.slice(0, MAX_DESTINATION_LENGTH),
  }));

  // Key order as in the original literal; `location` last (Object.assign).
  return {
    id: stop.entityId,
    type: "PublicTransportStop",
    ags: { type: "Property", value: stop.ags },
    name: { type: "Property", value: stop.name },
    stopCode: { type: "Property", value: stop.stopId },
    dateObserved: dateObserved(now),
    departures: { type: "Property", value: shortened, observedAt: now },
    departureCount: { type: "Property", value: departures.length, unitCode: "C62", observedAt: now },
    avgDelayMinutes: { type: "Property", value: median(valid), unitCode: "MIN", observedAt: now },
    delayDataQuality: {
      type: "Property",
      value: `${String(valid.length)}/${String(departures.length)} Abfahrten mit plausibler Echtzeit`,
    },
    dataProvider: { type: "Property", value: DATA_PROVIDER },
    "@context": NGSI_CONTEXT,
    ...(stop.coords === null
      ? {}
      : { location: { type: "GeoProperty", value: { type: "Point", coordinates: stop.coords } } }),
  };
}

/** Pure: every stop with usable departures, in the order of the answers. */
export function build(raw: EfaRun, _geo: GeoIndex | null, now: IsoTime): readonly StopEntity[] {
  const entities: StopEntity[] = [];
  for (const answer of raw.answers) {
    const entity = buildStop(answer.stop, answer.monitor, now);
    if (entity !== null) entities.push(entity);
  }
  return entities;
}

/* ------------------------------------------------------------------ Dedupe */

export function signatureKey(entityId: EntityId): string {
  return `${SIGNATURE_PREFIX}${entityId}`;
}

export interface Trimmed {
  /** The entity with every unchanged attribute removed. */
  readonly entity: NgsiEntity;
  /** New signatures of the changed attributes, committed on confirmation. */
  readonly pending: readonly PendingSignature[];
  /** Attributes whose stored signature still holds — what the table keeps. */
  readonly unchanged: ReadonlySet<string>;
}

function valueOf(attribute: NgsiAttribute): unknown {
  return "value" in attribute ? attribute.value : null;
}

/**
 * The TRoE dedupe of FN_OEPNV against the stop's signature table `previous`:
 * an attribute whose `JSON.stringify(value)` equals the stored signature is
 * dropped from the write; every other one is sent and its new signature
 * becomes pending. Pure — the table is a copy.
 */
export function trimUnchanged(entity: StopEntity, previous: ReadonlyMap<string, SignatureValue>): Trimmed {
  const key = signatureKey(entity.id);
  const kept: [string, NgsiAttribute | string][] = [];
  const pending: PendingSignature[] = [];
  const unchanged = new Set<string>();
  for (const [name, attribute] of Object.entries(entity)) {
    if (attribute === undefined) continue;
    if (ALWAYS_SENT.has(name) || typeof attribute === "string") {
      kept.push([name, attribute]);
      continue;
    }
    const signature = JSON.stringify(valueOf(attribute));
    if (previous.get(name) === signature) {
      unchanged.add(name);
      continue;
    }
    kept.push([name, attribute]);
    pending.push([key, name, signature, entity.id]);
  }
  return {
    entity: { ...Object.fromEntries(kept), id: entity.id, type: entity.type, "@context": entity["@context"] },
    pending,
    unchanged,
  };
}

/* ------------------------------------------------------------------ Run */

/** Stops already reported as unconfigured — one warning per process. */
export const REPORTED_MISSING = stateKey("reportedMissing", () => new Set<Ags>());

function reportMissing(ctx: Ctx, missing: readonly Ags[]): void {
  const reported = ctx.state.slot(REPORTED_MISSING).get();
  for (const ags of missing) {
    if (reported.has(ags)) continue;
    reported.add(ags);
    ctx.log.warn(`efa-abfahrten without params.stopId for ${ags} — skipped`);
  }
}

/** One stop's answer, or `null` after the old node's warning. */
async function fetchStop(ctx: Ctx, stop: StopConfig): Promise<StopAnswer | null> {
  let status: string;
  let payload: unknown;
  try {
    const response = await ctx.fetch.text(departuresUrl(stop), {
      minIntervalMs: EFA_MIN_INTERVAL_MS,
      retries: 0,
    });
    status = String(response.status);
    payload = response.status >= 400 ? null : nodePayload(response);
  } catch (error) {
    status = failureText(error);
    payload = null;
  }
  try {
    return { stop, monitor: parseDepartureMonitor(payload) };
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ctx.log.warn(`EFA-BW ${stop.ags}: no departures (${status})`);
    return null;
  }
}

export async function run(ctx: Ctx): Promise<void> {
  const { stops, missing } = stopsFromParams(ctx.enabledFor, ctx.params);
  reportMissing(ctx, missing);
  if (stops.length === 0) return;

  const answers = await mapPool(stops, EFA_CONCURRENCY, (stop) => fetchStop(ctx, stop), ctx.signal);
  const now = ctx.now();
  const entities: NgsiEntity[] = [];
  const pending: PendingSignature[] = [];
  for (const answer of answers) {
    if (answer === null) continue;
    const entity = buildStop(answer.stop, answer.monitor, now);
    if (entity === null) {
      ctx.log.warn(`EFA-BW ${answer.stop.ags}: no usable departures`);
      continue;
    }
    const key = signatureKey(entity.id);
    const trimmed = trimUnchanged(entity, ctx.gate.table(key));
    // `flow.set(sigKey, table)`: only the still-valid signatures stay; the
    // changed ones come back through the plan once Orion confirms the write.
    ctx.gate.retain(key, (field) => trimmed.unchanged.has(field));
    entities.push(trimmed.entity);
    pending.push(...trimmed.pending);
  }
  if (entities.length === 0) return;

  const result = await ctx.orion.upsert({ entities, pending });
  ctx.log.status(
    `${String(entities.length)}/${String(stops.length)} stops, ${String(result.committed)} signatures committed` +
      (result.dropped > 0 ? `, ${String(result.dropped)} dropped` : ""),
  );
}

export const connector: ConnectorModule<EfaRun, readonly StopEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
