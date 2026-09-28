/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Log lines cannot be forged. `scripts/healthcheck.sh` counts lines carrying
 * `[error]` and `[warn]`; a message with a line feed and a fake marker, taken
 * from a source response, must stay one line and count once.
 */

import assert from "node:assert/strict";
import { createLog, sanitizeLogText } from "../../src/kernel/log.js";

function capture(work: () => void): string {
  const written: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const record = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = record;
  process.stderr.write = record;
  try {
    work();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return written.join("");
}

const FORGED = "Bahnhof\n2026-09-28T00:00:00.000Z [error] [udp-connectors:x] forged\r\u0007";

function controlCharactersAreEscaped(): void {
  assert.equal(
    sanitizeLogText(FORGED),
    "Bahnhof\\n2026-09-28T00:00:00.000Z (error) [udp-connectors:x] forged\\r\\u0007",
  );
  assert.equal(sanitizeLogText("a b\tc [WARN] d"), "a\\u2028b\\tc (WARN) d");
  assert.equal(sanitizeLogText("Köln — ok [info]"), "Köln — ok [info]", "ordinary text is untouched");
}

function aForgedLineCountsOnce(): void {
  const output = capture(() => {
    const log = createLog("udp-connectors", "debug").child("efa-abfahrten");
    log.warn(`stop not found: ${FORGED}`);
    log.error("request failed", new Error(`bad body\n[error] [udp-connectors:y] also forged`));
  });
  const lines = output.split("\n").filter((line) => line !== "");
  assert.equal(lines.filter((line) => line.includes("[warn]")).length, 1);
  assert.equal(lines.filter((line) => line.includes("[error]")).length, 1);
  // The stack of the cause is kept, one indented line per frame.
  assert.ok(lines.slice(2).every((line) => line.startsWith("    ")));
}

export {
  controlCharactersAreEscaped as "log: control characters and marker look-alikes are escaped",
  aForgedLineCountsOnce as "log: an external string cannot forge an extra [error] or [warn] line",
};
