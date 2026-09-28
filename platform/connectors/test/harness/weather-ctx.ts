/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test helpers of the weather group (`wetter-bw`, `vorhersage-bw`, `pollen-bw`,
 * `hitze-bw`): a real `Ctx` over a scripted network, and the old Open-Meteo node
 * chain (batch -> wrap -> join -> build) replayed in the vm.
 *
 * The kernel services are the real ones (Orion client, change gate, geo store,
 * rate limiter) — only the network edge is replaced, as in test/harness/kernel.ts.
 * Unlike `scriptedFetcher`, the fetcher here records the options of every call
 * (pacing, timeout, retries are behaviour of these connectors) and can hold an
 * answer back, which is how a test drives the join into its timeout.
 */

import { SignatureStore } from "../../src/kernel/change-gate.js";
import { StateStore } from "../../src/kernel/state.js";
import { createCtx } from "../../src/kernel/context.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { createRegistry, loadRegistry, resolveRegistryPath } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import type { Ctx, Fetcher, FetchOptions, HttpResponse, JsonResponse } from "../../src/kernel/types.js";
import { isArray } from "../../src/kernel/parse.js";
import { recordingLog } from "./kernel.js";
import type { RecordedLog } from "./kernel.js";
import { isRecord } from "./normalize.js";
import { messagesOf, runFunctionNode } from "./vm-runner.js";

/* ------------------------------------------------------------------ network */

export interface SeenCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly options: FetchOptions | undefined;
}

/** An answer, optionally held back for `delayMs`; an `Error` makes the call throw. */
export interface ScriptedAnswer {
  readonly response: HttpResponse | Error;
  readonly delayMs?: number;
}

export function jsonAnswer(status: number, body: unknown, delayMs = 0): ScriptedAnswer {
  return {
    response: { status, ok: status >= 200 && status < 300, headers: {}, body: JSON.stringify(body) },
    delayMs,
  };
}

async function hold(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function weatherFetcher(respond: (call: SeenCall) => ScriptedAnswer): {
  readonly fetcher: Fetcher;
  readonly seen: SeenCall[];
} {
  const seen: SeenCall[] = [];
  const text = async (url: string, options?: FetchOptions): Promise<HttpResponse> => {
    const call: SeenCall = { url, method: options?.method ?? "GET", body: options?.body, options };
    seen.push(call);
    const answer = respond(call);
    await hold(answer.delayMs ?? 0);
    if (answer.response instanceof Error) throw answer.response;
    return answer.response;
  };
  const fetcher: Fetcher = {
    text,
    json: async (url: string, options?: FetchOptions): Promise<JsonResponse> => {
      const response = await text(url, options);
      if (!response.ok) return { status: response.status, ok: false, body: null };
      const body: unknown = JSON.parse(response.body);
      return { status: response.status, ok: true, body };
    },
  };
  return { fetcher, seen };
}

/** Upserted entities, in request order — the bodies of the POSTs to Orion. */
export function upsertedBatches(seen: readonly SeenCall[]): unknown[][] {
  return seen
    .filter((call) => call.method === "POST" && call.url.includes("/entityOperations/upsert"))
    .map((call) => {
      const parsed: unknown = JSON.parse(call.body ?? "[]");
      return isArray(parsed) ? [...parsed] : [];
    });
}

export const MUNICIPALITIES_URL = "http://cockpit:8080/bw-gemeinden.json";
export const OPEN_METEO_PREFIX = "https://api.open-meteo.com/";

/**
 * The network of an Open-Meteo run: `bw-gemeinden.json` from the cockpit, the
 * batch calls (answered by `openMeteo(index)` in request order) and the
 * upserts towards Orion (204).
 */
export function openMeteoNetwork(
  municipalities: unknown,
  openMeteo: (index: number) => ScriptedAnswer,
  gemeinden?: ScriptedAnswer,
): { readonly fetcher: Fetcher; readonly seen: SeenCall[] } {
  let calls = 0;
  return weatherFetcher((call) => {
    if (call.url === MUNICIPALITIES_URL) return gemeinden ?? jsonAnswer(200, municipalities);
    if (call.url.startsWith(OPEN_METEO_PREFIX)) {
      calls += 1;
      return openMeteo(calls - 1);
    }
    if (call.method === "POST" && call.url.includes("/entityOperations/upsert")) {
      return { response: { status: 204, ok: true, headers: {}, body: "" } };
    }
    return { response: new Error(`unexpected call ${call.method} ${call.url}`) };
  });
}

export function openMeteoCalls(seen: readonly SeenCall[]): SeenCall[] {
  return seen.filter((call) => call.url.startsWith(OPEN_METEO_PREFIX));
}

/* ------------------------------------------------------------------ ctx */

export interface TestCtx {
  readonly ctx: Ctx;
  readonly kernel: Kernel;
  readonly log: RecordedLog;
}

/**
 * A `Ctx` for the registry entry `id` of platform/config/connectors.json, over
 * the given fetcher. Nothing listens and nothing is scheduled: the HTTP servers
 * and the scheduler are only constructed, never started.
 */
export function weatherCtx(id: string, fetcher: Fetcher): TestCtx {
  const registry = loadRegistry(resolveRegistryPath());
  const entry = registry.byId(id);
  if (entry === undefined) throw new Error(`registry has no connector "${id}"`);
  const log = recordingLog();
  const env = createEnv();
  const kernel: Kernel = {
    log,
    env,
    limiter: createRateLimiter(log),
    fetch: fetcher,
    orionUrl: "http://orion-ld:1026",
    signatures: new SignatureStore(),
    state: new StateStore(),
    geo: createSharedGeo(log),
    registry: createRegistry([entry]),
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: Date.now,
  };
  return { ctx: createCtx(kernel, entry), kernel, log };
}

/**
 * Runs `work` with the process time zone set to `zone`. Node applies a runtime
 * change of `process.env.TZ` to `Date` (and so to `getHours()` inside the vm,
 * which shares the host's `Date`) — the old nodes ran with `TZ=Europe/Berlin`.
 */
export async function withTimeZone<T>(zone: string, work: () => Promise<T> | T): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/* ------------------------------------------------------------------ old chain */

export interface LegacyBatch {
  readonly msg: Record<string, unknown>;
  readonly url: string;
  readonly agsList: readonly string[];
}

/** Runs the old batch node and returns the messages it emitted (one per batch). */
export async function legacyBatches(
  nodeId: string,
  msg: Record<string, unknown>,
): Promise<{ batches: LegacyBatch[]; warnings: readonly string[]; global: ReadonlyMap<string, unknown> }> {
  const run = await runFunctionNode(nodeId, { msg });
  const batches: LegacyBatch[] = [];
  for (const message of messagesOf(run)) {
    if (!isRecord(message)) continue;
    const url = message.url;
    const agsList = message.agsList;
    if (typeof url !== "string" || !Array.isArray(agsList)) continue;
    batches.push({ msg: message, url, agsList: agsList.map(String) });
  }
  return { batches, warnings: run.warnings, global: run.global };
}

/**
 * Runs the old wrap node on one batch message with the given answer, as the
 * `http request` node would have handed it on, and returns the wrapped payload
 * (the element the join collects).
 */
export async function legacyWrap(
  nodeId: string,
  batch: LegacyBatch,
  statusCode: number | string,
  payload: unknown,
): Promise<{ payload: unknown; warnings: readonly string[] }> {
  const run = await runFunctionNode(nodeId, {
    msg: { ...batch.msg, statusCode, payload: structuredClone(payload) },
  });
  const [message] = messagesOf(run);
  return { payload: isRecord(message) ? message.payload : undefined, warnings: run.warnings };
}

/**
 * Runs the old build node on a joined array and returns the upsert chunks it
 * emitted (their payloads), its warnings and its status.
 */
export async function legacyBuild(
  nodeId: string,
  joined: readonly unknown[],
): Promise<{ chunks: unknown[][]; warnings: readonly string[]; status: readonly unknown[] }> {
  const run = await runFunctionNode(nodeId, { msg: { _msgid: "parity", payload: structuredClone(joined) } });
  const chunks = messagesOf(run).map((message) => {
    const payload = isRecord(message) ? message.payload : undefined;
    return isArray(payload) ? [...payload] : [];
  });
  return { chunks, warnings: run.warnings, status: run.status };
}

/** What the `http request` node handed to the wrap node. */
export interface LegacyAnswer {
  /** A number, or the error code (`'ECONNRESET'`) for a network error. */
  readonly statusCode: number | string;
  readonly payload: unknown;
}

/**
 * The old chain after the batch node: every batch's answer through the wrap
 * node, the wrapped parts joined in `order` (the join's arrival order), the
 * joined array through the build node.
 */
export async function legacyChain(
  nodes: { readonly wrap: string; readonly build: string },
  batches: readonly LegacyBatch[],
  answers: readonly LegacyAnswer[],
  order: readonly number[],
): Promise<{ chunks: unknown[][]; warnings: readonly string[]; wrapWarnings: readonly string[] }> {
  const joined: unknown[] = [];
  const wrapWarnings: string[] = [];
  for (const index of order) {
    const batch = batches[index];
    const answer = answers[index];
    if (batch === undefined || answer === undefined) throw new Error(`no batch/answer ${String(index)}`);
    const wrapped = await legacyWrap(nodes.wrap, batch, answer.statusCode, answer.payload);
    joined.push(wrapped.payload);
    wrapWarnings.push(...wrapped.warnings);
  }
  const built = await legacyBuild(nodes.build, joined);
  return { chunks: built.chunks, warnings: built.warnings, wrapWarnings };
}

/**
 * Splits one recorded multi-location Open-Meteo answer along the batches:
 * Open-Meteo answers location by location in request order, so slice `k` is
 * what the call for batch `k` returns. A batch of ONE location gets the bare
 * object, as Open-Meteo answers a call with a single coordinate.
 */
export function splitAnswer(
  recorded: unknown,
  batches: readonly { readonly agsList: readonly unknown[] }[],
): unknown[] {
  if (!Array.isArray(recorded)) throw new Error("recorded Open-Meteo answer is not an array");
  const out: unknown[] = [];
  let offset = 0;
  for (const batch of batches) {
    const slice: unknown[] = recorded.slice(offset, offset + batch.agsList.length);
    offset += batch.agsList.length;
    out.push(slice.length === 1 ? slice[0] : slice);
  }
  if (offset !== recorded.length) {
    throw new Error(`batches cover ${String(offset)} locations, the recording ${String(recorded.length)}`);
  }
  return out;
}
