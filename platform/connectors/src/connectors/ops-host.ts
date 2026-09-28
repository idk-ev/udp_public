/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `ops-host` — host metrics (load, memory, disk, uptime) as
 * `PlatformStatus:udp`, the entity the main dashboard shows as server load.
 *
 * Port of the exec node `udp-rt-op-exec` and FN_OPS (`udp-rt-op-fn`) from
 * scripts/generate-nodered-flows.py. The container shares the kernel with the
 * host, so `/proc` shows the host's load and memory; the old flow read them
 * through a shell command in an `exec` node, and so does this port, through
 * `node:child_process` — same shell, same busybox tools (both images are
 * Alpine), same 10 s kill timer, same parsing of the text.
 *
 * Exec semantics kept: the exec node passed stdout on to FN_OPS whatever the
 * exit code (the error went to its third output, which was wired to nothing,
 * plus a `node.log` line). A command that dies halfway therefore reaches the
 * parser with fewer than five sections and ends as the parser's `[warn]`, not
 * as an error of its own.
 *
 * ONE DELIBERATE DEVIATION: the disk figure comes from `df -P /`, not from
 * `df -P /data`. `/data` is Node-RED's user directory; this image has none,
 * and busybox then prints only the header line — `diskUsedPct` would become
 * NaN (`null` on the wire) and `diskTotalGb` 0 on every run (checked in
 * node:22-alpine, test/fixtures/ops-host.json). `/` measures the same disk
 * the old node saw: in Kubernetes Node-RED has no volume on `/data`
 * (helm/udp/values.yaml), so `/data` lay on the container's overlay root —
 * exactly what `/` is here; in Compose `/data` was a named volume below
 * Docker's data root, which is the file system the overlay root lives on too.
 *
 * Written ungated on every run, as before: the entity is one object whose
 * values change every two minutes anyway.
 */

import { exec } from "node:child_process";

import { ParseError, isString } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  Log,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "ops-host";

/** The mount whose usage is reported; see the module header for why not `/data`. */
export const DISK_PATH = "/";

/**
 * The command of the old exec node, section by section, with `---` between
 * the sections. The old node wrapped it in `sh -c '…'`; `exec()` runs its
 * command through `/bin/sh -c` itself, which is the same thing.
 */
export const COMMAND =
  `cat /proc/loadavg; echo ---; free -m; echo ---; df -P ${DISK_PATH}; echo ---; ` +
  "cat /proc/uptime; echo ---; nproc";

/** `timer: "10"` of the exec node: the command is killed (SIGTERM) after 10 s. */
export const EXEC_TIMEOUT_MS = 10_000;

/** The five sections of the command's output, in command order. */
export type HostReport = readonly [
  loadavg: string,
  memory: string,
  disk: string,
  uptime: string,
  cores: string,
];

/** `unitCode` as in the old node: C62 count, P1 percent, E38 MB, E34 GB, DAY days. */
type Measured<T extends number | null = number> = Property<T> & {
  readonly unitCode: string;
  readonly observedAt: IsoTime;
};

export interface HostStatusEntity extends NgsiEntity {
  readonly id: "urn:ngsi-ld:PlatformStatus:udp";
  readonly type: "PlatformStatus";
  readonly name: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly cpuLoad1: Measured;
  readonly cpuLoad15: Measured;
  readonly cpuCores: Measured;
  readonly cpuLoadPct: Measured;
  /** `null` when `free` reported no total. */
  readonly memUsedPct: Measured<number | null>;
  readonly memTotalMb: Measured;
  readonly diskUsedPct: Measured;
  readonly diskTotalGb: Measured;
  readonly uptimeDays: Measured;
  readonly "@context": string;
}

/**
 * Loud on output the old node rejected with
 * `node.warn('Betriebsmetriken: unerwartete exec-Ausgabe')`: fewer than five
 * sections. Anything beyond the fifth is ignored, as there.
 */
export function parse(raw: unknown): HostReport {
  if (!isString(raw)) throw new ParseError("exec output", "string", raw);
  const [loadavg, memory, disk, uptime, cores] = raw.split("---");
  if (
    loadavg === undefined ||
    memory === undefined ||
    disk === undefined ||
    uptime === undefined ||
    cores === undefined
  ) {
    throw new ParseError("exec output", "five sections separated by ---", raw);
  }
  return [loadavg, memory, disk, uptime, cores];
}

/**
 * `num` of the old node: `parseFloat(String(s).replace(',', '.'))`. A missing
 * column is `String(undefined)`, i.e. NaN — kept, because NaN is what the old
 * node sent (as `null` on the wire).
 */
function num(text: string | undefined): number {
  return Number.parseFloat(String(text).replace(",", "."));
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(report: HostReport, _geo: GeoIndex | null, now: IsoTime): HostStatusEntity {
  const [loadavg, memory, disk, uptime, coresText] = report;
  const load = loadavg.trim().split(/\s+/);
  // `free -m`: the Mem: row; column 6 is "available", column 3 "free" on a
  // `free` without the available column.
  const memLine = (/^Mem:.*$/m.exec(memory)?.[0] ?? "").trim().split(/\s+/);
  // `df -P`: the last line is the file system asked for.
  const dfLine = (disk.trim().split("\n").pop() ?? "").trim().split(/\s+/);
  const uptimeS = num(uptime.trim().split(/\s+/)[0]);
  // `parseInt(…) || 1`: NaN and 0 both mean one core.
  const parsedCores = Number.parseInt(coresText.trim(), 10);
  const cores = Number.isNaN(parsedCores) || parsedCores === 0 ? 1 : parsedCores;
  const memTotal = num(memLine[1]);
  const memAvail = num(memLine[6] ?? memLine[3]);
  const diskPct = num((dfLine[4] ?? "").replace("%", ""));
  // `memTotal ? … : null` — 0 and NaN are both falsy.
  const memUsedPct =
    memTotal !== 0 && !Number.isNaN(memTotal) ? Math.round((1 - memAvail / memTotal) * 100) : null;

  const measured = <T extends number | null>(value: T, unitCode: string): Measured<T> => ({
    type: "Property",
    value,
    unitCode,
    observedAt: now,
  });
  return {
    id: "urn:ngsi-ld:PlatformStatus:udp",
    type: "PlatformStatus",
    // German on purpose: an attribute VALUE shown on the dashboard, not log text.
    name: { type: "Property", value: "UDP-Host Betriebsmetriken" },
    dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
    cpuLoad1: measured(num(load[0]), "C62"),
    cpuLoad15: measured(num(load[2]), "C62"),
    cpuCores: measured(cores, "C62"),
    cpuLoadPct: measured(Math.round((num(load[0]) / cores) * 100), "P1"),
    memUsedPct: measured(memUsedPct, "P1"),
    memTotalMb: measured(memTotal, "E38"),
    diskUsedPct: measured(diskPct, "P1"),
    diskTotalGb: measured(Math.round(num(dfLine[1]) / 1048576), "E34"),
    uptimeDays: measured(Math.round((uptimeS / 86400) * 10) / 10, "DAY"),
    "@context": NGSI_CONTEXT,
  };
}

/** The `node.status` line of the old node, from the built values. */
export function statusText(entity: HostStatusEntity): string {
  const ram = entity.memUsedPct.value === null ? "?" : String(entity.memUsedPct.value);
  return (
    `Load ${String(entity.cpuLoad1.value)}/${String(entity.cpuCores.value)} · RAM ${ram}% · ` +
    `Disk ${String(entity.diskUsedPct.value)}%`
  );
}

/**
 * Runs {@link COMMAND} and resolves with its stdout — also when the command
 * failed or was killed, as the exec node did. Never rejects.
 */
export function readHostReport(log: Log): Promise<string> {
  return new Promise((resolve) => {
    exec(COMMAND, { timeout: EXEC_TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      // `node.log('error:' + error)` of the exec node: informational, the
      // parser below decides whether the output is still usable.
      if (error !== null) log.info(`exec failed: ${error.message}`);
      resolve(stdout);
    });
  });
}

/** `run` with the command injectable, so a test can hand in recorded output. */
export async function runWith(ctx: Ctx, read: (log: Log) => Promise<string>): Promise<void> {
  const output = await read(ctx.log);
  let report: HostReport;
  try {
    report = parse(output);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ctx.log.warn("host metrics: unexpected exec output");
    return;
  }
  const entity = build(report, null, ctx.now());
  ctx.log.status(statusText(entity));
  await ctx.orion.upsert(ctx.gate.ungated([entity]));
}

export async function run(ctx: Ctx): Promise<void> {
  await runWith(ctx, readHostReport);
}

export const connector: ConnectorModule<HostReport, HostStatusEntity> = {
  id: ID,
  parse,
  build,
  run,
};
