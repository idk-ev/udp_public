/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: hystreet — FN_HY_GUARD (`udp-rt-hy-guard`), FN_HY_FIND
 * (`udp-rt-hy-find`) and FN_HY_BUILD (`udp-rt-hy-build`) chained through a
 * stand-in of the http request node, against `run(ctx)` on a scripted network.
 *
 * Compared: that nothing happens without a token (and nothing is logged as a
 * warning — an unconfigured instance must not light up the health check every
 * hour), the two request URLs and their headers, the upserted entity, and the
 * warning paths (401, no Reutlingen location, unknown answer format).
 *
 * The token comes from the real kernel environment (`createEnv`), so the test
 * also pins that an EMPTY variable counts as unset, as the flow's `!token`.
 *
 * Fixtures: hystreet-unauthorized.json is recorded (401 without token);
 * hystreet-locations.json and hystreet-location.json are SYNTHETIC — shaped
 * like the old nodes expect, marked as such in their `note`.
 */

import assert from "node:assert/strict";
import { LOCATIONS_URL, run, TOKEN_ENV } from "../../src/connectors/hystreet.js";
import type { HttpResponse } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import type { GRequest } from "../harness/g-transport.js";
import {
  afterHttpRequest,
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

const TOKEN = "test-token-123";

function fixtureAnswer(name: string): HttpResponse {
  const fixture = readFixture(name);
  return jsonHttp(fixture.statusCode, fixture.payload);
}

/** Runs `body` with `HYSTREET_API_TOKEN` set to `value` (or unset), then restores it. */
async function withToken<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env[TOKEN_ENV];
  if (value === undefined) Reflect.deleteProperty(process.env, TOKEN_ENV);
  else process.env[TOKEN_ENV] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, TOKEN_ENV);
    else process.env[TOKEN_ENV] = previous;
  }
}

interface LegacyChain {
  /** `msg.url` / `msg.headers` handed to the two http request nodes. */
  readonly requests: readonly { readonly url: unknown; readonly headers: unknown }[];
  readonly entities: unknown[];
  readonly warnings: readonly string[];
  readonly status: readonly unknown[];
}

/** The old chain, the http request nodes answered by `respond`. */
async function legacy(token: string, respond: (url: string) => HttpResponse): Promise<LegacyChain> {
  const env = { [TOKEN_ENV]: token };
  const requests: { url: unknown; headers: unknown }[] = [];
  const warnings: string[] = [];
  const guard = await runFunctionNode("udp-rt-hy-guard", { msg: { _msgid: "parity", payload: 0 }, env });
  const empty = { requests, entities: [], warnings, status: guard.status };
  if (!isRecord(guard.returned)) return empty;
  let msg: Record<string, unknown> = guard.returned;
  for (const nodeId of ["udp-rt-hy-find", "udp-rt-hy-build"]) {
    requests.push({ url: msg.url, headers: msg.headers });
    const result = await runFunctionNode(nodeId, {
      msg: afterHttpRequest(msg, respond(String(msg.url))),
      env,
    });
    warnings.push(...result.warnings);
    if (!isRecord(result.returned)) return empty;
    msg = result.returned;
  }
  const payload = msg.payload;
  return { requests, entities: Array.isArray(payload) ? payload : [], warnings, status: guard.status };
}

async function ported(
  token: string | undefined,
  respond: (url: string) => HttpResponse,
): Promise<{ seen: readonly GRequest[]; warnings: readonly string[]; status: readonly string[] }> {
  return withToken(token, async () => {
    const network = recordingFetcher((request) =>
      request.url.startsWith(ORION) ? httpResponse(204) : respond(request.url),
    );
    const g = rig(registryEntry("hystreet"), network.fetcher);
    await run(g.ctx);
    return {
      seen: network.seen,
      warnings: g.log.warnings(),
      status: g.log.lines.filter((line) => line.level === "status").map((line) => line.text),
    };
  });
}

function sourceRequests(seen: readonly GRequest[]): readonly GRequest[] {
  return seen.filter((request) => !request.url.startsWith(ORION));
}

const normalRespond = (url: string): HttpResponse =>
  url === LOCATIONS_URL ? fixtureAnswer("hystreet-locations") : fixtureAnswer("hystreet-location");

async function inactiveWithoutToken(): Promise<void> {
  const old = await legacy("", normalRespond);
  assert.equal(old.requests.length, 0);
  assert.deepEqual(normalize(old.status), [{ text: "inaktiv (kein Token)" }]);
  assert.deepEqual(old.warnings, []);

  for (const token of [undefined, ""]) {
    const now = await ported(token, normalRespond);
    assert.equal(now.seen.length, 0, `token ${JSON.stringify(token)}: no request at all`);
    assert.deepEqual(now.warnings, [], `token ${JSON.stringify(token)}: no warning spam`);
    assert.deepEqual(now.status, ["inactive (no token)"]);
  }
}

async function activeChainMatches(): Promise<void> {
  const legacyClock = openClock();
  const old = await legacy(TOKEN, normalRespond);
  const legacyWindow = legacyClock.close();
  const portClock = openClock();
  const now = await ported(TOKEN, normalRespond);
  const portWindow = portClock.close();
  const requests = sourceRequests(now.seen);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => ({ url: request.url, headers: request.options?.headers })),
    normalize(old.requests),
    "request URLs or headers differ from the old http request nodes",
  );
  assert.ok(requests.every((request) => request.options?.retries === 0));
  assert.deepEqual(now.warnings, old.warnings);
  assertEntitiesEqual(old.entities, upsertedEntities(now.seen));
  assertClockStamps(old.entities, upsertedEntities(now.seen), { legacy: legacyWindow, ported: portWindow });
  assert.equal(old.entities.length, 1);
}

/** The old warnings, word for word, and what the port logs instead (English log texts). */
const TRANSLATED = new Map<string, string>([
  ["hystreet: Standortliste fehlgeschlagen (401)", "hystreet: location list failed (401)"],
  ["hystreet: kein Reutlingen-Standort gefunden", "hystreet: no Reutlingen location found"],
  ["hystreet: Detailabruf fehlgeschlagen (503)", "hystreet: detail request failed (503)"],
  [
    "hystreet: unbekanntes Antwortformat — Feldnamen prüfen",
    "hystreet: unknown response format — check the field names",
  ],
]);

async function warningPathsMatch(): Promise<void> {
  const cases: readonly { readonly name: string; readonly respond: (url: string) => HttpResponse }[] = [
    { name: "401 without valid token", respond: () => fixtureAnswer("hystreet-unauthorized") },
    {
      name: "no Reutlingen location",
      respond: (url) =>
        url === LOCATIONS_URL ? jsonHttp(200, { data: [{ id: 1, city: "Ulm" }] }) : normalRespond(url),
    },
    {
      name: "location without id",
      respond: (url) =>
        url === LOCATIONS_URL ? jsonHttp(200, [{ city: "Reutlingen" }]) : normalRespond(url),
    },
    {
      name: "detail 503",
      respond: (url) => (url === LOCATIONS_URL ? normalRespond(url) : httpResponse(503, "busy")),
    },
    {
      name: "unknown answer format",
      respond: (url) =>
        url === LOCATIONS_URL ? normalRespond(url) : jsonHttp(200, { data: { statistics: {} } }),
    },
    {
      name: "only the hourly count, name in data",
      respond: (url) =>
        url === LOCATIONS_URL
          ? normalRespond(url)
          : jsonHttp(200, {
              data: { name: "Wilhelm's Straße", statistics: { last_hour_count: 17, today_count: null } },
            }),
    },
  ];
  for (const scenario of cases) {
    const old = await legacy(TOKEN, scenario.respond);
    const now = await ported(TOKEN, scenario.respond);
    assert.deepEqual(
      now.warnings,
      old.warnings.map((text) => TRANSLATED.get(text) ?? `<untranslated: ${text}>`),
      `${scenario.name}: warnings differ`,
    );
    assert.deepEqual(
      sourceRequests(now.seen).map((request) => ({ url: request.url, headers: request.options?.headers })),
      normalize(old.requests),
      `${scenario.name}: requests differ`,
    );
    assertEntitiesEqual(old.entities, upsertedEntities(now.seen), {
      labels: { left: `old (${scenario.name})`, right: `new (${scenario.name})` },
    });
  }
}

export {
  inactiveWithoutToken as "hystreet: without (or with an empty) token nothing is requested and nothing warns",
  activeChainMatches as "hystreet: request URLs, headers and the PedestrianFlowObserved entity match the old chain",
  warningPathsMatch as "hystreet: 401, missing location, detail error and unknown format behave as the old nodes",
};
