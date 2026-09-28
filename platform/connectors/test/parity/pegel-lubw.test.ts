/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: pegel-lubw — FN_PEGEL_LUBW (`udp-rt-pl-fn`) and its signature commit
 * node (`udp-rt-pl-commit`) against the ported module plus the change gate.
 *
 * Compared: the emitted chunks (entities, pending signatures, chunks of 50) on
 * the recorded file, the status counts, the gate cycle, and test inputs for the
 * branches the dry-weather recording does not reach (flood state, a decimal
 * comma, a missing PEG_DB). `parseRow` and `num` are additionally pinned
 * against the old code cut out of the node.
 *
 * Fixture: test/fixtures/pegel-lubw.json — hvz_peg_stmn.js as text, 56 of 334
 * rows (see its `note`), with the trimmed geo fixtures as geo context.
 */

import assert from "node:assert/strict";
import {
  build,
  CHUNK_SIZE,
  GATE_KEY,
  num,
  parse,
  parseRow,
  run,
  signatureOf,
} from "../../src/connectors/pegel-lubw.js";
import type { HvzBuild } from "../../src/connectors/pegel-lubw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createGeoIndex } from "../../src/kernel/geo.js";
import { chunk } from "../../src/kernel/orion.js";
import { isString, ParseError } from "../../src/kernel/parse.js";
import type { UpsertPlan } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { httpResponse, recordingLog } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { evaluateSnippet, extractSnippet, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";
import { fixtureGeo, legacyChunks, rig, upsertBodies } from "../harness/water-warnings-rig.js";
import type { LegacyChunks } from "../harness/water-warnings-rig.js";

const NODE_ID = "udp-rt-pl-fn";
const COMMIT_NODE_ID = "udp-rt-pl-commit";
const FIXTURE = "pegel-lubw";

interface Legacy extends LegacyChunks {
  readonly run: FunctionNodeRun;
}

function fixtureText(): string {
  const payload = readFixture(FIXTURE).payload;
  assert.ok(isString(payload));
  return payload;
}

async function runLegacy(text: string, flow: Readonly<Record<string, unknown>> = {}): Promise<Legacy> {
  const geo = fixtureGeo();
  const run = await runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(readFixture(FIXTURE)), payload: text },
    flow,
    global: { bwGrenzen: geo.rawBoundaries, bwGemeinden: geo.rawRows },
  });
  return { run, ...legacyChunks(run) };
}

function portedBuild(text: string): HvzBuild {
  const geo = fixtureGeo();
  return build(parse(text), createGeoIndex(geo.rows, geo.boundaries), new Date().toISOString());
}

function ported(text: string, store: SignatureScope): UpsertPlan {
  return createChangeGate(store, recordingLog()).check(GATE_KEY, portedBuild(text).entities, signatureOf);
}

function assertPlanMatches(legacy: Legacy, plan: UpsertPlan): void {
  assertEntitiesEqual(legacy.entities, plan.entities);
  assert.deepEqual(normalize(legacy.pending), normalize(plan.pending), "pending signatures differ");
  assert.deepEqual(
    legacy.sizes,
    chunk(plan.entities, CHUNK_SIZE).map((part) => part.length),
    "chunking differs",
  );
}

/** Replaces field `index` of the row whose id is `id` — a test input, not fixture data. */
function withField(text: string, id: string, index: number, value: string): string {
  const line = text.split("\n").find((candidate) => candidate.includes(`['${id}',`));
  assert.ok(line !== undefined, `row ${id} in the fixture`);
  const inner = /\[(.*)\]/.exec(line)?.[1];
  assert.ok(inner !== undefined);
  // Split outside quotes exactly as the file is written, keep the quoting.
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of inner) {
    if (c === "'") quoted = !quoted;
    if (c === "," && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  fields.push(current);
  fields[index] = value;
  return text.replace(line, line.replace(inner, fields.join(",")));
}

async function recordedFileIsIdentical(): Promise<void> {
  const text = fixtureText();
  const legacy = await runLegacy(text);
  const store = new SignatureStore().scope("test");
  const plan = ported(text, store);
  const built = portedBuild(text);

  assert.deepEqual(legacy.run.warnings, []);
  assertPlanMatches(legacy, plan);
  // The status line carries the count of gauges outside the polygons.
  assert.deepEqual(normalize(legacy.run.status[0]), {
    text: `${String(built.entities.length)} Landespegel (${String(built.outsidePolygons)} außerhalb BW-Polygonen)`,
  });

  // Branches the recording has to exercise.
  const all = built.entities;
  assert.equal(all.length, 41);
  assert.ok(built.outsidePolygons >= 5, "gauges outside the polygons are skipped");
  assert.ok(all.some((e) => e.levelState.value === "low"));
  assert.ok(all.some((e) => e.levelState.value === "normal"));
  assert.ok(
    all.some((e) => e.level.unitCode === "MTR"),
    "a level in m above sea level",
  );
  assert.ok(all.some((e) => e.discharge !== undefined) && all.some((e) => e.discharge === undefined));
  assert.ok(all.some((e) => e.floodLevels !== undefined) && all.some((e) => e.floodLevels === undefined));
  assert.ok(all.some((e) => e.meanLowLevel !== undefined));
}

async function floodStateAndDecimalComma(): Promise<void> {
  // Test inputs: Zell (00074, five warning levels) above its first level, with
  // a decimal comma; Ulm's discharge with a comma as well.
  const text = withField(withField(fixtureText(), "00074", 4, "'999,5'"), "00319", 7, "'1,75'");
  const legacy = await runLegacy(text);
  const plan = ported(text, new SignatureStore().scope("test"));
  assertPlanMatches(legacy, plan);
  const zell = portedBuild(text).entities.find((e) => e.id.endsWith("-00074"));
  assert.equal(zell?.levelState.value, "high");
  assert.equal(zell.level.value, 999.5);
}

async function gateCycle(): Promise<void> {
  const text = fixtureText();
  const store = new SignatureStore().scope("test");
  const first = await runLegacy(text);
  const plan = ported(text, store);
  let flow = Object.fromEntries(first.run.flow);
  for (const message of first.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE_ID, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    flow = Object.fromEntries(commit.flow);
  }
  store.commit(plan.pending, new Set(plan.entities.map((entity) => entity.id)));
  assert.deepEqual(normalize(flow[GATE_KEY]), normalize(Object.fromEntries(store.copy(GATE_KEY))));

  // A changed discharge alone is a change (it is part of the signature).
  const changed = withField(text, "00042", 7, "'9.99'");
  const second = await runLegacy(changed, flow);
  const secondPlan = ported(changed, store);
  assertPlanMatches(second, secondPlan);
  assert.equal(secondPlan.pending.length, 1);
}

function parseRowAndNumAreTheOldOnes(): void {
  const source =
    extractSnippet(NODE_ID, "const parseRow = line => {", "    return out;\n};") +
    "\n" +
    extractSnippet(NODE_ID, "const num = v =>", "};");
  const lines = [
    "'00435','Wiesloch-Hilfspegel','Leimbach',1,'--','',x",
    " 'a, b' , ' c ',,'',d'e'f ",
    "'unterminated, quote",
    "",
  ];
  const numbers = ["12,5", "1,2,3", "--", "", " 7.25cm", "0", "-3,0", "1e3", "Infinity", "NaN"];
  const legacy = evaluateSnippet(
    source,
    { LINES: lines, NUMBERS: numbers },
    "[LINES.map(parseRow), NUMBERS.map(num)]",
  );
  assert.deepEqual(normalize(legacy), [lines.map(parseRow), numbers.map(num)]);
}

async function missingPegDbWarns(): Promise<void> {
  const text = "HVZ_Site.PEG_LHP = 0;\n// maintenance\n";
  const legacy = await runLegacy(text);
  assert.equal(legacy.messages.length, 0);
  assert.match(legacy.run.warnings[0] ?? "", /PEG_DB nicht gefunden/);
  assert.throws(() => parse(text), ParseError);

  const r = rig("pegel-lubw", () => httpResponse(200, text));
  await run(r.ctx);
  assert.deepEqual(r.log.warnings(), ["HVZ: PEG_DB not found (format changed?)"]);
  assert.equal(upsertBodies(r.seen).length, 0);
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const text = fixtureText();
  const geo = fixtureGeo();
  const legacy = await runLegacy(text);
  const r = rig("pegel-lubw", (request) =>
    request.url.host === "www.hvz.baden-wuerttemberg.de" ? httpResponse(200, text) : httpResponse(204),
  );
  r.geo.setBoundaries(geo.boundaries, 0);
  await run(r.ctx); // municipalities optional: runs without master data
  r.geo.setMunicipalities(geo.rows);
  const withoutNames = upsertBodies(r.seen).flat();
  assert.equal(withoutNames.length, legacy.entities.length);
  assert.ok(
    withoutNames.every((e) => isRecord(e) && isRecord(e.gemeindeName) && e.gemeindeName.value === ""),
  );

  // Names changed nothing measured: the gate sends freshness only. A fresh rig
  // with master data upserts exactly the old chunks.
  const full = rig("pegel-lubw", (request) =>
    request.url.host === "www.hvz.baden-wuerttemberg.de" ? httpResponse(200, text) : httpResponse(204),
  );
  full.geo.setBoundaries(geo.boundaries, 0);
  full.geo.setMunicipalities(geo.rows);
  await run(full.ctx);
  const bodies = upsertBodies(full.seen);
  assertEntitiesEqual(legacy.entities, bodies.flat());
  assert.deepEqual(
    bodies.map((body) => body.length),
    legacy.sizes,
  );
}

export {
  recordedFileIsIdentical as "pegel-lubw: old FN_PEGEL_LUBW and ported build() + gate agree on the recorded HVZ file",
  floodStateAndDecimalComma as "pegel-lubw: flood state and decimal commas (test inputs) agree",
  gateCycle as "pegel-lubw: commit matches the old commit node; a changed discharge alone is a change",
  parseRowAndNumAreTheOldOnes as "pegel-lubw: parseRow and num agree with the old code on odd input",
  missingPegDbWarns as "pegel-lubw: a file without PEG_DB warns and writes nothing",
  runUpsertsWhatTheOldFlowSent as "pegel-lubw: run() works without master data and upserts exactly the old chunks",
};
