/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The `msg.payload` an old `http request` node with `ret: "obj"` handed to its
 * function node — shared by the ports of group G (`efa-abfahrten`,
 * `abfahrten-on-demand`, `hystreet`, `wetter-dwd-station`), whose function
 * nodes all decide on that value rather than on a parsed body.
 *
 * Why not `ctx.fetch.json`: that throws a `JsonParseError` on a body that is not
 * JSON. The http request node did not — it left the text in `msg.payload` and
 * the function node's own guard (`!Array.isArray(msg.payload.stopEvents)`,
 * `!msg.payload.weather`, …) turned it into the warning or the 502. Keeping the
 * text reproduces exactly those branches.
 */

import { isBoolean, isFiniteNumber, isString } from "../kernel/parse.js";
import type { HttpResponse } from "../kernel/types.js";

/** Parsed JSON body, or the body text when it is not JSON (`ret: "obj"`). */
export function nodePayload(response: HttpResponse): unknown {
  try {
    const parsed: unknown = JSON.parse(response.body);
    return parsed;
  } catch {
    return response.body;
  }
}

/**
 * Short rendering of a failed request for a warning line — what the old nodes
 * printed as `msg.statusCode` after a transport error (`ECONNREFUSED`, …).
 * One line, no stack: the health check counts lines.
 */
export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "request failed";
}

/** A JSON leaf, as the old nodes concatenated or copied it into an attribute. */
export type Scalar = string | number | boolean;

export function scalar(value: unknown): Scalar | undefined {
  return isString(value) || isFiniteNumber(value) || isBoolean(value) ? value : undefined;
}
