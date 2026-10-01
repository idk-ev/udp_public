/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Null-valued attributes of ungated writes (src/kernel/null-values.ts, used by
 * `eco-bw` and `wetter-bw`): Orion-LD 1.6 refuses `value: null` for the whole
 * entity, so the attribute is left out, and a value still in the broker is
 * withdrawn once while it stays unknown.
 */

import assert from "node:assert/strict";
import { splitNulls, withdrawNulls } from "../../src/kernel/null-values.js";
import type { HttpResponse, NgsiEntity } from "../../src/kernel/types.js";
import { NGSI_CONTEXT } from "../../src/kernel/types.js";
import type { GRequest } from "../harness/g-transport.js";
import { jsonHttp, ORION, recordingFetcher, registryEntry, rig } from "../harness/g-transport.js";
import { httpResponse } from "../harness/kernel.js";

const ID = "urn:ngsi-ld:WeatherObserved:bw-08111000";

function weather(temperature: number | null): NgsiEntity {
  return {
    id: ID,
    type: "WeatherObserved",
    ags: { type: "Property", value: "08111000" },
    temperature: {
      type: "Property",
      value: temperature,
      unitCode: "CEL",
      observedAt: "2026-10-01T06:10:00Z",
    },
    windSpeed: { type: "Property", value: 3, unitCode: "KMH", observedAt: "2026-10-01T06:10:00Z" },
    "@context": NGSI_CONTEXT,
  };
}

function splitIsPure(): void {
  const known = weather(12.5);
  assert.equal(splitNulls(known).entity, known, "nothing to drop: the same object");
  const { entity, cleared } = splitNulls(weather(null));
  assert.deepEqual(cleared, ["temperature"]);
  assert.deepEqual(Object.keys(entity).sort(), ["@context", "ags", "id", "type", "windSpeed"]);
  // A null inside a compound value is fine for Orion-LD and stays.
  const nested: NgsiEntity = { ...known, departures: { type: "Property", value: [{ delay: null }] } };
  assert.deepEqual(splitNulls(nested).cleared, []);
}

async function unknownValuesAreWithdrawnOnce(): Promise<void> {
  let deleteAnswer: HttpResponse = httpResponse(500, "busy");
  const network = recordingFetcher((request: GRequest): HttpResponse => {
    if (request.url.startsWith(ORION) && request.method === "DELETE") return deleteAnswer;
    return httpResponse(204);
  });
  const { ctx } = rig(registryEntry("wetter-bw"), network.fetcher);
  const deletes = (): number => network.seen.filter((request) => request.method === "DELETE").length;
  const url = `${ORION}/ngsi-ld/v1/entities/${encodeURIComponent(ID)}/attrs/temperature`;

  // The withdrawal fails: the attribute is still left out, and tried again next time.
  let [sent] = await withdrawNulls(ctx, [weather(null)], "test");
  assert.ok(sent !== undefined && !("temperature" in sent) && "windSpeed" in sent);
  assert.equal(deletes(), 1);
  assert.equal(network.seen[0]?.url, url);
  deleteAnswer = jsonHttp(404, { type: "https://uri.etsi.org/ngsi-ld/errors/ResourceNotFound" });
  await withdrawNulls(ctx, [weather(null)], "test");
  assert.equal(deletes(), 2);
  // Withdrawn: not again while it stays unknown.
  await withdrawNulls(ctx, [weather(null)], "test");
  assert.equal(deletes(), 2);
  // A value again: written, and the next unknown is withdrawn again.
  [sent] = await withdrawNulls(ctx, [weather(7)], "test");
  assert.ok(sent !== undefined && "temperature" in sent);
  assert.equal(deletes(), 2);
  deleteAnswer = httpResponse(204);
  await withdrawNulls(ctx, [weather(null)], "test");
  assert.equal(deletes(), 3);
}

export {
  splitIsPure as "null values: only top-level null-valued attributes are dropped",
  unknownValuesAreWithdrawnOnce as "null values: left out, and withdrawn from the broker once while unknown",
};
