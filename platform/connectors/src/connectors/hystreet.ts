/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `hystreet` — pedestrian frequency of Reutlingen's Wilhelmstraße
 * (hystreet.com) as a `PedestrianFlowObserved` entity.
 *
 * Port of FN_HY_GUARD, FN_HY_FIND and FN_HY_BUILD in
 * scripts/generate-nodered-flows.py. Prepared, not live: the connector only
 * runs once `HYSTREET_API_TOKEN` is set (free registration). Without it a run
 * ends in a status line — no warning, so an instance that never configured the
 * token does not show up in the health check every hour. An EMPTY variable
 * counts as unset: docker-compose passes `${HYSTREET_API_TOKEN:-}` through as
 * "" (src/kernel/env.ts), and the flow's `if (!token)` treated it the same.
 *
 * Three requests per run, as before: the location list, the Reutlingen entry
 * found in it, its detail. The first match wins — FN_HY_FIND searched the
 * serialised entry for "reutlingen", not a field, because the list format was
 * never confirmed against a live answer; that search is kept verbatim.
 *
 * ## Deliberate deviations
 *
 *  * Requests go through the kernel's per-host bucket (hystreet.com, one per
 *    second); the old http request nodes were unpaced. No retries, as before.
 *  * Malformed data only: a `data` member that is not an array counts as an
 *    empty list (the old node threw on `.find`), a location id or name that is
 *    not a scalar counts as absent.
 *  * One write per run through `ctx.orion.upsert` — ungated, as the old
 *    `upsert` node had no commit node behind it.
 *  * Warning texts are English (the code language of this service).
 *  * Security review: redirects are refused (`redirect: "error"` — the token
 *    must not follow a `Location`; the node followed), the location id is
 *    URL-encoded as a path segment, and a `__proto__` key in the detail
 *    stays a key.
 */

import { cleanText, dateObserved } from "../kernel/ngsi.js";
import {
  field,
  isArray,
  isBoolean,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  nullPrototypeRecord,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  HttpResponse,
  IsoTime,
  JsonObject,
  JsonValue,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import { failureText, nodePayload, scalar } from "./http-payload.js";
import type { Scalar } from "./http-payload.js";

export const ID = "hystreet";

/** The secret named by the registry's `requiresSecret`. */
export const TOKEN_ENV = "HYSTREET_API_TOKEN";

export const LOCATIONS_URL = "https://hystreet.com/api/locations";

export const ENTITY_ID = "urn:ngsi-ld:PedestrianFlowObserved:reutlingen-wilhelmstrasse";

/** Fixed point of the counter in the Wilhelmstraße, as in the original. */
const LOCATION: GeoJsonPoint = { type: "Point", coordinates: [9.2109, 48.4926] };

const DEFAULT_NAME = "Wilhelmstraße";

/** The headers both old http request nodes were given through `msg.headers`. */
export function requestHeaders(token: string): Readonly<Record<string, string>> {
  return { "X-API-Token": token, "Content-Type": "application/vnd.hystreet.v2" };
}

/** What FN_HY_BUILD reads of a location detail. */
export interface HystreetLocation {
  readonly name: Scalar | undefined;
  /** `statistics.today_count`, any JSON value but `null`. */
  readonly todayCount: JsonValue | undefined;
  /** `statistics.last_hour_count`, any JSON value but `null`. */
  readonly lastHourCount: JsonValue | undefined;
}

export interface PedestrianFlowEntity extends NgsiEntity {
  readonly id: typeof ENTITY_ID;
  readonly type: "PedestrianFlowObserved";
  readonly name: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
  readonly dailyTotal?: Property | undefined;
  readonly pedestrianCount?: Property | undefined;
}

/** A value that came out of `JSON.parse`, checked as such. */
function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || isString(value) || isFiniteNumber(value) || isBoolean(value)) return value;
  if (isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const checked = jsonValue(item);
      if (checked === undefined) return undefined;
      items.push(checked);
    }
    return items;
  }
  if (isRecord(value)) {
    // Keys come from the source: a `__proto__` key must stay a key (see nullPrototypeRecord).
    const out = nullPrototypeRecord<JsonValue>();
    for (const [key, item] of Object.entries(value)) {
      const checked = jsonValue(item);
      if (checked === undefined) return undefined;
      out[key] = checked;
    }
    const object: JsonObject = out;
    return object;
  }
  return undefined;
}

/** `stats.x != null` of the original: present unless null or missing. */
function count(value: unknown): JsonValue | undefined {
  return value === null ? undefined : jsonValue(value);
}

/**
 * FN_HY_FIND: the id of the first entry whose serialisation mentions
 * Reutlingen, as the text the URL is built from; `null` if there is none.
 */
export function findLocation(payload: unknown): string | null {
  const data = isArray(payload) ? payload : field(payload, "data");
  const list = isArray(data) ? data : [];
  const location = list.find((entry) => JSON.stringify(entry).toLowerCase().includes("reutlingen"));
  const id = scalar(field(location, "id"));
  return id !== undefined && isTruthy(id) ? String(id) : null;
}

/** Encoded as a path segment; the numeric ids hystreet hands out stay byte-identical. */
export function locationUrl(id: string): string {
  return `${LOCATIONS_URL}/${encodeURIComponent(id)}`;
}

/** `const d = msg.payload.data || msg.payload; const stats = d.statistics || {};` */
export function parse(raw: unknown): HystreetLocation {
  const data = field(raw, "data");
  const detail = isTruthy(data) ? data : raw;
  const statistics = field(detail, "statistics");
  return {
    name: scalar(field(detail, "name")),
    todayCount: count(field(statistics, "today_count")),
    lastHourCount: count(field(statistics, "last_hour_count")),
  };
}

/** Pure: the one entity, or none when neither count is present (unknown format). */
export function build(
  raw: HystreetLocation,
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly PedestrianFlowEntity[] {
  if (raw.todayCount === undefined && raw.lastHourCount === undefined) return [];
  return [
    {
      id: ENTITY_ID,
      type: "PedestrianFlowObserved",
      name: { type: "Property", value: cleanText(isTruthy(raw.name) ? raw.name : DEFAULT_NAME) },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: "hystreet.com" },
      location: { type: "GeoProperty", value: LOCATION },
      "@context": NGSI_CONTEXT,
      ...(raw.todayCount === undefined
        ? {}
        : { dailyTotal: { type: "Property", value: raw.todayCount, unitCode: "C62", observedAt: now } }),
      ...(raw.lastHourCount === undefined
        ? {}
        : {
            pedestrianCount: { type: "Property", value: raw.lastHourCount, unitCode: "C62", observedAt: now },
          }),
    },
  ];
}

/** The payload of a GET, or `null` with the status the old guard printed. */
async function load(ctx: Ctx, url: string, token: string): Promise<{ payload: unknown; status: string }> {
  let response: HttpResponse;
  try {
    // Never follow a redirect: the token would travel to wherever it points.
    response = await ctx.fetch.text(url, { headers: requestHeaders(token), retries: 0, redirect: "error" });
  } catch (error) {
    return { payload: null, status: failureText(error) };
  }
  // `msg.statusCode >= 400 || !msg.payload`
  const payload = response.status >= 400 ? null : nodePayload(response);
  return { payload: isTruthy(payload) ? payload : null, status: String(response.status) };
}

export async function run(ctx: Ctx): Promise<void> {
  const token = ctx.env.get(TOKEN_ENV);
  if (token === undefined) {
    ctx.log.status("inactive (no token)");
    return;
  }

  const list = await load(ctx, LOCATIONS_URL, token);
  if (list.payload === null) {
    ctx.log.warn(`hystreet: location list failed (${list.status})`);
    return;
  }
  const id = findLocation(list.payload);
  if (id === null) {
    ctx.log.warn("hystreet: no Reutlingen location found");
    return;
  }

  const detail = await load(ctx, locationUrl(id), token);
  if (detail.payload === null) {
    ctx.log.warn(`hystreet: detail request failed (${detail.status})`);
    return;
  }
  const entities = build(parse(detail.payload), null, ctx.now());
  if (entities.length === 0) {
    ctx.log.warn("hystreet: unknown response format — check the field names");
    return;
  }
  await ctx.orion.upsert(ctx.gate.ungated(entities));
}

export const connector: ConnectorModule<HystreetLocation, readonly PedestrianFlowEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
