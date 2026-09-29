/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The findings of the security review, each pinned by a test: the body cap of
 * the fetcher (a gzip bomb served by a local server), redirects refused by
 * default and followed under a URL policy, the caller's abort, the load
 * shedding of `/abfahrten`, the loopback-only trigger and its body handling,
 * the cooldown floor, the GBFS URL policy, `__proto__` keys, URL encoding, C1
 * control characters in log lines, the nginx template and the Orion write
 * timeout.
 *
 * Real sockets on ephemeral ports of 127.0.0.1 wherever the kernel's own
 * networking is the subject; scripted fetchers where a connector is.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  BUSY_TEXT,
  DIRECTORY_URL,
  ON_DEMAND_CONCURRENCY,
  ON_DEMAND_QUEUE,
  routes as abfahrtenRoutes,
  run as loadDirectory,
} from "../../src/connectors/abfahrten-on-demand.js";
import { departuresUrl } from "../../src/connectors/efa-abfahrten.js";
import { allowedFeedUrl, feedAllowed } from "../../src/connectors/gbfs.js";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { locationUrl, parse as parseHystreet } from "../../src/connectors/hystreet.js";
import { run as runSharing } from "../../src/connectors/sharing-bw.js";
import { weatherUrl } from "../../src/connectors/wetter-dwd-station.js";
import { adminRoutes, isLoopback, triggerCooldownMs } from "../../src/kernel/admin.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import {
  createFetcher,
  DEFAULT_MAX_BYTES,
  FetchAbortedError,
  FetchRedirectError,
  FetchTooLargeError,
  FetchUrlRefusedError,
} from "../../src/kernel/fetcher.js";
import { MAX_BODY_BYTES, textResponse } from "../../src/kernel/http.js";
import { sanitizeLogText } from "../../src/kernel/log.js";
import { createOrion, WRITE_TIMEOUT_MS } from "../../src/kernel/orion.js";
import { isRecord } from "../../src/kernel/parse.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import type {
  Env,
  Fetcher,
  FetchOptions,
  HttpResponse,
  JsonResponse,
  RouteDefinition,
  RouteRequest,
} from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "../harness/fixtures.js";
import { jsonHttp, recordingFetcher, registryEntry, rig } from "../harness/g-transport.js";
import type { GRequest } from "../harness/g-transport.js";
import { httpResponse, recordingLog } from "../harness/kernel.js";
import { jsonAnswer, mobilityCtx } from "../harness/mobility.js";

/* ── a local endpoint ────────────────────────────────────────────────────────*/

interface Endpoint {
  readonly url: string;
  readonly paths: string[];
  readonly headers: IncomingMessage["headers"][];
  close(): Promise<void>;
}

async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Endpoint> {
  const paths: string[] = [];
  const headers: IncomingMessage["headers"][] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "?");
    headers.push(request.headers);
    handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    paths,
    headers,
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

function fetcher(): Fetcher {
  const log = recordingLog();
  return createFetcher(log, createRateLimiter(log));
}

/** Unpaced, no retry unless a test asks for one. */
const QUICK: FetchOptions = { bucket: null, retries: 0 };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
}

/* ── 1. body cap ─────────────────────────────────────────────────────────────*/

async function gzipBombIsCappedOnDecompressedBytes(): Promise<void> {
  // 48 MiB of zeros compress to ~48 KB: small on the wire, fatal in memory.
  const bomb = gzipSync(Buffer.alloc(48 * 1024 * 1024));
  assert.ok(bomb.length < 200_000, "the bomb is small on the wire");
  const server = await endpoint((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(bomb.length),
    });
    response.end(bomb);
  });
  try {
    const error = await rejection(fetcher().text(`${server.url}/bomb`, { bucket: null, retries: 2 }));
    assert.ok(error instanceof FetchTooLargeError, String(error));
    assert.equal(error.maxBytes, DEFAULT_MAX_BYTES);
    assert.equal(server.paths.length, 1, "a too-large body is not retried");

    // A per-call cap below the default: 1 MiB against the same bomb.
    const small = await rejection(fetcher().json(`${server.url}/bomb`, { ...QUICK, maxBytes: 1024 * 1024 }));
    assert.ok(small instanceof FetchTooLargeError);
    assert.equal(small.maxBytes, 1024 * 1024);
  } finally {
    await server.close();
  }
}

async function announcedLengthIsRefusedAndSmallBodiesPass(): Promise<void> {
  const body = `${String.fromCharCode(0xfeff)}{"ok":true,"text":"${"x".repeat(5000)}"}`;
  const server = await endpoint((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  try {
    const refused = await rejection(fetcher().text(`${server.url}/big`, { ...QUICK, maxBytes: 1000 }));
    assert.ok(refused instanceof FetchTooLargeError, "Content-Length above the cap is refused");
    // Within the cap: the body arrives whole, the BOM dropped as response.text() did.
    const ok = await fetcher().json(`${server.url}/big`, QUICK);
    assert.ok(ok.ok && isRecord(ok.body) && ok.body.ok === true);
  } finally {
    await server.close();
  }
}

/* ── 4. redirects ────────────────────────────────────────────────────────────*/

async function redirectsAreRefusedByDefaultAndFollowedOnRequest(): Promise<void> {
  const target = await endpoint((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("landed");
  });
  const origin = await endpoint((request, response) => {
    if (request.url === "/same") {
      response.writeHead(302, { Location: "/final" });
      response.end();
    } else if (request.url === "/cross") {
      response.writeHead(301, { Location: `${target.url}/elsewhere` });
      response.end();
    } else if (request.url === "/scheme") {
      response.writeHead(302, { Location: "file:///etc/passwd" });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("same origin");
    }
  });
  try {
    const refused = await rejection(fetcher().text(`${origin.url}/same`, { bucket: null, retries: 2 }));
    assert.ok(refused instanceof FetchRedirectError, "the default refuses a redirect");
    assert.equal(refused.location, `${origin.url}/final`);
    assert.deepEqual(origin.paths, ["/same"], "not followed, not retried");

    const same = await fetcher().text(`${origin.url}/same`, { ...QUICK, redirect: "follow" });
    assert.equal(same.body, "same origin");

    // Cross-origin: followed, but credentials and custom headers stay behind.
    const cross = await fetcher().text(`${origin.url}/cross`, {
      ...QUICK,
      redirect: "follow",
      headers: { Accept: "application/json", "X-API-Token": "secret", Authorization: "Bearer x" },
    });
    assert.equal(cross.body, "landed");
    const seen = target.headers[0] ?? {};
    assert.equal(seen["x-api-token"], undefined);
    assert.equal(seen.authorization, undefined);
    assert.equal(seen.accept, "application/json");

    // Every hop under the URL policy: the target is refused before it is contacted.
    const before = target.paths.length;
    const policy = await rejection(
      fetcher().text(`${origin.url}/cross`, {
        ...QUICK,
        redirect: "follow",
        allowUrl: (url) => url.port !== new URL(target.url).port,
      }),
    );
    assert.ok(policy instanceof FetchUrlRefusedError);
    assert.equal(policy.target, `${target.url}/elsewhere`);
    assert.equal(target.paths.length, before, "the refused target saw no request");

    const scheme = await rejection(fetcher().text(`${origin.url}/scheme`, { ...QUICK, redirect: "follow" }));
    assert.ok(scheme instanceof FetchRedirectError, "only http(s) targets");
  } finally {
    await Promise.all([origin.close(), target.close()]);
  }
}

async function callerAbortEndsTheRequest(): Promise<void> {
  const server = await endpoint((_request, response) => {
    setTimeout(() => {
      response.writeHead(200);
      response.end("late");
    }, 5_000).unref();
  });
  try {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    const started = Date.now();
    const error = await rejection(
      fetcher().text(`${server.url}/slow`, { bucket: null, retries: 2, signal: controller.signal }),
    );
    assert.ok(error instanceof FetchAbortedError, String(error));
    assert.ok(Date.now() - started < 2_000, "aborted at once, not after the answer");
    assert.equal(server.paths.length, 1, "an abort is not retried");
  } finally {
    await server.close();
  }
}

/* ── 2. /abfahrten load shedding ─────────────────────────────────────────────*/

/** Twelve municipalities, each with a stop of its own. */
const STOPS = 12;

/** `08110000`, `08110001`, … — eight digits, as the route demands. */
function agsOf(i: number): string {
  return `081${String(10000 + i)}`;
}

function stopDirectory(): Record<string, unknown> {
  const halte: Record<string, unknown> = {};
  for (let i = 0; i < STOPS; i += 1) {
    halte[agsOf(i)] = { stopId: `de:08111:${String(9000 + i)}`, stopName: `Halt ${String(i)}` };
  }
  return halte;
}

function request(ags: string, signal?: AbortSignal): RouteRequest {
  return {
    method: "GET",
    path: "/abfahrten",
    query: new URLSearchParams(`ags=${ags}`),
    params: {},
    headers: {},
    body: "",
    ...(signal === undefined ? {} : { signal }),
  };
}

const EFA_OK = jsonHttp(200, { stopEvents: [] });

async function onDemandRig(
  respond: (request: GRequest) => HttpResponse | Error,
  delayMs: number,
): Promise<{ route: RouteDefinition; seen: GRequest[]; log: ReturnType<typeof recordingLog> }> {
  const network = recordingFetcher((request) => {
    if (request.url === DIRECTORY_URL) return jsonHttp(200, { halte: stopDirectory() });
    return respond(request);
  }, delayMs);
  const g = rig(registryEntry("abfahrten-on-demand"), network.fetcher);
  await loadDirectory(g.ctx);
  const [route] = abfahrtenRoutes(g.ctx);
  assert.ok(route !== undefined);
  return { route, seen: network.seen, log: g.log };
}

function efaRequests(seen: readonly GRequest[]): GRequest[] {
  return seen.filter((request) => request.url !== DIRECTORY_URL);
}

async function sameStopIsFetchedOnceAndReused(): Promise<void> {
  const r = await onDemandRig(() => EFA_OK, 30);
  const answers = await Promise.all(Array.from({ length: 6 }, () => r.route.handle(request(agsOf(0)))));
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200, 200, 200, 200],
  );
  assert.equal(efaRequests(r.seen).length, 1, "concurrent requests for one stop share one upstream call");
  // Within the reuse window: served from the shared answer, same body.
  const again = await r.route.handle(request(agsOf(0)));
  assert.equal(efaRequests(r.seen).length, 1);
  assert.equal(again.body, answers[0]?.body);
  await r.route.handle(request(agsOf(1)));
  assert.equal(efaRequests(r.seen).length, 2, "another stop is its own request");
}

async function fullQueueIsA503WithoutWarning(): Promise<void> {
  const r = await onDemandRig(() => EFA_OK, 80);
  const answers = await Promise.all(
    Array.from({ length: STOPS }, (_, i) => r.route.handle(request(agsOf(i)))),
  );
  const busy = answers.filter((answer) => answer.status === 503);
  assert.equal(busy.length, STOPS - ON_DEMAND_CONCURRENCY - ON_DEMAND_QUEUE);
  for (const answer of busy) {
    assert.deepEqual(JSON.parse(answer.body), { fehler: BUSY_TEXT });
    assert.equal(answer.headers?.["Retry-After"], "30");
  }
  assert.equal(efaRequests(r.seen).length, ON_DEMAND_CONCURRENCY + ON_DEMAND_QUEUE);
  const counted = r.log.lines.filter((line) => line.level === "warn" || line.level === "error");
  assert.deepEqual(counted, [], "public load is no [warn]/[error]");
  assert.ok(r.log.lines.some((line) => line.level === "debug" && line.text.includes("queue full")));
  // Every EFA request is paced by the shared bucket and carries the abort signal.
  for (const seen of efaRequests(r.seen)) assert.ok(seen.options?.signal instanceof AbortSignal);
}

async function lastClientGoneAbortsTheUpstreamRequest(): Promise<void> {
  const signals: AbortSignal[] = [];
  const network: Fetcher = {
    text: (url: string, options?: FetchOptions): Promise<HttpResponse> => {
      if (url === DIRECTORY_URL) return Promise.resolve(jsonHttp(200, { halte: stopDirectory() }));
      const signal = options?.signal;
      if (signal === undefined) return Promise.reject(new Error("no signal handed to the fetcher"));
      signals.push(signal);
      return new Promise<HttpResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(EFA_OK);
        }, 300);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new FetchAbortedError(url));
        });
      });
    },
    json: (): Promise<JsonResponse> => Promise.reject(new Error("not used")),
  };
  const g = rig(registryEntry("abfahrten-on-demand"), network);
  await loadDirectory(g.ctx);
  const [route] = abfahrtenRoutes(g.ctx);
  assert.ok(route !== undefined);

  // Two clients on one stop; the first leaves: the request goes on.
  const first = new AbortController();
  const second = new AbortController();
  const a = route.handle(request(agsOf(0), first.signal));
  const b = route.handle(request(agsOf(0), second.signal));
  await new Promise((resolve) => setTimeout(resolve, 20));
  first.abort();
  await a;
  assert.equal(signals[0]?.aborted, false, "one client is still waiting");
  assert.equal((await b).status, 200);

  // A single client that leaves: the upstream request is aborted, nothing cached.
  const lone = new AbortController();
  const c = route.handle(request(agsOf(1), lone.signal));
  await new Promise((resolve) => setTimeout(resolve, 20));
  lone.abort();
  await c;
  assert.equal(signals[1]?.aborted, true, "the upstream request was aborted");
  assert.deepEqual(
    g.log.lines.filter((line) => line.level === "warn" || line.level === "error"),
    [],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await route.handle(request(agsOf(1)))).status, 200, "an aborted flight is not reused");
  assert.equal(signals.length, 3);
}

async function upstreamFailuresWarnOncePerMinute(): Promise<void> {
  const r = await onDemandRig(() => new Error("connect ECONNREFUSED 1.2.3.4:443"), 0);
  for (let i = 0; i < 5; i += 1) assert.equal((await r.route.handle(request(agsOf(i)))).status, 502);
  assert.equal(r.log.warnings().length, 1, "five failing stops, one [warn]");
  assert.equal(
    r.log.lines.filter((line) => line.level === "debug" && line.text.includes("request failed")).length,
    4,
  );
}

/* ── 3. admin port ───────────────────────────────────────────────────────────*/

function envWith(value: string | undefined): Env {
  return {
    get: () => value,
    require: () => value ?? "",
    number: (_name, fallback) => {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    flag: (_name, fallback) => fallback,
  };
}

function cooldownHasAFloor(): void {
  for (const [raw, ms] of [
    [undefined, 60_000],
    ["0", 60_000],
    ["-5", 60_000],
    ["abc", 60_000],
    ["NaN", 60_000],
    ["10", 60_000],
    ["300", 300_000],
  ] as const) {
    assert.equal(triggerCooldownMs(envWith(raw)), ms, String(raw));
  }
}

function loopbackMeansTheThreeSpellings(): void {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal(isLoopback(address), true, address);
  for (const address of [undefined, "", "10.0.0.7", "::ffff:10.0.0.7", "127.0.0.2", "0.0.0.0", "localhost"]) {
    assert.equal(isLoopback(address), false, String(address));
  }
}

async function triggerOnlyFromLoopbackAndBodiesNeverError(): Promise<void> {
  const g = rig(registryEntry("abfahrten-on-demand"), recordingFetcher(() => EFA_OK).fetcher);
  const kernel = g.kernel;
  let runs = 0;
  kernel.scheduler.add(
    "demo",
    { kind: "manual", intervalSeconds: null, cron: null, fireOnStart: false, startupDelaySeconds: 0 },
    () => {
      runs += 1;
      return Promise.resolve();
    },
  );
  for (const route of adminRoutes(kernel, { version: "test", started: Date.now(), cooldownMs: 60_000 })) {
    kernel.adminHttp.register(route);
  }
  let received = "";
  kernel.adminHttp.register({
    method: "POST",
    path: "/echo",
    readsBody: true,
    handle: (routeRequest) => {
      received = routeRequest.body;
      return Promise.resolve(textResponse(200, "ok"));
    },
  });
  await kernel.adminHttp.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${String(kernel.adminHttp.port() ?? 0)}`;
  try {
    // A peer that is not loopback: 403, no run — handed straight to the route.
    const trigger = adminRoutes(kernel, { version: "test", started: Date.now(), cooldownMs: 60_000 }).find(
      (route) => route.path === "/trigger/:id",
    );
    assert.ok(trigger !== undefined);
    for (const remoteAddress of ["10.0.0.7", "::ffff:192.168.1.5", undefined]) {
      const answer = await trigger.handle({
        method: "POST",
        path: "/trigger/demo",
        query: new URLSearchParams(),
        params: { id: "demo" },
        headers: {},
        body: "",
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      });
      assert.equal(answer.status, 403, String(remoteAddress));
    }
    assert.equal(runs, 0);

    // From loopback, with a 2 MB body the route never reads: 202, no [error].
    const big = "x".repeat(2 * 1024 * 1024);
    const accepted = await fetch(`${base}/trigger/demo`, { method: "POST", body: big });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 1);

    // A route that reads bodies: 413 above the limit, no [error]; a small one arrives.
    const tooLarge = await fetch(`${base}/echo`, { method: "POST", body: "y".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(tooLarge.status, 413);
    const small = await fetch(`${base}/echo`, { method: "POST", body: "hello" });
    assert.equal(small.status, 200);
    assert.equal(received, "hello");
    assert.deepEqual(
      g.log.lines.filter((line) => line.level === "error" || line.level === "warn"),
      [],
      "no counted line for a client's request",
    );
  } finally {
    await kernel.adminHttp.close();
  }
}

/* ── 5. GBFS URL policy ──────────────────────────────────────────────────────*/

function gbfsUrlPolicy(): void {
  const allowed = [
    "https://api.mobidata-bw.de/sharing/gbfs/v2/x/gbfs",
    "https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_ds/gbfs.json",
    "https://93.184.216.34/gbfs",
    "https://[2a00:1450:4001:80b::200e]/gbfs",
    "https://example.org./gbfs",
  ];
  const refused = [
    "http://api.mobidata-bw.de/gbfs",
    "ftp://example.org/gbfs",
    "https://localhost/gbfs",
    "https://orion-ld:1026/ngsi-ld/v1/entities",
    "https://udp-connectors/trigger/x",
    "https://apisix.udp.svc/gbfs",
    "https://apisix.udp.svc.cluster.local/gbfs",
    "https://metadata.google.internal/gbfs",
    "https://foo.localhost/gbfs",
    "https://127.0.0.1/gbfs",
    "https://2130706433/gbfs",
    "https://0x7f.1/gbfs",
    "https://10.1.2.3/gbfs",
    "https://172.20.0.1/gbfs",
    "https://192.168.0.10/gbfs",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/gbfs",
    "https://0.0.0.0/gbfs",
    "https://[::1]/gbfs",
    "https://[fd00::1]/gbfs",
    "https://[fe80::1]/gbfs",
    "https://[::ffff:127.0.0.1]/gbfs",
    "https://user:pw@example.org/gbfs",
  ];
  for (const url of allowed) assert.equal(allowedFeedUrl(new URL(url)), true, url);
  for (const url of refused) assert.equal(feedAllowed(url), false, url);
  assert.equal(feedAllowed("not a url"), false);
}

async function sharingSkipsRefusedFeedsWithOneWarning(): Promise<void> {
  const world = mobilityCtx({ id: "sharing-bw", start: Date.now() });
  const list = readFixture("gbfs-systems");
  world.broker.sources.set(
    list.source,
    jsonAnswer({
      systems: [
        { id: "meta", url: "https://169.254.169.254/latest/gbfs" },
        { id: "orion", url: "https://orion-ld:1026/gbfs" },
        { id: "plain", url: "http://api.mobidata-bw.de/sharing/gbfs/v2/plain/gbfs" },
        { id: "fine", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/fine/gbfs" },
      ],
    }),
  );
  await runSharing(world.ctx);
  assert.equal(
    world.broker.requests.filter((request) => request.url.pathname.endsWith("/free_bike_status")).length,
    1,
    "only the allowed feed is requested",
  );
  for (const host of ["169.254.169.254", "orion-ld:1026"]) {
    assert.equal(
      world.broker.requests.some(
        (request) => request.url.host === host && request.url.pathname.includes("gbfs"),
      ),
      false,
      `${host} was contacted`,
    );
  }
  assert.deepEqual(world.log.warnings(), [
    "GBFS-BW: 3 feed URLs refused by the URL policy and skipped (first: https://169.254.169.254/latest/free_bike_status)",
  ]);
}

/* ── 6. __proto__ keys ───────────────────────────────────────────────────────*/

function protoKeysStayKeys(): void {
  const entry = {
    b: [7.5, 47.5, 7.6, 47.6],
    r: [
      [
        [7.5, 47.5],
        [7.6, 47.5],
        [7.6, 47.6],
        [7.5, 47.5],
      ],
    ],
  };
  const raw: unknown = JSON.parse(
    `{"__proto__": ${JSON.stringify(entry)}, "08111000": ${JSON.stringify(entry)}}`,
  );
  const { boundaries } = parseBoundaries(raw);
  assert.deepEqual(Object.keys(boundaries).sort(), ["08111000", "__proto__"]);
  assert.equal(Object.getPrototypeOf(boundaries), null, "the prototype was not replaced");
  assert.equal(Object.hasOwn(boundaries, "constructor"), false);
  assert.equal(Object.keys(boundaries).includes("b"), false, "no key inherited from the entry");

  const detail: unknown = JSON.parse('{"statistics": {"today_count": {"__proto__": {"x": 1}, "a": 2}}}');
  const parsed = parseHystreet(detail);
  const today = parsed.todayCount;
  assert.ok(isRecord(today));
  assert.deepEqual(Object.keys(today).sort(), ["__proto__", "a"]);
  assert.equal(Object.getPrototypeOf(today), null);
  assert.equal(JSON.stringify(today), '{"__proto__":{"x":1},"a":2}');
}

/* ── 7. URL encoding ─────────────────────────────────────────────────────────*/

function urlValuesAreEncodedWithoutChangingRealOnes(): void {
  const stop = { ags: "08111000", name: "x", entityId: "urn:ngsi-ld:T:x", coords: null } as const;
  assert.ok(departuresUrl({ ...stop, stopId: "de:08111:6115" }).includes("&name_dm=de:08111:6115&"));
  assert.ok(
    departuresUrl({ ...stop, stopId: "de:1&limit=999 x" }).includes("&name_dm=de:1%26limit%3D999%20x&"),
  );
  assert.equal(weatherUrl("04931"), "https://api.brightsky.dev/current_weather?dwd_station_id=04931");
  assert.ok(weatherUrl("1&x=2").endsWith("dwd_station_id=1%26x%3D2"));
  assert.equal(locationUrl("241"), "https://hystreet.com/api/locations/241");
  assert.equal(locationUrl("../admin"), "https://hystreet.com/api/locations/..%2Fadmin");
}

/* ── 8. log lines ────────────────────────────────────────────────────────────*/

function c1ControlsAreEscaped(): void {
  assert.equal(sanitizeLogText("a\u0085b"), "a\\u0085b", "NEL");
  assert.equal(sanitizeLogText("x\u009b31my"), "x\\u009b31my", "CSI");
  assert.equal(sanitizeLogText("\u0080\u009f"), "\\u0080\\u009f");
  assert.equal(sanitizeLogText("Straße  ok"), "Straße  ok", "U+00A0 and above stay");
}

/* ── 2 + 9. nginx template ───────────────────────────────────────────────────*/

function locationBlock(conf: string, path: string): string {
  const match = new RegExp(`location = ${path.replace(".", "\\.")} \\{([\\s\\S]*?)\\n    \\}`).exec(conf);
  assert.ok(match?.[1] !== undefined, `location = ${path} not found`);
  return match[1];
}

function nginxKeysLimitsAndHeaders(): void {
  const conf = readFileSync(
    join(repositoryRoot(), "platform", "config", "nginx", "cockpit.conf.template"),
    "utf8",
  );
  assert.match(conf, /limit_req_zone \$binary_remote_addr zone=udp_abfahrten:\d+m rate=\d+r\/m;/);
  assert.match(conf, /limit_req_zone \$binary_remote_addr zone=udp_warnungen:\d+m rate=\d+r\/m;/);
  // One upstream per endpoint: Node-RED by default, the connector service
  // after the cutover (gui/docker/17-udp-upstreams.envsh).
  for (const [path, param, zone, upstream] of [
    ["/abfahrten", "ags", "udp_abfahrten", "abfahrten"],
    ["/warnungen.ics", "kreis", "udp_warnungen", "warnungen"],
  ] as const) {
    const block = locationBlock(conf, path);
    assert.ok(block.includes(`proxy_cache_key "$uri?${param}=$arg_${param}";`), `${path}: cache key`);
    assert.ok(
      block.includes(`set $${upstream} http://\${UDP_${upstream.toUpperCase()}_UPSTREAM};`),
      `${path}: upstream variable`,
    );
    assert.ok(
      block.includes(`proxy_pass $${upstream}${path}?${param}=$arg_${param};`),
      `${path}: upstream query`,
    );
    assert.match(block, new RegExp(`limit_req zone=${zone} burst=\\d+ nodelay;`));
    for (const header of [
      "add_header X-Content-Type-Options nosniff always;",
      "add_header X-Frame-Options SAMEORIGIN always;",
      "add_header Referrer-Policy strict-origin-when-cross-origin always;",
    ]) {
      assert.ok(block.includes(header), `${path}: ${header}`);
    }
  }
}

/* ── 10. Orion write timeout ─────────────────────────────────────────────────*/

async function orionWritesWait120Seconds(): Promise<void> {
  const log = recordingLog();
  const network = recordingFetcher((request) =>
    request.method === "GET" ? httpResponse(200, "[]") : httpResponse(204),
  );
  const store = new SignatureStore().scope("test");
  const orion = createOrion(
    log,
    network.fetcher,
    createChangeGate(store, log),
    store,
    "http://orion.test:1026",
  );
  await orion.upsert({
    entities: [{ id: "urn:ngsi-ld:T:1", type: "T", "@context": "https://example.org/ctx" }],
    pending: [],
  });
  await orion.delete(["urn:ngsi-ld:T:1"]);
  await orion.find({ type: "T" });
  assert.equal(WRITE_TIMEOUT_MS, 120_000);
  assert.deepEqual(
    network.seen.map((request) => [request.method, request.options?.timeoutMs, request.options?.redirect]),
    [
      ["POST", 120_000, "error"],
      ["POST", 120_000, "error"],
      ["GET", undefined, undefined],
    ],
  );
}

export {
  gzipBombIsCappedOnDecompressedBytes as "security: a gzip bomb is cut off at the decompressed cap, typed error, no retry",
  announcedLengthIsRefusedAndSmallBodiesPass as "security: an announced Content-Length above the cap is refused; bodies within pass whole",
  redirectsAreRefusedByDefaultAndFollowedOnRequest as "security: redirects refused by default; followed per call, credentials dropped cross-origin, every hop under the URL policy",
  callerAbortEndsTheRequest as "security: the caller's signal aborts a request at once, without retry",
  sameStopIsFetchedOnceAndReused as "security: /abfahrten coalesces one stop into one EFA request and reuses it",
  fullQueueIsA503WithoutWarning as "security: /abfahrten sheds load beyond its own queue with 503, logged at debug only",
  lastClientGoneAbortsTheUpstreamRequest as "security: /abfahrten aborts the EFA request when its last client disconnects",
  upstreamFailuresWarnOncePerMinute as "security: /abfahrten logs EFA failures as at most one [warn] a minute",
  cooldownHasAFloor as "security: UDP_TRIGGER_COOLDOWN_SECONDS cannot go below 60 s; 0, negative and NaN are the default",
  loopbackMeansTheThreeSpellings as "security: loopback is 127.0.0.1, ::1 and ::ffff:127.0.0.1, nothing else",
  triggerOnlyFromLoopbackAndBodiesNeverError as "security: /trigger answers loopback only (403 otherwise); unread and oversized bodies are no [error]",
  gbfsUrlPolicy as "security: GBFS feed URLs — https only, no private IP literals, no internal host names",
  sharingSkipsRefusedFeedsWithOneWarning as "security: sharing-bw skips refused feeds and reports them in one [warn]",
  protoKeysStayKeys as "security: a __proto__ key from foreign JSON stays a key (grenzen-bw, hystreet)",
  urlValuesAreEncodedWithoutChangingRealOnes as "security: stop, station and location ids are URL-encoded, real ids byte-identical",
  c1ControlsAreEscaped as "security: C1 control characters (NEL, CSI, …) are escaped in log lines",
  nginxKeysLimitsAndHeaders as "security: nginx caches /abfahrten and /warnungen.ics by their one parameter, limits per client, keeps the security headers",
  orionWritesWait120Seconds as "data: Orion upserts and deletes wait 120 s like the old nodes; reads keep the default",
};
