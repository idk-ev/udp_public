/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Load test: realistic municipality page loads (k6).
 *
 * Every virtual user repeatedly opens a random municipality page the way
 * gui/public/stadt.html does it – ~25 API requests in parallel (entities by id,
 * type+ags queries, district road works, water levels nearby, departures, one
 * temporal sparkline) – without think time. Random municipalities mostly miss
 * the cockpit cache, so this measures the backend, not nginx.
 *
 * Runs against a LIVE platform: start small, only deliberately, never in CI.
 * The test aborts by itself at > 30 % failed requests.
 *
 *   docker run --rm -e VUS=10 -e BASE=https://udp.example.org \
 *     -v "$PWD/tests/load:/s" -v "$PWD/gui/public/bw-gemeinden.json:/s/bw-gemeinden.json" \
 *     grafana/k6 run -q /s/municipality-page.js
 *
 * Target: 20 VUs, page p95 < 3 s, < 1 % errors.
 * Baseline 2026-09-24 (before the Mongo indexes): 3 VUs -> page p95 34 s.
 *
 * Note: per-client rate limiting (apisix.rateLimit) applies – all VUs share
 * the tester's IP, so above ~30 req/s sustained the gateway answers 429. For
 * capacity tests beyond that, raise the limit temporarily or test from
 * several addresses.
 */
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';

const gemeinden = JSON.parse(open('/s/bw-gemeinden.json')).gemeinden
  .map(g => ({ ags: g[0], krs: g[4], lat: g[2], lon: g[3] }));
const BASE = (__ENV.BASE || 'https://udp.example.org').replace(/\/$/, '');
const VUS = Number(__ENV.VUS || 5);

const pageDuration = new Trend('page_duration', true);
const pages = new Counter('pages');
const status = {};
for (const c of ['200', '400', '404', '429', '500', '502', '503', '504', '0', 'other']) status[c] = new Counter('status_' + c);

export const options = {
  vus: VUS,
  duration: __ENV.DURATION || '30s',
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'max'],
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.3', abortOnFail: true, delayAbortEval: '10s' }],
  },
};

const GW = `${BASE}/gateway/ngsi-ld/v1/entities`;
const TEMPORAL = `${BASE}/gateway/temporal/temporal/entities/`;
const byId = id => `${GW}/${encodeURIComponent(id)}`;
const byAgs = (type, ags, attrs) =>
  `${GW}?type=${type}&q=ags%3D%3D%22${ags}%22&limit=1000` + (attrs ? `&attrs=${attrs}` : '');

export default function () {
  const { ags, krs, lat, lon } = gemeinden[Math.floor(Math.random() * gemeinden.length)];
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const urls = [
    byId(`urn:ngsi-ld:WeatherObserved:bw-${ags}`),
    byId(`urn:ngsi-ld:Alert:bw-kreis-${krs}-dwd`),
    byId(`urn:ngsi-ld:Alert:bw-kreis-${krs}-nina`),
    byAgs('AirQualityObserved', ags),
    byAgs('ParkingSummary', ags),
    byAgs('SharingSummary', ags),
    byAgs('ChargingSummary', ags),
    byAgs('TrafficFlowObserved', ags),
    byId(`urn:ngsi-ld:EnergyMonitor:bw-${ags}`),
    byId(`urn:ngsi-ld:CityPulse:bw-${ags}`),
    `${BASE}/abfahrten?ags=${ags}`,
    `${GW}?type=RoadWork&q=ags~%3D%5E${krs}&limit=1000&attrs=name,ags,gemeindeName,endDate,description,location`,
    `${GW}?type=WaterLevelObserved&georel=near%3BmaxDistance%3D%3D20000&geometry=Point` +
      `&coordinates=%5B${lon}%2C${lat}%5D&limit=200&attrs=name,water,level,levelState,floodLevels,measuredAt,dataProvider,ags,location`,
    `${GW}?type=PollenForecast&limit=5`,
    byId(`urn:ngsi-ld:CivicStructure:bw-${ags}-rathaus`),
    byId(`urn:ngsi-ld:TouristDestination:bw-${ags}`),
    byAgs('EVChargingStation', ags, 'name,operator,socketNumber,availableEvse,chargingEvse,defectEvse,liveEvse,ags,location'),
    byId(`urn:ngsi-ld:WeatherForecast:bw-${ags}`),
    byAgs('CarSharingStation', ags, 'name,operator,availableVehicles,capacity,ags,location'),
    `${GW}?type=HeatHealthWarning&limit=10&options=keyValues`,
    byId(`urn:ngsi-ld:PublicAmenity:bw-${ags}`),
    byAgs('WasteContainer', ags),
    byAgs('ParkingSite', ags, 'name,totalSpotNumber,availableSpotNumber,category,ags,location'),
    `${TEMPORAL}${encodeURIComponent(`urn:ngsi-ld:WeatherObserved:bw-${ags}`)}` +
      `?attrs=windSpeed&timerel=after&timeAt=${since}&options=temporalValues`,
  ];
  const t0 = Date.now();
  const res = http.batch(urls.map(u => ['GET', u, null, { headers: { Accept: 'application/json' }, timeout: '20s' }]));
  pageDuration.add(Date.now() - t0);
  pages.add(1);
  for (const r of res) (status[String(r.status)] || status.other).add(1);
}

export function handleSummary(d) {
  const m = d.metrics;
  const v = k => (m[k] ? m[k].values : {});
  const n = k => v(k).count || 0;
  const codes = Object.keys(m).filter(k => k.startsWith('status_') && n(k)).map(k => `${k.slice(7)}:${n(k)}`).join(' ');
  const s = x => (x == null ? '-' : (x / 1000).toFixed(1) + 's');
  return {
    stdout: `VUs=${VUS} pages=${n('pages')} pages/s=${(v('pages').rate || 0).toFixed(2)} ` +
      `req/s=${(v('http_reqs').rate || 0).toFixed(0)} page_p50=${s(v('page_duration')['p(50)'])} ` +
      `page_p95=${s(v('page_duration')['p(95)'])} failed=${((v('http_req_failed').rate || 0) * 100).toFixed(1)}% ` +
      `codes[${codes}]\n`,
  };
}
