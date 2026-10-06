/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Invariants of the connector service (platform/connectors).

   History: these checks began as the invariants of the Node-RED ingestion
   flows (sprint 2.9), after the ParkAPI incident of 24.08.2026 — an offset
   pagination the API silently ignored and entity ids built from free text ran
   unnoticed for a month and produced about half of all TRoE rows. With the
   flows gone (docs/migration-konnektoren.md, phase 6), every invariant is
   carried by the TypeScript modules in platform/connectors/src, which are the
   production code now.

   Two mechanisms, both without a running stack:
   - Source checks on the ported modules (code only, comments stripped) where a
     regex can see the invariant.
   - CARRIED_BY: the connectors tests (platform/connectors/test/parity, run in
     the same suite by tests/run.js) that assert an invariant by behaviour. Each
     is named here, so a renamed or deleted one fails this file instead of
     leaving the invariant unguarded.

   Dropped with the flows, no production counterpart: "All function nodes
   compile" (tsc and eslint cover the modules), the `libs` declarations and the
   wiring of delay/commit nodes (their properties — paced writes, commit only
   after a confirmed upsert — are carried below), and the one-off csStand →
   csSig seeding of carsharing (a migration of the flow context the service
   never had; see the header of carsharing-bw.ts). */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "platform/connectors/src");
const PARITY = path.join(ROOT, "platform/connectors/test/parity");
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, "platform/config/connectors.json"), "utf8")).connectors;

const tsFiles = dir => fs.readdirSync(path.join(SRC, dir)).filter(f => f.endsWith(".ts")).map(f => `${dir}/${f}`);
const MODULES = tsFiles("connectors").map(f => path.basename(f, ".ts"));
const ALL_SOURCES = tsFiles("connectors").concat(tsFiles("kernel"), ["index.ts"]);

/* Code only: block and line comments removed (the comments describe the fixed
   errors on purpose, »vorher &offset=…«), adjacent string literals ("…" + "…")
   joined, so a statement reads as the database gets it. */
function code(file) {
  const src = fs.readFileSync(path.join(SRC, file), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")
    .replace(/"\s*\+\s*"/g, "");
}
const portedCode = module => code(`connectors/${module}.ts`);

/* The connectors tests that carry each invariant: [test file (without
   .test.ts), exported test name] — or, for a scenario inside a table-driven
   test, [file, scenario name, "scenario"]. */
const CARRIED_BY = {
  slug: [
    ["mobility-invariants", "mobility invariants: no entity id from slugged free text in any ported module"],
  ],
  parkingIds: [
    ["mobility-invariants", "mobility invariants: parking site ids from the ParkAPI key, without the AGS"],
    ["mobility-invariants", "mobility invariants: no entity id from slugged free text in any ported module"],
  ],
  cursor: [
    ["mobility-invariants", "mobility invariants: ParkAPI paginates by cursor start=, never offset="],
    ["parken-bw", "parken-bw: old cursor fetch node and port request the same pages and fold the same records"],
  ],
  overlap: [
    ["mobility-invariants", "mobility invariants: ParkAPI checks page overlap, stalled cursors and caps the loop"],
    ["parken-bw", "parken-bw: overlap, stalled cursor, HTTP error and malformed pages abort both sides"],
    ["parken-bw", "parken-bw: the page cap is the old one, warns, and leaves the run incomplete"],
  ],
  gateModes: [
    ["mobility-invariants", "mobility invariants: gate replace for whole-stock runs, merge per system, commit only via the plan"],
    ["carsharing-bw", "carsharing-bw: stations and fleets match across two runs (merge gate, freshEvery 3)"],
    ["puls-bw", "puls-bw: gate in replace mode — commit, freshness-only rerun and a dropped pulse match the old tables"],
    ["ladesaeulen-bw", "ladesaeulen-bw: complete runs replace the split tables, a vanished location loses its signatures"],
  ],
  troeBudget: [
    ["troe-stats", "troe-stats: the budget is the kernel's sumRowBudgets() — equal to the object the generator baked into the old node"],
    ["troe-stats", "troe-stats: under, at and over budget, types without budget — warnings identical to the old node"],
    ["mobility-invariants", "mobility invariants: the registry row budgets cover every type written"],
  ],
  troeCheap: [
    ["troe-stats", "troe-stats: session settings are the old client's (udp-troe-stats, 50 s server / 60 s client)"],
    ["troe-stats", "troe-stats: a previous run still active skips the run on both sides, nothing written"],
    ["troe-retention", "troe-retention: a typical night — same statements, batches, warnings and summary as the old node"],
  ],
  centroid: [
    ["uba-bw", "uba-bw: old build node and ported build() agree — strict polygon hits and centroid fallback"],
    ["strict-lookup", "strict lookup: forRun skips with a warning unless boundaries are declared optional"],
  ],
  strictLookup: [
    ["strict-lookup", "strict lookup: on the full file Stuttgart is 08111000, Basel/Strasbourg/Kaiserslautern are no BW municipality, > 95 % of centroids hit their own polygon"],
    ["strict-lookup", "strict lookup: old and new agree on the full gui/public/bw-grenzen.json"],
    ["strict-lookup", "strict lookup: old STRICT_LOOKUP and GeoIndex.agsAt agree on border, notch, sliver and grid probes"],
  ],
  pruneGuards: [
    ["prune", "prune: old pruneStale and Pruner.stale agree on every guard (deletions, broker, warnings, signatures)"],
    ["prune", "prune: unanchored pattern refused, maxFraction clamped to (0, 1]"],
    ["prune", "prune: implausible master data (< 1000 municipalities) never even lists"],
    ["prune", "prune: MasterDataCheck agrees with the old PRUNE_OK_JS (95 % ratchet, 99 % by key)"],
    ["prune", "prune: a boundary set with dropped polygons blocks pruning"],
    ["prune", "prune: interval guard keyed by label/type/pattern, 0/NaN/negative fall back"],
    ["mobility-invariants", "mobility invariants: every prune is anchored, bounded and guarded; legacy prune intact"],
    ["parken-bw", "parken-bw: run() upserts the old chunks and resets the confirmations on an incomplete run"],
    ["feinstaub-bw", "feinstaub-bw: prune in the detail runs only, armed then deleting, as the old node on full master data"],
  ],
  pruneConfirmation: [
    ["prune", "confirmKey needs two consecutive runs and 24 h", "scenario"],
    ["parken-bw", "parken-bw: candidates just inside and just outside the 24 h confirmation are deleted run by run as by the old node"],
    ["ladesaeulen-bw", "ladesaeulen-bw: candidates just inside and just outside the 24 h confirmation are deleted run by run as by the old node"],
  ],
  pruneReset: [
    ["prune", "prune: a failed listing between confirmation runs restarts the 24 h, as in the old node"],
    ["prune", "a reset of the confirmation table restarts the 24 h", "scenario"],
    ["prune", "prune: implausible master data clear the confirmation table"],
  ],
  pruneFirstRun: [
    ["prune", "arms quietly, then deletes stale own ids only (grace, keep, foreign id)", "scenario"],
    ["prune", "more than 30 % of the stock is refused", "scenario"],
  ],
  prune207: [
    ["prune", "207: only confirmed deletes count; every attempted one loses its signature", "scenario"],
  ],
  roadworks: [
    ["baustellen-bw", "baustellen-bw: identical on the full gui/public boundary file (swapped points assigned)"],
    ["baustellen-bw", "baustellen-bw: more than 5 % invalid coordinates warn identically"],
    ["baustellen-bw", "baustellen-bw: ended, id-less, renamed, invalid and point-less features (test inputs) agree"],
  ],
  commitBehindUpsert: [
    ["sig-commit", "signature commit: old SIG_COMMIT node and Orion.upsert commit identically for every broker answer"],
    ["sig-commit", "signature commit: each chunk commits only its own pending signatures"],
    ["mobility-invariants", "mobility invariants: gate replace for whole-stock runs, merge per system, commit only via the plan"],
    ["change-gate", "change gate: retain can only keep or drop confirmed entries, never write"],
  ],
  signatures: [
    ["pegel-bw", "pegel-bw: a failed upsert resends, a confirmed one gates — per chunk, and per entity on a 207"],
    ["pegel-bw", "pegel-bw: commit after a confirmed upsert matches the old commit node, next run is freshness only"],
    ["sig-commit", "signature commit: each chunk commits only its own pending signatures"],
  ],
  gbfsZero: [
    ["sharing-bw", "sharing-bw: ffLast tables — old zeros are the emptied summaries, confirmed once, empty feed none, failed repeated"],
    ["sharing-bw", "sharing-bw: old FN_GBFS_FF and port build the same summaries and pending entries on two live feeds"],
    ["sharing-bw", "sharing-bw: an emptied summary is deleted, not zeroed — outside the age prune, retried, written anew (deliberate)"],
  ],
  parkingFreshness: [
    ["parken-bw", "parken-bw: entities, pending signatures and parkStatik/parkFrei/parkSummenSig match across two runs"],
    ["parken-bw", "parken-bw: run() upserts the old chunks and resets the confirmations on an incomplete run"],
  ],
  parkingLegacy: [
    ["parken-bw", "parken-bw: the legacy cleanup deletes only own old slug ids past the grace — unknown slug, late, untimed and municipal ids stay"],
    ["parken-bw", "parken-bw: legacy sites just inside and just outside the 7-day grace are deleted as by the old node"],
    ["parken-bw", "parken-bw: the legacy cleanup switches itself off after an empty listing"],
    ["parken-bw", "parken-bw: a complete run prunes the same ids (sites, sums, legacy), never a municipal entity"],
    ["mobility-invariants", "mobility invariants: every prune is anchored, bounded and guarded; legacy prune intact"],
    ["mobility-invariants", "mobility invariants: parking site ids from the ParkAPI key, without the AGS"],
  ],
  ocpdbPages: [
    ["ladesaeulen-bw", "ladesaeulen-bw: all pages from total_count, the cap of 60 and the skips match the old fan-out"],
    ["ladesaeulen-bw", "ladesaeulen-bw: an incomplete run writes the old chunks, merges the tables, resets the confirmations"],
    ["ladesaeulen-bw", "ladesaeulen-bw: a complete run prunes the same stations and sums and forgets the station signatures"],
    ["ladesaeulen-bw", "ladesaeulen-bw: register entries without live status carry no live values and no dateObserved"],
  ],
  cityPulse: [
    ["puls-bw", "puls-bw: old node and run(ctx) write identical pulses; Freiburg scored by hand along the documented method"],
    ["puls-bw", "puls-bw: fewer than three components everywhere warns and writes nothing, as before"],
    ["puls-bw", "puls-bw: a stale or empty roadworks feed drops the component everywhere, on both sides"],
    ["puls-bw", "puls-bw: without a population figure there is no sharing component, on both sides"],
    ["puls-bw", "puls-bw: two pages complete; a shifted page or an HTTP 503 skips the run with the same warning"],
  ],
  carsharingMasterData: [
    ["carsharing-bw", "carsharing-bw: a new station list replaces that system's stations, other systems stay"],
    ["carsharing-bw", "carsharing-bw: a station list without a station in BW leaves the cache alone"],
  ],
  carsharingOwnership: [
    ["carsharing-bw", "carsharing-bw: run() requests, upserts and prunes (ownGbfs, signatures forgotten) as the two old flows"],
    ["mobility-invariants", "mobility invariants: every prune is anchored, bounded and guarded; legacy prune intact"],
  ],
  ocpdbRate: [
    ["orion", "orion: upsert chunks and deletes queue in the broker's token bucket, one per second"],
    ["ladesaeulen-bw", "ladesaeulen-bw: complete runs replace the split tables, a vanished location loses its signatures"],
    ["ladesaeulen-bw", "ladesaeulen-bw: an incomplete run writes the old chunks, merges the tables, resets the confirmations"],
  ],
  pulseShare: [
    ["puls-bw", "puls-bw: dropped pulses are pruned on the second run exactly as by the old node"],
    ["puls-bw", "puls-bw: two pages complete; a shifted page or an HTTP 503 skips the run with the same warning"],
  ],
};

function carriedBy(invariant) {
  const entries = CARRIED_BY[invariant];
  assert(entries && entries.length, `no connectors test named for ${invariant}`);
  for (const [file, name, kind] of entries) {
    const at = path.join(PARITY, file + ".test.ts");
    assert(fs.existsSync(at), `${invariant}: ${file}.test.ts is gone`);
    const test = fs.readFileSync(at, "utf8");
    const marker = kind === "scenario" ? `name: ${JSON.stringify(name)}` : `as ${JSON.stringify(name)}`;
    assert(test.includes(marker),
      `${invariant}: ${file}.test.ts no longer asserts ${kind === "scenario" ? "the scenario " : ""}"${name}"`);
  }
}

exports["No entity id from slugged free text"] = () => {
  // Every module of src/connectors, see mobility-invariants.test.ts.
  carriedBy("slug");
};

exports["Parking sites carry stable ids from the ParkAPI key"] = () => {
  carriedBy("parkingIds");
};

exports["ParkAPI paginates by cursor, not by offset"] = () => {
  // The ParkAPI v3 ignores offset silently: offset=0/500/…/2500 returned
  // byte-identical answers. Reintroducing it fetches the same 500 records 66×.
  carriedBy("cursor");
  const parkApi = MODULES.filter(module => portedCode(module).includes("park-api"));
  // Not vacuous: a renamed host must not turn the check into a silent pass.
  assert(parkApi.length > 0, "no connector module talks to the ParkAPI (park-api) any more — update this check");
  for (const module of parkApi) {
    const c = portedCode(module);
    assert(!/offset=/.test(c), `${module}: ParkAPI request with offset= again — the v3 API ignores it`);
    assert(/start=/.test(c), `${module}: ParkAPI request without the cursor parameter start=`);
  }
};

exports["ParkAPI fetch checks page overlap and caps the loop"] = () => {
  carriedBy("overlap");
};

exports["Change gate: replace mode for whole-stock runs, carsharing merges"] = () => {
  // Whole-stock runs may replace the signature table, per-system runs (one
  // GBFS system per run) must merge — or change detection never applies there.
  carriedBy("gateModes");
};

exports["TRoE statistics know the row budget from the registry"] = () => {
  // Backwards compatible: connectors without rowBudget24h stay unchallenged.
  assert(REGISTRY.some(c => !c.rowBudget24h), "test assumption void: every connector carries a budget");
  carriedBy("troeBudget");
  // The port takes the budget from the kernel, which sums the live registry.
  const port = portedCode("troe-stats");
  assert(/parse\(\{ \.\.\.snapshot, budget: ctx\.rowBudget \}\)/.test(port), "troe-stats does not check against ctx.rowBudget");
  assert(/if \(stats\.budgetWarning !== null\) ctx\.log\.warn\(stats\.budgetWarning\)/.test(port), "budget overrun stays silent in troe-stats");
  assert(/`TRoE-Zeilenbudget \(24 h\) überschritten — /.test(port), "budget warning text changed in troe-stats");
  assert(/rowBudget: sumRowBudgets\(kernel\.registry\.entries\)/.test(code("kernel/context.ts")),
    "ctx.rowBudget is no longer the registry sum");
};

/* A database connector's session: a server-side statement timeout that fires
   before the client's query timeout (the latter only gives up and leaves the
   query running). Returns the module's code for further checks. */
function portHasServerTimeout(module) {
  const c = portedCode(module);
  const ms = key => {
    const m = new RegExp(key + ":\\s*([\\d_]+)").exec(c);
    return m ? Number(m[1].replace(/_/g, "")) : NaN;
  };
  assert(ms("statementTimeoutMs") > 0, `${module}: no server-side statement timeout`);
  assert(ms("statementTimeoutMs") < ms("queryTimeoutMs"), `${module}: the server-side timeout does not fire before the client's`);
  return c;
}

/* The 10-minute statistics once counted the whole attributes table. The
   client timeout did not stop the server query, runs piled up and kept
   TimescaleDB at its CPU limit. Guard both halves of the fix. */
exports["TRoE statistics stay cheap: server-side timeout, no full scan, overlap guard"] = () => {
  carriedBy("troeCheap");
  const c = portHasServerTimeout("troe-stats");
  assert(!/count\(DISTINCT/i.test(c), "count(DISTINCT …) in troe-stats – that is a full scan");
  const reads = c.match(/FROM attributes\b[^"`]*/g) || [];
  assert(reads.length > 0, "troe-stats: no read of attributes found – the check went blind");
  for (const q of reads) assert(/WHERE ts >/.test(q), "unbounded query on attributes in troe-stats: " + q);
  assert(/applicationName: "udp-troe-stats"/.test(c) && /application_name = 'udp-troe-stats'/.test(c),
    "overlap guard missing in troe-stats");
  assert(/INSERT INTO udp_troe_type_stats/.test(portHasServerTimeout("troe-retention")),
    "retention no longer fills the nightly type statistics");
};

/* Municipality assignment. The former helper fell back to the nearest
   municipality centroid, so objects outside Baden-Württemberg (Basel, Alsace,
   Palatinate, Bavaria) were counted in the nearest BW municipality. Only
   inputs guaranteed to lie in BW may still use the centroid fallback. */
const CENTROID_WHITELIST = ["connectors/uba-bw.ts"];   // UBA stations, pre-selected by DEBW code

exports["No centroid fallback outside the whitelist"] = () => {
  carriedBy("centroid");
  for (const file of ALL_SOURCES) {
    const c = code(file);
    assert(!/\bnearest\s*\(/.test(c), `${file}: uses the removed nearest() with centroid fallback`);
    assert(!/\.slice\(0, 2\) !== "08"/.test(c), `${file}: an '08' check after the lookup suggests a centroid fallback`);
    if (CENTROID_WHITELIST.includes(file)) continue;
    assert(!/nearestOrCentroid/.test(c), `${file}: centroid fallback outside the whitelist`);
    assert(!/dy \* dy \+ dx \* dx|Math\.hypot\(/.test(c), `${file}: own nearest-centroid search`);
  }
  assert(/export function nearestOrCentroid\(/.test(portedCode("uba-bw")), "whitelist entry uba-bw no longer has the fallback — shrink the whitelist");
  // The geo context offers no centroid lookup that someone could pick up by accident.
  const types = code("kernel/types.ts");
  const start = types.indexOf("export interface GeoIndex {");
  assert(start >= 0, "GeoIndex not found in kernel/types.ts");
  const geoIndex = types.slice(start, types.indexOf("\n}", start));
  assert(!/nearest|centroid/i.test(geoIndex), "GeoIndex offers a nearest/centroid lookup again");
};

exports["Strict lookup: Stuttgart yes, Basel/Strasbourg/Kaiserslautern no"] = () => {
  carriedBy("strictLookup");
};

exports["The connector service reaches the cockpit on its container port"] = () => {
  // The service fetches the project's static files (bw-gemeinden.json,
  // bw-grenzen.json, oepnv-halte.json) from the cockpit, whose unprivileged
  // nginx listens on 8080 only; Compose maps no ports between containers.
  for (const file of ALL_SOURCES) {
    assert(!/https?:\/\/cockpit(?!:8080\b)/.test(code(file)),
      `${file}: http://cockpit/ without port 8080 — nginx-unprivileged listens on 8080 only (Compose)`);
  }
  assert(/export const COCKPIT_URL = "http:\/\/cockpit:8080";/.test(code("kernel/env.ts")), "COCKPIT_URL is not http://cockpit:8080");
  assert(/DEFAULT_URL = `\$\{COCKPIT_URL\}\/bw-gemeinden\.json`/.test(portedCode("stammdaten-bw")), "stammdaten-bw does not load from the cockpit");
  assert(/DEFAULT_URL = `\$\{COCKPIT_URL\}\/bw-grenzen\.json`/.test(portedCode("grenzen-bw")), "grenzen-bw does not load from the cockpit");
  const apps = fs.readFileSync(path.join(ROOT, "helm/udp/templates/apps.yaml"), "utf8");
  const svc = apps.slice(apps.lastIndexOf("kind: Service"));
  assert(/name: cockpit/.test(svc) && /port: 8080, targetPort: 8080/.test(svc),
    "Helm Service cockpit does not expose port 8080");
};

/* Every module that prunes has its option objects compared with the old
   node's (test/harness/prune-settings.ts) in the named test. */
const PRUNE_SETTINGS = {
  "baustellen-bw": ["baustellen-bw", "baustellen-bw: old and new prune delete the same stale own ids, foreign ids stay"],
  "carsharing-bw": ["carsharing-bw", "carsharing-bw: run() requests, upserts and prunes (ownGbfs, signatures forgotten) as the two old flows"],
  "eco-bw": ["eco-bw", "eco-bw: the daily prune arms and deletes as the old node did, foreign ids untouched"],
  "feinstaub-bw": ["feinstaub-bw", "feinstaub-bw: prune in the detail runs only, armed then deleting, as the old node on full master data"],
  "ladesaeulen-bw": ["ladesaeulen-bw", "ladesaeulen-bw: a complete run prunes the same stations and sums and forgets the station signatures"],
  "parken-bw": ["parken-bw", "parken-bw: a complete run prunes the same ids (sites, sums, legacy), never a municipal entity"],
  "puls-bw": ["puls-bw", "puls-bw: dropped pulses are pruned on the second run exactly as by the old node"],
  "sharing-bw": ["sharing-bw", "sharing-bw: run() requests, drops vanished tables, prunes and upserts as the old flow"],
};

exports["Prune steps carry their safety guards"] = () => {
  carriedBy("pruneGuards");
  const pruning = MODULES.filter(m => /\bprune\.stale\(/.test(portedCode(m))).sort();
  assert(pruning.length >= 5, `only ${pruning.length} connectors prune`);
  assert.deepStrictEqual(pruning, Object.keys(PRUNE_SETTINGS).sort(),
    "a module prunes without its settings being compared (PRUNE_SETTINGS), or the table names one that no longer prunes");
  for (const [module, [file, name]] of Object.entries(PRUNE_SETTINGS)) {
    const test = fs.readFileSync(path.join(PARITY, file + ".test.ts"), "utf8");
    assert(test.includes(`as ${JSON.stringify(name)}`), `${file}.test.ts no longer asserts "${name}"`);
    assert(test.includes(`assertPruneSettings(${JSON.stringify(module)}`), `${file}.test.ts no longer compares the prune settings of ${module}`);
  }
  // Patterns: literal (or a literal constant of the module), anchored, not .*
  let patterns = 0;
  for (const module of pruning) {
    const c = portedCode(module);
    for (const m of c.matchAll(/\bpattern:\s*("[^"]*"|`[^`]*`|[A-Z_]+)/g)) {
      let value = m[1];
      if (/^[A-Z_]+$/.test(value)) {
        const constant = new RegExp(`const ${value} =\\s*("[^"]*")`).exec(c);
        assert(constant, `${module}: prune pattern ${value} is not a literal constant of the module`);
        value = constant[1];
      }
      const p = value.slice(1, -1);
      patterns++;
      assert(p.startsWith("^urn:ngsi-ld:") && p.endsWith("$"), `${module}: prune pattern not anchored: ${p}`);
      assert(!/\.\*/.test(p), `${module}: prune pattern with .* is too broad: ${p}`);
    }
  }
  assert(patterns >= 12, `only ${patterns} prune patterns found — the check went blind`);
};

exports["Prune: confirmation needs 24 h of consecutive runs"] = () => {
  carriedBy("pruneConfirmation");
};

exports["Prune: a skipped run resets the confirmation"] = () => {
  carriedBy("pruneReset");
};

exports["Prune: first run and share limit skip"] = () => {
  carriedBy("pruneFirstRun");
};

exports["Prune: 207 counts only confirmed deletions"] = () => {
  carriedBy("prune207");
};

exports["Roadworks: strict lookup and coordinate check"] = () => {
  carriedBy("roadworks");
  const rw = portedCode("baustellen-bw");
  assert(/ctx\.geo\.forRun\(LABEL\)/.test(rw), "roadworks run without required boundaries");
  assert(/geo\.municipalityAt\(y, x\)/.test(rw), "roadworks not assigned by the strict lookup");
  assert(/swapped \+= 1/.test(rw), "roadworks without swapped-coordinate repair");
  assert(/result\.invalid > result\.features \* 0\.05/.test(rw), "no warning on many invalid coordinates");
  assert(!/bw-gemeinden/.test(rw), "roadworks fetch bw-gemeinden.json again");
};

/* Every gated connector hands its signatures to Orion.upsert as pending; the
   kernel commits them for the ids the broker confirmed — otherwise a failed
   write marks values as sent. */
exports["Change signatures are committed only behind the upsert"] = () => {
  carriedBy("commitBehindUpsert");
  const gated = MODULES.filter(m => /\bgate\.(check|table|retain)\(|upsertChanged\(/.test(portedCode(m)));
  assert(gated.length >= 11, `only ${gated.length} modules use change signatures`);
  for (const module of MODULES) {
    const c = portedCode(module);
    assert(!/\.commit\(/.test(c), `${module}: commits signatures itself`);
    assert(!/\bSignature(Store|Scope)\b/.test(c), `${module}: reaches into the signature store past the gate`);
  }
  const types = code("kernel/types.ts");
  const start = types.indexOf("export interface ChangeGate {");
  assert(start >= 0, "ChangeGate not found in kernel/types.ts");
  assert(!/\bcommit\s*\(/.test(types.slice(start, types.indexOf("\n}", start))),
    "ChangeGate offers a commit — a connector could commit before the write");
};

exports["Signatures: failed upsert resends, confirmed upsert gates, 207 per entity, per chunk"] = () => {
  carriedBy("signatures");
};

exports["GBFS: vanished municipalities get their summary deleted once, empty feeds do not"] = () => {
  carriedBy("gbfsZero");
};

exports["Parking: realtime sites refresh dateObserved, static sites stay silent"] = () => {
  carriedBy("parkingFreshness");
};

exports["Parking legacy ids: guarded one-off cleanup"] = () => {
  carriedBy("parkingLegacy");
};

exports["OCPDB: all pages from total_count, capped, completeness before prune"] = () => {
  carriedBy("ocpdbPages");
  const oc = portedCode("ladesaeulen-bw");
  assert(/export const MAX_PAGES = 60;/.test(oc), "OCPDB page cap changed");
  assert(/if \(built\.complete && built\.stations\.length > 0 && \(await ctx\.prune\.masterDataPlausible\(\)\)\)/.test(oc),
    "OCPDB prunes without the completeness guard");
};

exports["CityPulse: honest minimum, roadworks coverage, normalized sharing, stale dust, pagination"] = () => {
  carriedBy("cityPulse");
};

exports["Carsharing: master data run replaces the system's stations"] = () => {
  carriedBy("carsharingMasterData");
};

exports["Carsharing prunes only touch entities of this connector"] = () => {
  carriedBy("carsharingOwnership");
  const cs = portedCode("carsharing-bw");
  assert(/provider\.value === PROVIDER/.test(cs), "ownGbfs no longer checks the dataProvider");
  const calls = cs.split("prune.stale({").slice(1).map(c => c.slice(0, c.indexOf("});")));
  assert.strictEqual(calls.length, 2);
  for (const c of calls) {
    assert(/accept: ownGbfs/.test(c) && /attrs: \[[^\]]*"dataProvider"/.test(c), "carsharing prune without ownership check");
  }
};

/* The city page called parking and B+R values "Echtzeit" without looking at
   their age. staleStand() decides; the parking/B+R texts must use it. */
exports["GUI: realtime labels only for current values"] = () => {
  const lib = fs.readFileSync(path.join(ROOT, "gui/public/smartcity-lib.js"), "utf8");
  const start = lib.indexOf("  const obsTime = e => {");
  const end = lib.indexOf("  };", lib.indexOf("  const staleStand = ")) + 4;
  assert(start > 0 && end > start, "obsTime/staleStand missing in smartcity-lib.js");
  const staleStand = new Function(lib.slice(start, end) + "\nreturn staleStand;")();
  const at = ms => new Date(Date.now() - ms).toISOString();
  const H = 3600e3;
  assert.strictEqual(staleStand({ dateObserved: { value: { "@type": "DateTime", "@value": at(H) } } }, 6 * H), "");
  assert.strictEqual(staleStand({ realtimeFree: { value: 3, observedAt: at(H) } }, 6 * H), "");
  assert(/^Stand: \d\d\.\d\d\. \d\d:\d\d$/.test(staleStand({ dateObserved: { value: at(7 * H) } }, 6 * H)));
  assert.strictEqual(staleStand([{ dateObserved: { value: at(9 * H) } }, { dateObserved: { value: at(H) } }], 6 * H), "",
    "newest entity decides");
  assert.strictEqual(staleStand({ name: { value: "x" } }, 6 * H), "Stand unbekannt");
  const page = fs.readFileSync(path.join(ROOT, "gui/public/stadt.html"), "utf8");
  // Age of the realtime sum only (dateObserved, realtimeFree), not of siteCount.
  assert(/const pkStand = [^;]*staleStand\(\{ dateObserved: pk\.dateObserved, realtimeFree: pk\.realtimeFree \}, STALE\.parken\)/.test(page),
    "parking tile without age check of the realtime sum");
  assert(/const brStand = staleStand\(bikes, STALE\.parken\)/.test(page), "B+R tile without age check");
  assert(!/hint: "freie Plätze, Echtzeit", explain/.test(page), "B+R still labelled Echtzeit unconditionally");
  assert(/"name,operator,vehicleType,availableVehicles,capacity,ags,location,dateObserved"/.test(page), "carsharing popup without dateObserved or vehicleType");
};

/* Review follow-ups: OCPDB rate limit and gated sums, pulse share limit,
   stale pulses in the GUI, row budgets. */
exports["OCPDB: rate-limited upsert, municipal sums gated"] = () => {
  // The delay node in front of the old upsert is the Orion host's token
  // bucket now; the orion test pins it for every write.
  carriedBy("ocpdbRate");
  const oc = portedCode("ladesaeulen-bw");
  assert(/await ctx\.orion\.upsert\(plan, \{ chunkSize: CHUNK_SIZE \}\)/.test(oc), "OCPDB no longer writes through ctx.orion");
  assert(/staticKey: SUMMARY_STATIC,[^}]*replace: built\.complete,\s*freshEvery: 3,/.test(oc),
    "municipal sums are no longer gated");
  assert(/label: "OCPDB ChargingSummary",[\s\S]*?confirmKey: summaryKey,\s*confirmMs: 24 \* HOUR_MS/.test(oc),
    "sums are no longer refreshed every run, their prune needs the confirmation mode");
  // The writes (upsert, delete) come before the reads in the Orion client.
  const orion = code("kernel/orion.ts");
  const writes = orion.slice(orion.indexOf("  async upsert("), orion.indexOf("  async count("));
  assert(/async delete\(/.test(writes) && !/bucket: null/.test(writes), "Orion writes left the token bucket");
};

exports["CityPulse: higher share limit, stale pulses marked in the GUI"] = () => {
  carriedBy("pulseShare");
  const n = portedCode("puls-bw");
  assert(/type: "CityPulse",[\s\S]*?maxFraction: 0\.8/.test(n), "CityPulse prune without its own share limit");
  assert(/\["br", "BikeParking", undefined,/.test(n), "pulse B+R limited to one connector");
  const page = fs.readFileSync(path.join(ROOT, "gui/public/stadt.html"), "utf8");
  assert(/const pStand = staleStand\(pulse, 3 \* 3600e3\)/.test(page), "pulse tile without age check");
  const kreis = fs.readFileSync(path.join(ROOT, "gui/public/kreis.html"), "utf8");
  assert(/const pulsVals = pulseAktuell\.filter/.test(kreis) && /pulseAktuell\.forEach/.test(kreis), "district average counts stale pulses");
};

exports["Row budgets cover the new freshness volume"] = () => {
  const b = Object.assign({}, ...REGISTRY.map(c => c.rowBudget24h || {}));
  for (const t of ["EVChargingStation", "ChargingSummary", "CarSharingStation", "CityPulse"]) assert(b[t] > 0, "no row budget for " + t);
};

/* Weather tiles: the Open-Meteo values carry their age like parking and
   charging do. The threshold follows the real cadence of wetter-bw and
   vorhersage-bw: two missed runs plus a margin. */
exports["GUI: weather tiles show their age after two missed Open-Meteo runs"] = () => {
  const page = fs.readFileSync(path.join(ROOT, "gui/public/stadt.html"), "utf8");
  const takt = Number((page.match(/const OM_TAKT_H = (\d+);/) || [])[1]);
  for (const id of ["wetter-bw", "vorhersage-bw"]) {
    assert.strictEqual(REGISTRY.find(c => c.id === id).intervalSeconds, takt * 3600, `${id}: OM_TAKT_H is not its cadence`);
  }
  const expr = (page.match(/const STALE = \{[^\n]*wetter: ([^}\n]+?) \};/) || [])[1];
  assert(expr, "STALE.wetter missing");
  const maxAge = new Function("OM_TAKT_H", `return ${expr};`)(takt);
  const H = 3600e3;
  assert(maxAge > 2 * takt * H && maxAge <= 2 * takt * H + 2 * H, `STALE.wetter ${maxAge / H} h, expected 2 × ${takt} h plus a small margin`);
  assert(/const wxStand = wx \? staleStand\(wx, STALE\.wetter\)/.test(page), "weather tiles without age check");
  assert(/const fcStand = fcEnt \? staleStand\(fcEnt, STALE\.wetter\)/.test(page), "forecast values without age check");
  assert(/hint: fcStand \|\| "aktuell \(Open-Meteo\)"/.test(page), "UV tile still labelled current unconditionally");
  assert(!/3-stündlich|2-h-Takt/.test(page), "outdated Open-Meteo cadence in the texts");

  const lib = fs.readFileSync(path.join(ROOT, "gui/public/smartcity-lib.js"), "utf8");
  const start = lib.indexOf("  const obsTime = e => {");
  const end = lib.indexOf("  };", lib.indexOf("  const staleStand = ")) + 4;
  const staleStand = new Function(lib.slice(start, end) + "\nreturn staleStand;")();
  const at = ms => new Date(Date.now() - ms).toISOString();
  // WeatherObserved carries observedAt on its values, WeatherForecast a dateObserved.
  assert.strictEqual(staleStand({ temperature: { value: 20, observedAt: at(12 * H) } }, maxAge), "");
  assert(/^Stand: /.test(staleStand({ temperature: { value: 20, observedAt: at(maxAge + H) } }, maxAge)));
  assert.strictEqual(staleStand({ dateObserved: { value: { "@type": "DateTime", "@value": at(12 * H) } } }, maxAge), "");
  assert(/^Stand: /.test(staleStand({ dateObserved: { value: { "@type": "DateTime", "@value": at(maxAge + H) } } }, maxAge)));
};
