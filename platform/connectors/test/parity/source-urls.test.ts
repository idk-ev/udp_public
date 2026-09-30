/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: the source URL of every connector that has a static one, against
 * the `http request` node that fed the old function node.
 *
 * Found through the wires of the frozen flows (test/fixtures/legacy-flows.json),
 * not by name: the request node whose
 * output is wired into the connector's function node. Its `url`, or — where
 * the request node is empty and the URL came in on `msg.url` — the one
 * `msg.url = '…'` literal of the function node wired into the request node
 * (the "Roadworks-URL" prep node of `baustellen-bw`, the hystreet guard).
 *
 * Not here, because their URLs are built per run and each connector's own
 * test compares them request for request: `efa-abfahrten` (23 stops),
 * `rathaus-bw`/`ausflug-bw`/`poi-bw` (Overpass), `mastr-bw` (pages),
 * `parken-bw` (cursor pages, fetched by a function node), the Open-Meteo
 * batches, the per-district warning requests and the UBA station requests.
 */

import assert from "node:assert/strict";
import { DIRECTORY_URL } from "../../src/connectors/abfahrten-on-demand.js";
import { SOURCE_URL as BAUSTELLEN_URL } from "../../src/connectors/baustellen-bw.js";
import { SOURCE_URL as ECO_URL } from "../../src/connectors/eco-bw.js";
import { SOURCE_URL as FEINSTAUB_URL } from "../../src/connectors/feinstaub-bw.js";
import { SYSTEMS_URL } from "../../src/connectors/gbfs.js";
import { DEFAULT_URL as GRENZEN_URL } from "../../src/connectors/grenzen-bw.js";
import { SOURCE_URL as HITZE_URL } from "../../src/connectors/hitze-bw.js";
import { LOCATIONS_URL } from "../../src/connectors/hystreet.js";
import { COUNT_URL } from "../../src/connectors/ladesaeulen-bw.js";
import { SOURCE_URL as PEGEL_URL } from "../../src/connectors/pegel-bw.js";
import { SOURCE_URL as PEGEL_LUBW_URL } from "../../src/connectors/pegel-lubw.js";
import { SOURCE_URL as POLLEN_URL } from "../../src/connectors/pollen-bw.js";
import { DEFAULT_URL as STAMMDATEN_URL } from "../../src/connectors/stammdaten-bw.js";
import { STATIONS_URL } from "../../src/connectors/uba-bw.js";
import { DEFAULT_MUNICIPALITIES_URL } from "../../src/connectors/warnungen-bw.js";
import { SOURCES_URL } from "../../src/connectors/wetter-dwd-station.js";
import { legacyFlowsPath } from "../harness/fixtures.js";
import { isRecord } from "../harness/normalize.js";
import { readFileSync } from "node:fs";

/** Connector, the old function node the source answer went into, the port's URL. */
const SOURCES: readonly (readonly [connector: string, consumer: string, ported: string])[] = [
  ["pollen-bw", "udp-rt-po-fn", POLLEN_URL],
  ["hitze-bw", "udp-rt-hz-fn", HITZE_URL],
  ["pegel-bw", "udp-rt-pe-fn", PEGEL_URL],
  ["pegel-lubw", "udp-rt-pl-fn", PEGEL_LUBW_URL],
  ["stammdaten-bw", "udp-rt-bm-fn", STAMMDATEN_URL],
  ["grenzen-bw", "udp-rt-bgr-fn", GRENZEN_URL],
  // wetter-bw and vorhersage-bw load bw-gemeinden.json through stammdaten-bw's URL.
  ["wetter-bw", "udp-rt-bw-batch", STAMMDATEN_URL],
  ["vorhersage-bw", "udp-rt-bv-batch", STAMMDATEN_URL],
  ["warnungen-bw", "udp-rt-bk-msgs", DEFAULT_MUNICIPALITIES_URL],
  ["abfahrten-on-demand", "udp-rt-ah-fn", DIRECTORY_URL],
  ["wetter-dwd-station", "udp-rt-w-msgs", SOURCES_URL],
  ["uba-bw", "udp-rt-bu-msgs", STATIONS_URL],
  ["feinstaub-bw", "udp-rt-bs-fn", FEINSTAUB_URL],
  ["sharing-bw", "udp-rt-bg-msgs", SYSTEMS_URL],
  ["carsharing-bw (stations)", "udp-rt-cs-msgs", SYSTEMS_URL],
  ["carsharing-bw (status)", "udp-rt-cz-msgs", SYSTEMS_URL],
  ["ladesaeulen-bw", "udp-rt-bo-msgs", COUNT_URL],
  ["eco-bw", "udp-rt-be-fn", ECO_URL],
  ["baustellen-bw", "udp-rt-br-fn", BAUSTELLEN_URL],
  ["hystreet", "udp-rt-hy-find", LOCATIONS_URL],
];

function flowNodes(): readonly Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(readFileSync(legacyFlowsPath(), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("legacy-flows.json is not an array");
  return parsed.filter(isRecord);
}

function wiredInto(node: Record<string, unknown>, target: string): boolean {
  const wires = node.wires;
  return Array.isArray(wires) && wires.some((output) => Array.isArray(output) && output.includes(target));
}

/** The one `msg.url = '…';` literal of a function node, or `null`. */
function urlLiteral(node: Record<string, unknown>): string | null {
  const func = node.func;
  if (typeof func !== "string") return null;
  const found = [...func.matchAll(/msg\.url\s*=\s*'([^']*)'/g)].map((match) => match[1] ?? "");
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** The URL the old flow fetched before `consumer` ran — see the header. */
function oldSourceUrl(nodes: readonly Record<string, unknown>[], consumer: string): string {
  const requests = nodes.filter((node) => node.type === "http request" && wiredInto(node, consumer));
  assert.equal(requests.length, 1, `${consumer}: exactly one http request node wired into it`);
  const [request] = requests;
  assert.ok(request !== undefined);
  if (typeof request.url === "string" && request.url !== "") return request.url;
  const feeders = nodes.filter((node) => node.type === "function" && wiredInto(node, String(request.id)));
  const literals = feeders.map(urlLiteral).filter((url): url is string => url !== null);
  assert.equal(literals.length, 1, `${consumer}: the empty request node gets its msg.url from one literal`);
  return literals[0] ?? "";
}

function everySourceUrlIsTheOldOne(): void {
  const nodes = flowNodes();
  const mismatches: string[] = [];
  for (const [connector, consumer, ported] of SOURCES) {
    const old = oldSourceUrl(nodes, consumer);
    if (old !== ported) mismatches.push(`  ${connector} (${consumer}):\n    old ${old}\n    new ${ported}`);
  }
  assert.equal(
    mismatches.length,
    0,
    `source URLs differ from the old http request nodes:\n${mismatches.join("\n")}`,
  );
}

export { everySourceUrlIsTheOldOne as "source URLs: every static source URL is the one of the old http request node wired into the connector" };
