# UDP connector service

Ingestion of the open data sources into NGSI-LD. Replaces the generated Node-RED
flows step by step (`platform/config/nodered/flows.json`).

**Status: phase 3b — all 29 connectors ported, contract gaps closed.** The
kernel matches the current flow generator (strict municipality lookup, commit
of change signatures after a confirmed upsert, pruning of stale entities);
every connector is pinned by parity tests against its old function nodes.
Nothing is switched over yet: all 29 connectors keep running in Node-RED until
phase 4 sets `"runtime": "app"` per connector.

## Why

The flows are a generated artifact: `scripts/generate-nodered-flows.py` writes
4,768 lines of JavaScript into a 442 KB JSON file. The editor is not used — in
Kubernetes there is deliberately no volume on `/data`, so a change made in the
editor does not survive the next pod restart. That makes Node-RED a JSON
interpreter here, not a low-code environment, and it is paid for with a lack of
testability: the ParkAPI incident of 24.08.2026 ran unnoticed for a month,
because logic inside a string cannot be checked with a fixture.

Node-RED **stays** — as a low-code building block with the example tab, as
B.II.4 of the service specification demands. Only the ingestion moves out.

The full migration plan with phases and work split is in
[`docs/migration-konnektoren.md`](../../docs/migration-konnektoren.md).

## Layout

    src/index.ts               entry point: registry, scheduler, public and admin server
    src/kernel/types.ts        THE CONTRACT — Ctx, ConnectorModule, NgsiEntity, …
    src/kernel/context.ts      assembles the kernel and one Ctx per connector
    src/kernel/registry.ts     platform/config/connectors.json, narrowed
    src/kernel/env.ts          environment access (env.get of the flows), COCKPIT_URL
    src/kernel/parse.ts        narrowing building blocks for foreign data
    src/kernel/ngsi.ts         cleanText, observed (P), dateObserved
    src/kernel/fetcher.ts      fetch with timeout, retry, User-Agent
    src/kernel/rate-limit.ts   token bucket per host (the delay nodes), optional concurrency cap
    src/kernel/state.ts        ctx.state: per-connector in-memory state (stateKey)
    src/kernel/orion.ts        upsert + signature commit, delete, find, paged list
    src/kernel/change-gate.ts  change detection, two-phase (check -> commit)
    src/kernel/geo.ts          geo context, strict municipality lookup
    src/kernel/prune.ts        removal of stale own entities, with its guards
    src/kernel/scheduler.ts    interval/cron, delayed start
    src/kernel/http.ts         HTTP server (used twice: public and admin port)
    src/kernel/admin.ts        admin routes: /healthz, /trigger/:id with cooldown
    src/kernel/db.ts           TimescaleDB sessions for troe-stats / troe-retention
    src/kernel/log.ts          [warn]/[error] lines for scripts/healthcheck.sh
    src/connectors/index.ts    the ported connectors, by registry id
    src/connectors/*.ts        one module per connector
    test/harness/              vm runner for the old function nodes, diff, test kernel
    test/fixtures/             recorded (and trimmed) source responses
    test/parity/               old against new, per connector and per kernel helper
    test/hardening/            proofs that the hardening takes effect

## The contract

`src/kernel/types.ts` is the only thing a port is written against. A module
exports `parse(raw: unknown)` (narrow, get loud on malformed input), a pure
`build(raw, geo, now)` (no network, no clock — this is what the parity harness
diffs) and `run(ctx)` for the I/O. Three kernel facilities carry the lessons the
flows learned the hard way:

- **Geo:** `ctx.geo.forRun(label, requirements?)` returns the index or `null`
  after logging the skip. The lookup is strict — polygon or nothing, with a
  ~330 m sliver tolerance — and there is no centroid fallback: that put rental
  bikes from Basel into Lörrach. Without boundaries the run is skipped unless
  the module declares `{ boundaries: "optional" }` by name.
- **Change gate:** `ctx.gate.check(...)` returns an `UpsertPlan` whose new
  signatures are only *pending*; `ctx.orion.upsert(plan)` commits them for the
  ids the broker confirmed (2xx, or per entity on 207). Storing them before
  the write froze values for weeks during Orion outages. `ctx.orion
  .upsertChanged(...)` does check, upsert and commit in one call; an ungated
  write says so with `ctx.gate.ungated(entities)`. Tables are namespaced per
  connector, and `ctx.gate.retain(...)` can only keep or drop entries, never
  write one.
- **Prune:** `ctx.prune.stale(options)` deletes own entities a complete run no
  longer produces — only with plausible master data (the 95 % reference is
  seeded from Orion after a start; no prune while Orion cannot answer), a
  complete listing, the interval, grace/confirmation and share guards, an
  anchored pattern, and only what the broker confirms.

```ts
export async function run(ctx: Ctx): Promise<void> {
  const response = await ctx.fetch.json(SOURCE_URL);
  if (!response.ok) {
    ctx.log.warn(`source not loadable (HTTP ${String(response.status)})`);
    return;
  }
  const geo = ctx.geo.forRun("BW roadworks"); // boundaries required by default
  if (geo === null) return; // already logged
  const entities = build(parse(response.body), geo, ctx.now());
  if (entities.length === 0) return;

  // Road works are written in full every run (no gate in the old flow either).
  await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: 100 });

  // After a complete, successful, non-empty run only. Never throws.
  await ctx.prune.stale({
    label: "BW roadworks",
    type: "RoadWork",
    pattern: "^urn:ngsi-ld:RoadWork:bw-(svz-[A-Za-z0-9_-]+|kreis-[0-9]{5}-summary)$",
    attrs: ["ags", "dateObserved", "activeCount"],
    keep: new Set(entities.map((entity) => entity.id)),
    graceMs: 24 * 3_600_000,
  });
}
```

A gated connector replaces the plain upsert with one call —
`await ctx.orion.upsertChanged("pegelSig", entities, signatureOf, { chunkSize: 50 })`
— or, when several sources share one write (`parken-bw`), builds plans with
`ctx.gate.check(...)`, adds its own `PendingSignature`s and hands
`mergePlans(...)` to `ctx.orion.upsert(...)`.

Endpoints are built with the connector's own ctx:
`routes: (ctx) => [{ method: "GET", path: "/abfahrten", handle }]`.

The rest of the ctx, added in phase 3b where the ports pinched:

- **`ctx.state`** — per-connector state that is neither a signature nor prune
  bookkeeping (the old flow/global context: `oepnvHalte`, `mastrPos`,
  `scTakt`, …). Declare a key once at module level and read it through the
  ctx; the key carries the type, so no assertion is needed:

  ```ts
  const RUNS = stateKey("scTakt", () => 0); // src/kernel/state.ts
  const runs = ctx.state.slot(RUNS); // StateSlot<number>
  runs.set(runs.get() + 1);
  ```

  `run` and the connector's `routes` share it; no other connector sees it.
  Never a module-level `let` or `WeakMap<Ctx, …>`: state belongs to the ctx.
  It lives in memory, like the signature store and the prune bookkeeping, and
  all three move to Postgres together in phase 6.
- **`ctx.rowBudget`** — `rowBudget24h` of every registry entry summed per
  type (`ROW_BUDGET` of the generator), for `troe-stats`.
- **`ctx.entry`** carries what connectors read from the registry, including
  `sensorDetailFor`; use `ctx.intervalMs()` rather than copying an interval.
- **Rate limiting** — `FetchOptions.minIntervalMs` spaces starts per host,
  `maxConcurrent` caps requests in flight per host (Overpass: 1 across all
  three connectors); the strictest value seen for a host wins. Orion reads
  (`find`, `list`, `count`) are unpaced (`bucket: null`) so they never queue
  behind a write backlog; writes stay paced.
- **`SqlParam`** accepts `readonly string[]` for `$1::text[]`.

## Ports

| Port | Env (default) | Serves | Exposure |
|---|---|---|---|
| public | `UDP_CONNECTORS_PORT` (1880) | only the routes connectors register (`/abfahrten`, `/warnungen.ics`) | proxied by the cockpit nginx |
| admin | `UDP_CONNECTORS_ADMIN_PORT` (1881), bound to `UDP_CONNECTORS_ADMIN_HOST` (0.0.0.0) | `GET /healthz`, `POST /trigger/:id` | **never** mapped by nginx, APISIX or an ingress; in Compose published on the host at most on 127.0.0.1 |

Around every route the server answers what Express answered around the old
`http in` nodes: `HEAD` on a `GET` route (same status and headers, no body),
`OPTIONS` (200, `Allow: GET,HEAD`, the list as body), and 304 for a
`GET`/`HEAD` whose `If-None-Match` matches the route's `ETag` (`weakEtag` in
src/kernel/http.ts). Routes see the request headers, names lowercased.

`/trigger` on the public port is a 404: it makes the service fetch a source and
write to Orion, which must not be reachable from the internet. A trigger within
`UDP_TRIGGER_COOLDOWN_SECONDS` (60) of the previous one, or while a run is
active, answers 429 with a `Retry-After` instead of starting another run. The
admin host defaults to all interfaces so container probes reach it; phase 5
points `scripts/trigger-connector.sh` at the admin port.

## Developing

    npm install
    npm run build          # tsc -> dist/
    npm run typecheck      # tsc --noEmit
    npm run lint           # eslint, type-aware
    node ../../tests/run.js

`tests/run.js` in the repository root is the project's only test runner; the
parity tests hang in there as well (`dist/test/parity/`). The `pre-commit` hook
builds beforehand.

## Type discipline — binding

These rules are not a question of style. 29 connectors are ported with the work
split up; a single lenient module devalues the typing for all the others,
because then exactly the unwieldy external data runs through the program
unchecked again.

**External data enters the program as `unknown` and is _narrowed_, never
_asserted._** Every source gets a parse function
`(raw: unknown) => GaugeResponse` that gets loud in the error case. That is the
same check as today's
`if (!msg.payload || !Array.isArray(msg.payload.gemeinden)) return null;` — only
in one place and with a type as the result.

Enforced technically, not merely requested:

| Blocked | By |
|---|---|
| `any` | `@typescript-eslint/no-explicit-any` + the `no-unsafe-*` family |
| `x as T` | `consistent-type-assertions: never` (`as const` stays allowed) |
| `x!` | `no-non-null-assertion` |
| `enum`, `namespace` | `erasableSyntaxOnly` in `tsconfig.json` |
| an unnoticed missing `await` | `no-floating-promises` |
| `eslint-disable` | `noInlineConfig` — the comments simply have no effect |

`test/hardening/` shows that all of this really takes effect:
`tests/static/type-discipline.test.js` calls `tsc` and `eslint` and expects both
to **fail**. Whoever switches off a hardening turns these proofs green — and
thereby brings the test down. So a loosening is noticed instead of spreading
quietly across 29 modules.

For ports there is one more rule: types in the kernel are not touched. If the
contract pinches, that is a report to the review — not a detour inside your own
module.

## Switching over per connector

A connector is rehooked via the registry, not via a code path:

```json
{ "id": "troe-stats", "runtime": "app" }
```

`generate-nodered-flows.py` drops switched-over connectors from `flows.json`,
and this service picks up exactly those. If the field is missing, `"nodered"`
still applies. The way back: turn the field back, run the generator, roll out
again.

`scripts/healthcheck.sh` does not need to be touched for this — it measures the
freshness of the entities in Orion, not the runtime that wrote them.
