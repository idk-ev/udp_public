/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Runs an OLD Node-RED function node out of `flows.json` in `node:vm`.
 *
 * This is the half of the parity harness that makes the migration divisible at
 * all: without it "the rewrite is correct" stays an opinion. The old connector
 * logic is a JavaScript string inside a 442 KB generated JSON — not callable,
 * not testable, and that is precisely why the ParkAPI incident of 24.08.2026
 * wrote roughly 1.04 million rows a day for a month unnoticed.
 *
 * ## How faithful the sandbox is
 *
 * Node-RED 4.1 (`@node-red/nodes/core/function/10-function.js`) does
 * `vm.createContext(sandbox)` and wraps the node body in an async function. The
 * wrapper below is that same wrapper, and the sandbox carries the same names.
 * That matters in both directions:
 *
 *  * A fresh vm context has almost NO Node globals. Verified on Node 22.22:
 *    `console`, `Intl` and `WebAssembly` are there; `setTimeout`, `Buffer`,
 *    `URL`, `process`, `structuredClone`, `queueMicrotask`, `crypto` and — the
 *    important one — `fetch` are NOT. Whatever the node is to see has to be put
 *    in here explicitly. `udp-rt-bp-fetch` documents exactly this in its own
 *    header and therefore uses `node:https` plus `node:zlib` through its `libs`
 *    declaration.
 *  * `fetch` is deliberately absent. A ported module that reaches for the
 *    network would fail on this side, and it should.
 *
 * Deliberately NOT replicated, because no node in `flows.json` needs it (each
 * checked against all 84 function nodes):
 *
 *  * `RED.util` beyond `cloneMessage` — no node uses `RED.`.
 *  * Nested context keys (`flow.get("a.b")` resolves an object path in
 *    Node-RED). Every key used is flat; the dynamic ones are
 *    `'oepnvSig:' + entity id` and contain no dot either.
 *  * The `timeout` field of the function node (empty everywhere) — this runner
 *    brings its own timeout, so a hanging node fails instead of hanging.
 *  * Node-RED's stack rewriting. Instead `lineOffset: -1` makes a thrown error
 *    report the line number of the node body directly.
 *  * Message cloning between nodes. A parity test passes a single message and
 *    `messageFromFixture()` already clones the payload.
 *
 * One deviation for the sake of the typing: Node-RED assigns the async IIFE to
 * `var results` and awaits it in the runtime. Here the IIFE gets a `.then()`
 * onto a host callback pair instead. That keeps the result on this side as
 * plain `unknown` — no `await` on an untyped value, no assertion, no hole in
 * the type discipline.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, Script } from "node:vm";
import util from "node:util";
import { flowsPath } from "./fixtures.js";
import { isRecord } from "./normalize.js";

export interface FunctionNodeLib {
  /** Name the module is bound to inside the sandbox. */
  readonly var: string;
  /** Module specifier Node-RED would require. */
  readonly module: string;
}

export interface FunctionNodeDefinition {
  readonly id: string;
  readonly name: string;
  /** The node body verbatim — the code this harness exists for. */
  readonly func: string;
  readonly outputs: number;
  readonly libs: readonly FunctionNodeLib[];
}

/** Core modules the flows declare in their `libs`; extend via `allowModules`. */
const ALLOWED_MODULES = new Map<string, string>([
  ["https", "node:https"],
  ["zlib", "node:zlib"],
  ["pg", "pg"],
]);

const DEFAULT_TIMEOUT_MS = 15_000;

const requireModule = createRequire(import.meta.url);
const flowsCache = new Map<string, readonly unknown[]>();

function readFlows(file: string): readonly unknown[] {
  const cached = flowsCache.get(file);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: a Node-RED flow file must be a JSON array`);
  }
  flowsCache.set(file, parsed);
  return parsed;
}

function readLibs(value: unknown, where: string): FunctionNodeLib[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${where}: "libs" must be an array`);
  const libs: FunctionNodeLib[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error(`${where}: every entry of "libs" must be an object`);
    const variable = entry.var;
    const module = entry.module;
    if (typeof variable !== "string" || typeof module !== "string") {
      throw new Error(`${where}: "libs" entry needs the string fields "var" and "module"`);
    }
    libs.push({ var: variable, module });
  }
  return libs;
}

/** Ids of all function nodes in the flow file — a map for the porting agents. */
export function listFunctionNodes(flowsFile?: string): { id: string; name: string }[] {
  const found: { id: string; name: string }[] = [];
  for (const node of readFlows(flowsFile ?? flowsPath())) {
    if (!isRecord(node) || node.type !== "function") continue;
    const id = node.id;
    const name = node.name;
    if (typeof id !== "string") continue;
    found.push({ id, name: typeof name === "string" ? name : "" });
  }
  return found;
}

/** Reads one function node out of `flows.json`. The file is never modified. */
export function loadFunctionNode(nodeId: string, flowsFile?: string): FunctionNodeDefinition {
  const file = flowsFile ?? flowsPath();
  for (const node of readFlows(file)) {
    if (!isRecord(node) || node.id !== nodeId) continue;
    if (node.type !== "function") {
      throw new Error(`${file}: node "${nodeId}" is of type ${String(node.type)}, not "function"`);
    }
    const func = node.func;
    if (typeof func !== "string") {
      throw new Error(`${file}: node "${nodeId}" has no "func" body`);
    }
    const name = node.name;
    const outputs = node.outputs;
    return {
      id: nodeId,
      name: typeof name === "string" ? name : "",
      func,
      outputs: typeof outputs === "number" ? outputs : 1,
      libs: readLibs(node.libs, `${file}: node "${nodeId}"`),
    };
  }
  throw new Error(`${file}: no node with the id "${nodeId}"`);
}

export interface RunOptions {
  /** The incoming message. The node may modify it, as it does in Node-RED. */
  readonly msg: unknown;
  /** Initial content of the flow context. */
  readonly flow?: Readonly<Record<string, unknown>>;
  /** Initial content of the global context. */
  readonly global?: Readonly<Record<string, unknown>>;
  /** Values for `env.get()`; `process.env` is the fallback, as in Node-RED. */
  readonly env?: Readonly<Record<string, string>>;
  /** Additional module specifiers a node may load through its `libs`. */
  readonly allowModules?: readonly string[];
  readonly timeoutMs?: number;
  readonly flowsFile?: string;
}

export interface FunctionNodeRun {
  readonly definition: FunctionNodeDefinition;
  /** What the body returned — `null` when it aborts, a message, or an array. */
  readonly returned: unknown;
  /** Messages handed over via `node.send()`. */
  readonly sent: readonly unknown[];
  /** Arguments of `node.status()`, in order. */
  readonly status: readonly unknown[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly logs: readonly string[];
  /** Events the node registered via `node.on()` — nothing calls them here. */
  readonly events: readonly string[];
  /** Flow context AFTER the run — for nodes whose result is a context write. */
  readonly flow: ReadonlyMap<string, unknown>;
  readonly global: ReadonlyMap<string, unknown>;
}

type Outcome =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "threw"; readonly reason: unknown }
  | { readonly kind: "timeout" };

/* The Node-RED 4.1 wrapper, verbatim except for the settlement at the end. It
   stays on ONE line so that `lineOffset: -1` lines a stack trace up with the
   node body. */
const PROLOGUE =
  "var results = null;" +
  "results = (async function(msg,__send__,__done__){" +
  "var __msgid__ = msg._msgid;" +
  "var node = {" +
  "id:__node__.id,name:__node__.name,path:__node__.path,outputCount:__node__.outputCount," +
  "log:__node__.log,error:__node__.error,warn:__node__.warn,debug:__node__.debug," +
  "trace:__node__.trace,on:__node__.on,status:__node__.status," +
  "send:function(msgs,cloneMsg){ __node__.send(__msgid__,msgs,cloneMsg); }," +
  "done:__done__" +
  "};\n";

const EPILOGUE = "\n})(msg,__send__,__done__).then(__settle__.ok,__settle__.fail);";

function resolveModule(lib: FunctionNodeLib, allowed: readonly string[]): string {
  const known = ALLOWED_MODULES.get(lib.module);
  if (known !== undefined) return known;
  if (allowed.includes(lib.module)) return lib.module;
  throw new Error(
    `module "${lib.module}" is not released for the harness. ` +
      `Released: ${[...ALLOWED_MODULES.keys()].join(", ")}. ` +
      `Pass it via RunOptions.allowModules if the node really needs it.`,
  );
}

/** Node-RED's callback form of the context API: `(error, value) => void`. */
type ContextCallback = (error: unknown, value?: unknown) => void;

/**
 * A shape check, not an assertion: what comes out of the sandbox is `unknown`,
 * and `typeof x === "function"` is the only thing JavaScript can actually tell
 * about a callback. The predicate makes that visible in the type rather than
 * calling a `Function`.
 */
function isContextCallback(value: unknown): value is ContextCallback {
  return typeof value === "function";
}

function contextApi(store: Map<string, unknown>): Record<string, unknown> {
  // Node-RED offers get/set both synchronously and with a callback. Only the
  // synchronous form occurs in flows.json; the callback form is served anyway,
  // because a node written by hand later would silently lose its value.
  return {
    get: (key: unknown, second: unknown): unknown => {
      const value = store.get(String(key));
      if (isContextCallback(second)) {
        second(null, value);
        return undefined;
      }
      return value;
    },
    set: (key: unknown, value: unknown, second: unknown): void => {
      store.set(String(key), value);
      if (isContextCallback(second)) second(null);
    },
    keys: (): string[] => [...store.keys()],
  };
}

/**
 * Message and stack of an error out of the sandbox.
 *
 * `error instanceof Error` is false here: an error thrown inside the vm comes
 * from the other realm and is not an instance of THIS `Error`. Whoever tests
 * for it that way loses the stack and gets the bare message — precisely the
 * useless failure output the harness is supposed to prevent.
 */
function describeError(reason: unknown): string {
  if (isRecord(reason)) {
    const stack = reason.stack;
    if (typeof stack === "string" && stack !== "") return stack;
    const message = reason.message;
    if (typeof message === "string") return message;
  }
  return String(reason);
}

/** JSON-based deep copy — the payloads in question are JSON throughout. */
function cloneMessage(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Executes the body of the function node against `options.msg` and reports
 * everything the node produced.
 *
 * Nothing typed comes back: `returned` and `sent` stay `unknown`. That is not a
 * gap, it is the point — the old code is not typed, and it must not force an
 * assertion onto the new side. Comparison happens in `normalize.ts`.
 */
export async function runFunctionNode(nodeId: string, options: RunOptions): Promise<FunctionNodeRun> {
  const definition = loadFunctionNode(nodeId, options.flowsFile);
  const sent: unknown[] = [];
  const status: unknown[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const flowStore = new Map<string, unknown>(Object.entries(options.flow ?? {}));
  const globalStore = new Map<string, unknown>(Object.entries(options.global ?? {}));
  const nodeStore = new Map<string, unknown>();
  const environment = options.env ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const record = (into: string[]): ((value: unknown) => void) => {
    return (value: unknown): void => {
      into.push(typeof value === "string" ? value : util.inspect(value, { depth: 4 }));
    };
  };

  // Loaded BEFORE the timer starts. A rejected module is a mistake in the call,
  // not a result of the run, and must not first make the test wait out the
  // timeout. What `require` returns stays `unknown`, exactly like the vm result.
  const libs: { readonly name: string; readonly value: unknown }[] = [];
  for (const lib of definition.libs) {
    const value: unknown = requireModule(resolveModule(lib, options.allowModules ?? []));
    libs.push({ name: lib.var, value });
  }

  const outcome = await new Promise<Outcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
    // Deliberately NOT unref'd: a node that never settles (a promise that is
    // never resolved — the `join` semantics are full of them) would otherwise
    // let the process exit quietly with no test result at all. The timer is
    // cleared on every settlement, so it holds nothing open unnecessarily.
    const settle = {
      ok: (value: unknown): void => {
        clearTimeout(timer);
        resolve({ kind: "returned", value });
      },
      fail: (reason: unknown): void => {
        clearTimeout(timer);
        resolve({ kind: "threw", reason });
      },
    };

    const send = (msgs: unknown): void => {
      sent.push(msgs);
    };
    const sandboxNode: Record<string, unknown> = {
      id: definition.id,
      name: definition.name,
      path: `parity/${definition.id}`,
      outputCount: definition.outputs,
      log: record(logs),
      debug: record(logs),
      trace: record(logs),
      warn: record(warnings),
      error: record(errors),
      status: (value: unknown): void => {
        status.push(value);
      },
      on: (event: unknown): void => {
        events.push(String(event));
      },
      send: (_msgid: unknown, msgs: unknown): void => {
        send(msgs);
      },
    };

    const sandbox: Record<string, unknown> = {
      console: {
        log: record(logs),
        info: record(logs),
        debug: record(logs),
        trace: record(logs),
        warn: record(warnings),
        error: record(errors),
      },
      util,
      Buffer,
      Date,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      RED: { util: { cloneMessage } },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      promisify: util.promisify,
      context: {
        ...contextApi(nodeStore),
        flow: contextApi(flowStore),
        global: contextApi(globalStore),
      },
      flow: contextApi(flowStore),
      global: contextApi(globalStore),
      env: {
        get: (name: unknown): string | undefined => {
          const key = String(name);
          return environment[key] ?? process.env[key];
        },
      },
      __node__: sandboxNode,
      __settle__: settle,
      __send__: send,
      __done__: (error: unknown): void => {
        if (error !== undefined && error !== null) record(errors)(error);
      },
      msg: options.msg,
    };

    for (const lib of libs) {
      sandbox[lib.name] = lib.value;
    }

    const context = createContext(sandbox);
    const label = definition.name === "" ? definition.id : `${definition.id} [${definition.name}]`;
    try {
      const script = new Script(`${PROLOGUE}${definition.func}${EPILOGUE}`, {
        filename: `Function node: ${label}`,
        lineOffset: -1,
      });
      script.runInContext(context);
    } catch (error) {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(describeError(error)));
    }
  });

  if (outcome.kind === "timeout") {
    throw new Error(`function node "${nodeId}" did not settle within ${String(timeoutMs)} ms`);
  }
  if (outcome.kind === "threw") {
    throw new Error(`function node "${nodeId}" failed: ${describeError(outcome.reason)}`);
  }

  return {
    definition,
    returned: outcome.value,
    sent,
    status,
    warnings,
    errors,
    logs,
    events,
    flow: flowStore,
    global: globalStore,
  };
}

function collectMessages(value: unknown, into: unknown[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const element of value) collectMessages(element, into);
    return;
  }
  if (isRecord(value)) into.push(value);
}

/**
 * All messages the node emitted — returned and sent — flattened the way
 * Node-RED's `sendResults` does it (per output, and arrays within an output).
 */
export function messagesOf(run: FunctionNodeRun): unknown[] {
  const messages: unknown[] = [];
  collectMessages(run.returned, messages);
  for (const entry of run.sent) collectMessages(entry, messages);
  return messages;
}

export function payloadOf(message: unknown): unknown {
  return isRecord(message) ? message.payload : undefined;
}

export function payloadsOf(run: FunctionNodeRun): unknown[] {
  return messagesOf(run).map(payloadOf);
}

/**
 * Payload of the one and only message. Most connectors emit exactly one; if a
 * node emits several (chunked upserts), use `payloadsOf`.
 */
export function solePayload(run: FunctionNodeRun): unknown {
  const messages = messagesOf(run);
  if (messages.length !== 1) {
    throw new Error(
      `function node "${run.definition.id}" emitted ${String(messages.length)} messages, expected exactly 1` +
        (run.warnings.length > 0 ? ` (warnings: ${run.warnings.join("; ")})` : ""),
    );
  }
  return payloadOf(messages[0]);
}
