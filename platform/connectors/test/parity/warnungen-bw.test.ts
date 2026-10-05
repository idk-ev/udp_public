/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: warnungen-bw — the chain FN_KREIS_MSGS (`udp-rt-bk-msgs`) →
 * FN_WARN_WRAP (`udp-rt-bk-wrap`) → join → FN_WARN_BUILD (`udp-rt-bk-build`) →
 * commit (`udp-rt-bk-commit`), and the endpoint FN_WARN_ICS_REQ
 * (`udp-rt-wf-req`) → FN_WARN_ICS_BUILD (`udp-rt-wf-fn`), against the port.
 *
 * Compared: the 88 request URLs (full gui/public file) and the 20 of the
 * trimmed master data fixture; the entities, signatures and chunks built from
 * the recorded join array (with DWD alerts as marked test inputs — there was
 * no DWD warning at recording time); the gate cycle; what `run()` upserts
 * after its own fan-out, against the old wrap and build nodes on the same
 * responses; the join semantics (count, timeout with a late second batch,
 * settle); and the calendar — parameter handling, status, headers, bytes.
 *
 * Fixture: test/fixtures/warnungen-bw.json — the 88 responses of one fan-out
 * (see its `note`).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  boundedHeadlines,
  build,
  calendarResponse,
  calendarUrl,
  HEADLINES_MAX_BYTES,
  NINA_WARNING_URL,
  esc,
  FOLD_OCTETS,
  foldLine,
  CHUNK_SIZE,
  fanIn,
  GATE_KEY,
  kreisParameter,
  parse,
  renderCalendar,
  requestsFor,
  routes,
  run,
  signatureOf,
  UNAVAILABLE_TEXT,
} from "../../src/connectors/warnungen-bw.js";
import type { GroupEnd } from "../../src/connectors/warnungen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { chunk } from "../../src/kernel/orion.js";
import { isArray, isString } from "../../src/kernel/parse.js";
import type {
  HttpResponse,
  NgsiEntity,
  PendingSignature,
  RouteRequest,
  UpsertPlan,
} from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { httpResponse, recordingLog } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { messagesOf, payloadOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";
import { fullGeo, legacyChunks, rig, upsertBodies } from "../harness/water-warnings-rig.js";
import type { LegacyChunks } from "../harness/water-warnings-rig.js";

const MSGS_NODE = "udp-rt-bk-msgs";
const WRAP_NODE = "udp-rt-bk-wrap";
const BUILD_NODE = "udp-rt-bk-build";
const COMMIT_NODE = "udp-rt-bk-commit";
const ICS_REQ_NODE = "udp-rt-wf-req";
const ICS_BUILD_NODE = "udp-rt-wf-fn";
const FIXTURE = "warnungen-bw";

/* ── recorded responses ──────────────────────────────────────────────────────*/

interface Recorded {
  readonly kreis: string;
  readonly quelle: string;
  readonly statusCode: number;
  readonly body: unknown;
}

function recordedUrls(): unknown[] {
  const payload = readFixture(FIXTURE).payload;
  return isArray(payload) ? payload.map((entry) => (isRecord(entry) ? entry.url : null)) : [];
}

function recorded(): Recorded[] {
  const payload = readFixture(FIXTURE).payload;
  assert.ok(isArray(payload));
  return payload.map((entry) => {
    assert.ok(isRecord(entry));
    const { kreis, quelle, statusCode, body } = entry;
    assert.ok(isString(kreis) && isString(quelle) && typeof statusCode === "number");
    return { kreis, quelle, statusCode, body };
  });
}

/**
 * Test input: DWD alerts for Stuttgart in BrightSky's field names — the
 * recording had none. Four current ones (so `slice(0, 3)` cuts), one expired,
 * one without `expires`, one with only `event_de`, apostrophe and a long text.
 */
function withDwdAlerts(responses: readonly Recorded[]): Recorded[] {
  const future = "2999-01-01T00:00:00+00:00";
  const alerts = [
    { headline_de: "Amtliche WARNUNG vor STURMBÖEN", severity: "Moderate", expires: future },
    {
      headline_de: "Amtliche UNWETTERWARNUNG vor ORKANBÖEN im Kreis 'Stuttgart' und Umgebung",
      severity: "Extreme",
      expires: future,
    },
    { headline_de: "Abgelaufene Warnung", severity: "Severe", expires: "2020-01-01T00:00:00+00:00" },
    { event_de: "FROST", severity: "Minor" },
    { headline_de: "", event_de: "GLÄTTE", severity: "Minor", expires: future },
  ];
  return responses.map((response) =>
    response.kreis === "08111" && response.quelle === "dwd" && isRecord(response.body)
      ? { ...response, body: { ...response.body, alerts } }
      : response,
  );
}

/** The old join array: every response through FN_WARN_WRAP, in the given order. */
async function legacyJoin(responses: readonly Recorded[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const response of responses) {
    const wrapped = await runFunctionNode(WRAP_NODE, {
      msg: {
        _msgid: "parity",
        kreis: response.kreis,
        quelle: response.quelle,
        statusCode: response.statusCode,
        payload: structuredClone(response.body),
      },
    });
    out.push(payloadOf(wrapped.returned));
  }
  return out;
}

interface Legacy extends LegacyChunks {
  readonly run: FunctionNodeRun;
}

async function runLegacyBuild(join: unknown, flow: Readonly<Record<string, unknown>> = {}): Promise<Legacy> {
  const run = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: structuredClone(join) },
    flow,
  });
  return { run, ...legacyChunks(run) };
}

function ported(join: unknown, store: SignatureScope): UpsertPlan {
  const entities = build(parse(join), null, new Date().toISOString());
  return createChangeGate(store, recordingLog()).check(GATE_KEY, entities, signatureOf);
}

/** A headline in the old node's shape: cut to 60 characters, no link. */
function legacyHeadline(item: Readonly<Record<string, unknown>>): { h: string; sev: string } {
  return {
    h: typeof item.h === "string" ? item.h.slice(0, 60) : "",
    sev: typeof item.sev === "string" ? item.sev : "",
  };
}

/** A gate signature (`count|severity|headlines JSON`) in the old node's shape. */
function legacySignature(signature: unknown): unknown {
  if (typeof signature !== "string") return signature;
  const [count, severity, ...rest] = signature.split("|");
  const list: unknown = JSON.parse(rest.join("|"));
  const headlines = isArray(list) ? list.map((item) => (isRecord(item) ? legacyHeadline(item) : item)) : list;
  return `${count ?? ""}|${severity ?? ""}|${JSON.stringify(headlines)}`;
}

/** `.value` of an NGSI-LD attribute read off an untyped entity. */
function valueOf(attribute: unknown): unknown {
  return isRecord(attribute) ? attribute.value : undefined;
}

/**
 * DELIBERATE DEVIATION (licence, module header): the port keeps every
 * headline in full and links a NINA warning to its page (`url`); the old node
 * cut headlines to 60 characters. This puts the port's plan into the old
 * shape — headlines cut, no links, signatures recomputed over them — so
 * everything else is still compared with the old node.
 * {@link headlinesInFullWithLinks} checks the deviation itself.
 */
function asLegacyShape(plan: UpsertPlan): UpsertPlan {
  const entities = plan.entities.map((entity): NgsiEntity => {
    const headlines = entity.headlines;
    if (headlines === undefined || typeof headlines === "string" || headlines.type !== "Property")
      return entity;
    const list = headlines.value;
    if (!isArray(list)) return entity;
    const cut = list.map((item) => (isRecord(item) ? legacyHeadline(item) : item));
    return { ...entity, headlines: { ...headlines, value: cut } };
  });
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const pending = plan.pending.map(([key, field, value, id]): PendingSignature => {
    const entity = byId.get(id);
    if (entity === undefined || key !== GATE_KEY || entity.headlines === undefined)
      return [key, field, value, id];
    const signature =
      `${String(valueOf(entity.activeCount))}|${String(valueOf(entity.maxSeverity))}|` +
      JSON.stringify(valueOf(entity.headlines));
    return [key, field, signature, id];
  });
  return { entities, pending };
}

function assertPlanMatches(legacy: Legacy, ported: UpsertPlan): void {
  const plan = asLegacyShape(ported);
  assertEntitiesEqual(legacy.entities, plan.entities);
  assert.deepEqual(normalize(legacy.pending), normalize(plan.pending), "pending signatures differ");
  assert.deepEqual(
    legacy.sizes,
    chunk(plan.entities, CHUNK_SIZE).map((part) => part.length),
    "chunking differs",
  );
}

/* ── requests ────────────────────────────────────────────────────────────────*/

async function requestsAreTheOldOnes(): Promise<void> {
  const full = fullGeo();
  for (const [label, file] of [
    ["gui/public/bw-gemeinden.json", { gemeinden: full.rawRows }],
    ["the trimmed fixture", readFixture("stammdaten-bw").payload],
  ] as const) {
    const legacy = await runFunctionNode(MSGS_NODE, {
      msg: { _msgid: "parity", statusCode: 200, payload: file },
    });
    const old = messagesOf(legacy).map((message) =>
      isRecord(message) ? { url: message.url, kreis: message.kreis, quelle: message.quelle } : null,
    );
    const ports = requestsFor(parseMunicipalities(file).gemeinden);
    assert.deepEqual(normalize(old), normalize(ports), `requests differ for ${label}`);
  }
  assert.equal(requestsFor(full.rows).length, 88);
  // The recording was made with exactly these URLs.
  assert.deepEqual(
    requestsFor(full.rows).map((request) => request.url),
    recordedUrls(),
  );
}

/* ── build and gate ──────────────────────────────────────────────────────────*/

async function recordedJoinIsIdentical(): Promise<void> {
  const join = await legacyJoin(withDwdAlerts(recorded()));
  const legacy = await runLegacyBuild(join);
  const plan = ported(join, new SignatureStore().scope("test"));
  assert.deepEqual(legacy.run.warnings, []);
  assertPlanMatches(legacy, plan);

  assert.equal(plan.entities.length, 88);
  const stuttgart = build(parse(join), null, new Date().toISOString()).find((e) =>
    e.id.endsWith("-08111-dwd"),
  );
  assert.equal(stuttgart?.activeCount.value, 4, "the expired alert is dropped");
  assert.equal(stuttgart.maxSeverity.value, 4);
  assert.equal(stuttgart.headlines.value.length, 3);
  const ludwigsburg = build(parse(join), null, new Date().toISOString()).find((e) =>
    e.id.endsWith("-08118-nina"),
  );
  assert.equal(ludwigsburg?.activeCount.value, 1, "the recorded MOWAS warning");
  assert.equal(ludwigsburg.maxSeverity.value, 1);
}

async function headlinesInFullWithLinks(): Promise<void> {
  // DELIBERATE DEVIATION (licence): official warnings are passed on unaltered.
  const join = await legacyJoin(withDwdAlerts(recorded()));
  const entities = build(parse(join), null, new Date().toISOString());
  const stuttgart = entities.find((e) => e.id.endsWith("-08111-dwd"));
  assert.deepEqual(
    stuttgart?.headlines.value.map((headline) => headline.h),
    [
      "Amtliche WARNUNG vor STURMBÖEN",
      // Longer than 60 characters, which the old node cut; the apostrophe swap stays (TRoE).
      "Amtliche UNWETTERWARNUNG vor ORKANBÖEN im Kreis ’Stuttgart’ und Umgebung",
      "FROST",
    ],
  );
  assert.ok(
    stuttgart.headlines.value.every((headline) => headline.url === undefined),
    "DWD: no per-warning link",
  );
  const ludwigsburg = entities.find((e) => e.id.endsWith("-08118-nina"));
  assert.deepEqual(ludwigsburg?.headlines.value, [
    {
      h: "Trinkwasserverunreinigung - Winzerhausen Holzweiler Hof",
      sev: "minor",
      url: `${NINA_WARNING_URL}mow.DE-BW-LB-W026-20260921-000`,
    },
  ]);

  // A NINA id that is no plain identifier gets no link; the headline stays.
  const odd = parse([
    {
      kreis: "08111",
      quelle: "nina",
      ok: true,
      body: [{ id: "x/y?q=1", payload: { data: { headline: "H", severity: "Minor" } } }],
    },
  ]);
  assert.deepEqual(odd.parts[0]?.items[0]?.headline, { h: "H", sev: "minor" });

  // Long headlines are never cut; the list is shortened by entries to stay
  // below the TRoE compound limit, activeCount keeps the true number.
  const long = (n: number): { h: string; sev: string } => ({
    h: `${String(n)} ${"Ä".repeat(400)}`,
    sev: "severe",
  });
  const bounded = boundedHeadlines([long(1), long(2), long(3)]);
  assert.equal(bounded.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= HEADLINES_MAX_BYTES);
  assert.ok(
    bounded.every((headline) => headline.h.length === 2 + 400),
    "a headline was cut",
  );
  const huge = { h: "Ä".repeat(2000), sev: "extreme" };
  assert.deepEqual(boundedHeadlines([huge, long(2)]), [huge], "the first headline always stays, in full");
}

async function failedAndOddPartsAgree(): Promise<void> {
  // Test inputs: a 503 (dropped), an error text as the body (the old
  // "no response" case: ok stays true, zero items), a body without alerts, a
  // part without district.
  const responses = recorded().slice(0, 8);
  const join = await legacyJoin([
    { ...responses[0], kreis: "08111", quelle: "dwd", statusCode: 503, body: "<html>busy</html>" },
    {
      ...responses[1],
      kreis: "08111",
      quelle: "nina",
      statusCode: 200,
      body: "Error: ETIMEDOUT : https://…",
    },
    { kreis: "08115", quelle: "dwd", statusCode: 200, body: { location: {} } },
    { kreis: "", quelle: "nina", statusCode: 200, body: [] },
    ...responses.slice(4),
  ]);
  const legacy = await runLegacyBuild(join);
  const plan = ported(join, new SignatureStore().scope("test"));
  assertPlanMatches(legacy, plan);
  assert.equal(plan.entities.length, 6);
}

async function gateCycle(): Promise<void> {
  const join = await legacyJoin(recorded());
  const store = new SignatureStore().scope("test");
  const first = await runLegacyBuild(join);
  const plan = ported(join, store);
  let flow = Object.fromEntries(first.run.flow);
  for (const message of first.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    flow = Object.fromEntries(commit.flow);
  }
  store.commit(plan.pending, new Set(plan.entities.map((entity) => entity.id)));
  // The port's table in the old shape (full headlines and links, deliberate; see asLegacyShape).
  const committed = [...store.copy(GATE_KEY)].map(([id, signature]) => [id, legacySignature(signature)]);
  assert.deepEqual(normalize(flow[GATE_KEY]), normalize(Object.fromEntries(committed)));

  // New warnings for Stuttgart: one entity in full, 87 freshness stamps.
  const changed = await legacyJoin(withDwdAlerts(recorded()));
  const second = await runLegacyBuild(changed, flow);
  const secondPlan = ported(changed, store);
  assertPlanMatches(second, secondPlan);
  assert.equal(secondPlan.pending.length, 1);
}

/* ── run(): fan-out, join, write ─────────────────────────────────────────────*/

function responder(rows: Parameters<typeof requestsFor>[0], responses: readonly Recorded[]) {
  const byUrl = new Map<string, Recorded | undefined>(
    requestsFor(rows).map((request) => [
      request.url,
      responses.find((response) => response.kreis === request.kreis && response.quelle === request.quelle),
    ]),
  );
  return (request: SeenRequest): HttpResponse | Error => {
    if (request.url.pathname.endsWith("/bw-gemeinden.json")) {
      return httpResponse(200, JSON.stringify(readFixture("stammdaten-bw").payload));
    }
    const response = byUrl.get(request.url.href);
    if (response !== undefined) {
      return httpResponse(
        response.statusCode,
        isString(response.body) ? response.body : JSON.stringify(response.body),
      );
    }
    if (request.url.host === "orion-ld:1026") return httpResponse(204);
    return new Error(`unexpected request ${request.url.href}`);
  };
}

async function runWritesWhatTheOldChainBuilt(): Promise<void> {
  const rows = parseMunicipalities(readFixture("stammdaten-bw").payload).gemeinden;
  const responses = withDwdAlerts(recorded());
  const r = rig("warnungen-bw", responder(rows, responses));
  const portClock = openClock();
  await run(r.ctx);
  const portWindow = portClock.close();

  // Old chain on the same responses, in request order (the scripted source
  // answers at once, so arrival order is request order).
  const inOrder = requestsFor(rows).map((request) => {
    const response = responses.find(
      (candidate) => candidate.kreis === request.kreis && candidate.quelle === request.quelle,
    );
    assert.ok(response !== undefined);
    return response;
  });
  const joined = await legacyJoin(inOrder);
  const legacyClock = openClock();
  const legacy = await runLegacyBuild(joined);
  const legacyWindow = legacyClock.close();
  const bodies = upsertBodies(r.seen);
  assertEntitiesEqual(legacy.entities, bodies.flat());
  assertClockStamps(legacy.entities, bodies.flat(), { legacy: legacyWindow, ported: portWindow });
  assert.equal(bodies.flat().length, 20, "10 districts of the fixture, DWD and NINA");
  // The fan-out asked for exactly the old URLs, then wrote once.
  const sourceRequests = r.seen
    .filter((request) => request.url.host === "api.brightsky.dev" || request.url.host === "warnung.bund.de")
    .map((request) => request.url.href);
  assert.deepEqual(
    sourceRequests,
    requestsFor(rows).map((request) => request.url),
  );
  assert.deepEqual(r.log.warnings(), []);
}

async function transportFailureKeepsTheLastValue(): Promise<void> {
  // DELIBERATE DEVIATION (decided): the old flow read a request without any
  // response as "no warnings" for its district (FN_WARN_WRAP: `ok:
  // !(msg.statusCode >= 400)` is true for an error string), so an unreachable
  // source could overwrite a real warning with "none". Now such a district is
  // skipped and keeps its last value in Orion; the other 19 are written.
  const rows = parseMunicipalities(readFixture("stammdaten-bw").payload).gemeinden;
  const base = responder(rows, withDwdAlerts(recorded()));
  const failingRequest = requestsFor(rows)[0];
  assert.ok(failingRequest !== undefined);
  const r = rig("warnungen-bw", (request) =>
    request.url.href === failingRequest.url ? new Error("connect ETIMEDOUT") : base(request),
  );
  await run(r.ctx);
  const written = upsertBodies(r.seen).flat();
  assert.equal(written.length, 19);
  const skipped = `urn:ngsi-ld:Alert:bw-kreis-${failingRequest.kreis}-${failingRequest.quelle}`;
  assert.ok(
    written.every((entity) => !isRecord(entity) || entity.id !== skipped),
    `${skipped} must not be written`,
  );
  assert.match(
    r.log.warnings().join("\n"),
    /1 requests without a response, skipped — those districts keep their last value/,
  );
}

/* ── the join ────────────────────────────────────────────────────────────────*/

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

async function joinSemantics(): Promise<void> {
  const groups: { group: readonly string[]; end: GroupEnd }[] = [];
  const collect = (group: readonly string[], end: GroupEnd): Promise<void> => {
    groups.push({ group, end });
    return Promise.resolve();
  };

  // Count reached: two groups of two, the last one closed when all settled.
  await fanIn(
    [after(1, "a"), after(2, "b"), after(3, "c"), after(4, "d"), after(5, "e")],
    { count: 2, timeoutMs: 1000 },
    collect,
  );
  assert.deepEqual(groups.splice(0), [
    { group: ["a", "b"], end: "count" },
    { group: ["c", "d"], end: "count" },
    { group: ["e"], end: "settled" },
  ]);

  // Timeout 60 ms after the FIRST arrival: a, b go out partial; the late c
  // opens its own group, closed once everything has settled.
  await fanIn([after(5, "a"), after(20, "b"), after(200, "c")], { count: 88, timeoutMs: 60 }, collect);
  assert.deepEqual(groups.splice(0), [
    { group: ["a", "b"], end: "timeout" },
    { group: ["c"], end: "settled" },
  ]);

  // Arrival order, not request order; a rejected task never arrives.
  await fanIn(
    [after(30, "slow"), Promise.reject(new Error("lost")), after(5, "fast")],
    { count: 88, timeoutMs: 1000 },
    collect,
  );
  assert.deepEqual(groups.splice(0), [{ group: ["fast", "slow"], end: "settled" }]);

  // Abort: nothing is handed on.
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, 10);
  await fanIn(
    [after(1, "x"), after(500, "y")],
    { count: 88, timeoutMs: 1000, signal: controller.signal },
    collect,
  );
  assert.deepEqual(groups, []);

  // No tasks: returns at once.
  await fanIn([], { count: 88, timeoutMs: 1000 }, collect);
  assert.deepEqual(groups, []);
}

/* ── /warnungen.ics ──────────────────────────────────────────────────────────*/

const STAMP = /\d{8}T\d{6}Z/g;

function unstamped(text: string): string {
  return text.replace(STAMP, "<stamp>");
}

/**
 * RFC 5545 unfolding: a CRLF followed by a space goes. The port folds long
 * lines (deliberate), the old node did not; unfolded, the bytes must agree.
 */
function unfolded(text: string): string {
  return text.replace(/\r\n /g, "");
}

function routeRequest(search: string): RouteRequest {
  return {
    method: "GET",
    path: "/warnungen.ics",
    query: new URLSearchParams(search),
    params: {},
    headers: {},
    body: "",
  };
}

/** Express's query object for the old side (a repeated key becomes an array). */
function expressQuery(search: string): Record<string, string | string[]> {
  const all = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(search)) all.set(key, [...(all.get(key) ?? []), value]);
  const query: Record<string, string | string[]> = {};
  for (const [key, values] of all) query[key] = values.length === 1 ? (values[0] ?? "") : values;
  return query;
}

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function weakEtagOf(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  return `W/"${bytes.length.toString(16)}-${createHash("sha1").update(bytes).digest("base64").slice(0, 27)}"`;
}

async function parameterHandlingAgrees(): Promise<void> {
  for (const search of [
    "kreis=08415",
    "kreis=8415",
    "",
    "kreis=",
    "kreis=08&kreis=415",
    "kreis=08415abc",
    "kreis=<script>08415",
    "kreis=084150",
  ]) {
    const legacy = await runFunctionNode(ICS_REQ_NODE, {
      msg: { _msgid: "parity", req: { query: expressQuery(search) } },
    });
    assert.ok(isArray(legacy.returned));
    const [toOrion, toResponse] = legacy.returned;
    const r = rig("warnungen-bw", () => httpResponse(200, "[]"));
    const response = await calendarResponse(r.ctx, routeRequest(search));
    if (isRecord(toResponse)) {
      assert.equal(response.status, 400, search);
      assert.equal(toResponse.statusCode, 400);
      assert.deepEqual(normalize(toResponse.headers), { "Content-Type": "text/plain" });
      // Express's res.send appended the charset to the bare text/plain.
      assert.equal(response.contentType, "text/plain; charset=utf-8");
      assert.equal(response.body, toResponse.payload);
      assert.equal(r.seen.length, 0, "no Orion query for a bad parameter");
    } else {
      assert.ok(isRecord(toOrion), search);
      assert.equal(response.status, 200, search);
      assert.equal(kreisParameter(new URLSearchParams(search)), toOrion.krs);
      // Same query, however it is percent-encoded.
      const old = new URL(String(toOrion.url));
      const now = r.seen[0]?.url;
      assert.ok(now !== undefined);
      assert.equal(now.origin + now.pathname, old.origin + old.pathname);
      for (const key of ["type", "q", "options"])
        assert.equal(now.searchParams.get(key), old.searchParams.get(key), key);
      assert.equal(now.searchParams.get("limit"), null, "no limit, as before");
    }
    assert.equal(response.headers?.ETag, weakEtagOf(response.body));
  }
}

/** Alerts as Orion returns them with options=keyValues. */
function keyValues(entities: readonly Record<string, unknown>[]): unknown[] {
  return entities.map((entity) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entity)) {
      if (key === "@context") continue;
      out[key] = isRecord(value) && "value" in value ? value.value : value;
    }
    return out;
  });
}

async function calendarBytesAgree(): Promise<void> {
  const join = await legacyJoin(withDwdAlerts(recorded()));
  const entities = build(parse(join), null, new Date().toISOString());
  const stuttgart = keyValues(entities.filter((entity) => entity.ags.value === "08111"));
  const ludwigsburg = keyValues(entities.filter((entity) => entity.ags.value === "08118"));
  // Test inputs for what the escaping and the fallbacks do.
  const odd: unknown[] = [
    {
      id: "urn:ngsi-ld:Alert:x-nina",
      headlines: [
        { headline: "Straße gesperrt; Umleitung, bitte\\folgen", description: "Zeile 1\r\nZeile 2\nZeile 3" },
        { h: "", desc: "nur Beschreibung" },
        { sev: "minor" },
      ],
    },
    { id: "urn:ngsi-ld:Alert:y-dwd", headlines: "ab" },
    { id: "urn:ngsi-ld:Alert:z-dwd" },
  ];
  for (const alerts of [stuttgart, ludwigsburg, odd, [], "not a list"]) {
    const legacy = await runFunctionNode(ICS_BUILD_NODE, {
      msg: { _msgid: "parity", krs: "08111", payload: structuredClone(alerts) },
    });
    assert.ok(isRecord(legacy.returned));
    const oldBody = legacy.returned.payload;
    assert.ok(isString(oldBody));
    const newBody = renderCalendar("08111", isArray(alerts) ? alerts : [], new Date().toISOString());
    // DELIBERATE DEVIATION (licence): a linked headline adds a URL line, the
    // old node had none; everything else is byte for byte the old calendar.
    assert.equal(unstamped(withoutUrlLines(unfolded(newBody))), unstamped(oldBody));
    assert.equal(legacy.returned.statusCode, 200);
    assert.deepEqual(normalize(legacy.returned.headers), { "Content-Type": "text/calendar; charset=utf-8" });
  }
}

/** The calendar without its URL lines (the link to the original warning, deliberate). */
function withoutUrlLines(text: string): string {
  return text.replace(/\r\nURL:[^\r]*/g, "");
}

function calendarLinksTheOriginalWarning(): void {
  const body = renderCalendar(
    "08118",
    [
      {
        id: "urn:ngsi-ld:Alert:bw-kreis-08118-nina",
        headlines: [
          { h: "A", sev: "minor", url: `${NINA_WARNING_URL}mow.DE-BW-LB-W026-20260921-000` },
          // Not a warnung.bund.de page, or not a plain id: no URL line.
          { h: "B", sev: "minor", url: "https://example.org/x" },
          { h: "C", sev: "minor", url: `${NINA_WARNING_URL}a\r\nBEGIN:VEVENT` },
        ],
      },
    ],
    "2026-10-01T12:00:00.000Z",
  );
  const urls = unfolded(body)
    .split("\r\n")
    .filter((line) => line.startsWith("URL:"));
  assert.deepEqual(urls, [`URL:${NINA_WARNING_URL}mow.DE-BW-LB-W026-20260921-000`]);
  assert.equal(calendarUrl(`${NINA_WARNING_URL}mow.x`), `${NINA_WARNING_URL}mow.x`);
  assert.equal(calendarUrl(42), null);
}

async function routeServesTheCalendar(): Promise<void> {
  const join = await legacyJoin(withDwdAlerts(recorded()));
  const entities = build(parse(join), null, new Date().toISOString());
  const alerts = keyValues(entities.filter((entity) => entity.ags.value === "08111"));

  const answer = httpResponse(200, JSON.stringify(alerts));
  const r = rig("warnungen-bw", () => answer);
  const [route] = routes(r.ctx);
  assert.ok(route !== undefined);
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/warnungen.ics");
  const response = await route.handle(routeRequest("kreis=08111"));
  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/calendar; charset=utf-8");
  assert.equal(response.headers?.ETag, weakEtagOf(response.body));
  const legacy = await runFunctionNode(ICS_BUILD_NODE, {
    msg: { _msgid: "parity", krs: "08111", payload: parseJson(answer.body) },
  });
  assert.ok(isRecord(legacy.returned) && isString(legacy.returned.payload));
  assert.equal(unstamped(unfolded(response.body)), unstamped(legacy.returned.payload));
  // One read; unpaced and without retry (src/kernel/orion.ts), the nginx in front gives up after 60 s.
  const reads = r.seen.filter((request) => request.url.pathname === "/ngsi-ld/v1/entities");
  assert.equal(reads.length, 1);
}

async function orionFailureIsA503(): Promise<void> {
  // DELIBERATE DEVIATION (decided with the fix of the fan-out): the old node
  // read an Orion error as "no alerts" and served a 200 calendar "Keine
  // amtlichen Warnungen" while the broker was down. Now: 503, which the
  // cockpit nginx does not cache and a calendar client answers by keeping its
  // last events.
  // A refused connection is a (throttled) [warn] now, no longer an [error] per
  // request — see calendarFailureLogIsThrottled.
  const failures: readonly [HttpResponse | Error, RegExp][] = [
    [httpResponse(500, JSON.stringify({ type: "InternalError" })), /Orion answered HTTP 500/],
    [new Error("connect ECONNREFUSED 10.0.0.1:1026"), /Orion query failed/],
  ];
  for (const [answer, expected] of failures) {
    const r = rig("warnungen-bw", () => answer);
    const [route] = routes(r.ctx);
    assert.ok(route !== undefined);
    const response = await route.handle(routeRequest("kreis=08111"));
    assert.equal(response.status, 503);
    assert.equal(response.contentType, "text/plain; charset=utf-8");
    assert.equal(response.body, UNAVAILABLE_TEXT);
    assert.equal(response.headers?.ETag, weakEtagOf(response.body));
    assert.match(r.log.warnings().join("\n"), expected);
    assert.deepEqual(
      r.log.lines.filter((line) => line.level === "error"),
      [],
      "no [error] for a public request",
    );
  }
}

async function calendarFailureLogIsThrottled(): Promise<void> {
  // DELIBERATE DEVIATION (security review): every public request could log a
  // counted line; now at most one [warn] a minute, the rest at debug.
  const r = rig("warnungen-bw", () => new Error("connect ECONNREFUSED 10.0.0.1:1026"));
  const [route] = routes(r.ctx);
  assert.ok(route !== undefined);
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await route.handle(routeRequest("kreis=08111"))).status, 503);
  }
  assert.equal(r.log.warnings().length, 1, "one [warn] for 25 failing requests");
  assert.equal(r.log.lines.filter((line) => line.level === "error").length, 0);
  assert.equal(
    r.log.lines.filter((line) => line.level === "debug" && line.text.includes("Orion")).length,
    24,
  );
}

function escapingNeutralisesEveryLineBreak(): void {
  // DELIBERATE DEVIATION (security review): a lone CR passed the old escaping
  // and let a headline forge a property or a whole event.
  const forged = "Sturm\rURL:https://evil.example/\rEND:VEVENT\r\nBEGIN:VEVENT\nX";
  assert.equal(esc(forged), "Sturm\\nURL:https://evil.example/\\nEND:VEVENT\\nBEGIN:VEVENT\\nX");
  assert.equal(esc("a\u0000b\u0007c\u001bd\u007fe\tf"), "abcde\tf", "controls dropped, the tab kept");
  assert.equal(esc("x,y;z\\"), "x\\,y\\;z\\\\", "the old escapes are unchanged");

  const body = renderCalendar(
    "08111",
    [{ id: "urn:ngsi-ld:Alert:a-dwd", headlines: [{ headline: forged, description: "d" }] }],
    "2026-09-01T00:00:00.000Z",
  );
  const lines = unfolded(body).split("\r\n");
  assert.equal(lines.filter((line) => line.startsWith("URL:")).length, 0);
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1, "no forged event");
  assert.equal(body.includes("\r") && /\r(?!\n)/.test(body), false, "no lone CR anywhere");
}

function longLinesAreFoldedAt75Octets(): void {
  const long = "Ä".repeat(60) + "x".repeat(100) + "🌩".repeat(20);
  const folded = foldLine(`SUMMARY:${long}`);
  const lines = folded.split("\r\n");
  assert.ok(lines.length > 3);
  for (const [index, line] of lines.entries()) {
    assert.ok(Buffer.byteLength(line, "utf8") <= FOLD_OCTETS, `line ${String(index)} too long`);
    if (index > 0) assert.ok(line.startsWith(" "), "continuation starts with a space");
    assert.ok(!line.includes("\ufffd"), "no split code point");
  }
  assert.equal(folded.replace(/\r\n /g, ""), `SUMMARY:${long}`, "unfolding restores the line");
  assert.equal(foldLine("SHORT:line"), "SHORT:line");
  assert.equal(foldLine("x".repeat(75)), "x".repeat(75), "exactly 75 octets stay one line");
}

export {
  requestsAreTheOldOnes as "warnungen-bw: the 88 (and the fixture's 20) requests are the old FN_KREIS_MSGS URLs, in order",
  recordedJoinIsIdentical as "warnungen-bw: old wrap + FN_WARN_BUILD and ported parse/build + gate agree on the recorded join",
  headlinesInFullWithLinks as "warnungen-bw: headlines in full, NINA linked to its warning, list bounded by entries (deliberate, licence)",
  calendarLinksTheOriginalWarning as "warnungen-bw: the calendar links a NINA warning to its page, nothing else (deliberate, licence)",
  failedAndOddPartsAgree as "warnungen-bw: failed, error-text, alert-less and district-less parts agree",
  gateCycle as "warnungen-bw: commit matches the old commit node; changed warnings of one district are sent in full",
  runWritesWhatTheOldChainBuilt as "warnungen-bw: run() fans out, joins and upserts what the old chain built",
  transportFailureKeepsTheLastValue as "warnungen-bw: a request without response is skipped, the district keeps its last value (deliberate deviation)",
  joinSemantics as "warnungen-bw: fan-in keeps the join's count/timeout semantics, late responses as a second batch",
  parameterHandlingAgrees as "warnungen-bw: /warnungen.ics parameter handling, 400 and Orion query agree with FN_WARN_ICS_REQ",
  calendarBytesAgree as "warnungen-bw: calendar bytes agree with FN_WARN_ICS_BUILD (escaping, fallbacks, empty)",
  routeServesTheCalendar as "warnungen-bw: the route answers 200 with the old calendar from one Orion read",
  orionFailureIsA503 as "warnungen-bw: Orion unreachable or failing is a 503, not a calendar without warnings (deliberate deviation)",
  calendarFailureLogIsThrottled as "warnungen-bw: failing calendar reads log at most one [warn] a minute, never [error] (deliberate)",
  escapingNeutralisesEveryLineBreak as "warnungen-bw: calendar escaping turns a lone CR into \\n and drops control characters (deliberate)",
  longLinesAreFoldedAt75Octets as "warnungen-bw: calendar lines are folded at 75 octets, UTF-8 safe (deliberate)",
};
