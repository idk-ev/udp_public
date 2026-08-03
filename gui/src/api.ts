/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// NGSI-LD-Anbindung (Orion-LD über APISIX) inkl. Mandanten-Header und
// Demo-Modus, falls die Plattform nicht erreichbar ist (z. B. reine GUI-Vorschau).

import { config } from "./config";

export interface NgsiEntity {
  id: string;
  type: string;
  [attr: string]: unknown;
}

export interface TemporalPoint {
  time: string;
  value: number;
}

let currentTenant = "";
export function setTenant(t: string) {
  currentTenant = t;
}
export function getTenant() {
  return currentTenant;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    ...extra,
  };
  if (currentTenant) h["NGSILD-Tenant"] = currentTenant;
  return h;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// --- Live-Zugriffe -----------------------------------------------------------

export async function fetchEntityTypes(): Promise<string[]> {
  const data = await fetchJson<{ typeList?: string[] }>(
    `${config.gatewayUrl}/ngsi-ld/v1/types`,
    { headers: headers() },
  );
  return (data.typeList ?? []).map((t) => t.split(/[#/]/).pop() ?? t);
}

export async function fetchEntities(type?: string, limit = 100): Promise<NgsiEntity[]> {
  if (type) {
    const q = new URLSearchParams({ type, limit: String(limit) });
    return fetchJson<NgsiEntity[]>(
      `${config.gatewayUrl}/ngsi-ld/v1/entities?${q}`,
      { headers: headers() },
    );
  }
  // Ohne Typfilter: erst "local=true" versuchen, sonst über die Typliste sammeln
  // (ältere Broker lehnen zu breite Abfragen ab).
  try {
    const q = new URLSearchParams({ local: "true", limit: String(limit) });
    return await fetchJson<NgsiEntity[]>(
      `${config.gatewayUrl}/ngsi-ld/v1/entities?${q}`,
      { headers: headers() },
    );
  } catch {
    const types = await fetchEntityTypes();
    const perType = await Promise.all(
      types.slice(0, 20).map((t) => fetchEntities(t, limit).catch(() => [])),
    );
    return perType.flat().slice(0, limit);
  }
}

export async function fetchTemporal(
  entityId: string,
  attr: string,
  hours = 24,
): Promise<TemporalPoint[]> {
  const timeAt = new Date(Date.now() - hours * 3600_000).toISOString();
  const q = new URLSearchParams({
    attrs: attr,
    timerel: "after",
    timeAt,
  });
  const data = await fetchJson<Record<string, unknown>>(
    `${config.gatewayUrl}/temporal/temporal/entities/${encodeURIComponent(entityId)}?${q}`,
    { headers: headers() },
  );
  const series = data[attr];
  const list = Array.isArray(series) ? series : series ? [series] : [];
  return list
    .map((p) => {
      const o = p as { value?: unknown; observedAt?: string; modifiedAt?: string };
      return {
        time: o.observedAt ?? o.modifiedAt ?? "",
        value: typeof o.value === "number" ? o.value : NaN,
      };
    })
    .filter((p) => p.time && !Number.isNaN(p.value))
    .sort((a, b) => a.time.localeCompare(b.time));
}

export interface ComponentStatus {
  name: string;
  role: string;
  url: string;
  ok: boolean | null;
}

const probeTargets: Omit<ComponentStatus, "ok">[] = [
  { name: "Orion-LD Context Broker", role: "NGSI-LD Echtzeit-Kontext", url: `${config.gatewayUrl}/ngsi-ld/ex/v1/version` },
  { name: "Mintaka", role: "NGSI-LD Temporal API", url: `${config.gatewayUrl}/temporal/health` },
  { name: "FROST-Server", role: "OGC SensorThings API", url: `${config.gatewayUrl}/FROST-Server/v1.1/` },
  { name: "IoT-Agent (JSON/MQTT)", role: "Geräteanbindung", url: `${config.gatewayUrl}/iot/about` },
  { name: "CKAN", role: "Open-Data-Katalog (DCAT-AP.de)", url: `${config.gatewayUrl}/catalog/api/3/action/status_show` },
  { name: "GeoServer", role: "OGC WMS/WFS", url: `${config.gatewayUrl}/geoserver/web/` },
];

export async function probeComponents(): Promise<ComponentStatus[]> {
  return Promise.all(
    probeTargets.map(async (t) => {
      try {
        const res = await fetch(t.url, { signal: AbortSignal.timeout(4000) });
        return { ...t, ok: res.ok };
      } catch {
        return { ...t, ok: false };
      }
    }),
  );
}

// --- Demo-Modus ---------------------------------------------------------------
// Liefert plausible Beispieldaten, wenn kein Context Broker erreichbar ist,
// damit die Oberfläche jederzeit vorführbar bleibt.

export const demoEntities: NgsiEntity[] = [
  mkDemo("urn:ngsi-ld:WeatherObserved:wetzlar-mitte", "WeatherObserved", 8.5010, 50.5658, { temperature: 19.4, relativeHumidity: 0.63 }),
  mkDemo("urn:ngsi-ld:WeatherObserved:dillenburg-bhf", "WeatherObserved", 8.2871, 50.7407, { temperature: 18.1, relativeHumidity: 0.71 }),
  mkDemo("urn:ngsi-ld:ParkingSpot:wetzlar-p1", "OffStreetParking", 8.5043, 50.5561, { availableSpotNumber: 74, totalSpotNumber: 220 }),
  mkDemo("urn:ngsi-ld:ParkingSpot:alsfeld-p2", "OffStreetParking", 9.2711, 50.7512, { availableSpotNumber: 12, totalSpotNumber: 90 }),
  mkDemo("urn:ngsi-ld:Streetlight:lauterbach-081", "Streetlight", 9.3941, 50.6378, { powerState: "on", illuminanceLevel: 0.8 }),
  mkDemo("urn:ngsi-ld:AirQualityObserved:herborn-1", "AirQualityObserved", 8.3062, 50.6822, { pm25: 8.2, pm10: 14.6, no2: 21.3 }),
  mkDemo("urn:ngsi-ld:WasteContainer:wetzlar-w17", "WasteContainer", 8.4949, 50.5539, { fillingLevel: 0.42 }),
  mkDemo("urn:ngsi-ld:EVChargingStation:alsfeld-e1", "EVChargingStation", 9.2769, 50.7488, { availableCapacity: 2, capacity: 4 }),
];

function mkDemo(
  id: string,
  type: string,
  lon: number,
  lat: number,
  props: Record<string, number | string>,
): NgsiEntity {
  const e: NgsiEntity = {
    id,
    type,
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
  };
  for (const [k, v] of Object.entries(props)) {
    e[k] = { type: "Property", value: v, observedAt: new Date().toISOString() };
  }
  return e;
}

export function demoTemporal(hours = 24): TemporalPoint[] {
  const pts: TemporalPoint[] = [];
  const now = Date.now();
  let v = 18 + Math.random() * 3;
  const n = hours * 4; // 15-Minuten-Raster
  for (let i = n; i >= 0; i--) {
    v += (Math.random() - 0.5) * 0.6;
    const dayPhase = Math.sin(((now - i * 900_000) % 86_400_000) / 86_400_000 * Math.PI * 2 - Math.PI / 2);
    pts.push({
      time: new Date(now - i * 900_000).toISOString(),
      value: Math.round((v + dayPhase * 2.5) * 10) / 10,
    });
  }
  return pts;
}

export function entityCoords(e: NgsiEntity): [number, number] | null {
  const loc = e.location as
    | { value?: { type?: string; coordinates?: [number, number] } }
    | undefined;
  const c = loc?.value?.coordinates;
  return Array.isArray(c) && c.length >= 2 ? [c[0], c[1]] : null;
}

// HTML-Maskierung für die wenigen Stellen, die Markup als String bauen müssen
// (maplibre-Popups). JSX maskiert selbst — hier ist es Handarbeit, weil die
// Werte aus dem Context Broker kommen.
const ESC_MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export function plainValue(attr: unknown): string {
  if (attr === null || attr === undefined) return "–";
  if (typeof attr !== "object") return String(attr);
  const v = (attr as { value?: unknown }).value;
  if (v === undefined) return "–";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
