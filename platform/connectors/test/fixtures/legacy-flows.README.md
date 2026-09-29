# legacy-flows.json

Frozen reference of the old Node-RED connector code, for the parity tests only.

- **What:** `platform/config/nodered/flows.json` exactly as it stood at commit
  `c3419c2` ("Konnektordienst: Test fuer verworfene Uploads robust gegen
  Verbindungsabbruch"), the last commit before the first connector was set to
  `"runtime": "app"` in `platform/config/connectors.json`. Byte-identical to
  that blob (`git rev-parse c3419c2:platform/config/nodered/flows.json` =
  `d583e418fa1edfee69153972a149f39d2afbb377`). At that commit all 29
  connectors still ran in Node-RED, so every old function node, request node,
  exec node and inject node is in here.
- **Why:** from the first cutover on, `scripts/generate-nodered-flows.py` drops
  a switched-over connector's nodes from the live `flows.json`, and phase 6
  shrinks that file to the example tab (`docs/migration-konnektoren.md`). The
  parity tests compare every ported module against its old node; they need the
  old side to outlive the live file.
- **Who reads it:** `test/harness/fixtures.ts` (`legacyFlowsPath()`) and through
  it `test/harness/vm-runner.ts`, `test/harness/prune-settings.ts` and the
  parity tests that read nodes, wires or URLs directly (`source-urls`,
  `efa-abfahrten`, `ops-host`, …). Nothing else.
- **Never regenerated, never edited, never deployed.** The generator does not
  know this file; no Dockerfile, Compose file or Helm chart copies it. A change
  to connector behaviour goes into `platform/connectors/src`, and a parity test
  that has to accept it states the deviation in the test, not in this file.
- **Its limit:** the old nodes carry values the generator baked in from the
  registry of that commit (run intervals, the summed row budgets, the EFA stop
  list, …). A parity test that feeds the port from the live registry compares
  against those frozen values; changing such a registry value later means
  adjusting that test, not this file.
