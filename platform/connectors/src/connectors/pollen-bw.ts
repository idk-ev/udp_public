/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `pollen-bw` — DWD pollen-flight hazard index for the three
 * Baden-Württemberg part-regions.
 *
 * Port of FN_POLLEN (`udp-rt-po-fn`) from the former Node-RED flow generator (see git history):
 * DWD `s31fg.json` in, one `PollenForecast:bw-region-<id>` per BW part-region
 * out. The worked example of the parity harness (phase 2); `parseDwdPollen`,
 * `REGION_KREISE` and `build` were written in test/parity/pollen-bw.test.ts
 * and moved here unchanged, fitted to the module contract.
 *
 * Worth knowing: the order of the species within `arten` comes from the ORDER
 * OF THE KEYS in the DWD response and differs from part-region to part-region.
 * The old node reads it via `Object.keys()`, so this one does as well. A fixed
 * species list would be tidier and would fail the parity test.
 *
 * Deliberate differences from the old node. The first changes output:
 *
 *  * 08335 (Landkreis Konstanz) is mapped to part-region 112. The old mapping
 *    had 43 of the 44 districts and left it out, so the Konstanz pages showed
 *    no pollen. Region per the DWD region polygons (GeoServer layer
 *    `dwd:Pollenfluggebiete`): 23 of the district's 25 municipality centres lie
 *    in 112 "Hohenlohe/mittlerer Neckar/Oberschwaben", the other two in the
 *    lake, none in 111 or 113 — as its neighbour 08435 Bodenseekreis.
 *
 * The other two only concern input the source does not produce:
 *
 *  * `parse` gets loud on a malformed response. The old node would put
 *    `undefined` into the position array for a species without `today`, and
 *    would fail outright on a species that is not an object. Getting loud is
 *    thus closer to it than silently skipping.
 *  * The mapping part-region -> district lives in a `Map`, not in an object
 *    literal. `REGION_KREISE["constructor"]` would find something on an object
 *    literal; a `Map` would not.
 *
 * No change gate and no chunking: three entities, written in full in one
 * request twice a day (cron `15 07,12 * * *`), as the old upsert node did.
 */

import { field, isArray, isRecord } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "pollen-bw";

export const SOURCE_URL = "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json";

const DATA_PROVIDER = "DWD Pollenflug-Gefahrenindex (GeoNutzV)";

/**
 * One species in the forecast — position array, exactly as the old node emits
 * it. The names of the tuple elements are what used to be a comment.
 */
export type SpeciesForecast = readonly [species: string, today: string, tomorrow: string];

export interface PartRegion {
  /** DWD part-region id as a string; the key of the district mapping. */
  readonly id: string;
  readonly name: string;
  readonly species: readonly SpeciesForecast[];
}

export interface PollenForecastEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:PollenForecast:bw-region-${string}`;
  readonly type: "PollenForecast";
  readonly name: Property<string>;
  readonly kreise: Property<readonly string[]>;
  readonly arten: {
    readonly type: "Property";
    readonly value: readonly SpeciesForecast[];
    readonly observedAt: IsoTime;
  };
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
}

/**
 * Curated district mapping of the three Baden-Württemberg part-regions
 * (111 Oberrhein/unteres Neckartal, 112 Hohenlohe/mittlerer Neckar/Oberschwaben,
 * 113 Mittelgebirge). `POLLEN_REGION` of the former Node-RED flow generator
 * (see git history) plus 08335 (see above); every other difference would show
 * up as a parity failure in `kreise`. All 44 BW districts, each once.
 *
 * As blank-separated strings, not as arrays of literals: 44 district keys one
 * per line is what Prettier makes of the latter, and that buries the mapping.
 */
const REGION_KREISE = new Map<string, readonly string[]>([
  ["111", "08211 08212 08215 08216 08221 08222 08226 08311 08315 08316 08317 08336".split(" ")],
  [
    "112",
    "08111 08115 08116 08117 08118 08119 08121 08125 08126 08127 08128 08135 08136 08231 08236 08335 08415 08416 08421 08425 08426 08435 08436 08437".split(
      " ",
    ),
  ],
  ["113", "08225 08235 08237 08325 08326 08327 08337 08417".split(" ")],
]);

/** External data enters as `unknown` and is narrowed, never asserted. */
export function parse(raw: unknown): readonly PartRegion[] {
  if (!isRecord(raw)) throw new Error("DWD pollen: response is not a JSON object");
  const content = raw.content;
  if (!Array.isArray(content)) throw new Error('DWD pollen: field "content" is not an array');

  const regions: PartRegion[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) throw new Error("DWD pollen: entry in content is not an object");
    const id = String(entry.partregion_id);
    const name = entry.partregion_name;
    if (typeof name !== "string") {
      throw new Error(`DWD pollen: part-region ${id} has no "partregion_name"`);
    }
    const pollen = entry.Pollen;
    const species: SpeciesForecast[] = [];
    if (isRecord(pollen)) {
      for (const [key, value] of Object.entries(pollen)) {
        if (!isRecord(value)) throw new Error(`DWD pollen: species "${key}" in ${id} is not an object`);
        const today = value.today;
        const tomorrow = value.tomorrow;
        if (typeof today !== "string" || typeof tomorrow !== "string") {
          throw new Error(`DWD pollen: species "${key}" in ${id} has no today/tomorrow`);
        }
        species.push([key, today, tomorrow]);
      }
    }
    regions.push({ id, name, species });
  }
  return regions;
}

/**
 * Transformation as a pure function: raw data and a timestamp in, entities out.
 * No network, no clock, no global state — that is what makes it comparable
 * against the old Node-RED code in the first place.
 */
export function build(
  raw: readonly PartRegion[],
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly PollenForecastEntity[] {
  const entities: PollenForecastEntity[] = [];
  for (const region of raw) {
    const kreise = REGION_KREISE.get(region.id);
    if (kreise === undefined) continue;
    entities.push({
      id: `urn:ngsi-ld:PollenForecast:bw-region-${region.id}`,
      type: "PollenForecast",
      name: { type: "Property", value: region.name },
      kreise: { type: "Property", value: kreise },
      arten: { type: "Property", value: region.species, observedAt: now },
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      "@context": NGSI_CONTEXT,
    });
  }
  return entities;
}

export async function run(ctx: Ctx): Promise<void> {
  const response = await ctx.fetch.json(SOURCE_URL);
  // `if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.content))`
  if (!response.ok || !isArray(field(response.body, "content"))) {
    ctx.log.warn(`DWD pollen: no data (HTTP ${String(response.status)})`);
    return;
  }
  const entities = build(parse(response.body), null, ctx.now());
  if (entities.length === 0) {
    ctx.log.warn("DWD pollen: no BW part-regions");
    return;
  }
  ctx.log.status(`${String(entities.length)} part-regions`);
  const result = await ctx.orion.upsert(ctx.gate.ungated(entities));
  ctx.log.info(
    `${String(result.entities)} PollenForecast upserted (${String(result.failedChunks)} chunks failed)`,
  );
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly PartRegion[], readonly PollenForecastEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
