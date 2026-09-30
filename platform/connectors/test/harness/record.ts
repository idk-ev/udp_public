/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Records a source response as a fixture.
 *
 * The ONE step in the harness that touches the network. Afterwards everything
 * runs offline: parity tests read `test/fixtures/`, never a live source. That
 * is the point — a test that depends on the DWD being reachable is not a
 * regression net, it is a second alarm clock.
 *
 * Invocation (from `platform/connectors/`, after `npm run build`):
 *
 *     node --enable-source-maps dist/test/harness/record.js <name> <url> [note]
 *
 * Example, the fixture of the worked parity example:
 *
 *     node --enable-source-maps dist/test/harness/record.js \
 *       pollen-bw https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json
 *
 * Writes `test/fixtures/<name>.json` in the SOURCE tree, not into `dist/`.
 * Deliberately no npm script: `package.json` belongs to the service, and a
 * recording is a manual, deliberate act — not something a build runs.
 *
 * If the response is large, trim the committed file by hand to a representative
 * subset and describe the trim in its `note` field. Real values, never invented
 * ones: a fixture that nobody has ever seen from the source proves nothing.
 */

import { writeFixture, type Fixture } from "./fixtures.js";

/**
 * Only these headers are kept. The rest is either volatile (`date`, `age`),
 * irrelevant to the parsing, or has no business in a committed file
 * (`set-cookie`, anything to do with authorisation).
 */
const KEPT_HEADERS = ["content-type", "content-encoding", "content-language", "last-modified", "etag"];

const USER_AGENT = "UDP parity harness (https://github.com/idk-ev/udp_public)";

function usage(): string {
  return "usage: node --enable-source-maps dist/test/harness/record.js <name> <url> [note]";
}

async function record(name: string, url: string, note: string | undefined): Promise<void> {
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.8", "user-agent": USER_AGENT },
    redirect: "follow",
  });
  const text = await response.text();

  const headers: Record<string, string> = {};
  for (const key of KEPT_HEADERS) {
    const value = response.headers.get(key);
    if (value !== null) headers[key] = value;
  }

  let format: Fixture["format"] = "text";
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
    format = "json";
  } catch {
    // Not JSON — kept as text, exactly as an `http request` node with ret:"txt"
    // would hand it on.
  }

  // Order matters only for the reader: everything that describes the recording
  // comes before the bulk payload, so `head` on the file already says what it is.
  const fixture: Fixture = {
    source: url,
    recordedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
    statusCode: response.status,
    headers,
    format,
    payload,
  };
  const file = writeFixture(name, fixture);
  process.stdout.write(
    `[record] ${url} -> ${file} (${String(response.status)}, ${format}, ${String(text.length)} bytes)\n`,
  );
  if (!response.ok) {
    process.stdout.write(`[record] warning: status ${String(response.status)} — check before committing\n`);
  }
}

const [name, url, note] = process.argv.slice(2);
if (name === undefined || url === undefined) {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
} else {
  try {
    await record(name, url, note);
  } catch (error) {
    process.stderr.write(`[record] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
