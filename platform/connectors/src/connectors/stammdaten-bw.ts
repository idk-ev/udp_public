/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `stammdaten-bw` — municipality master data of Baden-Württemberg.
 *
 * Port of FN_MUNI from scripts/generate-nodered-flows.py. Reads
 * `bw-gemeinden.json` (built by scripts/generate-bw-municipalities.py from
 * opendatasoft georef plus Wikidata, served by the cockpit), writes one
 * `Municipality` entity per municipality and — the part everything else depends
 * on — puts the rows into the geo context.
 *
 * This connector and `grenzen-bw` are in phase 1 rather than phase 3 for that
 * second reason: `global.set('bwGemeinden', …)` is what twenty other connectors
 * read before they can assign a coordinate to a municipality.
 *
 * The change gate matters here more than anywhere else. The original says why:
 *
 *   > Stammdaten ändern sich fast nie. Ohne Gate schrieb jeder Node-RED-Neustart
 *   > alle 1.103 Gemeinden neu (Restart-Refire, ~7,7k Zeilen/Deploy).
 *
 * Note that the gate runs in MERGE mode although this connector does see the
 * whole stock in one run and could therefore use `replace: true`. That is not an
 * oversight but the ported behaviour: FN_MUNI calls `gateChanged` without
 * options. The leak it implies — a municipality removed from the source keeping
 * its signature row forever — is bounded by the 1,103 rows of the file and is
 * not worth deviating for before parity is green.
 */

import {
  ParseError,
  isArray,
  optNumber,
  optString,
  requireArray,
  requireNumber,
  requireRecord,
  requireString,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  MunicipalitiesFile,
  MunicipalityRow,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "stammdaten-bw";

/** Served by the cockpit; overridable so a dev run can point at a local build. */
export const DEFAULT_URL = "http://cockpit/bw-gemeinden.json";

/** As FN_MUNI: `emitChunks(node, msg, geaendert, 150)`. */
const CHUNK_SIZE = 150;

/** Store key of the change gate, unchanged from the flow (`'muniSig'`). */
const GATE_KEY = "muniSig";

/**
 * Column `typ` spelled out. German on purpose: these are attribute VALUES that
 * end up in Orion-LD and on the municipality pages, not log or code text.
 */
const MUNICIPALITY_TYPE: Readonly<Record<string, string>> = {
  S: "Stadt",
  G: "Gemeinde",
  F: "gemeindefreies Gebiet",
};

export interface MunicipalityEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:Municipality:bw-${string}`;
  readonly type: "Municipality";
  readonly name: Property<string>;
  readonly ags: Property<string>;
  readonly kreisCode: Property<string>;
  readonly municipalityType: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
  readonly population?: Property<number> | undefined;
  readonly dashboardUrl?: Property<string> | undefined;
}

/**
 * The apostrophe swap of the original: `String(s == null ? '' : s).replace(/'/g,
 * '’')`. It exists because the entity text used to be spliced into generated
 * JavaScript, where a straight quote closed the string early. The typographic
 * apostrophe is now part of the stored data, so it stays — dropping it would
 * rewrite 1,103 names and produce a diff against the old runtime on the first
 * run.
 */
function clean(value: string | null): string {
  return (value ?? "").replace(/'/g, "’");
}

function parseRow(raw: unknown, index: number): MunicipalityRow {
  const at = `gemeinden[${String(index)}]`;
  const row = requireArray(raw, at);
  // Eight columns are the documented minimum; the ninth (slug) has been in the
  // file since the municipality pages (F2) and is read by carsharing-bw and
  // ladesaeulen-bw via g[8].
  if (row.length < 8) throw new ParseError(at, "at least 8 columns", raw);
  return [
    requireString(row[0], `${at}[0] ags`),
    requireString(row[1], `${at}[1] name`),
    requireNumber(row[2], `${at}[2] lat`),
    requireNumber(row[3], `${at}[3] lon`),
    requireString(row[4], `${at}[4] kreisCode`),
    requireString(row[5], `${at}[5] municipalityType`),
    optNumber(row[6]) ?? null,
    optString(row[7]) ?? null,
    optString(row[8]) ?? "",
  ];
}

/**
 * Strict, unlike the sources of phase 3: `bw-gemeinden.json` is this project's
 * own build artefact. A malformed row there is a generator bug and should be
 * loud, not silently skipped.
 */
export function parse(raw: unknown): MunicipalitiesFile {
  const payload = requireRecord(raw, "payload");
  const rows = payload.gemeinden;
  if (!isArray(rows)) throw new ParseError("payload.gemeinden", "array", rows);
  return {
    stand: optString(payload.stand) ?? "",
    quelle: optString(payload.quelle) ?? "",
    gemeinden: rows.map(parseRow),
  };
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(
  raw: MunicipalitiesFile,
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly MunicipalityEntity[] {
  return raw.gemeinden.map((row) => {
    const [ags, name, lat, lon, kreisCode, typ, population, dashboardUrl] = row;
    return {
      id: `urn:ngsi-ld:Municipality:bw-${ags}`,
      type: "Municipality",
      name: { type: "Property", value: clean(name) },
      ags: { type: "Property", value: ags },
      kreisCode: { type: "Property", value: kreisCode },
      municipalityType: { type: "Property", value: MUNICIPALITY_TYPE[typ] ?? typ },
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
      // GeoJSON order: longitude before latitude, the columns the other way round.
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
      // `if (ew)` / `if (url)` in the original: a population of 0 and an empty
      // URL are omitted just as null is.
      ...(population !== null && population !== 0
        ? { population: { type: "Property", value: population, unitCode: "C62" } }
        : {}),
      ...(dashboardUrl !== null && dashboardUrl !== ""
        ? { dashboardUrl: { type: "Property", value: dashboardUrl } }
        : {}),
    };
  });
}

/**
 * Signature over the fields that actually change: name, population, district and
 * dashboard URL. Not `dateObserved` — that is the whole point of the gate.
 */
export function signatureOf(entity: MunicipalityEntity): string {
  const population = entity.population === undefined ? "" : String(entity.population.value);
  const url = entity.dashboardUrl === undefined ? "" : entity.dashboardUrl.value;
  return `${entity.name.value}|${population}|${entity.kreisCode.value}|${url}`;
}

export async function run(ctx: Ctx): Promise<void> {
  const url = ctx.env.get("UDP_MUNICIPALITIES_URL") ?? DEFAULT_URL;
  const response = await ctx.fetch.json(url);
  if (!response.ok) {
    // Same diagnosis as the original: the file is produced by the GUI build, so
    // a 404 here almost always means the build did not run.
    ctx.log.warn(`bw-gemeinden.json not loadable (HTTP ${String(response.status)}) — GUI build missing?`);
    return;
  }

  const file = parse(response.body);

  // Before the gate, as in the flow: the geo context has to be filled even in a
  // run where nothing changed, or every connector that depends on it stalls
  // until the master data happen to change.
  ctx.geo.setMunicipalities(file.gemeinden);

  const entities = build(file, ctx.geo.index(), ctx.now());
  ctx.log.status(`${String(entities.length)} municipalities`);

  const changed = ctx.gate.gateChanged(GATE_KEY, entities, signatureOf);
  if (changed.length === 0) {
    ctx.log.status(`unchanged (${String(entities.length)})`);
    return;
  }
  const result = await ctx.orion.upsert(changed, { chunkSize: CHUNK_SIZE });
  ctx.log.info(
    `${String(changed.length)} of ${String(entities.length)} municipalities upserted in ` +
      `${String(result.chunks)} chunks (${String(result.failedChunks)} failed)`,
  );
}

/**
 * The annotation is the point: the compiler, not a review, checks this module
 * against the contract in src/kernel/types.ts. A port that does not fit falls
 * through at build time, before a human reads its first line.
 */
export const connector: ConnectorModule<MunicipalitiesFile, readonly MunicipalityEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
