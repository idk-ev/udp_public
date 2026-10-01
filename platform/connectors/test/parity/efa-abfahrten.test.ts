/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: efa-abfahrten — the generated per-municipality pipelines (FN_OEPNV
 * per AGS, its http request node, the "Signaturen bestätigen" node) against
 * the ported loop, run for real through `run(ctx)` on a scripted network.
 *
 * Compared per stop: the request URL (the old http request node's `url`), the
 * upserted entity after the attribute dedupe, and the per-stop signature
 * tables `oepnvSig:<id>` after the commit — across runs: first run (tables
 * empty, everything sent), second run (nothing changed, freshness only), a run
 * with one changed delay whose write the broker refuses, and the run after
 * that. Plus malformed and edge-case events, the error paths, and the request
 * profile towards EFA-BW.
 *
 * DELIBERATE DEVIATION (module header): a stop without any plausible
 * real-time departure has no median. The old node sent `avgDelayMinutes`
 * with `value: null`, which Orion-LD 1.6.0 refuses for the whole entity
 * (207); the port leaves the attribute out and withdraws it instead
 * ({@link unknownMedianIsWithdrawnNotNull}). The recorded fixtures all carry
 * real time, so the cycles above compare identical entities.
 *
 * Fixtures: test/fixtures/efa-abfahrten-<ags>.json — real departure monitor
 * answers of Reutlingen Hbf (the one stop with a registry entityId), Stuttgart
 * Hbf and Bad Peterstal (mostly without real-time data), trimmed as their
 * `note` says.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ABSENT,
  build,
  parse,
  run,
  signatureKey,
  stopFromParams,
} from "../../src/connectors/efa-abfahrten.js";
import type { StopConfig } from "../../src/connectors/efa-abfahrten.js";
import { EFA_CONCURRENCY, EFA_MIN_INTERVAL_MS } from "../../src/connectors/efa.js";
import type { HttpResponse } from "../../src/kernel/types.js";
import { legacyFlowsPath, messageFromFixture, readFixture } from "../harness/fixtures.js";
import type { GRequest, GRig } from "../harness/g-transport.js";
import {
  jsonHttp,
  ORION,
  recordingFetcher,
  registryEntry,
  rig,
  upsertedEntities,
} from "../harness/g-transport.js";
import { httpResponse } from "../harness/kernel.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";

const STOPS = ["08415061", "08111000", "08317008"] as const;
const REUTLINGEN = "08415061";

/** Reutlingen kept its historical node ids (empty suffix), the others got `-<ags>`. */
function nodePrefix(ags: string): string {
  return ags === REUTLINGEN ? "udp-rt-o" : `udp-rt-o-${ags}`;
}

function flowNodes(): readonly Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(readFileSync(legacyFlowsPath(), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("legacy-flows.json is not an array");
  return parsed.filter(isRecord);
}

function nodeById(id: string): Record<string, unknown> {
  const node = flowNodes().find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`legacy-flows.json has no node ${id}`);
  return node;
}

function oldUrl(ags: string): string {
  const url = nodeById(`${nodePrefix(ags)}-get`).url;
  assert.ok(typeof url === "string");
  return url;
}

function stopOf(ags: string): StopConfig {
  const stop = stopFromParams(ags, registryEntry("efa-abfahrten").params);
  assert.ok(stop !== null, `registry has a stop for ${ags}`);
  return stop;
}

/**
 * The recorded answer of `ags`; the stops without a recording of their own get
 * one of the three in turn (a test input — each old node builds its own id,
 * name and location from its generated config, only the departures are shared).
 */
function fixtureName(ags: string): string {
  if (STOPS.some((stop) => stop === ags)) return `efa-abfahrten-${ags}`;
  const all = enabledStops();
  const index = all.indexOf(ags);
  return `efa-abfahrten-${STOPS[(index < 0 ? 0 : index) % STOPS.length] ?? REUTLINGEN}`;
}

function fixturePayload(ags: string): unknown {
  const payload = readFixture(fixtureName(ags)).payload;
  if (STOPS.some((stop) => stop === ags)) return payload;
  // A borrowed recording answers as EFA would for this stop: resolved to it.
  const stop = stopOf(ags);
  return {
    ...(isRecord(payload) ? payload : {}),
    locations: [{ id: stop.stopId, name: stop.name, type: "stop", isBest: true }],
  };
}

/**
 * EFA's answer for an unknown or removed id, modelled on a real one: the id
 * resolved to some POI (`isBest`), the requested stop only as a fuzzy
 * candidate, and the POI's nearest stop's departures under `stopEvents`.
 */
function misresolved(ags: string): unknown {
  const payload = fixturePayload(ags);
  return {
    ...(isRecord(payload) ? payload : {}),
    locations: [
      {
        id: "poiID:1655788:8211000:-1:Domaine1795:Baden-Baden:Domaine1795:ANY:POI:915365:5757868:MRCV:b_w",
        name: "Baden-Baden, Domaine1795",
        type: "poi",
        isBest: true,
      },
      { id: stopOf(ags).stopId, name: "candidate", type: "stop", isBest: false },
    ],
  };
}

/** Every stop the registry enables — each has its own generated pipeline in the frozen flows. */
function enabledStops(): string[] {
  const enabled = registryEntry("efa-abfahrten").enabledFor;
  if (enabled === null || enabled === "*") throw new Error("efa-abfahrten: the registry lists no stops");
  return [...enabled];
}

/** What EFA answers per stop in the current step of a scenario. */
type Answer = { readonly status: number; readonly payload: unknown } | Error;

/* ------------------------------------------------------------------ the pair */

/** Old pipelines and port side by side, sharing the scripted answers. */
interface Pair {
  readonly flow: Map<string, unknown>;
  readonly port: GRig;
  readonly seen: GRequest[];
  readonly answers: Map<string, Answer>;
  orion: number;
}

function pair(stops: readonly string[] = STOPS): Pair {
  const answers = new Map<string, Answer>(
    stops.map((ags) => [ags, { status: 200, payload: fixturePayload(ags) }]),
  );
  const byStopId = new Map(stops.map((ags) => [stopOf(ags).stopId, ags]));
  const state = { orion: 204 };
  const network = recordingFetcher((request): HttpResponse | Error => {
    if (request.url.startsWith(ORION)) return httpResponse(state.orion);
    const ags = byStopId.get(new URL(request.url).searchParams.get("name_dm") ?? "") ?? "";
    const answer = answers.get(ags);
    if (answer === undefined) return httpResponse(404, "not found");
    if (answer instanceof Error) return answer;
    return jsonHttp(answer.status, answer.payload);
  });
  const port = rig(registryEntry("efa-abfahrten", { enabledFor: [...stops] }), network.fetcher);
  return {
    flow: new Map(),
    port,
    seen: network.seen,
    answers,
    get orion() {
      return state.orion;
    },
    set orion(value: number) {
      state.orion = value;
    },
  };
}

interface LegacyStop {
  readonly ags: string;
  readonly entity: unknown;
  readonly msg: Record<string, unknown> | null;
  readonly warnings: readonly string[];
}

/** One old pipeline: http request node result into FN_OEPNV of `ags`, shared flow context. */
async function legacyStop(p: Pair, ags: string): Promise<LegacyStop> {
  const answer = p.answers.get(ags);
  assert.ok(answer !== undefined);
  const base = messageFromFixture(readFixture(fixtureName(ags)));
  const msg =
    answer instanceof Error
      ? { ...base, statusCode: "ECONNREFUSED", payload: `${answer.message} : ${oldUrl(ags)}` }
      : { ...base, statusCode: answer.status, payload: structuredClone(answer.payload) };
  const result = await runFunctionNode(`${nodePrefix(ags)}-fn`, { msg, flow: Object.fromEntries(p.flow) });
  for (const [key, value] of result.flow) p.flow.set(key, value);
  const returned = result.returned;
  if (!isRecord(returned)) return { ags, entity: null, msg: null, warnings: result.warnings };
  const entities = returned.payload;
  assert.ok(Array.isArray(entities) && entities.length === 1, "one entity per stop");
  return { ags, entity: entities[0], msg: returned, warnings: result.warnings };
}

/** The old commit node behind the upsert, answering `p.orion`; its warnings. */
async function legacyCommit(p: Pair, stop: LegacyStop): Promise<readonly string[]> {
  if (stop.msg === null) return [];
  const result = await runFunctionNode(`${nodePrefix(stop.ags)}-commit`, {
    msg: { ...stop.msg, statusCode: p.orion, payload: p.orion < 300 ? "" : '{"title":"unavailable"}' },
    flow: Object.fromEntries(p.flow),
  });
  for (const [key, value] of result.flow) p.flow.set(key, value);
  return result.warnings;
}

/** Warnings of the Orion client (commit), as opposed to the connector's own. */
function isCommitWarning(text: string): boolean {
  return text.startsWith("Upsert not confirmed") || text.startsWith("orion upsert");
}

/**
 * One run on both sides; compares URLs, upserted entities, warnings per stop
 * and the signature tables after the commit. Returns what the port upserted.
 */
async function cycle(p: Pair, label: string): Promise<unknown[]> {
  const stops = [...p.answers.keys()];
  const before = p.seen.length;
  const warningsBefore = p.port.log.warnings().length;
  const legacy: LegacyStop[] = [];
  const legacyClock = openClock();
  for (const ags of stops) legacy.push(await legacyStop(p, ags));
  const legacyWindow = legacyClock.close();
  const portClock = openClock();
  await run(p.port.ctx);
  const portWindow = portClock.close();
  const requests = p.seen.slice(before);

  assert.deepEqual(
    requests.filter((request) => !request.url.startsWith(ORION)).map((request) => request.url),
    stops.map(oldUrl),
    `${label}: EFA request URLs differ from the old http request nodes`,
  );
  const upserted = upsertedEntities(requests);
  assertEntitiesEqual(
    legacy.filter((stop) => stop.entity !== null).map((stop) => stop.entity),
    upserted,
    { labels: { left: `old FN_OEPNV (${label})`, right: `new run() (${label})` } },
  );
  const written = legacy.filter((stop) => stop.entity !== null).map((stop) => stop.entity);
  if (written.length > 0) {
    assertClockStamps(written, upserted, { legacy: legacyWindow, ported: portWindow });
  }
  const portWarnings = p.port.log.warnings().slice(warningsBefore);
  assert.equal(
    portWarnings.filter((text) => !isCommitWarning(text)).length,
    legacy.reduce((sum, stop) => sum + stop.warnings.length, 0),
    `${label}: number of connector warnings differs`,
  );

  const commitWarnings: string[] = [];
  for (const stop of legacy) commitWarnings.push(...(await legacyCommit(p, stop)));
  // One batch instead of one upsert per stop: a refused write warns once, not
  // once per stop — but it warns on both sides or on neither.
  assert.equal(
    portWarnings.some(isCommitWarning),
    commitWarnings.length > 0,
    `${label}: one side warned about an unconfirmed upsert, the other did not`,
  );
  for (const ags of stops) {
    const key = signatureKey(stopOf(ags).entityId);
    assert.deepEqual(
      normalize(Object.fromEntries(p.port.ctx.gate.table(key))),
      normalize(p.flow.get(key) ?? {}),
      `${label}: signature table ${key} differs`,
    );
  }
  return upserted;
}

/** Moves one real-time estimate of Reutlingen by two minutes — a test input. */
function withChangedDelay(payload: unknown): unknown {
  const copy = structuredClone(payload);
  const events = isRecord(copy) ? copy.stopEvents : undefined;
  assert.ok(Array.isArray(events));
  const event: unknown = events[2];
  assert.ok(isRecord(event) && typeof event.departureTimeEstimated === "string");
  event.departureTimeEstimated = new Date(Date.parse(event.departureTimeEstimated) + 120_000)
    .toISOString()
    .replace(".000Z", "Z");
  return copy;
}

/* ------------------------------------------------------------------ tests */

async function runsAndSignatureTablesMatch(): Promise<void> {
  const p = pair();

  const first = await cycle(p, "run 1, empty tables");
  assert.equal(first.length, 3);
  assert.ok(first.every((entity) => isRecord(entity) && "location" in entity && "departures" in entity));

  const second = await cycle(p, "run 2, nothing changed");
  for (const entity of second) {
    assert.deepEqual(Object.keys(isRecord(entity) ? entity : {}).sort(), [
      "@context",
      "dateObserved",
      "id",
      "type",
    ]);
  }

  // One delay changes; the broker refuses the write: the changed attributes
  // lose their signature on both sides and go out again next time.
  p.answers.set(REUTLINGEN, { status: 200, payload: withChangedDelay(fixturePayload(REUTLINGEN)) });
  p.orion = 503;
  const third = await cycle(p, "run 3, changed delay, broker refuses");
  const changed = third.find((entity) => isRecord(entity) && entity.id === stopOf(REUTLINGEN).entityId);
  assert.ok(isRecord(changed) && "departures" in changed && !("name" in changed), "only changed attributes");

  p.orion = 204;
  const fourth = await cycle(p, "run 4, same input, broker back");
  const resent = fourth.find((entity) => isRecord(entity) && entity.id === stopOf(REUTLINGEN).entityId);
  assert.ok(isRecord(resent) && "departures" in resent, "the refused attributes are sent again");

  await cycle(p, "run 5, all committed");
}

async function everyEnabledStopMatchesItsOwnNode(): Promise<void> {
  // All stops of the registry, each against its OWN generated FN_OEPNV, http
  // request node and commit node — not only the three with a recording.
  const stops = enabledStops();
  assert.equal(stops.length, 23, "the registry enables 23 stops");
  const byStopId = new Set(stops.map((ags) => stopOf(ags).stopId));
  assert.equal(byStopId.size, stops.length, "every stop has its own stopId");
  const p = pair(stops);
  const first = await cycle(p, "all stops, run 1");
  assert.equal(first.length, stops.length);
  const ids = new Set(first.map((entity) => (isRecord(entity) ? entity.id : undefined)));
  assert.deepEqual(
    ids,
    new Set(stops.map((ags) => stopOf(ags).entityId)),
    "one entity per stop, under its registry id",
  );
  await cycle(p, "all stops, run 2");
}

async function errorPathsWarnAsBefore(): Promise<void> {
  const p = pair();
  p.answers.set("08415061", { status: 500, payload: "<html>error</html>" });
  p.answers.set("08111000", new Error("connect ECONNREFUSED 1.2.3.4:443"));
  p.answers.set("08317008", { status: 200, payload: "not json at all" });
  const upserted = await cycle(p, "EFA 500 / refused / not JSON");
  assert.equal(upserted.length, 0);
  assert.equal(p.port.log.warnings().length, 3, "one warning per stop, as each old node warned");
  assert.ok(!p.seen.some((request) => request.url.startsWith(ORION)), "nothing to write, no upsert");
}

async function edgeCaseEventsMatch(): Promise<void> {
  // Test inputs on top of the real answer: every branch of the departure
  // loop that the recorded morning did not happen to contain.
  const payload = structuredClone(fixturePayload(REUTLINGEN));
  const events = isRecord(payload) ? payload.stopEvents : undefined;
  assert.ok(Array.isArray(events));
  const edit = (index: number, change: (event: Record<string, unknown>) => void): void => {
    const event: unknown = events[index];
    assert.ok(isRecord(event));
    change(event);
  };
  edit(0, (e) => (e.isCancelled = true));
  edit(1, (e) => delete e.departureTimePlanned);
  edit(2, (e) => (e.departureTimeEstimated = "2026-09-28T05:15:00Z")); // +2 h: implausible
  edit(3, (e) => (e.departureTimeEstimated = "2026-09-28T03:10:00Z")); // early: negative
  edit(4, (e) => (e.isRealtimeControlled = false));
  edit(
    5,
    (e) =>
      (e.transportation = {
        name: "Bürgerbus",
        destination: { name: "Pfullingen's längster Zielname der Welt, wirklich sehr lang" },
      }),
  );
  edit(6, (e) => (e.transportation = {}));
  edit(7, (e) => delete e.location);
  edit(8, (e) => (e.departureTimeEstimated = ""));
  events.push(null, "junk");

  const p = pair([REUTLINGEN]);
  p.answers.set(REUTLINGEN, { status: 200, payload });
  // Structurally malformed events: the old node threw on them, the port skips
  // them. Without the two junk entries both sides must agree exactly.
  events.splice(-2, 2);
  await cycle(p, "edge-case events");

  // The module's own parse + build on the same input, without the dedupe
  // (a fresh flow context: the old node then sends the full entity).
  const stop = stopOf(REUTLINGEN);
  const built = build(parse({ answers: [{ stop, payload }] }), null, "2026-09-28T03:15:00.000Z");
  const fresh = pair([REUTLINGEN]);
  fresh.answers.set(REUTLINGEN, { status: 200, payload });
  assertEntitiesEqual([(await legacyStop(fresh, REUTLINGEN)).entity], built);

  // With junk events the port still answers; the old node would have thrown.
  events.push(null, "junk");
  const withJunk = build(parse({ answers: [{ stop, payload }] }), null, "2026-09-28T03:15:00.000Z");
  assertEntitiesEqual(built, withJunk, { labels: { left: "without junk", right: "with junk events" } });
}

async function noUsableDeparturesWarns(): Promise<void> {
  const payload = structuredClone(fixturePayload("08317008"));
  const events = isRecord(payload) ? payload.stopEvents : undefined;
  assert.ok(Array.isArray(events));
  for (const event of events) if (isRecord(event)) event.isCancelled = true;
  const p = pair(["08317008"]);
  p.answers.set("08317008", { status: 200, payload });
  const upserted = await cycle(p, "all cancelled");
  assert.equal(upserted.length, 0);
  assert.match(p.port.log.warnings()[0] ?? "", /no usable departures/);
}

async function requestProfileIsCapped(): Promise<void> {
  // The old profile, pinned from the frozen flows: one inject per stop, all firing
  // together (once after 15 s, then every 300 s), no delay node in between.
  const nodes = flowNodes().filter((node) => typeof node.id === "string" && node.id.startsWith("udp-rt-o-"));
  const injects = nodes.filter((node) => node.type === "inject");
  const entry = registryEntry("efa-abfahrten");
  const agsList = Array.isArray(entry.enabledFor) ? entry.enabledFor : [];
  assert.equal(injects.length, agsList.length);
  assert.ok(injects.every((node) => node.repeat === "300" && node.once === true && node.onceDelay === "15"));
  assert.equal(nodes.filter((node) => node.type === "delay").length, 0);

  // The new profile: every stop, at most EFA_CONCURRENCY in flight, each
  // request through the shared EFA bucket, no retries.
  const payload = fixturePayload(REUTLINGEN);
  // The same departures for every stop, each answer resolved to the stop asked for.
  const answerFor = (url: string): unknown => ({
    ...(isRecord(payload) ? payload : {}),
    locations: [{ id: new URL(url).searchParams.get("name_dm"), type: "stop", isBest: true }],
  });
  const network = recordingFetcher(
    (request) => (request.url.startsWith(ORION) ? httpResponse(204) : jsonHttp(200, answerFor(request.url))),
    25,
  );
  const g = rig(entry, network.fetcher);
  await run(g.ctx);
  const efa = network.seen.filter((request) => !request.url.startsWith(ORION));
  assert.equal(efa.length, agsList.length, "one request per configured stop");
  assert.ok(network.maxInFlight() <= EFA_CONCURRENCY, `at most ${String(EFA_CONCURRENCY)} in flight`);
  assert.equal(network.maxInFlight(), EFA_CONCURRENCY, "and the cap is actually used");
  for (const request of efa) {
    const options = request.options;
    assert.deepEqual([options?.minIntervalMs, options?.retries], [EFA_MIN_INTERVAL_MS, 0]);
  }
  const upserts = network.seen.filter((request) => request.url.startsWith(ORION));
  assert.equal(upserts.length, 1, "one batch upsert instead of one per stop");
  assert.equal(upsertedEntities(upserts).length, agsList.length);
}

/* ------------------------------------------------ departures of another place */

async function misresolvedStopIsNotWritten(): Promise<void> {
  // DELIBERATE DEVIATION (module header): the old node wrote the guessed
  // place's departures under this stop; the port warns and skips it.
  const p = pair([REUTLINGEN, "08111000"]);
  p.answers.set(REUTLINGEN, { status: 200, payload: misresolved(REUTLINGEN) });
  const legacy = await legacyStop(p, REUTLINGEN);
  assert.ok(isRecord(legacy.entity) && "departures" in legacy.entity, "the old node wrote them");

  const before = p.seen.length;
  await run(p.port.ctx);
  const written = upsertedEntities(p.seen.slice(before));
  assert.deepEqual(
    written.map((entity) => (isRecord(entity) ? entity.id : undefined)),
    [stopOf("08111000").entityId],
    "only the stop EFA resolved is written",
  );
  assert.deepEqual(p.port.log.warnings(), [
    `EFA-BW ${REUTLINGEN}: answer is not for stop ${stopOf(REUTLINGEN).stopId} (EFA resolved another place) — skipped`,
  ]);
}

/* ------------------------------------------------ the 207 of the audit */

/**
 * Orion-LD 1.6.0 on a batch upsert, as reproduced against the real broker:
 * an entity with a `null` attribute value is refused as a whole (207, the
 * error recorded verbatim), every other one is written.
 */
function orionLd16(body: string): HttpResponse {
  const parsed: unknown = JSON.parse(body);
  assert.ok(Array.isArray(parsed));
  const success: unknown[] = [];
  const errors: unknown[] = [];
  for (const entity of parsed) {
    assert.ok(isRecord(entity));
    const nulls = Object.entries(entity).filter(
      ([, attribute]) => isRecord(attribute) && attribute.value === null,
    );
    if (nulls.length === 0) {
      success.push(entity.id);
      continue;
    }
    errors.push({
      entityId: entity.id,
      error: {
        type: "https://uri.etsi.org/ngsi-ld/errors/BadRequestData",
        title: "The use of NULL value is not recommended for JSON-LD (the whole attribute gets ignored)",
        detail: `https://uri.etsi.org/ngsi-ld/default-context/${nulls[0]?.[0] ?? ""}`,
        status: 400,
      },
    });
  }
  return errors.length === 0 ? httpResponse(204) : jsonHttp(207, { success, errors });
}

/** The recorded answer with every real-time flag off: no plausible delay, no median. */
function withoutRealtime(payload: unknown): unknown {
  const copy = structuredClone(payload);
  const events = isRecord(copy) ? copy.stopEvents : undefined;
  assert.ok(Array.isArray(events));
  for (const event of events) if (isRecord(event)) event.isRealtimeControlled = false;
  return copy;
}

async function unknownMedianIsWithdrawnNotNull(): Promise<void> {
  const ags = "08317008";
  const stop = stopOf(ags);
  const key = signatureKey(stop.entityId);
  const deleteUrl = `${ORION}/ngsi-ld/v1/entities/${encodeURIComponent(stop.entityId)}/attrs/avgDelayMinutes`;

  // The old node: `avgDelayMinutes: null` — and the broker refuses the stop.
  const p = pair([ags]);
  p.answers.set(ags, { status: 200, payload: withoutRealtime(fixturePayload(ags)) });
  const legacy = await legacyStop(p, ags);
  assert.ok(isRecord(legacy.entity) && isRecord(legacy.entity.avgDelayMinutes));
  assert.equal(legacy.entity.avgDelayMinutes.value, null);
  const refused = orionLd16(JSON.stringify([legacy.entity]));
  assert.equal(refused.status, 207, "Orion-LD refuses the old entity");

  // The port against the same broker, over seven runs.
  let answer = { status: 200, payload: withoutRealtime(fixturePayload(ags)) };
  let deleteStatus = 500;
  let upsertStatus: number | null = null;
  const network = recordingFetcher((request): HttpResponse => {
    if (request.url.startsWith(ORION)) {
      if (request.method === "DELETE") return httpResponse(deleteStatus);
      if (upsertStatus !== null) return httpResponse(upsertStatus);
      return orionLd16(request.body ?? "[]");
    }
    return jsonHttp(answer.status, answer.payload);
  });
  const port = rig(registryEntry("efa-abfahrten", { enabledFor: [ags] }), network.fetcher);
  const step = async (): Promise<{ deletes: number; upserted: Record<string, unknown> }> => {
    const before = network.seen.length;
    await run(port.ctx);
    const requests = network.seen.slice(before);
    const [entity] = upsertedEntities(requests);
    assert.ok(isRecord(entity));
    return {
      deletes: requests.filter((r) => r.method === "DELETE" && r.url === deleteUrl).length,
      upserted: entity,
    };
  };

  // 1: the withdrawal fails — the entity is still written in full, but its
  // absence is not recorded, so the next run tries again.
  const first = await step();
  assert.equal(first.deletes, 1);
  assert.ok(!("avgDelayMinutes" in first.upserted) && "departures" in first.upserted);
  assert.deepEqual(
    port.log.warnings().filter((w) => !w.includes("delete avgDelayMinutes")),
    [],
  );
  assert.equal(port.ctx.gate.table(key).get("avgDelayMinutes"), undefined);
  assert.equal(port.ctx.gate.table(key).has("departures"), true, "the stop itself was confirmed");

  // 2: withdrawn (404 counts: not held); absence committed with the entity.
  deleteStatus = 404;
  const second = await step();
  assert.equal(second.deletes, 1);
  assert.equal(port.ctx.gate.table(key).get("avgDelayMinutes"), ABSENT);

  // 3: still unknown — no request for it, freshness only.
  const third = await step();
  assert.equal(third.deletes, 0);
  assert.deepEqual(Object.keys(third.upserted).sort(), ["@context", "dateObserved", "id", "type"]);

  // 4: real time is back — the median goes out, its signature replaces ABSENT.
  answer = { status: 200, payload: fixturePayload(ags) };
  const fourth = await step();
  assert.equal(fourth.deletes, 0);
  assert.ok(isRecord(fourth.upserted.avgDelayMinutes));
  assert.equal(typeof fourth.upserted.avgDelayMinutes.value, "number");
  assert.notEqual(port.ctx.gate.table(key).get("avgDelayMinutes"), ABSENT);

  // 5: gone again — withdrawn once more.
  answer = { status: 200, payload: withoutRealtime(fixturePayload(ags)) };
  deleteStatus = 204;
  const fifth = await step();
  assert.equal(fifth.deletes, 1);
  assert.equal(port.ctx.gate.table(key).get("avgDelayMinutes"), ABSENT);
  // Never a refused upsert, never a dropped signature.
  assert.ok(!port.log.warnings().some(isCommitWarning), port.log.warnings().join("\n"));
  const warned = port.log.warnings().length;

  // 6: real time back, then gone with the withdrawal done but the upsert
  // refused: the absence is not committed and the old number is forgotten,
  // so the next run withdraws again.
  answer = { status: 200, payload: fixturePayload(ags) };
  await step();
  answer = { status: 200, payload: withoutRealtime(fixturePayload(ags)) };
  upsertStatus = 503;
  const sixth = await step();
  assert.equal(sixth.deletes, 1);
  assert.equal(port.ctx.gate.table(key).has("avgDelayMinutes"), false);
  assert.ok(port.log.warnings().slice(warned).some(isCommitWarning));
  upsertStatus = null;
  const seventh = await step();
  assert.equal(seventh.deletes, 1);
  assert.equal(port.ctx.gate.table(key).get("avgDelayMinutes"), ABSENT);
}

export {
  unknownMedianIsWithdrawnNotNull as "efa-abfahrten: no median is withdrawn, not sent as null — Orion-LD accepts the batch (deliberate deviation)",
  misresolvedStopIsNotWritten as "efa-abfahrten: departures of a place EFA guessed for the stop id are not written (deliberate deviation)",
  runsAndSignatureTablesMatch as "efa-abfahrten: URLs, deduped entities and oepnvSig tables match the old pipelines over five runs",
  everyEnabledStopMatchesItsOwnNode as "efa-abfahrten: all 23 enabled stops match their own old pipeline over two runs",
  errorPathsWarnAsBefore as "efa-abfahrten: EFA errors, refused connections and non-JSON warn per stop and write nothing",
  edgeCaseEventsMatch as "efa-abfahrten: cancelled, implausible, non-real-time and incomplete events match FN_OEPNV",
  noUsableDeparturesWarns as "efa-abfahrten: a stop without usable departures warns and is not written",
  requestProfileIsCapped as "efa-abfahrten: old profile pinned (23 at once), new one capped at EFA_CONCURRENCY via the EFA bucket",
};
