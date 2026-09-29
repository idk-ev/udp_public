/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: ops-host — FN_OPS (`udp-rt-op-fn`) against the ported `build()` and
 * `run()`.
 *
 * The old exec node cannot run here (no `/proc` on a test machine, and it is
 * not a function node), so both sides get the command's recorded stdout as
 * `msg.payload` resp. from the injected reader — which is exactly the seam the
 * exec node had. The branches a healthy host never shows (a `free` without the
 * "available" column, a `df` with nothing but its header, a missing `nproc`,
 * decimal commas, a truncated output) are pinned on modified copies of the
 * recording.
 *
 * Fixture: test/fixtures/ops-host.json — the complete stdout of the command in
 * node:22-alpine, see its `note`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, COMMAND, EXEC_TIMEOUT_MS, parse, runWith } from "../../src/connectors/ops-host.js";
import { ParseError } from "../../src/kernel/parse.js";
import { legacyFlowsPath, messageFromFixture, readFixture } from "../harness/fixtures.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { testCtx, TEST_ORION_URL, upsertedEntities } from "../harness/operations-ctx.js";
import { loadFunctionNode, messagesOf, runFunctionNode, solePayload } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-op-fn";
const EXEC_NODE_ID = "udp-rt-op-exec";
const FIXTURE = "ops-host";

function recorded(): string {
  const payload = readFixture(FIXTURE).payload;
  assert.equal(typeof payload, "string");
  return String(payload);
}

async function runLegacy(output: string): Promise<FunctionNodeRun> {
  const fixture = readFixture(FIXTURE);
  return runFunctionNode(NODE_ID, { msg: { ...messageFromFixture(fixture), payload: output } });
}

/** Old node and new build() on the same exec output; returns the new entity for extra checks. */
async function assertSameEntity(output: string): Promise<ReturnType<typeof build>> {
  const legacy = await runLegacy(output);
  assert.deepEqual(legacy.warnings, [], "the old node warned");
  const entity = build(parse(output), null, new Date().toISOString());
  assertEntitiesEqual(solePayload(legacy), [entity]);
  return entity;
}

async function recordedOutputIsIdentical(): Promise<void> {
  const entity = await assertSameEntity(recorded());
  // Sanity of the recording itself, so a broken fixture cannot pass as parity.
  assert.equal(entity.cpuCores.value, 8);
  assert.equal(entity.diskUsedPct.value, 26);
  assert.equal(entity.memTotalMb.value, 32098);
  assert.equal(entity.memUsedPct.value, 5);
}

async function runUpsertsTheSameEntity(): Promise<void> {
  const output = recorded();
  const legacyClock = openClock();
  const legacy = await runLegacy(output);
  const legacyWindow = legacyClock.close();
  const message = messagesOf(legacy)[0];
  // The upsert node took Content-Type from msg.headers; the kernel's upsert sends the same.
  assert.deepEqual(normalize(isRecord(message) ? message.headers : undefined), {
    "Content-Type": "application/ld+json",
  });

  const t = testCtx({ id: "ops-host" });
  const portClock = openClock();
  await runWith(t.ctx, () => Promise.resolve(output));
  const portWindow = portClock.close();
  assert.deepEqual(t.log.warnings(), []);
  assert.equal(t.seen.length, 1, "exactly one upsert");
  const request = t.seen[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, "POST");
  assert.equal(
    `${request.url.origin}${request.target}`,
    `${TEST_ORION_URL}/ngsi-ld/v1/entityOperations/upsert?options=update`,
  );
  // What reached Orion, after JSON — against what the old node handed its upsert node.
  assertEntitiesEqual(JSON.parse(JSON.stringify(solePayload(legacy))), upsertedEntities(t.seen));
  assertClockStamps(solePayload(legacy), upsertedEntities(t.seen), {
    legacy: legacyWindow,
    ported: portWindow,
  });
}

async function unusualOutputsMatch(): Promise<void> {
  const output = recorded();
  const sections = output.split("---");

  // `free` without the "available" column: column 3 ("free") is read instead.
  const oldFree = output.replace(/Mem:.*$/m, "Mem:          32098        1172       23815           5");
  const withoutAvailable = await assertSameEntity(oldFree);
  assert.equal(withoutAvailable.memUsedPct.value, 26);

  // No Mem: row at all → memTotal NaN → memUsedPct null.
  const noMem = await assertSameEntity(output.replace(/^Mem:.*$/m, "Swap: 0 0 0"));
  assert.equal(noMem.memUsedPct.value, null);

  // `df -P /data` in an image without /data: busybox prints only the header.
  const headerOnly = [
    sections[0],
    sections[1],
    "\nFilesystem           1024-blocks    Used Available Capacity Mounted on\n",
    sections[3],
    sections[4],
  ].join("---");
  const noDisk = await assertSameEntity(headerOnly);
  assert.ok(Number.isNaN(noDisk.diskUsedPct.value), "the old node reported NaN here, the port must too");
  assert.equal(noDisk.diskTotalGb.value, 0);

  // `nproc` missing or 0 → one core.
  await assertSameEntity([...sections.slice(0, 4), "\n"].join("---"));
  await assertSameEntity([...sections.slice(0, 4), "\n0\n"].join("---"));

  // Decimal commas (a localised `cat`/`free` would print them).
  await assertSameEntity(output.replace("0.10 0.26 0.47", "0,10 0,26 0,47").replace("23375.25", "23375,25"));

  // Extra sections beyond the fifth are ignored on both sides.
  await assertSameEntity(`${output}---\nstray\n`);
}

async function truncatedOutputWarnsAndWritesNothing(): Promise<void> {
  const truncated = recorded().split("---").slice(0, 3).join("---");
  for (const output of [truncated, ""]) {
    const legacy = await runLegacy(output);
    assert.deepEqual(messagesOf(legacy), [], "the old node emitted a message");
    assert.deepEqual(legacy.warnings, ["Betriebsmetriken: unerwartete exec-Ausgabe"]);
    assert.throws(() => parse(output), ParseError);

    const t = testCtx({ id: "ops-host" });
    await runWith(t.ctx, () => Promise.resolve(output));
    assert.deepEqual(t.log.warnings(), ["host metrics: unexpected exec output"]);
    assert.equal(t.seen.length, 0, "nothing may be written");
  }
}

function commandMatchesTheExecNode(): void {
  // The exec node's command, with the one deliberate change of the disk path.
  const execNode = readExecCommand();
  assert.equal(execNode.timer, "10");
  assert.equal(EXEC_TIMEOUT_MS, 10_000);
  assert.equal(
    execNode.command.replace("df -P /data", "df -P /"),
    `sh -c '${COMMAND}'`,
    "the command drifted from the old exec node",
  );
  // FN_OPS is a plain function node: nothing in its libs, nothing to fake.
  assert.deepEqual(loadFunctionNode(NODE_ID).libs, []);
}

function readExecCommand(): { command: string; timer: string } {
  // The exec node is not a function node; read it through the same frozen flow file.
  const flows: unknown = JSON.parse(readFileSync(legacyFlowsPath(), "utf8"));
  assert.ok(Array.isArray(flows));
  for (const node of flows) {
    if (!isRecord(node) || node.id !== EXEC_NODE_ID) continue;
    assert.equal(node.type, "exec");
    assert.equal(typeof node.command, "string");
    assert.equal(typeof node.timer, "string");
    return { command: String(node.command), timer: String(node.timer) };
  }
  throw new Error(`exec node ${EXEC_NODE_ID} not found`);
}

export {
  recordedOutputIsIdentical as "ops-host: old FN_OPS and ported build() emit the identical PlatformStatus:udp on the recorded /proc output",
  runUpsertsTheSameEntity as "ops-host: run() upserts exactly the entity the old node handed its upsert node",
  unusualOutputsMatch as "ops-host: free without 'available', df header only, missing nproc, decimal commas — identical on both sides",
  truncatedOutputWarnsAndWritesNothing as "ops-host: truncated exec output warns and writes nothing, as before",
  commandMatchesTheExecNode as "ops-host: the command and its 10 s kill timer are the old exec node's (disk path / instead of /data)",
};
