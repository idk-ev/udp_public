/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Structured logging.
 *
 * The line format follows Node-RED's, and not out of nostalgia:
 * `scripts/healthcheck.sh` counts container log lines with `[error]` and
 * `[warn]` and, above ten warnings, groups them by the component in the next
 * pair of brackets:
 *
 *     grep -cE '\[warn\]'
 *     sed -E 's,.*\[warn\] \[([^]]*)\].*,   \1,' | sort | uniq -c | sort -rn
 *
 * (the real script uses slashes as the sed delimiter; they are commas here so
 * that the pattern does not close this comment)
 *
 * That check exists because a complete source outage (all EFA cities answering
 * "JSON parse error" at once) never produced an `[error]` — only warnings — and
 * therefore stayed invisible. Whoever renames the markers takes that away again
 * without anything turning red.
 *
 * Format: `2026-08-31T04:12:00.000Z [warn] [parken-bw] message`
 */

import type { Log, LogLevel } from "./types.js";

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdOf(raw: string | undefined): number {
  if (raw === undefined) return ORDER.info;
  const level = raw.trim().toLowerCase();
  if (level === "debug") return ORDER.debug;
  if (level === "info") return ORDER.info;
  if (level === "warn") return ORDER.warn;
  if (level === "error") return ORDER.error;
  return ORDER.info;
}

/**
 * Renders a thrown value for the `cause` line. `useUnknownInCatchVariables` means
 * a catch binding is `unknown`, which is honest — a thrown value need not be an
 * Error, and the old flows did throw plain strings out of the vm sandbox.
 */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack !== undefined && cause.stack !== "" ? cause.stack : `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === "string") return cause;
  // lib.es5.d.ts declares JSON.stringify as returning string, but it answers
  // undefined for undefined, a function or a symbol. Those are taken out first
  // rather than papered over with a fallback the compiler thinks is dead.
  if (cause === undefined || cause === null) return String(cause);
  if (typeof cause === "function" || typeof cause === "symbol") return String(cause);
  try {
    return JSON.stringify(cause);
  } catch {
    // Circular structures throw here; a log line must never be the reason a run
    // dies.
    return "<unserialisable cause>";
  }
}

class ConsoleLog implements Log {
  readonly #component: string;
  readonly #threshold: number;

  constructor(component: string, threshold: number) {
    this.#component = component;
    this.#threshold = threshold;
  }

  #write(level: LogLevel, message: string): void {
    if (ORDER[level] < this.#threshold) return;
    const line = `${new Date().toISOString()} [${level}] [${this.#component}] ${message}\n`;
    // stderr for warn and error so that a `docker logs` split by stream keeps
    // them apart; the health check reads both streams (2>&1) either way.
    if (level === "warn" || level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  }

  debug(message: string): void {
    this.#write("debug", message);
  }

  info(message: string): void {
    this.#write("info", message);
  }

  warn(message: string): void {
    this.#write("warn", message);
  }

  error(message: string, cause?: unknown): void {
    this.#write("error", message);
    // The cause goes on its own line: the counted [error] line stays short and
    // greppable, the stack stays readable.
    if (cause !== undefined) process.stderr.write(`    ${describeCause(cause)}\n`);
  }

  status(text: string): void {
    // node.status({ text }) painted the editor, it did not log. Emitting it at
    // info level would multiply the log volume of every run and drown the two
    // markers the health check lives on.
    this.#write("debug", text);
  }

  child(component: string): Log {
    return new ConsoleLog(`${this.#component}:${component}`, this.#threshold);
  }
}

/**
 * @param component Name in the second bracket pair — the connector id for
 *                  connector logs, so the health check's grouping names the
 *                  connector that is failing.
 * @param level     Lowest level written; `LOG_LEVEL` env, default `info`.
 */
export function createLog(component: string, level?: string): Log {
  return new ConsoleLog(component, thresholdOf(level));
}
