/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: abfahrten-on-demand — `GET /abfahrten?ags=<AGS>` as the client saw
 * it. Old side: `http in` → FN_ABF_HALT (`udp-rt-ab-halt`) → `http request` →
 * FN_ABF_BAUEN (`udp-rt-ab-fn`) → `http response`, the two function nodes run
 * in the vm, the three HTTP nodes stood in for by test/harness/g-transport.ts.
 * New side: the connector's route on a real kernel HTTP server, fetched over a
 * socket after `run(ctx)` loaded the stop directory.
 *
 * Compared: status, `Content-Type`, `Content-Length`, `ETag`, the absence of
 * any other header, and the body — for a valid AGS, an unknown one, one
 * without a stop, malformed ones, a missing directory, and every way EFA can
 * fail. The 200 body carries the clock (`stand`), so it is compared with
 * `stand` blanked and each side's ETag checked against its own body.
 *
 * DELIBERATE DEVIATION (module header): `zeit` is Berlin time, the old node's
 * was the UTC cut. It is blanked in the comparison too and pinned against the
 * fixture's times in {@link departureTimesAreLocal}.
 *
 * Fixtures: test/fixtures/abfahrten-on-demand-08115003.json (real departure
 * monitor answer for Böblingen, limit 12, trimmed as its `note` says); the
 * directory entries are taken from the committed gui/public/oepnv-halte.json.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAP_LOG_PREFIX,
  CAPPED_TEXT,
  clock,
  DAILY_CAP_ENV,
  DEFAULT_DAILY_CAP,
  DIRECTORY,
  DIRECTORY_URL,
  ROUTE_PATH,
  run,
  routes,
  stretchedCacheSeconds,
} from "../../src/connectors/abfahrten-on-demand.js";
import { EFA_HOST, EFA_MIN_INTERVAL_MS, isEmptyDepartureMonitor } from "../../src/connectors/efa.js";
import { isArray } from "../../src/kernel/parse.js";
import { memoryQuota } from "../../src/kernel/quota.js";
import type { Ctx, HttpResponse, RouteDefinition, RouteRequest } from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "../harness/fixtures.js";
import type { WireResponse } from "../harness/g-transport.js";
import {
  afterHttpRequest,
  httpResponseNode,
  jsonHttp,
  recordingFetcher,
  registryEntry,
  rig,
  weakEtag,
  wire,
} from "../harness/g-transport.js";
import { httpResponse } from "../harness/kernel.js";
import { isRecord } from "../harness/normalize.js";
import { recordEnv } from "../harness/operations-ctx.js";
import { runFunctionNode } from "../harness/vm-runner.js";

const FIXTURE = "abfahrten-on-demand-08115003";

/** Directory entry for the recorded no-departures stop (test input, not in oepnv-halte.json). */
const GSCHWEND = { ags: "08136025", stopId: "de:08136:2700", stopName: "Gschwend, L1150" };

/** Real entries of the committed directory, plus one without a stop id and Gschwend (test input). */
function directory(): Record<string, unknown> {
  const file: unknown = JSON.parse(
    readFileSync(join(repositoryRoot(), "gui", "public", "oepnv-halte.json"), "utf8"),
  );
  const halte = isRecord(file) ? file.halte : undefined;
  assert.ok(isRecord(halte));
  return {
    "08115003": halte["08115003"],
    "08111000": halte["08111000"],
    "08415061": halte["08415061"],
    "08999999": { stopName: "ohne Halt", qualitaet: 0, art: "ort" },
    [GSCHWEND.ags]: { stopId: GSCHWEND.stopId, stopName: GSCHWEND.stopName, qualitaet: 1000, art: "ort" },
  };
}

/** How EFA answers in a scenario. */
type Efa = HttpResponse | Error;

const efaOk = (): Efa => {
  const fixture = readFixture(FIXTURE);
  return jsonHttp(fixture.statusCode, fixture.payload, { "x-efa-server": "efa10" });
};

interface Scenario {
  readonly name: string;
  /** Query string after `?`, as the client sends it. */
  readonly query: string;
  /** `req.query` as Express's parser would have produced it. */
  readonly expressQuery: Record<string, unknown>;
  readonly efa: Efa;
  /** Whether the directory has been loaded. */
  readonly loaded?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "valid AGS", query: "ags=08115003", expressQuery: { ags: "08115003" }, efa: efaOk() },
  { name: "unknown AGS", query: "ags=08999998", expressQuery: { ags: "08999998" }, efa: efaOk() },
  { name: "AGS without stop id", query: "ags=08999999", expressQuery: { ags: "08999999" }, efa: efaOk() },
  { name: "no parameter", query: "", expressQuery: {}, efa: efaOk() },
  { name: "empty parameter", query: "ags=", expressQuery: { ags: "" }, efa: efaOk() },
  { name: "letters", query: "ags=abc", expressQuery: { ags: "abc" }, efa: efaOk() },
  { name: "seven digits", query: "ags=0811500", expressQuery: { ags: "0811500" }, efa: efaOk() },
  {
    name: "markup",
    query: "ags=%3Cscript%3E%22%27",
    expressQuery: { ags: "<script>\"'" },
    efa: efaOk(),
  },
  { name: "__proto__", query: "ags=__proto__", expressQuery: { ags: "__proto__" }, efa: efaOk() },
  {
    name: "repeated parameter",
    query: "ags=08115003&ags=08111000",
    expressQuery: { ags: ["08115003", "08111000"] },
    efa: efaOk(),
  },
  {
    name: "directory not loaded",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: efaOk(),
    loaded: false,
  },
  {
    name: "EFA 500",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: httpResponse(500, "<html>Internal Server Error</html>", {
      "content-type": "text/html",
      "x-efa-server": "efa10",
    }),
  },
  {
    name: "EFA refused",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: new Error("connect ECONNREFUSED 1.2.3.4:443"),
  },
  {
    name: "EFA 200 not JSON",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: httpResponse(200, "<html>maintenance</html>", { "content-type": "text/html" }),
  },
  {
    name: "EFA 200 without stopEvents",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: jsonHttp(200, { systemMessages: [{ text: "stop not found" }] }),
  },
];

/** The old flow on `scenario`: the response and the URL it asked EFA for. */
async function legacy(scenario: Scenario): Promise<{ response: WireResponse; url: string | null }> {
  const msg = {
    _msgid: "parity",
    req: { query: scenario.expressQuery },
    res: {},
    payload: scenario.expressQuery,
  };
  const halt = await runFunctionNode("udp-rt-ab-halt", {
    msg,
    global: scenario.loaded === false ? {} : { oepnvHalte: directory() },
  });
  const outputs = halt.returned;
  assert.ok(isArray(outputs) && outputs.length === 2, "FN_ABF_HALT has two outputs");
  const [toEfa, toResponse] = outputs;
  if (isRecord(toResponse)) return { response: httpResponseNode(toResponse), url: null };
  assert.ok(isRecord(toEfa));
  const url = toEfa.url;
  assert.ok(typeof url === "string");
  const built = await runFunctionNode("udp-rt-ab-fn", { msg: afterHttpRequest(toEfa, scenario.efa) });
  return { response: httpResponseNode(built.returned), url };
}

/** The port on `scenario`, over a real socket. */
async function ported(
  scenario: Scenario,
): Promise<{ response: WireResponse; url: string | null; warnings: number }> {
  const network = recordingFetcher((request) => {
    if (request.url === DIRECTORY_URL) return jsonHttp(200, { _doc: "test", halte: directory() });
    return scenario.efa;
  });
  const g = rig(registryEntry("abfahrten-on-demand"), network.fetcher);
  if (scenario.loaded !== false) await run(g.ctx);
  const server = g.kernel.publicHttp;
  for (const route of routes(g.ctx)) server.register(route);
  await server.listen(0, "127.0.0.1");
  try {
    const before = network.seen.length;
    const response = await wire(
      `http://127.0.0.1:${String(server.port() ?? 0)}${ROUTE_PATH}${scenario.query === "" ? "" : `?${scenario.query}`}`,
    );
    const efa = network.seen.slice(before);
    assert.ok(efa.length <= 1, "at most one EFA request per page view");
    for (const request of efa) {
      const options = request.options;
      // The shared EFA bucket, and no retry — the http request node had none.
      assert.deepEqual([options?.minIntervalMs, options?.retries], [EFA_MIN_INTERVAL_MS, 0]);
    }
    return { response, url: efa[0]?.url ?? null, warnings: g.log.warnings().length };
  } finally {
    await server.close();
  }
}

/** Body with the clock and the departure times blanked; the rest byte-exact as parsed JSON. */
function comparable(response: WireResponse): unknown {
  const body: unknown = JSON.parse(response.body);
  if (!isRecord(body) || !("stand" in body)) return body;
  const rows = Array.isArray(body.abfahrten)
    ? body.abfahrten.map((row: unknown) => (isRecord(row) ? { ...row, zeit: "<time>" } : row))
    : body.abfahrten;
  return { ...body, stand: "<timestamp>", abfahrten: rows };
}

function headerNames(response: WireResponse): string[] {
  return Object.keys(response.headers).sort();
}

async function everyAnswerMatches(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const old = await legacy(scenario);
    const now = await ported(scenario);
    const at = `${scenario.name} (?${scenario.query})`;

    assert.equal(now.url, old.url, `${at}: EFA request URL differs`);
    assert.equal(now.response.status, old.response.status, `${at}: status differs`);
    assert.deepEqual(headerNames(now.response), headerNames(old.response), `${at}: header set differs`);
    assert.equal(
      now.response.headers["content-type"],
      old.response.headers["content-type"],
      `${at}: content type`,
    );
    assert.deepEqual(comparable(now.response), comparable(old.response), `${at}: body differs`);
    for (const side of [old.response, now.response]) {
      assert.equal(side.headers.etag, weakEtag(side.body), `${at}: ETag is not Express's over the body`);
      assert.equal(side.headers["content-length"], String(Buffer.byteLength(side.body)), `${at}: length`);
    }
    if (old.response.status !== 200) {
      // No clock in the error bodies: byte-identical, hence the same ETag.
      assert.equal(now.response.body, old.response.body, `${at}: error body bytes differ`);
      assert.equal(now.response.headers.etag, old.response.headers.etag, `${at}: ETag differs`);
    }
    assert.equal(now.warnings, scenario.efa instanceof Error && old.url !== null ? 1 : 0, `${at}: warnings`);
  }
}

async function validAnswerHasTheDashboardShape(): Promise<void> {
  const now = await ported(SCENARIOS[0] ?? assert.fail("no scenario"));
  assert.equal(now.response.status, 200);
  const body: unknown = JSON.parse(now.response.body);
  assert.ok(isRecord(body));
  assert.deepEqual(Object.keys(body), [
    "halt",
    "stopId",
    "stand",
    "medianVerspaetung",
    "echtzeitAbfahrten",
    "quelle",
    "abfahrten",
  ]);
  const rows = body.abfahrten;
  assert.ok(Array.isArray(rows) && rows.length === 12);
  assert.deepEqual(Object.keys(isRecord(rows[0]) ? rows[0] : {}), ["linie", "ziel", "zeit", "verspaetung"]);
  // What gui/public/stadt.html reads: medianVerspaetung, halt, echtzeitAbfahrten, abfahrten[].
  assert.equal(typeof body.echtzeitAbfahrten, "number");
}

async function departureTimesAreLocal(): Promise<void> {
  const now = await ported(SCENARIOS[0] ?? assert.fail("no scenario"));
  const body: unknown = JSON.parse(now.response.body);
  assert.ok(isRecord(body) && Array.isArray(body.abfahrten));
  const payload = readFixture(FIXTURE).payload;
  const events = isRecord(payload) && Array.isArray(payload.stopEvents) ? payload.stopEvents : [];
  const expected = events.map((event: unknown) => {
    const e = isRecord(event) ? event : {};
    const shown = [e.departureTimeEstimated, e.departureTimePlanned].find((t) => typeof t === "string");
    return typeof shown === "string" ? clock(shown) : "";
  });
  assert.deepEqual(
    body.abfahrten.map((row: unknown) => (isRecord(row) ? row.zeit : null)),
    expected,
  );
  // Recorded 2026-09-28, summer time: UTC + 2 h.
  assert.equal(clock("2026-09-28T03:12:06Z"), "05:12");
  assert.equal(clock("2026-12-01T23:30:00Z"), "00:30");
  assert.equal(clock("2026-13-45T25:99:00"), "25:99", "unparseable: the old cut");
}

async function failedDirectoryLoadKeepsThePreviousOne(): Promise<void> {
  let answer: HttpResponse = jsonHttp(200, { halte: directory() });
  const network = recordingFetcher(() => answer);
  const g = rig(registryEntry("abfahrten-on-demand"), network.fetcher);
  await run(g.ctx);
  answer = httpResponse(404, "not found");
  await run(g.ctx);
  assert.match(g.log.warnings()[0] ?? "", /stop directory not loadable \(404\).*efa-haltestellen\.py/);

  // The old node: same warning, global untouched.
  const old = await runFunctionNode("udp-rt-ah-fn", {
    msg: { _msgid: "parity", statusCode: 404, payload: "not found" },
    global: { oepnvHalte: { kept: true } },
  });
  assert.equal(old.warnings.length, 1);
  assert.deepEqual(old.global.get("oepnvHalte"), { kept: true });

  const [route] = routes(g.ctx);
  assert.ok(route !== undefined);
  const response = await route.handle({
    method: "GET",
    path: ROUTE_PATH,
    query: new URLSearchParams("ags=08999999"),
    params: {},
    headers: {},
    body: "",
  });
  assert.equal(response.status, 404, "the directory of the first run still answers");
}

/** A recorded EFA-BW answer as the fetcher returns it. */
function recorded(name: string): Efa {
  const fixture = readFixture(name);
  return jsonHttp(fixture.statusCode, fixture.payload);
}

/** The recorded payload of a fixture, for the unit checks. */
function recordedPayload(name: string): unknown {
  return readFixture(name).payload;
}

/**
 * Deliberate deviation: the old node answered 502 "Auskunft nicht erreichbar"
 * for a stop without departures; the port answers 200 with an empty list.
 * Real answer: Gschwend, Saturday 01:00 – no stopEvents, error -4050
 * "no serving lines found", the stop itself with isBest.
 */
async function noDeparturesIsAnEmptyList(): Promise<void> {
  const scenario: Scenario = {
    name: "EFA 200 valid, no departures",
    query: `ags=${GSCHWEND.ags}`,
    expressQuery: { ags: GSCHWEND.ags },
    efa: recorded("abfahrten-on-demand-keine-abfahrten"),
  };
  const old = await legacy(scenario);
  assert.equal(old.response.status, 502, "the old node's answer changed – revisit the deviation");
  const now = await ported(scenario);
  assert.equal(now.response.status, 200);
  const body: unknown = JSON.parse(now.response.body);
  assert.ok(isRecord(body));
  assert.deepEqual(
    { ...body, stand: "<timestamp>" },
    {
      halt: GSCHWEND.stopName,
      stopId: GSCHWEND.stopId,
      stand: "<timestamp>",
      medianVerspaetung: null,
      echtzeitAbfahrten: 0,
      quelle: "MobiData BW; NVBW – EFA-BW (dl-de/by-2-0)",
      abfahrten: [],
    },
  );
  assert.equal(now.warnings, 0);
}

/** Only the requested stop, resolved, without other errors is "no departures"; the rest stays 502. */
async function realErrorsStay502(): Promise<void> {
  const night = recordedPayload("abfahrten-on-demand-keine-abfahrten");
  assert.equal(isEmptyDepartureMonitor(night, GSCHWEND.stopId), true);
  assert.ok(isRecord(night));
  const stop = { id: GSCHWEND.stopId, name: GSCHWEND.stopName, type: "stop", isBest: true };
  assert.equal(
    isEmptyDepartureMonitor(
      { ...night, locations: [{ ...stop, id: `${GSCHWEND.stopId}:1:1` }] },
      GSCHWEND.stopId,
    ),
    true,
    "a platform of the requested stop",
  );
  for (const [what, payload] of [
    // Recorded: an unknown stop id gets fuzzy candidates – another stop, isBest false.
    ["unknown stop (recorded)", recordedPayload("abfahrten-on-demand-unbekannter-halt")],
    // Recorded: "invalid date" (code -1) with the stop resolved.
    ["invalid date (recorded)", recordedPayload("abfahrten-on-demand-ungueltiges-datum")],
    [
      "error -4001",
      { ...night, systemMessages: [{ type: "error", module: "BROKER", code: -4001, text: "invalid date" }] },
    ],
    [
      "-4050 plus another error",
      {
        ...night,
        systemMessages: [
          { type: "error", code: -4050 },
          { type: "error", code: -2000 },
        ],
      },
    ],
    ["systemMessages not an array", { ...night, systemMessages: "error" }],
    ["stop not best match", { ...night, locations: [{ ...stop, isBest: false }] }],
    ["another stop", { ...night, locations: [{ ...stop, id: "de:08136:27001" }] }],
    ["location is no stop", { ...night, locations: [{ ...stop, type: "poi" }] }],
    ["no version", { locations: [stop] }],
    ["no locations", { version: "11" }],
    ["empty locations", { version: "11", locations: [] }],
    ["stopEvents not an array", { ...night, stopEvents: null }],
    ["stop not found", { systemMessages: [{ text: "stop not found" }] }],
    ["not an object", "<html>maintenance</html>"],
    ["nothing", null],
  ] as const) {
    assert.equal(isEmptyDepartureMonitor(payload, GSCHWEND.stopId), false, what);
  }
  for (const efa of [
    recorded("abfahrten-on-demand-unbekannter-halt"),
    recorded("abfahrten-on-demand-ungueltiges-datum"),
    jsonHttp(200, { version: "11", systemMessages: [{ type: "error", code: -2000 }] }),
    jsonHttp(503, night),
    new Error("socket hang up"),
  ]) {
    const now = await ported({ name: "error", query: `ags=${GSCHWEND.ags}`, expressQuery: {}, efa });
    assert.equal(now.response.status, 502);
    assert.deepEqual(JSON.parse(now.response.body), {
      fehler: "Auskunft nicht erreichbar",
      halt: GSCHWEND.stopName,
    });
  }
}

/**
 * Deliberate deviation: EFA resolves an unknown or removed id to another
 * place and answers with its departures. The old node showed them under this
 * stop's name; the port answers 502 ("gestört" on the page). Modelled on a
 * real answer for an unknown id: a POI as best match, the stop only fuzzy.
 */
async function misresolvedStopIs502(): Promise<void> {
  const real = recordedPayload("abfahrten-on-demand-08115003");
  assert.ok(isRecord(real));
  const guessed = {
    ...real,
    locations: [
      {
        id: "poiID:1655788:8211000:-1:Domaine1795:Baden-Baden:Domaine1795:ANY:POI:915365:5757868:MRCV:b_w",
        name: "Baden-Baden, Domaine1795",
        type: "poi",
        isBest: true,
      },
      { id: "de:08115:7100", name: "Böblingen, Böblingen", type: "stop", isBest: false },
    ],
  };
  const scenario: Scenario = {
    name: "EFA answers for another place",
    query: "ags=08115003",
    expressQuery: { ags: "08115003" },
    efa: jsonHttp(200, guessed),
  };
  const old = await legacy(scenario);
  assert.equal(old.response.status, 200, "the old node's answer changed – revisit the deviation");
  const now = await ported(scenario);
  assert.equal(now.response.status, 502);
  const body: unknown = JSON.parse(now.response.body);
  assert.ok(isRecord(body));
  assert.equal(body.fehler, "Auskunft nicht erreichbar");
  // The recorded answer itself, resolved to the stop, still lists its departures.
  const fine = await ported({ ...scenario, efa: recorded("abfahrten-on-demand-08115003") });
  assert.equal(fine.response.status, 200);
}

/** -4030 "no matching departure" for the resolved stop is "no departures" like -4050. */
async function noMatchingDepartureIsEmpty(): Promise<void> {
  const night = recordedPayload("abfahrten-on-demand-keine-abfahrten");
  assert.ok(isRecord(night));
  const evening = {
    ...night,
    systemMessages: [{ type: "error", module: "BROKER", code: -4030, text: "no matching departure found" }],
  };
  assert.equal(isEmptyDepartureMonitor(evening, GSCHWEND.stopId), true);
  // Same resolved-stop rule as for -4050.
  const stop = { id: GSCHWEND.stopId, name: GSCHWEND.stopName, type: "stop" };
  assert.equal(
    isEmptyDepartureMonitor({ ...evening, locations: [{ ...stop, isBest: false }] }, GSCHWEND.stopId),
    false,
  );
  assert.equal(
    isEmptyDepartureMonitor(
      { ...evening, locations: [{ ...stop, id: "de:08136:27001", isBest: true }] },
      GSCHWEND.stopId,
    ),
    false,
  );
  const now = await ported({
    name: "-4030",
    query: `ags=${GSCHWEND.ags}`,
    expressQuery: { ags: GSCHWEND.ags },
    efa: jsonHttp(200, evening),
  });
  assert.equal(now.response.status, 200);
  const body: unknown = JSON.parse(now.response.body);
  assert.ok(isRecord(body));
  assert.deepEqual(body.abfahrten, []);
}

/**
 * Deliberate deviation: the directory is reloaded hourly, not daily, as a
 * conditional GET. During a rolling update the first load can reach a cockpit
 * that still serves the old file; the old node kept that for a day.
 */
async function directoryIsReloadedConditionally(): Promise<void> {
  const entry = registryEntry("abfahrten-on-demand");
  assert.equal(entry.intervalSeconds, 3600, "hourly");
  let file: unknown = { halte: { "08115003": { stopId: "de:08115:1", stopName: "Alt" } } };
  let etag = 'W/"alt"';
  const network = recordingFetcher((request) => {
    assert.equal(request.url, DIRECTORY_URL);
    const sent = request.options?.headers ?? {};
    if (sent["If-None-Match"] === etag) return httpResponse(304, "");
    return jsonHttp(200, file, { etag, "last-modified": "Wed, 30 Sep 2026 10:00:00 GMT" });
  });
  const g = rig(entry, network.fetcher);
  const stopOf = (): string | undefined => g.ctx.state.slot(DIRECTORY).get()?.get("08115003")?.stopId;

  // First load: unconditional (nothing in memory to fall back on).
  await run(g.ctx);
  assert.deepEqual(network.seen[0]?.options?.headers ?? {}, {});
  assert.equal(stopOf(), "de:08115:1");
  // Unchanged: a 304, the directory stays.
  await run(g.ctx);
  assert.deepEqual(network.seen[1]?.options?.headers, {
    "If-None-Match": 'W/"alt"',
    "If-Modified-Since": "Wed, 30 Sep 2026 10:00:00 GMT",
  });
  assert.equal(stopOf(), "de:08115:1");
  // The new file arrives: the next reload serves it.
  file = { halte: { "08115003": { stopId: "de:08115:7100", stopName: "Bahnhof" } } };
  etag = 'W/"neu"';
  await run(g.ctx);
  assert.equal(stopOf(), "de:08115:7100");
  assert.deepEqual(g.log.warnings(), []);
}

/* ------------------------------------------------------------------ daily cap */

/** Eight municipalities `0811000x`, each with a stop `de:08111:900x` named `Halt x`. */
function capDirectory(): Record<string, unknown> {
  const halte: Record<string, unknown> = {};
  for (let i = 0; i < 8; i += 1) {
    halte[`0811000${String(i)}`] = { stopId: `de:08111:900${String(i)}`, stopName: `Halt ${String(i)}` };
  }
  return halte;
}

function capRequest(i: number): RouteRequest {
  return {
    method: "GET",
    path: ROUTE_PATH,
    query: new URLSearchParams(`ags=0811000${String(i)}`),
    params: {},
    headers: {},
    body: "",
  };
}

interface CapRig {
  readonly ctx: Ctx;
  readonly route: RouteDefinition;
  readonly efaRequests: () => number;
  readonly lines: () => readonly { level: string; text: string }[];
  /** Moves the clock of the route, the counter and the reuse window. */
  readonly at: (iso: string) => void;
}

/** The endpoint with a cap from the environment and one clock for everything. */
async function capRig(env: Record<string, string>): Promise<CapRig> {
  let nowMs = Date.parse("2026-10-05T10:00:00.000Z");
  const network = recordingFetcher((request) => {
    if (request.url === DIRECTORY_URL) return jsonHttp(200, { halte: capDirectory() });
    const stopId = new URL(request.url).searchParams.get("name_dm") ?? "";
    return jsonHttp(200, { stopEvents: [], locations: [{ id: stopId, type: "stop", isBest: true }] });
  });
  const g = rig(registryEntry("abfahrten-on-demand"), network.fetcher);
  const ctx: Ctx = {
    ...g.ctx,
    env: recordEnv(env),
    quota: memoryQuota("abfahrten-on-demand", () => nowMs),
    now: () => new Date(nowMs).toISOString(),
  };
  await run(ctx);
  const [route] = routes(ctx);
  assert.ok(route !== undefined);
  return {
    ctx,
    route,
    efaRequests: () => network.seen.filter((request) => request.url !== DIRECTORY_URL).length,
    lines: () => g.log.lines,
    at: (iso) => {
      nowMs = Date.parse(iso);
    },
  };
}

function capLines(r: CapRig, level: string): string[] {
  return r
    .lines()
    .filter((line) => line.level === level && line.text.startsWith(CAP_LOG_PREFIX))
    .map((line) => line.text);
}

async function dailyCapRefusesAndIsVisible(): Promise<void> {
  const r = await capRig({ [DAILY_CAP_ENV]: "5" });
  const statuses: number[] = [];
  for (let i = 0; i < 7; i += 1) statuses.push((await r.route.handle(capRequest(i))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 503, 503]);
  assert.equal(r.efaRequests(), 5, "no EFA request beyond the cap");
  assert.equal(r.ctx.quota.used(EFA_HOST), 5);

  // The 503 names the stop (the city page shows "gestört") and when to come back.
  const refused = await r.route.handle(capRequest(6));
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.body), { fehler: CAPPED_TEXT, halt: "Halt 6" });
  assert.equal(refused.headers?.["Retry-After"], String(14 * 3600), "seconds until 00:00 UTC");
  // A stop asked for within the reuse window is answered from its flight: no charge.
  assert.equal((await r.route.handle(capRequest(0))).status, 200);
  assert.equal(r.efaRequests(), 5);

  // Once a day each, greppable: [warn] at 80 %, [error] when reached.
  assert.deepEqual(capLines(r, "warn"), [`${CAP_LOG_PREFIX} at 80%: used=4 cap=5 day=2026-10-05 (UTC)`]);
  assert.deepEqual(capLines(r, "error"), [
    `${CAP_LOG_PREFIX} reached: used=5 cap=5 day=2026-10-05 (UTC) — /abfahrten answers 503 until ` +
      `2026-10-06T00:00:00.000Z; raise ${DAILY_CAP_ENV} only with the provider's consent`,
  ]);
  assert.ok(r.lines().some((line) => line.level === "debug" && line.text.includes("daily cap used up, 503")));

  // The hourly run repeats it as a [warn] while the cap stays used up.
  await run(r.ctx);
  assert.equal(capLines(r, "warn").length, 2);
  assert.match(capLines(r, "warn")[1] ?? "", /reached: used=5 cap=5/);

  // The next UTC day starts over, and so do the log lines.
  r.at("2026-10-06T00:00:01.000Z");
  assert.equal((await r.route.handle(capRequest(7))).status, 200);
  assert.equal(r.ctx.quota.used(EFA_HOST), 1);
  for (let i = 1; i < 5; i += 1) await r.route.handle(capRequest(i));
  assert.equal(capLines(r, "error").length, 2, "reached again on the new day");
}

async function dailyCapCountsWhatWasStoredAndHasADefault(): Promise<void> {
  // The day's count is the quota's: after a restart the stored count applies.
  const r = await capRig({});
  r.ctx.quota.charge(EFA_HOST, DEFAULT_DAILY_CAP - 1);
  assert.equal((await r.route.handle(capRequest(0))).status, 200);
  assert.equal((await r.route.handle(capRequest(1))).status, 503);
  assert.equal(capLines(r, "error").length, 1);
  assert.deepEqual(capLines(r, "warn"), [], "the 80 % mark passed before the restart");

  // A cap that is not a positive number: the default, with one [warn].
  const bad = await capRig({ [DAILY_CAP_ENV]: "0" });
  assert.equal((await bad.route.handle(capRequest(0))).status, 200);
  await bad.route.handle(capRequest(1));
  assert.deepEqual(
    bad
      .lines()
      .filter((line) => line.level === "warn")
      .map((line) => line.text),
    [`${DAILY_CAP_ENV}=0 is not a positive whole number, using ${String(DEFAULT_DAILY_CAP)}`],
  );
}

async function dailyCapStretchesTheCache(): Promise<void> {
  // Cap 8, one EFA request per stop: 50 % at 4 calls, 75 % at 6, 90 % at 7.2.
  const r = await capRig({ [DAILY_CAP_ENV]: "8" });
  const ttl: (string | null)[] = [];
  for (let i = 0; i < 8; i += 1) {
    const answer = await r.route.handle(capRequest(i));
    assert.equal(answer.status, 200);
    ttl.push(answer.headers?.["X-Accel-Expires"] ?? null);
  }
  assert.deepEqual(ttl, [null, null, null, "300", "300", "600", "600", "1200"]);
  // Only departures: the 503 of the used-up cap and a 404 stay as they are.
  r.at("2026-10-05T10:05:00.000Z");
  const capped = await r.route.handle(capRequest(0));
  assert.equal(capped.status, 503);
  assert.equal(capped.headers?.["X-Accel-Expires"], undefined);
  const unknown = await r.route.handle({ ...capRequest(0), query: new URLSearchParams("ags=08999999") });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers?.["X-Accel-Expires"], undefined);

  assert.equal(stretchedCacheSeconds(9999, 20_000), null);
  assert.equal(stretchedCacheSeconds(10_000, 20_000), 300);
  assert.equal(stretchedCacheSeconds(15_000, 20_000), 600);
  assert.equal(stretchedCacheSeconds(18_000, 20_000), 1200);
  assert.equal(stretchedCacheSeconds(25_000, 20_000), 1200);
}

export {
  dailyCapStretchesTheCache as "abfahrten-on-demand: from half the daily cap on, departures may be cached longer (X-Accel-Expires)",
  dailyCapRefusesAndIsVisible as "abfahrten-on-demand: the daily cap answers 503 without an EFA request, warns at 80 %, errors once when reached",
  dailyCapCountsWhatWasStoredAndHasADefault as "abfahrten-on-demand: the daily cap counts the stored calls of the day; a bad value falls back to the default",
  directoryIsReloadedConditionally as "abfahrten-on-demand: the stop directory is reloaded hourly with a conditional GET (deviation)",
  misresolvedStopIs502 as "abfahrten-on-demand: departures of a place EFA guessed for the stop id are a 502 (deliberate deviation)",
  noMatchingDepartureIsEmpty as "abfahrten-on-demand: -4030 for the resolved stop is an empty list, like -4050",
  departureTimesAreLocal as "abfahrten-on-demand: departure times are Berlin wall-clock time, not the UTC cut (deliberate)",
  noDeparturesIsAnEmptyList as "abfahrten-on-demand: a valid EFA answer without departures is 200 with an empty list (deviation)",
  realErrorsStay502 as "abfahrten-on-demand: network, HTTP and malformed EFA answers stay 502",
  everyAnswerMatches as "abfahrten-on-demand: /abfahrten status, headers and body match the old http-in/response path in every scenario",
  validAnswerHasTheDashboardShape as "abfahrten-on-demand: the 200 answer keeps the shape stadt.html reads",
  failedDirectoryLoadKeepsThePreviousOne as "abfahrten-on-demand: a failed directory load warns and keeps the previous directory",
};
