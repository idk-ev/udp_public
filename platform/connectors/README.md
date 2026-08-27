# UDP connector service

Ingestion of the open data sources into NGSI-LD. Replaces the generated Node-RED
flows step by step (`platform/config/nodered/flows.json`).

**Status: phase 0 — scaffold.** Nothing is ingested here yet. All 29 connectors
keep running entirely in Node-RED.

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

    src/index.ts          entry point
    src/kernel/           scheduler, HTTP, fetch, rate limiting, Orion, geo   (phase 1)
    src/kernel/types.ts   THE CONTRACT — Ctx, ConnectorModule, NgsiEntity
    src/connectors/       one module per connector                            (phase 3)
    test/harness/         vm runner for the old function nodes
    test/fixtures/        recorded source responses
    test/parity/          old against new, per connector
    test/hardening/       proofs that the hardening takes effect

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
