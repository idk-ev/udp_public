/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: grenzen-bw — FN_GRENZEN (`udp-rt-bgr-fn`) against the ported module.
 *
 * The old node writes no entity; its whole effect is `global.set('bwGrenzen',
 * payload)`. So the comparison is between that global and what `build()`
 * returns for the geo context — including the key order, which decides which
 * polygon wins where two overlap (first hit wins in the strict lookup).
 *
 * Fixture: test/fixtures/grenzen-bw.json — 167 real polygons of
 * gui/public/bw-grenzen.json, trimmed as described in its `note`.
 */

import assert from "node:assert/strict";
import { build, DEFAULT_URL, parse, run } from "../../src/connectors/grenzen-bw.js";
import type { BoundarySet } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { isRecord, normalize } from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import { jsonAnswer, weatherCtx, weatherFetcher } from "../harness/weather-ctx.js";
import type { ScriptedAnswer } from "../harness/weather-ctx.js";

const NODE_ID = "udp-rt-bgr-fn";
const FIXTURE = "grenzen-bw";

async function boundaryCacheIsIdentical(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const run = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });
  const file = parse(fixture.payload);
  const built = build(file, null, new Date().toISOString());

  assert.equal(run.returned, null, "the old node emits nothing");
  assert.deepEqual(run.warnings, []);
  assert.equal(file.skipped, 0);
  assert.deepEqual(normalize(run.status), [{ text: "167 Gemeindepolygone" }]);
  assert.equal(Object.keys(built).length, 167);

  const legacy = run.global.get("bwGrenzen");
  assert.deepEqual(normalize(legacy), normalize(built), "bwGrenzen differs from the built boundary set");
  // normalize() sorts keys for a legible diff; the order matters here, so it is
  // compared separately.
  assert.deepEqual(isRecord(legacy) ? Object.keys(legacy) : [], Object.keys(built), "key order differs");
}

async function unreadableResponseLeavesCacheAlone(): Promise<void> {
  // A failed download must not clear the cache: the old node returns before
  // `global.set`, the port returns before `setBoundaries` (see run()).
  const fixture = readFixture(FIXTURE);
  const previous = { "08311000": { b: [0, 0, 1, 1], r: [] } };
  const run = await runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(fixture), statusCode: 404, payload: "<html>not found</html>" },
    global: { bwGrenzen: previous },
  });
  assert.equal(run.warnings.length, 1);
  assert.match(run.warnings[0] ?? "", /not loadable \(404\).*skip their runs/);
  assert.equal(run.global.get("bwGrenzen"), previous);
}

function brokenEntriesAreDroppedAndCounted(): void {
  // Deliberate difference: the old node stored whatever object arrived; the
  // port drops an unusable entry instead of letting the lookup throw on it
  // later, and reports the count. The fixture has none, so parity is untouched.
  const fixture = readFixture(FIXTURE);
  const payload = structuredClone(fixture.payload);
  assert.ok(isRecord(payload));
  payload["08999999"] = { b: [1, 2, 3], r: [] };
  const file = parse(payload);
  assert.equal(file.skipped, 1);
  assert.equal(Object.keys(file.boundaries).length, 167);
}

async function runFillsTheGeoContextAndA404KeepsIt(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });

  let answer: ScriptedAnswer = jsonAnswer(200, fixture.payload);
  const network = weatherFetcher((call) =>
    call.url === DEFAULT_URL ? answer : { response: new Error(`unexpected call ${call.url}`) },
  );
  const { ctx, kernel, log } = weatherCtx("grenzen-bw", network.fetcher);
  // Read through a function: a narrowing assert on the getter would stick.
  const context = (): BoundarySet | null => kernel.geo.boundaries;
  assert.equal(context(), null);

  await run(ctx);
  assert.deepEqual(log.warnings(), []);
  const filled = context();
  assert.ok(filled !== null, "run() did not set the boundaries");
  assert.deepEqual(normalize(filled), normalize(legacy.global.get("bwGrenzen")), "geo context differs");
  assert.equal(Object.keys(filled).length, 167);
  assert.equal(kernel.geo.boundariesDegraded, false);
  // Nothing goes to Orion: the boundaries are context only.
  assert.deepEqual(
    network.seen.map((call) => call.url),
    [DEFAULT_URL],
  );

  // HTTP 404: warned, the previous boundaries stay — as the old node returned
  // before global.set (see unreadableResponseLeavesCacheAlone).
  answer = jsonAnswer(404, "not found");
  await run(ctx);
  assert.equal(context(), filled, "a 404 replaced the boundaries");
  assert.match(log.warnings().at(-1) ?? "", /bw-grenzen\.json not loadable \(HTTP 404\)/);
}

export {
  runFillsTheGeoContextAndA404KeepsIt as "grenzen-bw: run() puts the old node's boundary set into the geo context; a 404 keeps it",
  boundaryCacheIsIdentical as "grenzen-bw: old FN_GRENZEN and ported build() put the identical boundary set into the geo context",
  unreadableResponseLeavesCacheAlone as "grenzen-bw: an unreadable response warns and leaves the previous cache in place",
  brokenEntriesAreDroppedAndCounted as "grenzen-bw: a malformed polygon entry is dropped and counted, not stored",
};
