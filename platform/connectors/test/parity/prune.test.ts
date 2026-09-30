/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: the prune — `pruneStale` of PRUNE_HELPER, cut verbatim out of the
 * road works node, against `Pruner.stale` of src/kernel/prune.ts.
 *
 * Deleting live data is the one thing a connector does that the next run does
 * not repair, so every guard is replayed as a scenario on both sides: each
 * side gets its own copy of a scripted broker, the same clock and the same
 * sequence of runs, and afterwards the deletions, the remaining entities, the
 * warnings and info lines (verbatim) and the change signature table must be
 * identical. The old code reaches the broker through a fake `node:http`, the
 * port through a scripted fetcher; both answer from the same function.
 *
 * The broker deliberately IGNORES `idPattern` and also returns foreign ids —
 * the local re-check of the pattern is the guard that has to hold then.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import type { SharedGeo } from "../../src/kernel/geo.js";
import { createOrion } from "../../src/kernel/orion.js";
import { createPruner } from "../../src/kernel/prune.js";
import type {
  BoundaryEntry,
  HttpResponse,
  MunicipalityRow,
  PruneOptions,
  Pruner,
} from "../../src/kernel/types.js";
import { fakeHttpModule, httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { RecordedLog, SeenRequest } from "../harness/kernel.js";
import { isRecord, normalize } from "../harness/normalize.js";
import { contextApi, evaluateSnippet, evaluateSnippetAsync, extractSnippet } from "../harness/vm-runner.js";

const HOUR = 3_600_000;
const START = Date.parse("2026-09-01T00:00:00Z");
const TYPE = "RoadWork";
const OWN = (n: number): string => `urn:ngsi-ld:RoadWork:bw-svz-${String(n)}`;
const FOREIGN = "urn:ngsi-ld:RoadWork:reutlingen-baustelle-1";
const PROVIDER = "SVZ-BW";

/** The road works node; PRUNE_HELPER is the same text in all eight nodes that embed it. */
const PRUNE_NODE = "udp-rt-br-fn";
const PRUNE_START = "async function pruneStale(o) {";
const PRUNE_END = "    return deletedIds.length;\n}";

/* ── the scripted broker ─────────────────────────────────────────────────────*/

class Broker {
  readonly entities = new Map<string, Record<string, unknown>>();
  countOffset = 0;
  /** Listings and deletes — the municipality count query is not counted. */
  requests = 0;
  /** What Orion reports as the number of Municipality entities (seed of the 95 % ratchet). */
  municipalityCount: number | Error = 1103;
  listAnswer: HttpResponse | null = null;
  deleteAnswer: (ids: readonly string[]) => HttpResponse | Error = () => httpResponse(204);

  constructor(now: number) {
    // Ten own road works written three days ago, one foreign entity of the same type.
    for (let n = 1; n <= 10; n += 1) this.entities.set(OWN(n), roadwork(OWN(n), now - 3 * 24 * HOUR));
    this.entities.set(FOREIGN, roadwork(FOREIGN, now - 30 * 24 * HOUR));
  }

  readonly respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.method === "GET" && request.url.searchParams.get("type") === "Municipality") {
      if (this.municipalityCount instanceof Error) return this.municipalityCount;
      return httpResponse(200, "[]", { "ngsild-results-count": String(this.municipalityCount) });
    }
    this.requests += 1;
    if (request.method === "GET") {
      if (this.listAnswer !== null) return this.listAnswer;
      // idPattern ignored on purpose, only the type filters.
      const all = [...this.entities.values()].filter(
        (entity) => entity.type === request.url.searchParams.get("type"),
      );
      const offset = Number(request.url.searchParams.get("offset"));
      const limit = Number(request.url.searchParams.get("limit"));
      return httpResponse(200, JSON.stringify(all.slice(offset, offset + limit)), {
        "ngsild-results-count": String(all.length + this.countOffset),
      });
    }
    const parsed: unknown = JSON.parse(request.body ?? "[]");
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    const answer = this.deleteAnswer(ids);
    if (answer instanceof Error) return answer;
    if (answer.status === 204) for (const id of ids) this.entities.delete(id);
    if (answer.status === 207) {
      const body: unknown = JSON.parse(answer.body);
      const success = isRecord(body) && Array.isArray(body.success) ? body.success : [];
      for (const id of success) if (typeof id === "string") this.entities.delete(id);
    }
    return answer;
  };
}

function roadwork(id: string, observedMs: number): Record<string, unknown> {
  return {
    id,
    type: TYPE,
    ags: { type: "Property", value: "08100000" },
    dataProvider: { type: "Property", value: id === FOREIGN ? "Stadt Reutlingen" : PROVIDER },
    dateObserved: {
      type: "Property",
      value: { "@type": "DateTime", "@value": new Date(observedMs).toISOString() },
    },
  };
}

/* ── the two sides ───────────────────────────────────────────────────────────*/

/** Synthetic master data: `count` municipalities, each with a (dummy) polygon. */
function masterData(count: number): { rows: MunicipalityRow[]; boundaries: Record<string, BoundaryEntry> } {
  const rows: MunicipalityRow[] = [];
  const boundaries: Record<string, BoundaryEntry> = {};
  const square: BoundaryEntry["r"] = [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ];
  for (let i = 0; i < count; i += 1) {
    const ags = `08${String(100000 + i)}`;
    rows.push([
      ags,
      `Gemeinde ${String(i)}`,
      48,
      9,
      ags.slice(0, 5),
      "G",
      1000,
      null,
      `gemeinde-${String(i)}`,
    ]);
    boundaries[ags] = { b: [0, 0, 1, 1], r: square };
  }
  return { rows, boundaries };
}

interface Side {
  readonly broker: Broker;
  stale(options: PruneOptions): Promise<number>;
  resetConfirmations(key: string): void;
  warnings(): string[];
  infos(): string[];
  signatures(key: string): Record<string, unknown>;
}

interface Clock {
  now: number;
}

interface PortedSide extends Side {
  readonly pruner: Pruner;
  readonly log: RecordedLog;
  readonly geo: SharedGeo;
}

function portedSide(clock: Clock, municipalities = 1103): PortedSide {
  const log = recordingLog();
  const store = new SignatureStore().scope("test");
  const geo = createSharedGeo(recordingLog());
  const data = masterData(municipalities);
  geo.setMunicipalities(data.rows);
  geo.setBoundaries(data.boundaries, 0);
  const broker = new Broker(START);
  const pruner = createPruner({
    log,
    orion: createOrion(log, scriptedFetcher(broker.respond).fetcher, createChangeGate(store, log), store),
    signatures: store,
    geo,
    masterData: new MasterDataCheck(),
    defaultIntervalMs: HOUR,
    nowMs: () => clock.now,
  });
  store.replace("rwSig", new Map([OWN(1), OWN(9), OWN(10)].map((id) => [id, `sig-${id}`])));
  return {
    broker,
    pruner,
    log,
    geo,
    stale: async (options) => (await pruner.stale(options)).deleted,
    resetConfirmations: (key) => {
      pruner.resetConfirmations(key);
    },
    warnings: () => log.warnings(),
    infos: () => log.lines.filter((line) => line.level === "info").map((line) => line.text),
    signatures: (key) => Object.fromEntries(store.copy(key)),
  };
}

/** The old `pruneStale` in a vm: flow context kept across calls, `Date.now` on the shared clock. */
function legacySide(clock: Clock): Side {
  const source = extractSnippet(PRUNE_NODE, PRUNE_START, PRUNE_END);
  const broker = new Broker(START);
  const flow = new Map<string, unknown>([
    ["rwSig", Object.fromEntries([OWN(1), OWN(9), OWN(10)].map((id) => [id, `sig-${id}`]))],
  ]);
  const warnings: string[] = [];
  const infos: string[] = [];
  const node = {
    warn: (text: unknown) => warnings.push(String(text)),
    log: (text: unknown) => infos.push(String(text)),
    status: () => undefined,
  };
  return {
    broker,
    stale: async (options) => {
      const result = await evaluateSnippetAsync(
        source,
        {
          http: fakeHttpModule(broker.respond),
          flow: contextApi(flow),
          node,
          Buffer,
          Date: { now: () => clock.now, parse: (value: unknown) => Date.parse(String(value)) },
          __o__: legacyOptions(options),
        },
        "pruneStale(__o__)",
      );
      return typeof result === "number" ? result : Number.NaN;
    },
    resetConfirmations: (key) => flow.set(key, {}),
    warnings: () => warnings,
    infos: () => infos,
    signatures: (key) => {
      const table = flow.get(key);
      return isRecord(table) ? { ...table } : {};
    },
  };
}

/** The same options in the old spelling: comma-joined attrs, `sigKey`. */
function legacyOptions(options: PruneOptions): Record<string, unknown> {
  const { attrs, signatureKey, ...rest } = options;
  return {
    ...rest,
    ...(attrs === undefined ? {} : { attrs: attrs.join(",") }),
    ...(signatureKey === undefined ? {} : { sigKey: signatureKey }),
  };
}

/* ── scenarios ───────────────────────────────────────────────────────────────*/

const BASE: PruneOptions = {
  label: "BW roadworks",
  type: TYPE,
  pattern: "^urn:ngsi-ld:RoadWork:bw-svz-[0-9]+$",
  attrs: ["ags", "dateObserved"],
  graceMs: 24 * HOUR,
  intervalMs: HOUR,
  signatureKey: "rwSig",
  status: "10 Objekte",
};

const keepAllBut = (...missing: number[]): Set<string> =>
  new Set(
    Array.from({ length: 10 }, (_, i) => i + 1)
      .filter((n) => !missing.includes(n))
      .map(OWN),
  );

interface Step {
  /** Clock advance before this run. */
  readonly advance: number;
  readonly options: PruneOptions;
  /** Something happening between runs — on both sides alike. */
  readonly before?: (side: Side) => void;
}

interface Scenario {
  readonly name: string;
  readonly steps: readonly Step[];
  /** Deletions of the port per run — stated, not only compared. */
  readonly expectDeleted: readonly number[];
  /**
   * Deliberate deviation: ids whose signature the port forgets and the old
   * helper kept — every ATTEMPTED delete loses it, confirmed or not
   * (src/kernel/prune.ts: a kept one could leave a skeleton entity).
   */
  readonly forgottenByThePort?: readonly string[];
}

const run = (options: PruneOptions, advance = HOUR, before?: (side: Side) => void): Step =>
  before === undefined ? { advance, options } : { advance, options, before };

const hourly = (count: number, options: PruneOptions): Step[] =>
  Array.from({ length: count }, () => run(options));

const CONFIRM: PruneOptions = { ...BASE, graceMs: undefined, confirmKey: "rwConfirm", keep: keepAllBut(9) };

const SCENARIOS: readonly Scenario[] = [
  {
    name: "arms quietly, then deletes stale own ids only (grace, keep, foreign id)",
    steps: [
      run({ ...BASE, keep: keepAllBut(9, 10) }, 0, (side) => {
        // Not produced by this run, but written an hour ago: within the grace period.
        side.broker.entities.set(OWN(11), roadwork(OWN(11), START - HOUR));
      }),
      run({ ...BASE, keep: keepAllBut(9, 10) }),
    ],
    expectDeleted: [0, 2],
  },
  {
    name: "more than 30 % of the stock is refused",
    steps: [
      run({ ...BASE, keep: new Set([OWN(1), OWN(2)]) }, 0),
      run({ ...BASE, keep: new Set([OWN(1), OWN(2)]) }),
    ],
    expectDeleted: [0, 0],
  },
  {
    name: "a gap of more than 2.5 intervals skips",
    steps: [run({ ...BASE, keep: keepAllBut(9) }, 0), run({ ...BASE, keep: keepAllBut(9) }, 3 * HOUR)],
    expectDeleted: [0, 0],
  },
  {
    name: "a listing short of NGSILD-Results-Count skips",
    steps: [
      run({ ...BASE, keep: keepAllBut(9) }, 0, (side) => {
        side.broker.countOffset = 2;
      }),
      run({ ...BASE, keep: keepAllBut(9) }),
    ],
    expectDeleted: [0, 0],
  },
  {
    name: "a failed listing skips",
    steps: [
      run({ ...BASE, keep: keepAllBut(9) }, 0, (side) => {
        side.broker.listAnswer = httpResponse(503, "busy");
      }),
      run({ ...BASE, keep: keepAllBut(9) }),
    ],
    expectDeleted: [0, 0],
  },
  {
    name: "age-only mode skips when nothing was written recently (connector down)",
    steps: [
      run({ ...BASE, keep: new Set(), liveMs: 3 * HOUR, maxFraction: 1 }, 0),
      run({ ...BASE, keep: new Set(), liveMs: 3 * HOUR, maxFraction: 1 }),
    ],
    expectDeleted: [0, 0],
  },
  {
    name: "accept and exclude narrow the own ids further",
    steps: [
      run({ ...BASE, keep: keepAllBut(8, 9, 10), exclude: "-10$" }, 0, (side) => {
        const nine = side.broker.entities.get(OWN(9));
        if (nine !== undefined) nine.dataProvider = { type: "Property", value: "Stadt Freiburg" };
      }),
      run({
        ...BASE,
        keep: keepAllBut(8, 9, 10),
        exclude: "-10$",
        accept: (_id, entity) => isRecord(entity.dataProvider) && entity.dataProvider.value === PROVIDER,
      }),
    ],
    expectDeleted: [0, 1],
  },
  {
    name: "confirmKey needs two consecutive runs and 24 h",
    steps: [run(CONFIRM, 0), ...hourly(26, CONFIRM)],
    // Candidate from the second run on; deleted in the run 24 h later.
    expectDeleted: [...Array.from({ length: 25 }, () => 0), 1, 0],
  },
  {
    name: "a reset of the confirmation table restarts the 24 h",
    steps: [
      run({ ...CONFIRM, intervalMs: 24 * HOUR }, 0),
      run({ ...CONFIRM, intervalMs: 24 * HOUR }),
      run({ ...CONFIRM, intervalMs: 24 * HOUR }, 23 * HOUR),
      run({ ...CONFIRM, intervalMs: 24 * HOUR }, HOUR, (side) => {
        side.resetConfirmations("rwConfirm");
      }),
    ],
    expectDeleted: [0, 0, 0, 0],
  },
  {
    name: "207: only confirmed deletes count; every attempted one loses its signature",
    steps: [
      run({ ...BASE, keep: keepAllBut(9, 10) }, 0, (side) => {
        side.broker.deleteAnswer = () =>
          httpResponse(207, JSON.stringify({ success: [OWN(9)], errors: [{ entityId: OWN(10) }] }));
      }),
      run({ ...BASE, keep: keepAllBut(9, 10) }),
    ],
    expectDeleted: [0, 1],
    forgottenByThePort: [OWN(10)],
  },
  {
    name: "a refused delete request is a warning, not a deletion",
    steps: [
      run({ ...BASE, keep: keepAllBut(9) }, 0, (side) => {
        side.broker.deleteAnswer = () => new Error("connect ECONNREFUSED 10.0.0.1:1026");
      }),
      run({ ...BASE, keep: keepAllBut(9) }),
    ],
    expectDeleted: [0, 0],
    forgottenByThePort: [OWN(9)],
  },
];

/** Replays one scenario on both sides; returns the port's warnings. */
async function compareScenario(scenario: Scenario): Promise<string[]> {
  const clock: Clock = { now: START };
  const legacy = legacySide(clock);
  const ported = portedSide(clock);
  const deleted: { legacy: number[]; ported: number[] } = { legacy: [], ported: [] };
  for (const step of scenario.steps) {
    clock.now += step.advance;
    step.before?.(legacy);
    step.before?.(ported);
    deleted.legacy.push(await legacy.stale(step.options));
    deleted.ported.push(await ported.stale(step.options));
  }
  const at = `${scenario.name}:`;
  assert.deepEqual(deleted.ported, deleted.legacy, `${at} deletions per run differ`);
  assert.deepEqual(deleted.ported, scenario.expectDeleted, `${at} unexpected deletions`);
  assert.deepEqual(
    [...ported.broker.entities.keys()],
    [...legacy.broker.entities.keys()],
    `${at} broker differs`,
  );
  assert.ok(ported.broker.entities.has(FOREIGN), `${at} a foreign id was deleted`);
  assert.deepEqual(ported.warnings(), legacy.warnings(), `${at} warnings differ`);
  assert.deepEqual(ported.infos(), legacy.infos(), `${at} info lines differ`);
  const forgotten = new Set(scenario.forgottenByThePort ?? []);
  const kept = legacy.signatures("rwSig");
  for (const id of forgotten) assert.ok(id in kept, `${at} ${id}: the old helper did not keep it either`);
  const legacySignatures = Object.fromEntries(Object.entries(kept).filter(([id]) => !forgotten.has(id)));
  assert.deepEqual(normalize(ported.signatures("rwSig")), normalize(legacySignatures), `${at} signatures`);
  return ported.warnings();
}

async function everyGuardBehavesAsBefore(): Promise<void> {
  for (const scenario of SCENARIOS) await compareScenario(scenario);
}

/**
 * A failed listing between two confirmation runs is a skipped run: the
 * candidates are forgotten and the 24 h start again from the next sighting.
 * Runs every 3 h; OWN(9) is a candidate from 3 h on. Without the reset it
 * would go at 27 h; with it, only 24 h after the sighting at 9 h, i.e. at 33 h.
 */
async function failedListingRestartsTheConfirmation(): Promise<void> {
  const options: PruneOptions = { ...CONFIRM, intervalMs: 3 * HOUR };
  const steps: Step[] = [
    run(options, 0),
    run(options, 3 * HOUR),
    run(options, 3 * HOUR, (side) => {
      side.broker.listAnswer = httpResponse(500, "boom");
    }),
    ...Array.from({ length: 10 }, (_, i) =>
      run(options, 3 * HOUR, (side) => {
        if (i === 0) side.broker.listAnswer = null;
      }),
    ),
  ];
  const warnings = await compareScenario({
    name: "a failed listing between confirmation runs",
    steps,
    // Runs at 0, 3, 6 (failed), 9 … 36 h: the deletion falls on 33 h.
    expectDeleted: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  });
  assert.ok(
    warnings.some((line) => line.includes("500")),
    `the failed listing was not reported: ${warnings.join(" | ")}`,
  );
}

async function implausibleMasterDataNeverLists(): Promise<void> {
  // PRUNE_OK lives at the old call sites (`if (PRUNE_OK) pruneStale(…)`), so
  // there is nothing to compare against — the port checks it itself.
  const clock: Clock = { now: START };
  const side = portedSide(clock, 999);
  const result = await side.pruner.stale({ ...BASE, keep: keepAllBut(9) });
  assert.equal(result.skipped, "master data not plausible");
  assert.equal(side.broker.requests, 0, "no listing, no delete");
  assert.equal(side.broker.entities.size, 11);
  assert.deepEqual(
    side.log.warnings(),
    [],
    "a skipped prune for implausible master data is not a fault of its own",
  );
}

/* ── review fixes: stricter than the old code where stated ─────────────────*/

async function restartWithTruncatedFileIsNotPlausible(): Promise<void> {
  // After a restart the 95 % reference is seeded from Orion (1,101 Municipality
  // entities). A truncated file of 1,020 rows arriving right then must not pass
  // — with a reference of 0 it would, and every prune would delete what the
  // missing municipalities own.
  const clock: Clock = { now: START };
  const truncated = portedSide(clock, 1020);
  truncated.broker.municipalityCount = 1101;
  assert.equal(await truncated.pruner.masterDataPlausible(), false);
  assert.equal(
    (await truncated.pruner.stale({ ...BASE, keep: keepAllBut(9) })).skipped,
    "master data not plausible",
  );

  const complete = portedSide(clock, 1101);
  complete.broker.municipalityCount = 1101;
  assert.equal(await complete.pruner.masterDataPlausible(), true);

  // Orion unreachable: no seed, no verdict, no prune — until it answers.
  const cut = portedSide(clock, 1101);
  cut.broker.municipalityCount = new Error("connect ECONNREFUSED 10.0.0.1:1026");
  assert.equal(await cut.pruner.masterDataPlausible(), false);
  cut.broker.municipalityCount = 1101;
  assert.equal(await cut.pruner.masterDataPlausible(), true);
}

async function implausibleMasterDataClearConfirmations(): Promise<void> {
  // Both old call sites with a confirmation table clear it in their else
  // branch (`flow.set('parkPruneSite', {})`), so candidacy restarts.
  const clock: Clock = { now: START };
  const side = portedSide(clock);
  const options: PruneOptions = { ...BASE, graceMs: undefined, confirmKey: "rwConfirm", keep: keepAllBut(9) };
  await side.stale(options); // arms
  for (let hour = 1; hour <= 23; hour += 1) {
    clock.now += HOUR;
    assert.equal(await side.stale(options), 0);
  }
  // Master data turn implausible for one run …
  const full = masterData(1103);
  side.geo.setMunicipalities(masterData(900).rows);
  clock.now += HOUR;
  assert.equal((await side.pruner.stale(options)).skipped, "master data not plausible");
  side.geo.setMunicipalities(full.rows);
  // … so the next run, 24 h after the first candidacy, must not delete.
  clock.now += HOUR;
  assert.equal(await side.stale(options), 0, "the confirmation table was not cleared");
  assert.ok(side.broker.entities.has(OWN(9)));
}

async function degradedBoundariesBlockPruning(): Promise<void> {
  const clock: Clock = { now: START };
  const side = portedSide(clock);
  assert.equal(await side.pruner.masterDataPlausible(), true);
  side.geo.setBoundaries(masterData(1103).boundaries, 1);
  assert.equal(await side.pruner.masterDataPlausible(), false, "a dropped polygon must stop the prune");
}

async function intervalGuardIsKeyedAndCannotBeDisabled(): Promise<void> {
  const clock: Clock = { now: START };
  const side = portedSide(clock);
  await side.stale({ ...BASE, keep: keepAllBut(9) }); // arms "BW roadworks|RoadWork|…"
  clock.now += HOUR;
  // Same label, different type: must not ride on the other prune's interval.
  const other = await side.pruner.stale({ ...BASE, type: "RoadWorkSummary", keep: keepAllBut(9) });
  assert.equal(other.skipped, "no successful run within the last 2.5 intervals");

  for (const intervalMs of [0, -1, Number.NaN]) {
    const fresh = portedSide(clock);
    const result = await fresh.pruner.stale({ ...BASE, intervalMs, keep: keepAllBut(9) });
    assert.equal(
      result.skipped,
      "no successful run within the last 2.5 intervals",
      `intervalMs ${String(intervalMs)}`,
    );
  }
}

async function patternAndFractionAreValidated(): Promise<void> {
  const clock: Clock = { now: START };
  const side = portedSide(clock);
  const result = await side.pruner.stale({
    ...BASE,
    pattern: "urn:ngsi-ld:RoadWork:bw-svz-",
    keep: keepAllBut(9),
  });
  assert.match(result.skipped ?? "", /is not anchored/);
  assert.equal(side.broker.entities.size, 11);

  // maxFraction 0 falls back to 0.3 (8 of 10 refused), 5 is clamped to 1 (allowed).
  const keep = new Set([OWN(1), OWN(2)]);
  for (const [maxFraction, expected] of [
    [0, 0],
    [5, 8],
  ] as const) {
    const fresh = portedSide(clock);
    await fresh.stale({ ...BASE, keep, maxFraction });
    clock.now += HOUR;
    assert.equal(
      await fresh.stale({ ...BASE, keep, maxFraction }),
      expected,
      `maxFraction ${String(maxFraction)}`,
    );
  }
}

/** PRUNE_OK_JS, cut out of the road works node — the same text in every geo_helper node. */
function pruneOkMatchesTheOldCheck(): void {
  const source = extractSnippet(PRUNE_NODE, "const PRUNE_OK = (() => {", "})();");
  const node = new Map<string, unknown>();
  const check = new MasterDataCheck();
  // The old node context started empty in Kubernetes; the port seeds from Orion.
  // A seed of 0 is that empty context, so the two ratchets can be compared.
  check.seed(0);

  const other = (count: number): Record<string, BoundaryEntry> => {
    const shifted: Record<string, BoundaryEntry> = {};
    for (const [ags, entry] of Object.entries(masterData(count).boundaries))
      shifted[`09${ags.slice(2)}`] = entry;
    return shifted;
  };
  const withBoundaries = (
    rows: number,
    covered: number,
  ): [MunicipalityRow[], Record<string, BoundaryEntry>] => {
    const data = masterData(rows);
    const boundaries = Object.fromEntries(Object.entries(data.boundaries).slice(0, covered));
    return [data.rows, boundaries];
  };
  const states: [
    label: string,
    rows: MunicipalityRow[] | null,
    boundaries: Record<string, BoundaryEntry> | null,
  ][] = [
    ["no master data", null, masterData(1103).boundaries],
    ["full", ...withBoundaries(1103, 1103)],
    ["95 % of 1103 is 1047.85: 1047 fails", ...withBoundaries(1047, 1047)],
    ["1048 passes and ratchets down", ...withBoundaries(1048, 1048)],
    ["1000 is 95.4 % of 1048", ...withBoundaries(1000, 1000)],
    ["999 is below the floor", ...withBoundaries(999, 999)],
    ["back to full", ...withBoundaries(1103, 1103)],
    ["99.0 % covered by key", ...withBoundaries(1103, 1092)],
    ["98.9 % covered", ...withBoundaries(1103, 1091)],
    ["right count, wrong keys", masterData(1103).rows, other(1103)],
    ["no boundaries (count still ratchets)", masterData(1103).rows, null],
  ];
  for (const [label, rows, boundaries] of states) {
    const legacy = evaluateSnippet(
      source,
      { GEM: rows, GRZ: boundaries, context: contextApi(node) },
      "PRUNE_OK",
    );
    const ported = check.evaluate(rows, boundaries, false);
    assert.equal(ported, legacy, `${label}: old ${String(legacy)} vs new ${String(ported)}`);
  }
}

export {
  everyGuardBehavesAsBefore as "prune: old pruneStale and Pruner.stale agree on every guard (deletions, broker, warnings, signatures)",
  failedListingRestartsTheConfirmation as "prune: a failed listing between confirmation runs restarts the 24 h, as in the old node",
  implausibleMasterDataNeverLists as "prune: implausible master data (< 1000 municipalities) never even lists",
  restartWithTruncatedFileIsNotPlausible as "prune: after a restart the 95 % reference is seeded from Orion; a truncated file fails",
  implausibleMasterDataClearConfirmations as "prune: implausible master data clear the confirmation table",
  degradedBoundariesBlockPruning as "prune: a boundary set with dropped polygons blocks pruning",
  intervalGuardIsKeyedAndCannotBeDisabled as "prune: interval guard keyed by label/type/pattern, 0/NaN/negative fall back",
  patternAndFractionAreValidated as "prune: unanchored pattern refused, maxFraction clamped to (0, 1]",
  pruneOkMatchesTheOldCheck as "prune: MasterDataCheck agrees with the old PRUNE_OK_JS (95 % ratchet, 99 % by key)",
};
