/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The kernel additions of phase 3b: `ctx.state`, `sensorDetailFor` in the
 * registry, the per-host concurrency cap, unpaced Orion reads, and what the
 * HTTP server answers around a route the way Express did (HEAD, OPTIONS, 304,
 * request headers) — plus the Open-Meteo join window derived from the shared
 * bucket.
 *
 * Real servers on ephemeral ports of 127.0.0.1 and the real limiter and
 * fetcher wherever timing is the point; timings are scaled down, with margins
 * wide enough for Windows timer granularity.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  BATCH_COUNT,
  JOIN_TIMEOUT_MS,
  joinGroups,
  joinTimingFor,
  joinWindowMs,
  MAX_RETRY_WAIT_MS,
  REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "../../src/connectors/open-meteo-batches.js";
import type { BucketPace } from "../../src/connectors/open-meteo-batches.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { createCtx, createKernel } from "../../src/kernel/context.js";
import { createFetcher } from "../../src/kernel/fetcher.js";
import { createHttpServer, textResponse, weakEtag } from "../../src/kernel/http.js";
import type { HttpServer } from "../../src/kernel/http.js";
import { createOrion } from "../../src/kernel/orion.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { createRegistry, parseRegistry } from "../../src/kernel/registry.js";
import { createConnectorState, stateKey } from "../../src/kernel/state.js";
import type { EntityId, NgsiEntity, RouteRequest } from "../../src/kernel/types.js";
import { recordingLog } from "../harness/kernel.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The limiter's timers are unref'd — they must not hold the service open — so
 * a test waiting on nothing else would let the process end mid-test. This
 * keeps the loop alive for the duration of `work`.
 */
async function alive(work: () => Promise<void>): Promise<void> {
  const keep = setInterval(() => undefined, 1_000);
  try {
    await work();
  } finally {
    clearInterval(keep);
  }
}

/* ── ctx.state ───────────────────────────────────────────────────────────────*/

const COUNTER = stateKey("counter", () => 0);
const SEEN = stateKey("seen", () => new Set<string>());

function stateIsTypedSharedAndScoped(): void {
  const registry = createRegistry(
    parseRegistry({
      connectors: [
        { id: "one", name: "One", scope: "land", intervalSeconds: 60 },
        { id: "two", name: "Two", scope: "land", intervalSeconds: 60 },
      ],
    }),
  );
  const kernel = createKernel(registry);
  const [one, two] = registry.entries;
  assert.ok(one !== undefined && two !== undefined);

  // The ctx `run` gets and the ctx a route is built with: the same values.
  const runCtx = createCtx(kernel, one);
  const routeCtx = createCtx(kernel, one);
  const counter = runCtx.state.slot(COUNTER);
  const typed: number = counter.get();
  assert.equal(typed, 0, "initial value on first use");
  counter.set(counter.get() + 1);
  runCtx.state.slot(SEEN).get().add("08111000");
  assert.equal(routeCtx.state.slot(COUNTER).get(), 1);
  assert.ok(routeCtx.state.slot(SEEN).get().has("08111000"), "a container changed in place is shared");

  // Another connector sees none of it, and gets its own fresh container.
  const other = createCtx(kernel, two);
  assert.equal(other.state.slot(COUNTER).get(), 0);
  assert.equal(other.state.slot(SEEN).get().size, 0);
  assert.notEqual(other.state.slot(SEEN).get(), runCtx.state.slot(SEEN).get());
  assert.deepEqual([...runCtx.state.keys()].sort(), ["counter", "seen"]);

  // Two keys under one name in one connector are a programming error.
  const clash = stateKey("counter", () => "text");
  assert.throws(() => runCtx.state.slot(clash), /declared twice/);
  // A fresh state (a test ctx) starts from the initial values again.
  assert.equal(createConnectorState().slot(COUNTER).get(), 0);
}

/* ── registry: sensorDetailFor ───────────────────────────────────────────────*/

function sensorDetailForIsNarrowed(): void {
  const entries = parseRegistry({
    connectors: [
      { id: "a", name: "A", scope: "land" },
      { id: "b", name: "B", scope: "land", sensorDetailFor: "*" },
      { id: "c", name: "C", scope: "land", sensorDetailFor: ["08111000", "08221000"] },
      { id: "d", name: "D", scope: "land", sensorDetailFor: null },
    ],
  });
  assert.deepEqual(
    entries.map((entry) => entry.sensorDetailFor),
    [[], "*", ["08111000", "08221000"], []],
    'missing or null means none, as `.get("sensorDetailFor", [])` of the generator',
  );
  assert.throws(
    () => parseRegistry({ connectors: [{ id: "x", name: "X", scope: "land", sensorDetailFor: ["8111"] }] }),
    /sensorDetailFor\[0\]: expected an 8-digit AGS/,
  );
  assert.throws(
    () => parseRegistry({ connectors: [{ id: "x", name: "X", scope: "land", sensorDetailFor: "all" }] }),
    /sensorDetailFor/,
  );
}

/* ── rate limiter: concurrency cap ───────────────────────────────────────────*/

async function concurrencyCapHoldsAcrossCallers(): Promise<void> {
  await alive(concurrencyCapHoldsAcrossCallersBody);
}

async function concurrencyCapHoldsAcrossCallersBody(): Promise<void> {
  const limiter = createRateLimiter(recordingLog());
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const task = (name: string) => async (): Promise<string> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(`start ${name}`);
    await sleep(40);
    order.push(`end ${name}`);
    inFlight -= 1;
    return name;
  };
  // Three "connectors" on one host; the first asks for the cap, a later one
  // cannot loosen it.
  const results = await Promise.all([
    limiter.run("overpass.test", task("rathaus"), { minIntervalMs: 1, maxConcurrent: 1 }),
    limiter.run("overpass.test", task("ausflug"), { minIntervalMs: 1, maxConcurrent: 3 }),
    limiter.run("overpass.test", task("poi"), { minIntervalMs: 1 }),
  ]);
  assert.deepEqual(results, ["rathaus", "ausflug", "poi"]);
  assert.equal(peak, 1, "requests overlapped despite maxConcurrent: 1");
  assert.deepEqual(order, [
    "start rathaus",
    "end rathaus",
    "start ausflug",
    "end ausflug",
    "start poi",
    "end poi",
  ]);

  // Without a cap the same tasks overlap (the limiter only spaces starts).
  inFlight = 0;
  peak = 0;
  await Promise.all(
    ["a", "b", "c"].map((name) => limiter.run("free.test", task(name), { minIntervalMs: 1 })),
  );
  assert.ok(peak > 1, "without a cap the starts are only spaced");

  // A failing task releases its slot; a release is idempotent.
  await assert.rejects(
    limiter.run("fail.test", () => Promise.reject(new Error("boom")), { minIntervalMs: 1, maxConcurrent: 1 }),
  );
  const release = await limiter.acquire("fail.test", { minIntervalMs: 1, maxConcurrent: 1 });
  release();
  release();
  const again = await Promise.race([
    limiter.acquire("fail.test").then(() => "acquired"),
    sleep(500).then(() => "blocked"),
  ]);
  assert.equal(again, "acquired", "a double release must not leak or block a slot");
}

/* ── a local HTTP endpoint ───────────────────────────────────────────────────*/

interface Endpoint {
  readonly url: string;
  readonly host: string;
  readonly requests: { method: string; path: string }[];
  peakConcurrent(): number;
  close(): Promise<void>;
}

async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Endpoint> {
  const requests: { method: string; path: string }[] = [];
  let open = 0;
  let peak = 0;
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method ?? "?", path: request.url ?? "?" });
    open += 1;
    peak = Math.max(peak, open);
    response.on("finish", () => {
      open -= 1;
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    host: `127.0.0.1:${String(port)}`,
    requests,
    peakConcurrent: () => peak,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

async function fetcherHoldsTheCapForTheWholeRequest(): Promise<void> {
  const server = await endpoint((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    }, 60);
  });
  try {
    const log = recordingLog();
    const fetcher = createFetcher(log, createRateLimiter(log));
    const options = { minIntervalMs: 1, maxConcurrent: 1, retries: 0 };
    await Promise.all([1, 2, 3].map((n) => fetcher.text(`${server.url}/tile/${String(n)}`, options)));
    assert.equal(server.requests.length, 3);
    assert.equal(server.peakConcurrent(), 1, "a slow answer overlapped the next request");
  } finally {
    await server.close();
  }
}

async function fetcherDecodesLatin1OnRequest(): Promise<void> {
  // "Dürrheim, Bad" as ISO-8859-1: ü is the single byte 0xFC, invalid as UTF-8.
  const bytes = Buffer.from([0x44, 0xfc, 0x72, 0x72, 0x68, 0x65, 0x69, 0x6d, 0x2c, 0x20, 0x42, 0x61, 0x64]);
  const server = await endpoint((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(bytes);
  });
  try {
    const log = recordingLog();
    const fetcher = createFetcher(log, createRateLimiter(log));
    const options = { minIntervalMs: 1, retries: 0 };
    const latin1 = await fetcher.text(`${server.url}/a`, { ...options, encoding: "latin1" });
    assert.equal(latin1.body, "Dürrheim, Bad");
    const utf8 = await fetcher.text(`${server.url}/b`, options);
    assert.equal(utf8.body, "D�rrheim, Bad", "the default stays UTF-8");
  } finally {
    await server.close();
  }
}

/* ── Orion: reads do not queue behind writes ─────────────────────────────────*/

function entity(n: number): NgsiEntity {
  const id: EntityId = `urn:ngsi-ld:Test:e-${String(n)}`;
  return { id, type: "Test", "@context": "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld" };
}

async function orionReadsDoNotWaitBehindWrites(): Promise<void> {
  const server = await endpoint((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "NGSILD-Results-Count": "0" });
      response.end("[]");
      return;
    }
    response.writeHead(204);
    response.end();
  });
  try {
    const log = recordingLog();
    const limiter = createRateLimiter(log);
    const fetcher = createFetcher(log, limiter);
    const store = new SignatureStore().scope("test");
    const orion = createOrion(log, fetcher, createChangeGate(store, log), store, server.url);

    // A write backlog: the broker's bucket is at one request per minute and
    // its token is spent, so every upsert chunk has to wait — as ~320 parken-bw
    // chunks at 1/s would.
    const release = await limiter.acquire(server.host, { minIntervalMs: 60_000 });
    release();
    void orion.upsert({ entities: [entity(1), entity(2), entity(3)], pending: [] }, { chunkSize: 1 });
    await sleep(20);

    const started = Date.now();
    const found = await orion.find(
      { type: "Alert", q: 'ags=="08111"', options: "keyValues" },
      { retries: 0 },
    );
    const count = await orion.count({ type: "Alert" });
    const listed = await orion.list({ type: "Alert" }, { maxPages: 2 });
    const took = Date.now() - started;
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, []);
    assert.equal(count, 0);
    assert.ok(listed.ok);
    assert.ok(took < 5_000, `reads waited behind the write backlog (${String(took)} ms)`);

    // The writes are still paced: none of them has reached the broker yet.
    assert.deepEqual(
      server.requests.filter((request) => request.method === "POST"),
      [],
      "a write jumped the queue",
    );
    assert.equal(server.requests.filter((request) => request.method === "GET").length, 3);
  } finally {
    await server.close();
  }
}

/* ── HTTP server: HEAD, OPTIONS, 304, request headers ────────────────────────*/

const PAYLOAD = JSON.stringify({ fehler: "Für diese Gemeinde ist kein Halt hinterlegt", ags: "08999999" });

async function routeServer(): Promise<{
  server: HttpServer;
  url: (path: string) => string;
  seen: RouteRequest[];
}> {
  const server = createHttpServer(recordingLog());
  const seen: RouteRequest[] = [];
  server.register({
    method: "GET",
    path: "/abfahrten",
    handle: (request) => {
      seen.push(request);
      const status = request.query.get("ags") === "missing" ? 404 : 200;
      return Promise.resolve({
        status,
        contentType: "application/json; charset=utf-8",
        body: PAYLOAD,
        headers: { ETag: weakEtag(PAYLOAD) },
      });
    },
  });
  server.register({
    method: "POST",
    path: "/submit",
    handle: () => Promise.resolve(textResponse(202, "ok\n")),
  });
  await server.listen(0, "127.0.0.1");
  return { server, url: (path) => `http://127.0.0.1:${String(server.port() ?? 0)}${path}`, seen };
}

async function headAndOptionsAsExpress(): Promise<void> {
  const { server, url } = await routeServer();
  try {
    const get = await fetch(url("/abfahrten?ags=08111000"));
    const getBody = await get.text();
    const head = await fetch(url("/abfahrten?ags=08111000"), { method: "HEAD" });
    assert.equal(head.status, get.status);
    for (const name of ["content-type", "content-length", "etag"]) {
      assert.equal(head.headers.get(name), get.headers.get(name), `HEAD ${name}`);
    }
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(getBody)));
    assert.equal(await head.text(), "", "HEAD carries no body");

    // Express's router: 200, Allow, the list as text/html body, weak ETag.
    const options = await fetch(url("/abfahrten"), { method: "OPTIONS" });
    assert.equal(options.status, 200);
    assert.equal(options.headers.get("allow"), "GET,HEAD");
    assert.equal(options.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(options.headers.get("etag"), weakEtag("GET,HEAD"));
    assert.equal(await options.text(), "GET,HEAD");
    const post = await fetch(url("/submit"), { method: "OPTIONS" });
    assert.equal(post.headers.get("allow"), "POST");
    assert.equal((await fetch(url("/nowhere"), { method: "OPTIONS" })).status, 404);

    // HEAD does not reach a POST route, as in Express.
    assert.equal((await fetch(url("/submit"), { method: "HEAD" })).status, 404);
  } finally {
    await server.close();
  }
}

interface RawAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/**
 * A plain `node:http` request. Not `fetch`: per the Fetch standard it adds
 * `Cache-Control: no-cache` to every request carrying `If-None-Match`, which
 * (rightly) defeats the 304 — a calendar client or a proxy does not.
 */
async function raw(target: string, method: string, headers: Record<string, string>): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function conditionalGetAnswers304(): Promise<void> {
  const { server, url, seen } = await routeServer();
  const etag = weakEtag(PAYLOAD);
  const strong = etag.slice(2);
  const get = (headers: Record<string, string>, path = "/abfahrten?ags=08111000", method = "GET") =>
    raw(url(path), method, headers);
  try {
    const cases: readonly [Record<string, string>, number, string][] = [
      [{ "If-None-Match": etag }, 304, "exact weak ETag"],
      [{ "If-None-Match": strong }, 304, "strong form of a weak ETag (weak comparison)"],
      [{ "If-None-Match": `"other", ${etag}` }, 304, "one of a list"],
      [{ "If-None-Match": "*" }, 304, "any"],
      [{ "If-None-Match": '"other"' }, 200, "no match"],
      [{ "If-None-Match": etag, "Cache-Control": "no-cache" }, 200, "no-cache forces a full answer"],
      [{ "If-Modified-Since": new Date().toUTCString() }, 200, "no Last-Modified to compare"],
      [{}, 200, "unconditional"],
    ];
    for (const [headers, status, what] of cases) {
      const response = await get(headers);
      assert.equal(response.status, status, what);
      if (status === 304) {
        assert.equal(response.body, "", `${what}: 304 has no body`);
        assert.equal(response.headers.etag, etag, `${what}: 304 keeps the ETag`);
        assert.equal(response.headers["content-type"], undefined, `${what}: 304 drops Content-Type`);
      } else {
        assert.equal(response.body, PAYLOAD, what);
      }
    }
    // What a browser's fetch sends (it adds no-cache itself): a full answer, as from Express.
    assert.equal((await fetch(url("/abfahrten"), { headers: { "If-None-Match": etag } })).status, 200);
    // HEAD is conditional too; a non-2xx answer never is.
    assert.equal((await get({ "If-None-Match": etag }, "/abfahrten?ags=08111000", "HEAD")).status, 304);
    assert.equal((await get({ "If-None-Match": etag }, "/abfahrten?ags=missing")).status, 404);

    // The route saw the request headers, names lowercased, read-only.
    const last = seen.at(-1);
    assert.ok(last !== undefined);
    assert.equal(last.headers["if-none-match"], etag);
    assert.equal(last.headers["If-None-Match"], undefined);
  } finally {
    await server.close();
  }
}

/* ── Open-Meteo: join window vs. the shared bucket ───────────────────────────*/

function joinWindowCoversTheSharedBucket(): void {
  // (7 own + 8 of the other connector) × 20 s + 120 s timeout, one retry after
  // a 429 (300 s pause + 20 s + 120 s) + 30 s margin.
  const retry = MAX_RETRY_WAIT_MS + REQUEST_INTERVAL_MS + REQUEST_TIMEOUT_MS;
  assert.equal(
    joinWindowMs(BATCH_COUNT),
    (7 + 8) * REQUEST_INTERVAL_MS + REQUEST_TIMEOUT_MS + retry + 30_000,
  );
  assert.equal(joinTimingFor(BATCH_COUNT).timeoutMs, 890_000);
  assert.equal(joinTimingFor(BATCH_COUNT).count, BATCH_COUNT, "count 8 as the join node");
  assert.ok(joinTimingFor(1).timeoutMs >= JOIN_TIMEOUT_MS, "never below the old 240 s");
  // The old window was sized for the flow's bucket of one's own: 7 × 15 s + 120 s fits 240 s …
  const flowInterval = 15_000;
  assert.ok(7 * flowInterval + REQUEST_TIMEOUT_MS < JOIN_TIMEOUT_MS);
  // … interleaved with the other connector it would not.
  assert.ok((7 + 8) * flowInterval + REQUEST_TIMEOUT_MS > JOIN_TIMEOUT_MS);
}

/**
 * The worst case, scaled down and run through the real limiter: our first
 * call gets the token, the other connector's eight calls land in the queue
 * before our remaining seven, and our last call takes the full timeout. The
 * derived window keeps the group whole; the old formula would have cut it.
 */
async function interleavedRunsStayOneGroup(): Promise<void> {
  await alive(interleavedRunsStayOneGroupBody);
}

async function interleavedRunsStayOneGroupBody(): Promise<void> {
  const pace: BucketPace = {
    intervalMs: 40,
    requestTimeoutMs: 120,
    sharers: 2,
    retryWaitMs: 0,
    marginMs: 300,
  };
  const window = joinWindowMs(BATCH_COUNT, pace);
  const oldWindow = 7 * pace.intervalMs + pace.requestTimeoutMs + 60;

  const simulate = async (timeoutMs: number): Promise<readonly string[]> => {
    const limiter = createRateLimiter(recordingLog());
    const call = (duration: number) =>
      limiter.run("open-meteo.test", () => sleep(duration), { minIntervalMs: 40 });
    const ours: Promise<number>[] = [];
    ours.push(call(5).then(() => 0));
    const theirs = Array.from({ length: BATCH_COUNT }, () => call(5));
    for (let i = 1; i < BATCH_COUNT; i += 1) {
      const duration = i === BATCH_COUNT - 1 ? pace.requestTimeoutMs : 5;
      ours.push(call(duration).then(() => i));
    }
    const closes: string[] = [];
    await joinGroups(ours, { count: BATCH_COUNT, timeoutMs }, new AbortController().signal, (group) => {
      closes.push(`${group.closedBy}:${String(group.parts.length)}`);
      return Promise.resolve();
    });
    await Promise.all(theirs);
    return closes;
  };

  assert.deepEqual(await simulate(window), ["complete:8"], "the derived window must keep the group whole");
  const cut = await simulate(oldWindow);
  assert.equal(
    cut[0]?.startsWith("timeout:"),
    true,
    `the old window should have cut the group: ${cut.join(", ")}`,
  );
}

export {
  stateIsTypedSharedAndScoped as "kernel: ctx.state is typed, shared by run and routes of a connector, scoped per connector",
  sensorDetailForIsNarrowed as 'kernel: registry sensorDetailFor — missing = none, "*", AGS list, rejects anything else',
  concurrencyCapHoldsAcrossCallers as "kernel: maxConcurrent holds across callers of one host, the strictest cap wins, release is safe",
  fetcherHoldsTheCapForTheWholeRequest as "kernel: the fetcher holds a concurrency slot until the answer is read",
  fetcherDecodesLatin1OnRequest as "kernel: the fetcher decodes ISO-8859-1 when asked (DWD station lists), UTF-8 otherwise",
  orionReadsDoNotWaitBehindWrites as "kernel: Orion reads are not paced — a pending write backlog does not delay find/count/list",
  headAndOptionsAsExpress as "kernel: HEAD and OPTIONS on a GET route answer as Express did",
  conditionalGetAnswers304 as "kernel: If-None-Match against a route's ETag answers 304 as Express's res.send; routes see request headers",
  joinWindowCoversTheSharedBucket as "open-meteo: the join window is derived from batch count × shared 20 s bucket + timeout + one 429 retry (890 s)",
  interleavedRunsStayOneGroup as "open-meteo: interleaved runs in the shared bucket stay one group with the derived window",
};
