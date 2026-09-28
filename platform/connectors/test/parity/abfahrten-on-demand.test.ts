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
 * Fixtures: test/fixtures/abfahrten-on-demand-08115003.json (real departure
 * monitor answer for Böblingen, limit 12, trimmed as its `note` says); the
 * directory entries are taken from the committed gui/public/oepnv-halte.json.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIRECTORY_URL, ROUTE_PATH, run, routes } from "../../src/connectors/abfahrten-on-demand.js";
import { EFA_MIN_INTERVAL_MS } from "../../src/connectors/efa.js";
import { isArray } from "../../src/kernel/parse.js";
import type { HttpResponse } from "../../src/kernel/types.js";
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
import { runFunctionNode } from "../harness/vm-runner.js";

const FIXTURE = "abfahrten-on-demand-08115003";

/** Real entries of the committed directory, plus one without a stop id (test input). */
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

/** Body with the clock blanked; the rest byte-exact as parsed JSON. */
function comparable(response: WireResponse): unknown {
  const body: unknown = JSON.parse(response.body);
  return isRecord(body) && "stand" in body ? { ...body, stand: "<timestamp>" } : body;
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

export {
  everyAnswerMatches as "abfahrten-on-demand: /abfahrten status, headers and body match the old http-in/response path in every scenario",
  validAnswerHasTheDashboardShape as "abfahrten-on-demand: the 200 answer keeps the shape stadt.html reads",
  failedDirectoryLoadKeepsThePreviousOne as "abfahrten-on-demand: a failed directory load warns and keeps the previous directory",
};
