/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The ported connectors, by registry id.
 *
 * One line per connector; nothing else in the service needs to know about them,
 * because scheduling, triggering and cadence all come from
 * platform/config/connectors.json. Shared helpers of a group (efa.ts,
 * overpass.ts, open-meteo-batches.ts, http-payload.ts) are not connectors and
 * are not listed.
 *
 * A connector listed here does not run yet on that account. It runs when its
 * registry entry says `"runtime": "app"`, which is the cutover in phase 4.
 */

import { connector as abfahrtenOnDemand } from "./abfahrten-on-demand.js";
import { connector as ausflugBw } from "./ausflug-bw.js";
import { connector as baustellenBw } from "./baustellen-bw.js";
import { connector as ecoBw } from "./eco-bw.js";
import { connector as efaAbfahrten } from "./efa-abfahrten.js";
import { connector as feinstaubBw } from "./feinstaub-bw.js";
import { connector as grenzenBw } from "./grenzen-bw.js";
import { connector as hitzeBw } from "./hitze-bw.js";
import { connector as hystreet } from "./hystreet.js";
import { connector as mastrBw } from "./mastr-bw.js";
import { connector as opsHost } from "./ops-host.js";
import { connector as pegelBw } from "./pegel-bw.js";
import { connector as pegelLubw } from "./pegel-lubw.js";
import { connector as poiBw } from "./poi-bw.js";
import { connector as pulsBw } from "./puls-bw.js";
import { connector as pollenBw } from "./pollen-bw.js";
import { connector as rathausBw } from "./rathaus-bw.js";
import { connector as stammdatenBw } from "./stammdaten-bw.js";
import { connector as troeRetention } from "./troe-retention.js";
import { connector as troeStats } from "./troe-stats.js";
import { connector as ubaBw } from "./uba-bw.js";
import { connector as vorhersageBw } from "./vorhersage-bw.js";
import { connector as warnungenBw } from "./warnungen-bw.js";
import { connector as wetterBw } from "./wetter-bw.js";
import { connector as wetterDwdStation } from "./wetter-dwd-station.js";
import type { ConnectorId, ConnectorRunner } from "../kernel/types.js";

const MODULES: readonly ConnectorRunner[] = [
  // Geo context first: nearly every other connector depends on it.
  stammdatenBw,
  grenzenBw,
  // A · operations
  opsHost,
  troeStats,
  troeRetention,
  // B · weather
  wetterBw,
  vorhersageBw,
  pollenBw,
  hitzeBw,
  // C · water & warnings
  pegelBw,
  pegelLubw,
  warnungenBw,
  baustellenBw,
  // D · Overpass
  rathausBw,
  ausflugBw,
  poiBw,
  // F · air & energy
  ubaBw,
  feinstaubBw,
  ecoBw,
  mastrBw,
  pulsBw,
  // G · public transport & endpoints
  efaAbfahrten,
  abfahrtenOnDemand,
  hystreet,
  wetterDwdStation,
];

export const CONNECTORS: ReadonlyMap<ConnectorId, ConnectorRunner> = new Map(
  MODULES.map((module) => [module.id, module]),
);
