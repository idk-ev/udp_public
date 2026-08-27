/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Entry point of the UDP connector service.
 *
 * Phase 0 (scaffold): the service starts, reports in and exits again. Registry,
 * scheduler and HTTP server arrive in phase 1 from src/kernel/ — until then
 * nothing is ingested here. The connectors keep running entirely in Node-RED;
 * the switch happens per connector via the registry field "runtime" (see
 * README.md).
 */

const VERSION = "0.0.0-scaffold";

function start(): void {
  const now = new Date().toISOString();
  process.stdout.write(
    `[info] udp-connectors ${VERSION} — scaffold in place, no connectors active yet (${now})\n`,
  );
}

start();
