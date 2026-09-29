# UDP connector service

Ingestion of the open data sources into NGSI-LD — every active entry of the
registry `platform/config/connectors.json` that has a module here.

**Status: in production, all 29 connectors run here.** The migration from the
generated Node-RED flows is complete (phase 6 of
[`docs/migration-konnektoren.md`](../../docs/migration-konnektoren.md)):
Node-RED stays as a low-code building block with an example flow, as B.II.4 of
the service specification demands, and ingests nothing. Change signatures,
prune bookkeeping and persisted `ctx.state` live in PostgreSQL, so a restart
does not rewrite every gated entity (see [State store](#state-store)).

## Why

The flows were a generated artifact: a Python generator wrote 4,768 lines of
JavaScript into a 442 KB JSON file. The editor was not used — in Kubernetes
there was deliberately no volume on `/data`, so a change made in the editor did
not survive the next pod restart. That made Node-RED a JSON interpreter, not a
low-code environment, paid for with a lack of testability: the ParkAPI
incident of 24.08.2026 ran unnoticed for a month, because logic inside a string
cannot be checked with a fixture.

**History in the code.** Module headers cite the old nodes by id
(`udp-rt-bp-build`, `FN_PARK_FETCH`, …) and the generator
`scripts/generate-nodered-flows.py`, removed in phase 6 (its last version is in
the git history). The old function nodes themselves are frozen in
`test/fixtures/legacy-flows.json`; the parity tests run them in `node:vm`
against the same fixtures as the modules, so they stay the regression suite.

## Adding a connector

1. Registry entry in `platform/config/connectors.json` (id, cadence, scope,
   monitoring fields; `docs/staedte-hinzufuegen.md` lists them).
2. A module `src/connectors/<id>.ts` against the contract below — `parse`,
   pure `build`, `run(ctx)` — and one line in `src/connectors/index.ts`.
   `test/parity/registry.test.ts` fails while registry and modules disagree.
3. A test in `test/parity/<id>.test.ts` with a recorded, trimmed fixture in
   `test/fixtures/`: a unit test of `build` and `run` (new connectors have no
   old node to compare against; the ported ones keep their parity tests).
4. `scripts/export-connector-status.py` for the dashboards' status export,
   then build, lint and `node ../../tests/run.js`.

## Layout

    src/index.ts               entry point: registry, scheduler, public and admin server
    src/kernel/types.ts        THE CONTRACT — Ctx, ConnectorModule, NgsiEntity, …
    src/kernel/context.ts      assembles the kernel and one Ctx per connector
    src/kernel/registry.ts     platform/config/connectors.json, narrowed
    src/kernel/env.ts          environment access (env.get of the flows), COCKPIT_URL
    src/kernel/parse.ts        narrowing building blocks for foreign data
    src/kernel/ngsi.ts         cleanText, observed (P), dateObserved
    src/kernel/fetcher.ts      fetch with timeout, retry, User-Agent, body cap, redirect policy
    src/kernel/rate-limit.ts   token bucket per host (the delay nodes), optional concurrency cap
    src/kernel/state.ts        ctx.state: per-connector state (stateKey, optionally persisted)
    src/kernel/persistence.ts  state store: load before the first run, write-through, one writer
    src/kernel/persistence-pg.ts  its PostgreSQL backend (schema udp_connectors, advisory lock)
    src/kernel/orion.ts        upsert + signature commit, delete, find, paged list
    src/kernel/change-gate.ts  change detection, two-phase (check -> commit)
    src/kernel/geo.ts          geo context, strict municipality lookup
    src/kernel/geo-bootstrap.ts  loads the geo context at startup and every 6 h, no Orion write
    src/kernel/prune.ts        removal of stale own entities, with its guards
    src/kernel/scheduler.ts    interval/cron, delayed start
    src/kernel/http.ts         HTTP server (used twice: public and admin port)
    src/kernel/admin.ts        admin routes: /healthz, /trigger/:id (loopback only) with cooldown
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
  The context is filled by the kernel itself (the **geo bootstrap**,
  `src/kernel/geo-bootstrap.ts`): before the scheduler starts, and then every
  6 h (the files change only with a rebuilt platform; every 5 min while it is
  still empty), it loads `bw-gemeinden.json` and `bw-grenzen.json` from the
  cockpit (`UDP_MUNICIPALITIES_URL` / `UDP_BOUNDARIES_URL` override) with the
  parsers of `stammdaten-bw` and `grenzen-bw` — so the geo-dependent
  connectors do not wait for those two connectors' schedules. It writes
  nothing to Orion, runs only with at least one scheduled connector, keeps the
  previous context on a failed load (one `[warn]` per failure streak) and
  keeps a degraded boundary file degraded (no prune). The two connectors fill
  the same context from the same files; last write wins. `/healthz` reports it
  under `geo`.
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
  persisted, and seeded from Orion where none is stored yet; no prune while
  Orion cannot answer), a
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
  const RUNS = stateKey("scTakt", () => 0, persisted.number); // src/kernel/state.ts
  const runs = ctx.state.slot(RUNS); // StateSlot<number>
  runs.set(runs.get() + 1);
  ```

  `run` and the connector's `routes` share it; no other connector sees it.
  Never a module-level `let` or `WeakMap<Ctx, …>`: state belongs to the ctx.
  A key with a codec (`persisted.number`, `.boolean`, `.numberMap`, or an own
  `StateCodec`) is persisted with the signatures and survives a restart; a key
  without one is a process-lifetime cache for what the next run rebuilds
  anyway (stop directory, station cache).
- **`ctx.rowBudget`** — `rowBudget24h` of every registry entry summed per
  type, for `troe-stats`.
- **`ctx.entry`** carries what connectors read from the registry, including
  `sensorDetailFor`; use `ctx.intervalMs()` rather than copying an interval.
- **Rate limiting** — `FetchOptions.minIntervalMs` spaces starts per host,
  `maxConcurrent` caps requests in flight per host (Overpass: 1 across all
  three connectors); the strictest value seen for a host wins. Orion reads
  (`find`, `list`, `count`) are unpaced (`bucket: null`) so they never queue
  behind a write backlog; writes stay paced.
- **`SqlParam`** accepts `readonly string[]` for `$1::text[]`.

## State store

The change gate's signature tables, the prune bookkeeping (interval
bookkeeping, confirmation tables, master data reference) and every `ctx.state`
key declared with a codec are persisted per connector in PostgreSQL. A process
that forgets them writes every gated entity in full on its next run (~400k
TRoE rows per restart, `parken-bw` alone ~230k).

- **Where:** the TimescaleDB of `ctx.db` (same `TROE_DB_HOST`, `TROE_DB_USER`,
  `TROE_DB_PASSWORD`, database `orion`), schema `udp_connectors`, never Orion's
  tables. Created at startup with `CREATE SCHEMA/TABLE IF NOT EXISTS`; the user
  needs `CREATE` on the database, or the schema has to exist.

  | Table | Key | Holds |
  |---|---|---|
  | `signatures` | `connector, table_key, field` | one signature (`value` jsonb: string or number) |
  | `prune_state` | `connector` | the prune bookkeeping as one jsonb document |
  | `connector_state` | `connector, name` | one persisted `ctx.state` key (jsonb) |

- **Load before the first run.** Every connector is loaded as soon as the
  writer lock is held: at startup, and again in the background right after
  the lock was lost and taken back (a database switchover, e.g. on every
  release) — not each connector before its next run. A failed load is
  retried after 30 s; before every run the connector's own load is checked
  once more, so a run never proceeds on unloaded state (it waits for a load
  in flight). While a connector's state is not loaded, the change gate and
  persisted state keys throw and the run is skipped with a `[warn]`; prunes
  are skipped with a `[warn]` and touch no bookkeeping; a gated upsert is not
  sent. Connectors that use none of it run normally. No scheduled connector
  = no connection at all.
- **Write-through.** A signature dropped in memory is persisted *before* the
  upsert goes out; if that fails, a gated upsert is not sent. A committed
  signature is persisted after the broker confirmed it, per chunk. The
  database therefore never holds a signature the broker did not confirm. A
  prune removes the persisted signatures of its candidates before it deletes.
  Bookkeeping and state are written when they change and at the end of every
  run. A failed write keeps memory as it is and is retried with the next one;
  one `[warn]` per failure streak.
- **One writer.** The service runs as exactly one replica (Helm:
  `replicas: 1`, `strategy: Recreate`). A session advisory lock held for the
  process lifetime enforces it: a second instance loads nothing, runs only
  ungated connectors and takes over once the lock is free.
- **`/healthz`** reports `stateStore` (`healthy`, `reason`, `writer`,
  `reloading`, loaded / not loaded / load-failed / write-failing connectors).
  `healthy` is false without the writer lock, while a load or write fails, or
  when a connector is not loaded outside a running reload; a connector merely
  queued in the reload after startup or a lock change (seconds) does not flip
  it. `reason` is set exactly when `healthy` is false. It stays 200:
  restarting does not fix a database.
- **New connector:** it has no signatures in the store yet, so its first run
  writes in full once. A one-time cost per connector, not per restart.

## Ports

| Port | Env (default) | Serves | Exposure |
|---|---|---|---|
| public | `UDP_CONNECTORS_PORT` (1880) | only the routes connectors register (`/abfahrten`, `/warnungen.ics`) | proxied by the cockpit nginx |
| admin | `UDP_CONNECTORS_ADMIN_PORT` (1881), bound to `UDP_CONNECTORS_ADMIN_HOST` (0.0.0.0) | `GET /healthz`, `POST /trigger/:id` | **never** mapped by nginx, APISIX or an ingress; Compose binds it to 127.0.0.1 (in-container only), in no Kubernetes Service |

Around every route the server answers what Express answered around the old
`http in` nodes: `HEAD` on a `GET` route (same status and headers, no body),
`OPTIONS` (200, `Allow: GET,HEAD`, the list as body), and 304 for a
`GET`/`HEAD` whose `If-None-Match` matches the route's `ETag` (`weakEtag` in
src/kernel/http.ts). Routes see the request headers, names lowercased.

`/trigger` on the public port is a 404: it makes the service fetch a source and
write to Orion, which must not be reachable from the internet. A trigger within
`UDP_TRIGGER_COOLDOWN_SECONDS` (60, never less) of the previous one, or while a
run is active, answers 429 with a `Retry-After` instead of starting another run.
The admin host defaults to all interfaces so kubelet probes reach `/healthz`;
Compose sets `UDP_CONNECTORS_ADMIN_HOST=127.0.0.1`, since its healthcheck runs
inside the container. `/trigger` itself answers only a loopback peer (403
otherwise), so `scripts/trigger-connector.sh` runs it inside the container
(`docker exec` / `kubectl exec`). No route reads a request body.

In Kubernetes the admin port is protected by two things only: the
NetworkPolicy (no rule opens 1881) and the loopback check of `/trigger`.
Consequences:

- Never run the pod behind a service mesh sidecar (or any proxy) that forwards
  inbound traffic to the application from 127.0.0.1 — every peer would then look
  like loopback and `/trigger` would be open to whoever reaches the pod.
- With `networkPolicies.enabled=false` port 1881 is reachable from the whole
  cluster: `/trigger` still refuses non-loopback peers, but `/healthz` is
  readable by anyone.

## Deployment

| | Compose (`platform/docker-compose.yml`) | Helm (`helm/udp`) |
|---|---|---|
| unit | service `connectors`, container `udp-connectors` | Deployment + Service `connectors`, `replicas: 1`, `Recreate` |
| image | built from this Dockerfile (context: repository root) | `udp-connectors` (`connectors.image`), built by `.github/workflows/build-images.yml` |
| registry | the checkout's `connectors.json`, mounted read-only | baked into the image |
| public port 1880 | not published; reachable from every container on the compose network | Service port; NetworkPolicy: cockpit only |
| admin port 1881 | bound to 127.0.0.1, in-container only | in no Service; no NetworkPolicy rule |
| health | Compose healthcheck: `/healthz` inside the container | startup/liveness `/healthz`, readiness TCP 1880 |

Liveness never looks at `stateStore.healthy`. The cockpit reaches the two
endpoints through `UDP_CONNECTORS_UPSTREAM` (default `connectors:1880`; Helm:
`cockpit.connectorsUpstream`, default the `connectors` Service). Operations:
[`docs/betrieb.md`](../../docs/betrieb.md), section "Konnektordienst".

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

## Registry fields of the migration

`runtime` and `nodePrefixes` decided, during the migration, which runtime ran a
connector and which generated nodes belonged to it. Both are gone from the
registry; the guard in `src/kernel/registry.ts` ignores them like any other
field it does not read, so a fork that still carries them loses nothing —
every active entry runs here.
