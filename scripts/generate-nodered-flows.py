#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Generiert alle udp-rt-*-Flow-Tabs (Reutlingen + BW + Betrieb) und schreibt sie nach platform/config/nodered/flows.json (Demo-Tab bleibt erhalten)."""
import json, sys
from datetime import datetime, timezone

from pathlib import Path
FLOWS = str(Path(__file__).resolve().parent.parent / "platform" / "config" / "nodered" / "flows.json")
REGISTRY_PATH = str(Path(__file__).resolve().parent.parent / "platform" / "config" / "connectors.json")
STATUS_EXPORT = str(Path(__file__).resolve().parent.parent / "gui" / "public" / "connectors-status.json")
with open(REGISTRY_PATH, encoding="utf-8") as _f:
    REGISTRY = json.load(_f)["connectors"]
REG = {c["id"]: c for c in REGISTRY}

def reg_param(conn_id, key, ags):
    return REG[conn_id].get("params", {}).get(key, {}).get(ags)

CTX = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld"
UPSERT = "http://orion-ld:1026/ngsi-ld/v1/entityOperations/upsert?options=update"

nodes = []

def tab(nid, label, info):
    nodes.append({"id": nid, "type": "tab", "label": label, "info": info})

def inject(nid, z, name, repeat, delay, wires, y):
    nodes.append({
        "id": nid, "type": "inject", "z": z, "name": name,
        "props": [{"p": "payload"}], "repeat": str(repeat), "crontab": "",
        "once": True, "onceDelay": str(delay), "topic": "", "payload": "",
        "payloadType": "date", "x": 150, "y": y, "wires": [wires],
    })

def http_get(nid, z, name, url, wires, y, x=400):
    nodes.append({
        "id": nid, "type": "http request", "z": z, "name": name,
        "method": "GET", "ret": "obj", "paytoqs": "ignore", "url": url,
        "persist": False, "authType": "", "senderr": False, "headers": [],
        "x": x, "y": y, "wires": [wires],
    })

def func(nid, z, name, code, wires, y, x=650, libs=None):
    nodes.append({
        "id": nid, "type": "function", "z": z, "name": name, "func": code,
        "outputs": 1, "timeout": "", "noerr": 0, "initialize": "", "finalize": "",
        "libs": libs or [], "x": x, "y": y, "wires": [wires],
    })

def upsert(nid, z, wires, y, x=890):
    nodes.append({
        "id": nid, "type": "http request", "z": z, "name": "Upsert Orion-LD",
        "method": "POST", "ret": "txt", "paytoqs": "ignore", "url": UPSERT,
        "persist": False, "authType": "", "senderr": False, "headers": [],
        "x": x, "y": y, "wires": [wires],
    })

def http_in(nid, z, url, wires, y, x=150):
    nodes.append({
        "id": nid, "type": "http in", "z": z, "name": "", "url": url, "method": "get",
        "upload": False, "swaggerDoc": "", "x": x, "y": y, "wires": [wires],
    })

def http_response(nid, z, y, x=1100):
    nodes.append({
        "id": nid, "type": "http response", "z": z, "name": "", "statusCode": "",
        "headers": {}, "x": x, "y": y, "wires": [],
    })

def batch_delete(nid, z, wires, y, x=890):
    """Sammel-Löschung: msg.payload ist ein Array von Entitäts-IDs."""
    nodes.append({
        "id": nid, "type": "http request", "z": z, "name": "Löschen Orion-LD",
        "method": "POST", "ret": "txt", "paytoqs": "ignore",
        "url": "http://orion-ld:1026/ngsi-ld/v1/entityOperations/delete",
        "persist": False, "authType": "", "senderr": False,
        "headers": [{"keyType": "Content-Type", "keyValue": "", "valueType": "other",
                     "valueValue": "application/json"}],
        "x": x, "y": y, "wires": [wires],
    })

# Gemeinde-Zuordnung per Punkt-in-Polygon; von mehreren Konnektoren genutzt und
# deshalb vor der ersten Verwendung definiert.
NEAREST_HELPER = r'''
const GEM = global.get('bwGemeinden');
if (!Array.isArray(GEM)) { node.warn('bwGemeinden noch nicht im Kontext — Stammdaten-Flow abwarten'); return null; }
// Punkt-in-Polygon (vereinfachte Gemeindegrenzen) mit Zentroid-Fallback (F1)
const GRZ = global.get('bwGrenzen') || null;
const GEMBYAGS = {};
for (const r of GEM) GEMBYAGS[r[0]] = r;
const pip = (lat, lon, rings) => {
    for (const ring of rings) {
        let ins = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
        }
        if (ins) return true;
    }
    return false;
};
const nearest = (lat, lon) => {
    if (GRZ) {
        for (const ags in GRZ) {
            const g = GRZ[ags], b = g.b;
            if (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3] && pip(lat, lon, g.r)) {
                const row = GEMBYAGS[ags];
                if (row) return row;
            }
        }
    }
    let best = null, bd = Infinity;
    for (const r of GEM) {
        const dy = r[2] - lat, dx = (r[3] - lon) * 0.66;
        const d = dy * dy + dx * dx;
        if (d < bd) { bd = d; best = r; }
    }
    return best;
};
const CTX = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const NOW = new Date().toISOString();
const P = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: NOW });
'''

def debug(nid, z, name, y, x=1100):
    nodes.append({
        "id": nid, "type": "debug", "z": z, "name": name, "active": True,
        "tosidebar": True, "console": False, "tostatus": False,
        "complete": "true", "targetType": "full", "statusVal": "", "statusType": "auto",
        "x": x, "y": y, "wires": [],
    })

def catch(nid, z, dbg, y):
    nodes.append({"id": nid, "type": "catch", "z": z, "name": "Fehler abfangen",
                  "scope": None, "uncaught": False, "x": 150, "y": y, "wires": [[dbg]]})

def delay_rate(nid, z, wires, y):
    nodes.append({
        "id": nid, "type": "delay", "z": z, "name": "1 Anfrage/s",
        "pauseType": "rate", "timeout": "5", "timeoutUnits": "seconds",
        "rate": "1", "nbRateUnits": "1", "rateUnits": "second",
        "randomFirst": "1", "randomLast": "5", "randomUnits": "seconds",
        "drop": False, "allowrate": False, "outputs": 1, "x": 400, "y": y, "wires": [wires],
    })

def delay_slow(nid, z, wires, y, secs):
    nodes.append({
        "id": nid, "type": "delay", "z": z, "name": f"1 Anfrage/{secs}s",
        "pauseType": "rate", "timeout": "5", "timeoutUnits": "seconds",
        "rate": "1", "nbRateUnits": str(secs), "rateUnits": "second",
        "randomFirst": "1", "randomLast": "5", "randomUnits": "seconds",
        "drop": False, "allowrate": False, "outputs": 1, "x": 400, "y": y, "wires": [wires],
    })

def join_parts(nid, z, wires, y, x=650, timeout=120):
    nodes.append({
        "id": nid, "type": "join", "z": z, "name": "join (parts)",
        "mode": "custom", "build": "array", "property": "payload", "propertyType": "msg",
        "key": "topic", "joiner": "\\n", "joinerType": "str", "useparts": True,
        "accumulate": False, "timeout": str(timeout), "count": "", "reduceRight": False,
        "x": x, "y": y, "wires": [wires],
    })

def join(nid, z, count, wires, y, x=650, timeout=60):
    nodes.append({
        "id": nid, "type": "join", "z": z, "name": f"join {count}",
        "mode": "custom", "build": "array", "property": "payload", "propertyType": "msg",
        "key": "topic", "joiner": "\\n", "joinerType": "str", "useparts": False,
        "accumulate": False, "timeout": str(timeout), "count": str(count), "reduceRight": False,
        "x": x, "y": y, "wires": [wires],
    })

# ---------------------------------------------------------------- Tab 1: Wetter & Luft
Z = "udp-rt-tab-wetter"
tab(Z, "Reutlingen: Wetter & Luft",
    "Offene Daten Reutlingen: DWD-Wetter (BrightSky), Luftqualität UBA (Stationen DEBW027 Pomologie "
    "und DEBW147 Lederstraße-Ost) und Feinstaubsensoren (sensor.community) als NGSI-LD-Entitäten.")

# --- Amtliche DWD-Stationen landesweit (Stufe-3-Baustein »amtliche-station«) ---
# Vorher: eine fest verdrahtete Abfrage für Reutlingen. Eine Abfrage je Gemeinde
# wäre mit 1.103 Aufrufen alle 10 Minuten maßlos gegenüber einem frei
# betriebenen Dienst. Stattdessen je DWD-Station eine Entität (197 in BW) —
# das Dashboard wählt daraus die nächstgelegene, genau wie bei den Pegeln.
FN_DWD_STATIONEN = r'''// BrightSky-Quellenliste -> je BW-Station eine Messwertabfrage
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.sources)) {
    node.warn('DWD-Stationen: Quellenliste nicht ladbar (' + msg.statusCode + ')');
    return null;
}
const stationen = {};
for (const s of msg.payload.sources) {
    const id = s.dwd_station_id;
    if (!id || !s.lat || !s.lon) continue;
    if (s.observation_type !== 'current' && s.observation_type !== 'synop') continue;
    if (s.lat < 47.4 || s.lat > 49.9 || s.lon < 7.3 || s.lon > 10.7) continue;
    if (!stationen[id]) {
        // DWD liefert Namen teils in Versalien (DACHSBERG-WOLPADINGE) — für die
        // Kachel lesbar machen, Bindestrich-Teile einzeln.
        let nm = s.station_name || ('Station ' + id);
        if (nm === nm.toUpperCase()) {
            nm = nm.toLowerCase().replace(/(^|[\s\-\/(])([a-zäöüß])/g, (m, a, b) => a + b.toUpperCase());
        }
        stationen[id] = { id: id, name: nm, lat: s.lat, lon: s.lon };
    }
}
const liste = Object.keys(stationen);
if (!liste.length) { node.warn('DWD-Stationen: keine BW-Station gefunden'); return null; }
flow.set('dwdStationen', stationen);
node.status({ text: liste.length + ' BW-Stationen' });
return [liste.map(id => ({
    url: 'https://api.brightsky.dev/current_weather?dwd_station_id=' + id,
    station: id
}))];'''

FN_DWD_BUILD = r'''// BrightSky-Messwerte -> WeatherObserved je DWD-Station
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.weather) return null;
const stationen = flow.get('dwdStationen') || {};
const st = stationen[msg.station];
if (!st) return null;
''' + NEAREST_HELPER + r'''
const GRZ3 = global.get('bwGrenzen');
const gem = (() => {
    if (!GRZ3) return null;
    for (const a in GRZ3) {
        const g = GRZ3[a], b = g.b;
        if (st.lon >= b[0] && st.lat >= b[1] && st.lon <= b[2] && st.lat <= b[3] && pip(st.lat, st.lon, g.r)) return GEMBYAGS[a] || null;
    }
    return null;
})();
const w = msg.payload.weather;
const clean = s => String(s == null ? '' : s).replace(/'/g, '’'); // TRoE-Bug: Apostroph bricht SQL-Insert
const now = new Date().toISOString();
const e = {
    id: 'urn:ngsi-ld:WeatherObserved:bw-dwd-' + msg.station,
    type: 'WeatherObserved',
    stationName: { type: 'Property', value: clean(st.name) },
    dwdStationId: { type: 'Property', value: String(msg.station) },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    dataProvider: { type: 'Property', value: 'BrightSky/DWD (' + clean(st.name) + ')' },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [st.lon, st.lat] } },
    '@context': CTX
};
if (gem) { e.ags = { type: 'Property', value: gem[0] }; e.gemeindeName = { type: 'Property', value: clean(gem[1]) }; }
const attrs = {
    temperature:        [w.temperature, 'CEL'],
    relativeHumidity:   [w.relative_humidity != null ? w.relative_humidity / 100 : null, 'P1'],
    atmosphericPressure:[w.pressure_msl, 'A97'],
    windSpeed:          [w.wind_speed_10, 'KMH'],
    windDirection:      [w.wind_direction_10, 'DD'],
    precipitation:      [w.precipitation_10, 'MMT']
};
let hat = false;
for (const k of Object.keys(attrs)) {
    const v = attrs[k][0];
    if (v === null || v === undefined) continue;
    e[k] = { type: 'Property', value: v, unitCode: attrs[k][1], observedAt: now };
    hat = true;
}
if (!hat) return null;   // Station meldet gerade nichts
msg.payload = [e];
msg.headers = { 'Content-Type': 'application/ld+json' };
delete msg.url;
return msg;'''

inject("udp-rt-w-inject", Z, "stündlich", 3600, 150, ["udp-rt-w-src"], 80)
http_get("udp-rt-w-src", Z, "BrightSky Quellen (BW)",
         "https://api.brightsky.dev/sources?lat=48.6&lon=9.0&max_dist=200000", ["udp-rt-w-msgs"], 80)
func("udp-rt-w-msgs", Z, "BW-Stationen ermitteln", FN_DWD_STATIONEN, ["udp-rt-w-rate"], 80, x=620)
delay_rate("udp-rt-w-rate", Z, ["udp-rt-w-get"], 140)
http_get("udp-rt-w-get", Z, "BrightSky Station", "", ["udp-rt-w-fn"], 140, x=620)
func("udp-rt-w-fn", Z, "→ WeatherObserved (DWD-Station)", FN_DWD_BUILD, ["udp-rt-w-post"], 140, x=860)
upsert("udp-rt-w-post", Z, ["udp-rt-w-debug"], 200)
debug("udp-rt-w-debug", Z, "DWD-Stationen Ergebnis", 200)

catch("udp-rt-wl-catch", Z, "udp-rt-wl-errdebug", 500)
debug("udp-rt-wl-errdebug", Z, "Fehler", 500, x=380)

# ---------------------------------------------------------------- Tab 2: Parken & Laden
Z = "udp-rt-tab-parken"
tab(Z, "Reutlingen: Parken & Laden",
    "MobiData BW ParkAPI (Parkplätze der Stadt Reutlingen, Echtzeit-Fahrradparken am Hbf) und "
    "Ladesäulen aus dem BNetzA-Register (OCPDB) als NGSI-LD-Entitäten.")


# B+R-Fahrradparken kommt seit dem landesweiten Ausbau aus parken-bw
# (ParkAPI unterscheidet purpose CAR/BIKE) — der Reutlingen-Block entfällt.

# Ladesäulen: Bestand, Livestatus und Einzelstandorte kommen seit dem
# landesweiten Ausbau aus ladesaeulen-bw (Abschnitt weiter unten) — die
# früheren Reutlingen-Pipelines udp-rt-l-/udp-rt-ls- sind damit abgelöst.

catch("udp-rt-pl-catch", Z, "udp-rt-pl-errdebug", 380)
debug("udp-rt-pl-errdebug", Z, "Fehler", 380, x=380)

# ---------------------------------------------------------------- Tab 3: Sharing
Z = "udp-rt-tab-sharing"
tab(Z, "Reutlingen: Sharing",
    "Sharing-Mobilität über MobiData BW GBFS: Dott- und Bolt-Flotten (aggregiert, keine "
    "Einzelfahrzeuge wegen rotierender IDs) sowie teilAuto-Carsharing-Stationen.")

FLEET_TMPL = r'''// GBFS free_bike_status -> aggregierte NGSI-LD FleetStatus-Entität
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.data || !Array.isArray(msg.payload.data.bikes)) {
    node.warn('GBFS __OP__: keine Daten (' + msg.statusCode + ')');
    return null;
}
// BBox Reutlingen (Bolt deckt auch Tübingen ab)
const box = b => b.lat > 48.44 && b.lat < 48.56 && b.lon > 9.10 && b.lon < 9.30;
const fleet = msg.payload.data.bikes.filter(box);
const avail = fleet.filter(b => !b.is_disabled && !b.is_reserved);
const ranges = avail.map(b => b.current_range_meters).filter(r => typeof r === 'number');
const now = new Date().toISOString();
const cx = avail.length ? avail.reduce((s, b) => s + b.lon, 0) / avail.length : 9.2043;
const cy = avail.length ? avail.reduce((s, b) => s + b.lat, 0) / avail.length : 48.4914;
const e = {
    id: 'urn:ngsi-ld:FleetStatus:reutlingen-__SUFFIX__',
    type: 'FleetStatus',
    operator: { type: 'Property', value: '__OP__' },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    availableVehicles: { type: 'Property', value: avail.length, unitCode: 'C62', observedAt: now },
    totalVehicles: { type: 'Property', value: fleet.length, unitCode: 'C62', observedAt: now },
    dataProvider: { type: 'Property', value: 'MobiData BW GBFS' },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [Math.round(cx * 1e5) / 1e5, Math.round(cy * 1e5) / 1e5] } },
    '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld'
};
if (ranges.length) {
    e.avgRangeKm = { type: 'Property', value: Math.round(ranges.reduce((s, r) => s + r, 0) / ranges.length / 100) / 10, unitCode: 'KMT', observedAt: now };
}
msg.payload = [e];
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;'''


# teilAuto-Einzelblock entfernt: stationsgebundenes Carsharing kommt jetzt
# landesweit aus carsharing-bw (alle GBFS-Anbieter, nicht nur Neckar-Alb).

catch("udp-rt-sh-catch", Z, "udp-rt-sh-errdebug", 440)
debug("udp-rt-sh-errdebug", Z, "Fehler", 440, x=380)

# ---------------------------------------------------------------- Tab 4: ÖPNV
Z = "udp-rt-tab-oepnv"
tab(Z, "Reutlingen: ÖPNV & Innenstadt",
    "Live-Abfahrtsmonitor Reutlingen Hauptbahnhof über die EFA-BW-Auskunft (naldo/bwegt) "
    "mit Echtzeitverspätungen als NGSI-LD PublicTransportStop-Entität. Zusätzlich "
    "(vorbereitet, aktiv sobald HYSTREET_API_TOKEN gesetzt): Passantenfrequenz "
    "Wilhelmstraße über hystreet.com.")

FN_OEPNV = r'''// EFA-BW Abfahrtsmonitor -> NGSI-LD PublicTransportStop mit departures-Compound
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.stopEvents)) {
    node.warn('EFA-BW: keine Abfahrten (' + msg.statusCode + ')');
    return null;
}
const fmt = t => new Date(t).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const clean = s => String(s == null ? '' : s).replace(/'/g, '’'); // TRoE-Bug: Apostroph bricht SQL-Insert
const deps = [];
for (const ev of msg.payload.stopEvents) {
    if (ev.isCancelled) continue;
    const planned = ev.departureTimePlanned;
    if (!planned) continue;
    // Nur wo EFA tatsächlich eine Echtzeitmeldung liefert, ist eine Aussage über
    // Verspätung möglich. Fehlt sie, war die frühere Rückfallebene auf die
    // Planzeit gleichbedeutend mit »pünktlich« — aus »unbekannt« wurde so eine
    // Pünktlichkeitsaussage, die die Daten nicht hergeben.
    const hatEchtzeit = ev.isRealtimeControlled === true && !!ev.departureTimeEstimated;
    const est = ev.departureTimeEstimated || planned;
    // EFA meldet an einzelnen Halten systematisch unplausible Planzeiten
    // (3-4 h Differenz trotz isRealtimeControlled). Solche Werte sind
    // Datenartefakte, keine Verspätungen -> als unbekannt (null) führen.
    const raw = Math.round((new Date(est) - new Date(planned)) / 60000);
    const delay = (hatEchtzeit && raw >= 0 && raw <= 60) ? raw : null;
    const tr = ev.transportation || {};
    deps.push({
        line: clean(tr.number || tr.name || '?'),
        destination: clean((tr.destination && tr.destination.name) || '?'),
        planned: fmt(planned),
        estimated: fmt(est),
        delayMinutes: delay,
        platform: clean((ev.location && ev.location.properties && ev.location.properties.platform) || '')
    });
}
if (!deps.length) { node.warn('EFA-BW: keine verwertbaren Abfahrten'); return null; }
// Median statt Mittelwert: robust gegen einzelne Ausreißer
const gueltig = deps.map(d => d.delayMinutes).filter(v => v != null).sort((a, b) => a - b);
const avg = gueltig.length
    ? Math.round((gueltig.length % 2 ? gueltig[(gueltig.length - 1) / 2]
        : (gueltig[gueltig.length / 2 - 1] + gueltig[gueltig.length / 2]) / 2) * 10) / 10
    : null;
// TRoE-Bug: Compound > ~2 KB wird still verworfen -> max. 10 Abfahrten, Ziele kürzen
const depsShort = deps.slice(0, 10).map(d => Object.assign({}, d, { destination: d.destination.slice(0, 40) }));
const now = new Date().toISOString();
const COORDS = __COORDS__;
msg.payload = [Object.assign({
    id: '__ENTITY_ID__',
    type: 'PublicTransportStop',
    ags: { type: 'Property', value: '__AGS__' },
    name: { type: 'Property', value: '__STOP_NAME__' },
    stopCode: { type: 'Property', value: '__STOP_CODE__' },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    departures: { type: 'Property', value: depsShort, observedAt: now },
    departureCount: { type: 'Property', value: deps.length, unitCode: 'C62', observedAt: now },
    avgDelayMinutes: { type: 'Property', value: avg, unitCode: 'MIN', observedAt: now },
    delayDataQuality: { type: 'Property', value: gueltig.length + '/' + deps.length + ' Abfahrten mit plausibler Echtzeit' },
    dataProvider: { type: 'Property', value: 'EFA-BW (naldo/bwegt)' },
    '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld'
}, COORDS ? { location: { type: 'GeoProperty', value: { type: 'Point', coordinates: COORDS } } } : {})];
// TRoE-Dedupe: unveränderte Attribute (Stammdaten wie name/stopCode/location,
// aber auch ein konstanter avgDelayMinutes) nicht bei jedem Lauf erneut in die
// Historie schreiben — Orion-LD legt bei options=update je mitgesendetem Attribut
// eine TRoE-Zeile an, der Broker behält Nicht-Mitgesendetes. dateObserved bleibt
// als Frischesignal immer dabei; nach Neustart ist der Kontext leer -> einmal voll.
const ent = msg.payload[0];
const sigKey = 'oepnvSig:' + ent.id;
const prevSig = flow.get(sigKey) || {};
const nextSig = {};
for (const k of Object.keys(ent)) {
    if (k === 'id' || k === 'type' || k === '@context' || k === 'dateObserved') continue;
    const s = JSON.stringify(ent[k].value);
    nextSig[k] = s;
    if (prevSig[k] === s) delete ent[k];
}
flow.set(sigKey, nextSig);
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;'''

# Eine Pipeline je Kommune in enabledFor (Sprint 3.3): Reutlingen behält seine
# historischen Node-IDs (Suffix leer), weitere Städte bekommen -<ags>-Suffixe.
for _i, _ags in enumerate(REG["efa-abfahrten"].get("enabledFor") or []):
    _sid = reg_param("efa-abfahrten", "stopId", _ags)
    if not _sid:
        print(f"WARNUNG: efa-abfahrten ohne params.stopId für {_ags} — übersprungen", file=sys.stderr)
        continue
    _pp = lambda k, d=None: REG["efa-abfahrten"].get("params", {}).get(k, {}).get(_ags, d)
    _sfx = "" if _ags == "08415061" else "-" + _ags
    _y = 80 + _i * 60
    _fn = (FN_OEPNV
           .replace("__ENTITY_ID__", _pp("entityId", "urn:ngsi-ld:PublicTransportStop:bw-" + _ags + "-stop"))
           .replace("__AGS__", _ags)
           .replace("__STOP_NAME__", str(_pp("stopName", "Zentraler Halt")).replace("'", "’"))
           .replace("__STOP_CODE__", _sid)
           .replace("__COORDS__", json.dumps(_pp("coords"))))
    inject(f"udp-rt-o{_sfx}-inject", Z, "alle 5 Minuten", 300, 15, [f"udp-rt-o{_sfx}-get"], _y)
    http_get(f"udp-rt-o{_sfx}-get", Z, f"EFA-BW Abfahrten {_ags}",
             ("https://www.efa-bw.de/nvbw/XML_DM_REQUEST?outputFormat=rapidJSON&type_dm=any&name_dm=" + _sid + "&mode=direct&useRealtime=1&limit=20"),
             [f"udp-rt-o{_sfx}-fn"], _y)
    func(f"udp-rt-o{_sfx}-fn", Z, "→ PublicTransportStop " + _ags, _fn, [f"udp-rt-o{_sfx}-post"], _y)
    upsert(f"udp-rt-o{_sfx}-post", Z, [f"udp-rt-o{_sfx}-debug"], _y)
    debug(f"udp-rt-o{_sfx}-debug", Z, "ÖPNV Ergebnis " + _ags, _y)
catch("udp-rt-o-catch", Z, "udp-rt-o-errdebug", 180)
debug("udp-rt-o-errdebug", Z, "Fehler", 180, x=380)

# ---------------------------------------------------------------- Tab 5: Prognose & Energie
Z = "udp-rt-tab-prognose"
tab(Z, "Reutlingen: Prognose & Energie",
    "Masterplan Phase 1-3: Wettervorhersage + UV (Open-Meteo), Warnungen (DWD via BrightSky, "
    "NINA/BBK), Baustellen (MobiData BW/SVZ-BW), PV-Ausbau (Marktstammdatenregister), "
    "Radzählstellen (Eco-Counter) und Reutlingen-Puls (Aggregat).")

# Reutlinger Einzelvorhersage entfernt: vorhersage-bw liefert die vollen
# Stufe-3-Werte (2-h-Takt, gefühlt, UV, Sonnenzeiten) für alle Gemeinden.

catch("udp-rt-pe-catch", Z, "udp-rt-pe-errdebug", 790)
debug("udp-rt-pe-errdebug", Z, "Fehler", 790, x=380)

# ------------------------------------------------- Abfahrten auf Anfrage (alle Kommunen)
# Warum kein Dauerabruf: 1.103 Gemeinden alle 5 Minuten wären 318.000 Anfragen
# am Tag bzw. 3,7 je Sekunde gegen die EFA-BW-Auskunft — ohne Vereinbarung mit
# dem NVBW nicht vertretbar (die Klärung steht aus, Sprint 3.5). Der Abruf
# erfolgt deshalb erst, wenn jemand ein Dashboard öffnet. Die Last skaliert
# damit mit tatsächlichen Seitenaufrufen statt mit der Zahl der Gemeinden, und
# die Anzeige ist dabei sekundenaktuell statt bis zu 5 Minuten alt.
# Der Micro-Cache des Cockpit-nginx (60 s, proxy_cache_lock) fängt Andrang auf
# denselben Halt ab, sodass gleichzeitige Aufrufe zu einer Anfrage werden.
FN_ABF_HALT = r'''// /abfahrten?ags=<AGS> -> EFA-Abfrage vorbereiten
const halte = global.get('oepnvHalte');
const ags = (msg.req && msg.req.query && msg.req.query.ags) || '';
if (!halte) {
    msg.statusCode = 503;
    msg.payload = { fehler: 'Haltestellenverzeichnis noch nicht geladen' };
    return [null, msg];
}
const h = halte[ags];
if (!h || !h.stopId) {
    msg.statusCode = 404;
    msg.payload = { fehler: 'Für diese Gemeinde ist kein Halt hinterlegt', ags: ags };
    return [null, msg];
}
msg.halt = h;
msg.url = 'https://www.efa-bw.de/nvbw/XML_DM_REQUEST?outputFormat=rapidJSON&type_dm=any&name_dm='
          + encodeURIComponent(h.stopId) + '&mode=direct&useRealtime=1&limit=12';
return [msg, null];'''

FN_ABF_BAUEN = r'''// EFA-Antwort -> schlanke Abfahrtsliste für das Dashboard
const halt = msg.halt || {};
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.stopEvents)) {
    msg.statusCode = 502;
    msg.payload = { fehler: 'Auskunft nicht erreichbar', halt: halt.stopName || '' };
    return msg;
}
const abfahrten = [];
for (const e of msg.payload.stopEvents) {
    const tr = e.transportation || {};
    const plan = e.departureTimePlanned || '';
    const ist = e.departureTimeEstimated || plan;
    // Verspätung nur bei echter Echtzeitmeldung. Ohne sie ist der Wert
    // unbekannt — nicht null Minuten. Sonst meldete ein Halt ohne
    // Echtzeitanbindung dauerhaft »pünktlich«.
    let verspaetung = null;
    if (plan && e.departureTimeEstimated && e.isRealtimeControlled === true) {
        const d = Math.round((Date.parse(e.departureTimeEstimated) - Date.parse(plan)) / 60000);
        // Dieselbe Plausibilitätsgrenze wie beim Dauerabruf: einzelne Halte
        // melden systematisch unsinnige Planzeiten; das sind Datenartefakte.
        if (isFinite(d) && Math.abs(d) <= 60) verspaetung = d;
    }
    abfahrten.push({
        linie: tr.number || tr.name || '',
        ziel: (tr.destination || {}).name || '',
        zeit: ist.slice(11, 16),
        verspaetung: verspaetung
    });
}
const bekannt = abfahrten.map(a => a.verspaetung).filter(v => v != null).sort((a, b) => a - b);
const median = bekannt.length ? bekannt[Math.floor(bekannt.length / 2)] : null;
msg.statusCode = 200;
msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
msg.payload = {
    halt: halt.stopName || '',
    stopId: halt.stopId || '',
    stand: new Date().toISOString(),
    medianVerspaetung: median,
    echtzeitAbfahrten: bekannt.length,
    quelle: 'EFA-BW (naldo/bwegt)',
    abfahrten: abfahrten
};
return msg;'''

Z = "udp-rt-tab-oepnv"
http_in("udp-rt-ab-in", Z, "/abfahrten", ["udp-rt-ab-halt"], 620)
nodes.append({
    "id": "udp-rt-ab-halt", "type": "function", "z": Z, "name": "Halt auflösen",
    "func": FN_ABF_HALT, "outputs": 2, "timeout": "", "noerr": 0,
    "initialize": "", "finalize": "", "libs": [], "x": 400, "y": 620,
    "wires": [["udp-rt-ab-get"], ["udp-rt-ab-out"]],
})
http_get("udp-rt-ab-get", Z, "EFA-BW Abfahrten (on demand)", "", ["udp-rt-ab-fn"], 620, x=620)
func("udp-rt-ab-fn", Z, "→ Abfahrtsliste", FN_ABF_BAUEN, ["udp-rt-ab-out"], 620, x=860)
http_response("udp-rt-ab-out", Z, 620)

# ---- Amtliche Warnungen als abonnierbarer iCal-Feed (Audit Sprint D) ----
# /warnungen.ics?kreis=<KRS> — in jedem Kalender abonnierbar; aktualisiert sich
# automatisch. Kein Push-Kanal (der bräuchte ein Relay), sondern der risikoarme
# Pull-Weg: der Bürger abonniert, sein Kalender zieht die Lage regelmäßig.
FN_WARN_ICS_REQ = r'''// /warnungen.ics?kreis=<KRS> -> Orion-Abfrage der Kreis-Alerts vorbereiten
const krs = String((msg.req && msg.req.query && msg.req.query.kreis) || '').replace(/[^0-9]/g, '');
if (!/^\d{5}$/.test(krs)) {
    msg.statusCode = 400; msg.headers = { 'Content-Type': 'text/plain' };
    msg.payload = 'Parameter kreis=<5-stelliger Kreisschlüssel> fehlt.';
    return [null, msg];
}
msg.krs = krs;
msg.url = 'http://orion-ld:1026/ngsi-ld/v1/entities?type=Alert&q=ags==%22' + krs + '%22&options=keyValues';
return [msg, null];'''

FN_WARN_ICS_BUILD = r'''// Orion-Alerts -> VCALENDAR (ein VEVENT je aktueller Warnmeldung)
const krs = msg.krs || '';
const alerts = Array.isArray(msg.payload) ? msg.payload : [];
const esc = s => String(s == null ? '' : s).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UDP//Warnungen//DE',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Warnungen Kreis ' + krs];
let n = 0;
for (const a of alerts) {
    const quelle = String(a.id || '').endsWith('-nina') ? 'BBK/NINA' : 'DWD';
    for (const h of (a.headlines || [])) {
        n++;
        lines.push('BEGIN:VEVENT',
            'UID:' + krs + '-' + n + '-' + stamp + '@udp',
            'DTSTAMP:' + stamp,
            'DTSTART:' + stamp,
            'SUMMARY:' + esc((quelle) + ': ' + (h.h || h.headline || 'Warnung')),
            'DESCRIPTION:' + esc((h.desc || h.description || '') + ' (Quelle: ' + quelle + ', amtliche Warnung)'),
            'END:VEVENT');
    }
}
if (!n) {
    lines.push('BEGIN:VEVENT', 'UID:none-' + krs + '-' + stamp + '@udp', 'DTSTAMP:' + stamp,
        'DTSTART:' + stamp, 'SUMMARY:Keine amtlichen Warnungen', 'END:VEVENT');
}
lines.push('END:VCALENDAR');
msg.statusCode = 200;
msg.headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
msg.payload = lines.join('\r\n') + '\r\n';
return msg;'''

http_in("udp-rt-wf-in", Z, "/warnungen.ics", ["udp-rt-wf-req"], 500)
nodes.append({
    "id": "udp-rt-wf-req", "type": "function", "z": Z, "name": "Kreis auflösen",
    "func": FN_WARN_ICS_REQ, "outputs": 2, "timeout": "", "noerr": 0,
    "initialize": "", "finalize": "", "libs": [], "x": 400, "y": 500,
    "wires": [["udp-rt-wf-get"], ["udp-rt-wf-out"]],
})
http_get("udp-rt-wf-get", Z, "Orion Kreis-Alerts", "", ["udp-rt-wf-fn"], 500, x=620)
func("udp-rt-wf-fn", Z, "→ iCal", FN_WARN_ICS_BUILD, ["udp-rt-wf-out"], 500, x=860)
http_response("udp-rt-wf-out", Z, 500)

# Haltestellenverzeichnis beim Start in den globalen Kontext
FN_ABF_HALTE_LADEN = r'''if (msg.statusCode >= 400 || !msg.payload || !msg.payload.halte) {
    node.warn('Haltestellenverzeichnis nicht ladbar (' + msg.statusCode + ') — scripts/efa-haltestellen.py laufen lassen');
    return null;
}
global.set('oepnvHalte', msg.payload.halte);
node.status({ text: Object.keys(msg.payload.halte).length + ' Halte' });
return null;'''
inject("udp-rt-ah-inject", Z, "täglich", 86400, 8, ["udp-rt-ah-get"], 700)
http_get("udp-rt-ah-get", Z, "oepnv-halte.json", "http://cockpit/oepnv-halte.json", ["udp-rt-ah-fn"], 700)
func("udp-rt-ah-fn", Z, "Halte in den Kontext", FN_ABF_HALTE_LADEN, [], 700, x=620)

# ---------------------------------------------------------------- hystreet (vorbereitet, env-gated)
Z = "udp-rt-tab-oepnv"

FN_HY_GUARD = r'''// hystreet: nur aktiv, wenn HYSTREET_API_TOKEN gesetzt ist (kostenlose Registrierung)
const token = env.get('HYSTREET_API_TOKEN');
if (!token) { node.status({ text: 'inaktiv (kein Token)' }); return null; }
msg.hyToken = token;
msg.url = 'https://hystreet.com/api/locations';
msg.headers = { 'X-API-Token': token, 'Content-Type': 'application/vnd.hystreet.v2' };
return msg;'''

FN_HY_FIND = r'''// Standort Reutlingen (Wilhelmstraße) finden
if (msg.statusCode >= 400 || !msg.payload) {
    node.warn('hystreet: Standortliste fehlgeschlagen (' + msg.statusCode + ')');
    return null;
}
const list = Array.isArray(msg.payload) ? msg.payload : (msg.payload.data || []);
const loc = list.find(l => JSON.stringify(l).toLowerCase().includes('reutlingen'));
if (!loc || !loc.id) { node.warn('hystreet: kein Reutlingen-Standort gefunden'); return null; }
msg.url = 'https://hystreet.com/api/locations/' + loc.id;
msg.headers = { 'X-API-Token': msg.hyToken, 'Content-Type': 'application/vnd.hystreet.v2' };
return msg;'''

FN_HY_BUILD = r'''// hystreet-Standortdetail -> PedestrianFlowObserved
if (msg.statusCode >= 400 || !msg.payload) {
    node.warn('hystreet: Detailabruf fehlgeschlagen (' + msg.statusCode + ')');
    return null;
}
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const d = msg.payload.data || msg.payload;
const now = new Date().toISOString();
const stats = d.statistics || {};
const e = {
    id: 'urn:ngsi-ld:PedestrianFlowObserved:reutlingen-wilhelmstrasse',
    type: 'PedestrianFlowObserved',
    name: { type: 'Property', value: clean(d.name || 'Wilhelmstraße') },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    dataProvider: { type: 'Property', value: 'hystreet.com' },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [9.2109, 48.4926] } },
    '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld'
};
if (stats.today_count != null) e.dailyTotal = { type: 'Property', value: stats.today_count, unitCode: 'C62', observedAt: now };
if (stats.last_hour_count != null) e.pedestrianCount = { type: 'Property', value: stats.last_hour_count, unitCode: 'C62', observedAt: now };
if (e.dailyTotal === undefined && e.pedestrianCount === undefined) {
    node.warn('hystreet: unbekanntes Antwortformat — Feldnamen prüfen');
    return null;
}
delete msg.url;
msg.payload = [e];
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;'''

inject("udp-rt-hy-inject", Z, "stündlich (hystreet)", 3600, 100, ["udp-rt-hy-guard"], 280)
func("udp-rt-hy-guard", Z, "Token-Check", FN_HY_GUARD, ["udp-rt-hy-list"], 280, x=380)
http_get("udp-rt-hy-list", Z, "hystreet Standorte", "", ["udp-rt-hy-find"], 280, x=600)
func("udp-rt-hy-find", Z, "Reutlingen finden", FN_HY_FIND, ["udp-rt-hy-get"], 280, x=820)
http_get("udp-rt-hy-get", Z, "hystreet Detail", "", ["udp-rt-hy-build"], 340, x=380)
func("udp-rt-hy-build", Z, "→ PedestrianFlowObserved", FN_HY_BUILD, ["udp-rt-hy-post"], 340, x=620)
upsert("udp-rt-hy-post", Z, ["udp-rt-hy-debug"], 340)
debug("udp-rt-hy-debug", Z, "hystreet Ergebnis", 340)

# ---------------------------------------------------------------- Tab BW-1: Stammdaten, Wetter, Warnungen, Baustellen
Z = "udp-rt-tab-bw1"
tab(Z, "BW: Stammdaten & Basisdaten",
    "Landesweite Ingestion für alle 1.103 Gemeinden Baden-Württembergs: Gemeinde-Stammdaten "
    "(georef/Wikidata via bw-gemeinden.json), Wetter (Open-Meteo-Batches), Warnungen je Kreis "
    "(DWD + NINA) und Baustellen (SVZ-BW) mit AGS-Zuordnung.")

GEMEINDEN_URL = "http://cockpit/bw-gemeinden.json"
CHUNK_HELPER = r'''
// Entities in Batch-Chunks aufteilen (Orion-Payload-Limit)
function emitChunks(node, msg, entities, size) {
    const out = [];
    for (let i = 0; i < entities.length; i += size) {
        out.push(Object.assign({}, msg, {
            payload: entities.slice(i, i + size),
            headers: { 'Content-Type': 'application/ld+json' },
            url: undefined,
            parts: undefined
        }));
    }
    return out;
}
// Änderungserkennung: Nur Entitäten mit geänderter Wertsignatur behalten. Orion-LD
// schreibt bei options=update je Attribut eine TRoE-Zeile — unabhängig davon, ob
// sich der Wert geändert hat. Ein über Stunden konstanter Pegel/Warnstatus/Median
// erzeugt so unnötig Volumen. sigOf(e) muss die Messwerte hashen, NICHT den
// dateObserved-Zeitstempel. Die Signaturen werden im flow-Kontext akkumuliert.
//
// opts.replace (Sprint 2.9): Standard ist MERGEN — Flows wie das GBFS-Carsharing
// rufen die Erkennung einmal je System auf und tragen jeweils nur einen
// Teilbestand bei; ein Ersetzen würde die Tabelle bei jedem System auf dessen
// Stationen eindampfen und die Erkennung wirkungslos machen. Für Flows, die den
// GANZEN Bestand in einem Lauf sehen (Parken landesweit), ist Mergen dagegen ein
// Leck: Entitäten, die aus der Quelle verschwinden, bleiben für immer in der
// Signaturtabelle stehen. Der flow-Kontext liegt über contextStorage
// (settings.js: localfilesystem) auch auf der Platte — das Leck wächst dort mit.
// Solche Aufrufer setzen { replace: true } und speichern nur den aktuellen Stand.
function gateChanged(node, entities, key, sigOf, opts) {
    const ersetzen = !!(opts && opts.replace);
    const prev = flow.get(key) || {};
    const next = {};
    const out = [];
    let changed = 0;
    for (const e of entities) {
        const s = sigOf(e);
        next[e.id] = s;
        if (prev[e.id] !== s) { out.push(e); changed++; }
        else if (e.dateObserved) {
            // Unverändert: nur die Frische (dateObserved) auffrischen, NICHT die
            // vollen Messwerte. options=update ersetzt nur die mitgesendeten
            // Attribute — die Wert-Zeilen entfallen (Volumen gespart), aber
            // Healthcheck und Frontend sehen weiter, dass die Daten aktuell sind.
            out.push({ id: e.id, type: e.type, dateObserved: e.dateObserved, '@context': e['@context'] });
        }
    }
    flow.set(key, ersetzen ? next : Object.assign(prev, next));
    node.status({ text: changed + '/' + entities.length + ' geändert (Rest: nur Frische)' });
    return out;
}
'''

FN_MUNI = r'''// bw-gemeinden.json -> Municipality-Entitäten (Chunks à 150)
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.gemeinden)) {
    node.warn('BW-Stammdaten: bw-gemeinden.json nicht ladbar (' + msg.statusCode + ') — GUI-Build fehlt?');
    return null;
}
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const TYP = { S: 'Stadt', G: 'Gemeinde', F: 'gemeindefreies Gebiet' };
global.set('bwGemeinden', msg.payload.gemeinden);
const entities = msg.payload.gemeinden.map(([ags, name, lat, lon, krs, typ, ew, url]) => {
    const e = {
        id: 'urn:ngsi-ld:Municipality:bw-' + ags,
        type: 'Municipality',
        name: { type: 'Property', value: clean(name) },
        ags: { type: 'Property', value: ags },
        kreisCode: { type: 'Property', value: krs },
        municipalityType: { type: 'Property', value: TYP[typ] || typ },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
        '@context': ctx
    };
    if (ew) e.population = { type: 'Property', value: ew, unitCode: 'C62' };
    if (url) e.dashboardUrl = { type: 'Property', value: url };
    return e;
});
node.status({ text: entities.length + ' Gemeinden' });
''' + CHUNK_HELPER + r'''
// Stammdaten ändern sich fast nie. Ohne Gate schrieb jeder Node-RED-Neustart
// alle 1.103 Gemeinden neu (Restart-Refire, ~7,7k Zeilen/Deploy). Signatur über
// die relevanten Felder — beim ersten Lauf leer, danach nur echte Änderungen.
const geaendert = gateChanged(node, entities, 'muniSig',
    e => (e.name.value) + '|' + (e.population ? e.population.value : '') + '|' + e.kreisCode.value + '|' + (e.dashboardUrl ? e.dashboardUrl.value : ''));
if (!geaendert.length) { node.status({ text: 'unverändert (' + entities.length + ')' }); return null; }
return [emitChunks(node, msg, geaendert, 150)];'''

nodes.append({
    "id": "udp-rt-bm-inject", "type": "inject", "z": Z, "name": "wöchentlich Mo 04:30 (+ initial)",
    "props": [{"p": "payload"}], "repeat": "", "crontab": "30 04 * * 1",
    "once": True, "onceDelay": "30", "topic": "", "payload": "", "payloadType": "date",
    "x": 150, "y": 80, "wires": [["udp-rt-bm-get"]],
})
http_get("udp-rt-bm-get", Z, "bw-gemeinden.json", GEMEINDEN_URL, ["udp-rt-bm-fn"], 80)
func("udp-rt-bm-fn", Z, "→ Municipality (Chunks)", FN_MUNI, ["udp-rt-bm-rate"], 80)
delay_rate("udp-rt-bm-rate", Z, ["udp-rt-bm-post"], 140)
upsert("udp-rt-bm-post", Z, ["udp-rt-bm-debug"], 140)
debug("udp-rt-bm-debug", Z, "Stammdaten Ergebnis", 140)

FN_GRENZEN = r'''// Gemeindegrenzen in den global-Kontext (für Punkt-in-Polygon)
if (msg.statusCode >= 400 || !msg.payload || typeof msg.payload !== 'object') {
    node.warn('bw-grenzen.json nicht ladbar (' + msg.statusCode + ') — Fallback nearest bleibt aktiv');
    return null;
}
global.set('bwGrenzen', msg.payload);
node.status({ text: Object.keys(msg.payload).length + ' Gemeindepolygone' });
return null;'''

inject("udp-rt-bgr-inject", Z, "stündlich (+ initial)", 3600, 15, ["udp-rt-bgr-get"], 150)
http_get("udp-rt-bgr-get", Z, "bw-grenzen.json", "http://cockpit/bw-grenzen.json", ["udp-rt-bgr-fn"], 150)
func("udp-rt-bgr-fn", Z, "→ global bwGrenzen", FN_GRENZEN, [], 150, x=860)

FN_WX_BATCH = r'''// Gemeinden -> 8 Open-Meteo-Batch-URLs (je ~140 Koordinaten)
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.gemeinden)) {
    node.warn('BW-Wetter: bw-gemeinden.json nicht ladbar (' + msg.statusCode + ')');
    return null;
}
const g = msg.payload.gemeinden;
global.set('bwGemeinden', g);
const N = 8, size = Math.ceil(g.length / N);
const withDaily = new Date().getHours() % 6 < 3; // Tages-Vorhersagewerte bei jedem 2. Lauf (3-h-Takt)
const msgs = [];
for (let i = 0; i < N; i++) {
    const part = g.slice(i * size, (i + 1) * size);
    if (!part.length) continue;
    const lat = part.map(r => r[2]).join(','), lon = part.map(r => r[3]).join(',');
    msgs.push({
        url: 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
             '&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation' +
             (withDaily ? '&daily=temperature_2m_max,temperature_2m_min,uv_index_max&forecast_days=1' : '') +
             '&timezone=Europe%2FBerlin',
        agsList: part.map(r => r[0]),
        withDaily,
        parts: { id: msg._msgid, index: i, count: N },
        topic: 'wx' + i
    });
}
return [msgs];'''

FN_WX_WRAP = r'''if (msg.statusCode >= 400 || !msg.payload) {
    node.warn('Open-Meteo-Batch fehlgeschlagen (' + msg.statusCode + ')');
    msg.payload = { agsList: msg.agsList, data: [] };
    return msg;
}
msg.payload = { agsList: msg.agsList, withDaily: msg.withDaily, data: Array.isArray(msg.payload) ? msg.payload : [msg.payload] };
return msg;'''

FN_WX_BUILD = r'''// Open-Meteo-Batches -> WeatherObserved:bw-<ags> (ohne location, TRoE-schonend)
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const P = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: now });
const entities = [];
for (const part of msg.payload) {
    if (!part || !part.agsList) continue;
    part.agsList.forEach((ags, i) => {
        const loc = part.data[i];
        if (!loc || !loc.current) return;
        const e = {
            id: 'urn:ngsi-ld:WeatherObserved:bw-' + ags,
            type: 'WeatherObserved',
            ags: { type: 'Property', value: ags },
            temperature: P(loc.current.temperature_2m, 'CEL'),
            windSpeed: P(loc.current.wind_speed_10m, 'KMH'),
            windDirection: P(loc.current.wind_direction_10m, 'DD'),
            precipitation: P(loc.current.precipitation, 'MMT'),
            '@context': ctx
        };
        if (part.withDaily && loc.daily && loc.daily.temperature_2m_max) {
            e.tempMax = P(loc.daily.temperature_2m_max[0], 'CEL');
            e.tempMin = P(loc.daily.temperature_2m_min[0], 'CEL');
            e.uvIndexMax = P(loc.daily.uv_index_max[0], '');
        }
        entities.push(e);
    });
}
if (!entities.length) { node.warn('BW-Wetter: keine Entitäten'); return null; }
node.status({ text: entities.length + ' Gemeinden bewettert' });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

inject("udp-rt-bw-inject", Z, "alle 3 Stunden", 10800, 90, ["udp-rt-bw-get"], 230)
http_get("udp-rt-bw-get", Z, "bw-gemeinden.json", GEMEINDEN_URL, ["udp-rt-bw-batch"], 230)
func("udp-rt-bw-batch", Z, "Open-Meteo-Batches", FN_WX_BATCH, ["udp-rt-bw-rate1"], 230)
delay_slow("udp-rt-bw-rate1", Z, ["udp-rt-bw-om"], 290, 15)
http_get("udp-rt-bw-om", Z, "Open-Meteo", "", ["udp-rt-bw-wrap"], 290, x=620)
func("udp-rt-bw-wrap", Z, "bündeln", FN_WX_WRAP, ["udp-rt-bw-join"], 290, x=840)
join("udp-rt-bw-join", Z, 8, ["udp-rt-bw-build"], 350, x=400, timeout=240)
func("udp-rt-bw-build", Z, "→ WeatherObserved (Chunks)", FN_WX_BUILD, ["udp-rt-bw-rate2"], 350)
delay_rate("udp-rt-bw-rate2", Z, ["udp-rt-bw-post"], 410)
upsert("udp-rt-bw-post", Z, ["udp-rt-bw-debug"], 410)
debug("udp-rt-bw-debug", Z, "BW-Wetter Ergebnis", 410)

FN_FC_BATCH = r"""// Gemeinden -> 8 Open-Meteo-Vorhersage-Batch-URLs (4 Tage, alle 2 h)
// Ein Aufruf trägt ~140 Koordinaten; 8 Aufrufe je Lauf, 96 am Tag — die
// Stufe-3-Vorhersage kostet damit landesweit weniger als früher die eine
// stündliche Einzelabfrage für Reutlingen.
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.gemeinden)) {
    node.warn('BW-Vorhersage: bw-gemeinden.json nicht ladbar (' + msg.statusCode + ')');
    return null;
}
const g = msg.payload.gemeinden;
const N = 8, size = Math.ceil(g.length / N);
const msgs = [];
for (let i = 0; i < N; i++) {
    const part = g.slice(i * size, (i + 1) * size);
    if (!part.length) continue;
    const lat = part.map(r => r[2]).join(','), lon = part.map(r => r[3]).join(',');
    msgs.push({
        url: 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
             '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,uv_index_max,weather_code,sunrise,sunset' +
             '&current=apparent_temperature,uv_index' +
             '&forecast_days=4&timezone=Europe%2FBerlin',
        agsList: part.map(r => r[0]),
        parts: { id: msg._msgid, index: i, count: N },
        topic: 'fc' + i
    });
}
return [msgs];"""

FN_FC_BUILD = r"""// Open-Meteo-Daily-Batches -> WeatherForecast:bw-<ags> (days-Compound wie Stufe-3-Vorhersage)
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
for (const part of msg.payload) {
    if (!part || !part.agsList) continue;
    part.agsList.forEach((ags, i) => {
        const loc = part.data[i];
        const dl = loc && loc.daily;
        if (!dl || !Array.isArray(dl.time) || !dl.time.length) return;
        const days = dl.time.map((d, j) => [d,
            dl.temperature_2m_min[j], dl.temperature_2m_max[j],
            dl.precipitation_sum[j], dl.wind_speed_10m_max[j], dl.uv_index_max[j],
            (dl.weather_code || [])[j]]);
        const cur = loc.current || {};
        const hhmm = x => (x || '').slice(11, 16);
        const e = {
            id: 'urn:ngsi-ld:WeatherForecast:bw-' + ags,
            type: 'WeatherForecast',
            ags: { type: 'Property', value: ags },
            dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
            days: { type: 'Property', value: days, observedAt: now },
            tomorrowTempMax: { type: 'Property', value: dl.temperature_2m_max[1], unitCode: 'CEL', observedAt: now },
            tomorrowTempMin: { type: 'Property', value: dl.temperature_2m_min[1], unitCode: 'CEL', observedAt: now },
            tomorrowPrecipitation: { type: 'Property', value: dl.precipitation_sum[1], unitCode: 'MMT', observedAt: now },
            dataProvider: { type: 'Property', value: 'Open-Meteo (CC-BY 4.0)' },
            '@context': ctx
        };
        // Gefühlte Temperatur, UV und Sonnenzeiten: bisher Stufe-3-Vorrecht
        // einer einzigen Stadt, jetzt Teil der Landesbasis.
        if (cur.apparent_temperature != null) e.apparentTemperature = { type: 'Property', value: cur.apparent_temperature, unitCode: 'CEL', observedAt: now };
        if (cur.uv_index != null) e.uvIndex = { type: 'Property', value: cur.uv_index, observedAt: now };
        if (dl.sunrise && dl.sunrise[0]) e.sunrise = { type: 'Property', value: hhmm(dl.sunrise[0]) };
        if (dl.sunset && dl.sunset[0]) e.sunset = { type: 'Property', value: hhmm(dl.sunset[0]) };
        entities.push(e);
    });
}
if (!entities.length) { node.warn('BW-Vorhersage: keine Entitäten'); return null; }
node.status({ text: entities.length + ' Gemeinden mit 4-Tage-Vorhersage' });
""" + CHUNK_HELPER + r"""
return [emitChunks(node, msg, entities, 100)];"""

inject("udp-rt-bv-inject", Z, "alle 2 Stunden", 7200, 45, ["udp-rt-bv-get"], 470)
http_get("udp-rt-bv-get", Z, "bw-gemeinden.json", GEMEINDEN_URL, ["udp-rt-bv-batch"], 470)
func("udp-rt-bv-batch", Z, "Vorhersage-Batches", FN_FC_BATCH, ["udp-rt-bv-rate1"], 470)
delay_slow("udp-rt-bv-rate1", Z, ["udp-rt-bv-om"], 530, 15)
http_get("udp-rt-bv-om", Z, "Open-Meteo Daily", "", ["udp-rt-bv-wrap"], 530, x=620)
func("udp-rt-bv-wrap", Z, "bündeln", FN_WX_WRAP, ["udp-rt-bv-join"], 530, x=840)
join("udp-rt-bv-join", Z, 8, ["udp-rt-bv-build"], 590, x=400, timeout=240)
func("udp-rt-bv-build", Z, "→ WeatherForecast (Chunks)", FN_FC_BUILD, ["udp-rt-bv-rate2"], 590)
delay_rate("udp-rt-bv-rate2", Z, ["udp-rt-bv-post"], 650)
upsert("udp-rt-bv-post", Z, ["udp-rt-bv-debug"], 650)
debug("udp-rt-bv-debug", Z, "BW-Vorhersage Ergebnis", 650)

# Kreis -> DWD-Pollenflug-Teilregion (kuratiert; Teilregionen 111 Oberrhein/
# unteres Neckartal, 112 Hohenlohe/mittlerer Neckar/Oberschwaben, 113 Mittelgebirge)
POLLEN_REGION = {
    "111": ["08211","08212","08215","08216","08221","08222","08226","08311","08315","08316","08317","08336"],
    "112": ["08111","08115","08116","08117","08118","08119","08121","08125","08126","08127","08128","08135",
             "08136","08231","08236","08415","08416","08421","08425","08426","08435","08436","08437"],
    "113": ["08225","08235","08237","08325","08326","08327","08337","08417"],
}

FN_POLLEN = r"""// DWD s31fg.json -> PollenForecast je BW-Teilregion (111/112/113)
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.content)) {
    node.warn('DWD-Pollen: keine Daten (' + msg.statusCode + ')');
    return null;
}
const REGION_KREISE = __POLLEN_REGION__;
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
for (const r of msg.payload.content) {
    const pid = String(r.partregion_id);
    if (!REGION_KREISE[pid]) continue;
    const arten = Object.keys(r.Pollen || {}).map(k => [k, r.Pollen[k].today, r.Pollen[k].tomorrow]);
    entities.push({
        id: 'urn:ngsi-ld:PollenForecast:bw-region-' + pid,
        type: 'PollenForecast',
        name: { type: 'Property', value: r.partregion_name },
        kreise: { type: 'Property', value: REGION_KREISE[pid] },
        arten: { type: 'Property', value: arten, observedAt: now },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'DWD Pollenflug-Gefahrenindex (GeoNutzV)' },
        '@context': ctx
    });
}
if (!entities.length) { node.warn('DWD-Pollen: keine BW-Regionen'); return null; }
node.status({ text: entities.length + ' Teilregionen' });
msg.payload = entities;
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;"""

inject("udp-rt-po-inject", Z, "2x täglich", None, 50, ["udp-rt-po-get"], 710)
http_get("udp-rt-po-get", Z, "DWD Pollenflug",
         "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json", ["udp-rt-po-fn"], 710)
func("udp-rt-po-fn", Z, "→ PollenForecast je Teilregion",
     FN_POLLEN.replace("__POLLEN_REGION__", json.dumps(POLLEN_REGION)), ["udp-rt-po-post"], 710)
upsert("udp-rt-po-post", Z, ["udp-rt-po-debug"], 710)
debug("udp-rt-po-debug", Z, "Pollen Ergebnis", 710)

# Thermischer Gefahrenindex (Hitzebelastung) des DWD — gesundheitsrelevante
# Sommerwarnung, sauberes JSON (gt.json). Städtebasiert (5 BW-Vertreterstädte);
# das Dashboard wählt die nächstgelegene wie bei den DWD-Stationen/Pegeln.
FN_HITZE = r"""// DWD gt.json -> HeatHealthWarning je BW-Vertreterstadt
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.content)) {
    node.warn('DWD-Hitze: keine Daten (' + msg.statusCode + ')');
    return null;
}
// Repräsentativstädte des DWD-Index mit fixen Koordinaten; Slug für die ID.
const CITIES = {
    'Stuttgart': [48.78, 9.18], 'Freiburg': [47.99, 7.85], 'Mannheim': [49.49, 8.47],
    'Konstanz': [47.66, 9.18], 'Ulm': [48.40, 9.99]
};
const RANK = { 'keine': 0, 'gering': 1, 'mittel': 2, 'hoch': 3, 'extrem': 4 };
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
for (const r of msg.payload.content) {
    const c = CITIES[r.city]; if (!c) continue;
    const f = r.forecast || {};
    // Wärmster Zeitpunkt (15 MEZ) für heute und morgen.
    const heute = f.today_15MEZ || 'keine', morgen = f.tomorrow_15MEZ || 'keine';
    const slug = r.city.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z0-9]+/g, '-');
    entities.push({
        id: 'urn:ngsi-ld:HeatHealthWarning:bw-' + slug,
        type: 'HeatHealthWarning',
        name: { type: 'Property', value: r.city },
        todayLevel: { type: 'Property', value: heute, observedAt: now },
        tomorrowLevel: { type: 'Property', value: morgen, observedAt: now },
        maxRank: { type: 'Property', value: Math.max(RANK[heute] || 0, RANK[morgen] || 0), observedAt: now },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'DWD Thermischer Gefahrenindex (GeoNutzV)' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [c[1], c[0]] } },
        '@context': ctx
    });
}
if (!entities.length) { node.warn('DWD-Hitze: keine BW-Städte'); return null; }
node.status({ text: entities.length + ' Vertreterstädte' });
msg.payload = entities;
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;"""

inject("udp-rt-hz-inject", Z, "2x täglich", None, 65, ["udp-rt-hz-get"], 770)
nodes[-1]["crontab"] = "5 6,11 * * *"; nodes[-1]["repeat"] = ""
http_get("udp-rt-hz-get", Z, "DWD Hitzeindex",
         "https://opendata.dwd.de/climate_environment/health/alerts/gt.json", ["udp-rt-hz-fn"], 770)
func("udp-rt-hz-fn", Z, "→ HeatHealthWarning", FN_HITZE, ["udp-rt-hz-post"], 770)
upsert("udp-rt-hz-post", Z, ["udp-rt-hz-debug"], 770)
debug("udp-rt-hz-debug", Z, "Hitze Ergebnis", 770)

FN_PEGEL = r"""// PEGELONLINE -> WaterLevelObserved je Station im Gemeindegebiet (nur PiP-Treffer)
if (msg.statusCode >= 400 || !Array.isArray(msg.payload)) {
    node.warn('PEGELONLINE: keine Daten (' + msg.statusCode + ')');
    return null;
}
const GRZ = global.get('bwGrenzen');
if (!GRZ) { node.warn('PEGELONLINE: Grenzen-Cache fehlt — Lauf übersprungen'); return null; }
const GEM = global.get('bwGemeinden') || [];
const NAME = {}; for (const r of GEM) NAME[r[0]] = r[1];
const pip = (lat, lon, rings) => {
    for (const ring of rings) {
        let ins = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
        }
        if (ins) return true;
    }
    return false;
};
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
for (const st of msg.payload) {
    const lat = st.latitude, lon = st.longitude;
    if (!lat || lat < 47.5 || lat > 49.85 || lon < 7.4 || lon > 10.6) continue;
    let ags = null;
    for (const a in GRZ) {
        const g = GRZ[a], b = g.b;
        if (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3] && pip(lat, lon, g.r)) { ags = a; break; }
    }
    if (!ags) continue; // außerhalb BW (z. B. Main in Bayern) — bewusst verwerfen
    // Zwingend die Wasserstandsreihe W (cm) nehmen. Stationen mit Abflussmessung
    // führen Q (m³/s) an erster Stelle — die frühere Auswahl timeseries[0] hat
    // dort Kubikmeter je Sekunde als Pegelstand ausgewiesen (Maxau 524 statt 351).
    const ts = (st.timeseries || []).find(t => t.shortname === 'W' && t.unit === 'cm');
    const cm = ts && ts.currentMeasurement;
    if (!cm || cm.value == null) continue;
    entities.push({
        id: 'urn:ngsi-ld:WaterLevelObserved:bw-pegel-' + st.number,
        type: 'WaterLevelObserved',
        ags: { type: 'Property', value: ags },
        gemeindeName: { type: 'Property', value: NAME[ags] || '' },
        name: { type: 'Property', value: st.shortname },
        water: { type: 'Property', value: st.water && st.water.shortname || '' },
        level: { type: 'Property', value: cm.value, unitCode: 'CMT', observedAt: now },
        levelState: { type: 'Property', value: cm.stateMnwMhw || 'unknown' },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'WSV/PEGELONLINE (dl-de/by-2-0)' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
        '@context': ctx
    });
}
if (!entities.length) { node.warn('PEGELONLINE: keine BW-Stationen'); return null; }
node.status({ text: entities.length + ' Pegel in BW-Gemeinden' });
""" + CHUNK_HELPER + r"""
// Pegel ändern sich bei Trockenwetter über Stunden nicht — nur geänderte schreiben.
const geaendert = gateChanged(node, entities, 'pegelSig',
    e => e.level.value + '|' + (e.levelState && e.levelState.value));
if (!geaendert.length) return null;
return [emitChunks(node, msg, geaendert, 50)];"""

inject("udp-rt-pe-inject", Z, "stündlich", 3600, 55, ["udp-rt-pe-get"], 770)
http_get("udp-rt-pe-get", Z, "PEGELONLINE Stationen",
         "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?includeTimeseries=true&includeCurrentMeasurement=true",
         ["udp-rt-pe-fn"], 770)
func("udp-rt-pe-fn", Z, "→ WaterLevelObserved (PiP)", FN_PEGEL, ["udp-rt-pe-rate"], 770)
delay_rate("udp-rt-pe-rate", Z, ["udp-rt-pe-post"], 830)
upsert("udp-rt-pe-post", Z, ["udp-rt-pe-debug"], 830)
debug("udp-rt-pe-debug", Z, "Pegel Ergebnis", 830)

# PiP-Bausteine für Overpass-FNs (nur exakte Polygon-Treffer, kein Zentroid-Fallback)
PIP_ONLY = r"""
const GRZ = global.get('bwGrenzen');
if (!GRZ) { node.warn('Overpass-FN: Grenzen-Cache fehlt'); return null; }
const pip = (lat, lon, rings) => {
    for (const ring of rings) {
        let ins = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
        }
        if (ins) return true;
    }
    return false;
};
const agsOf = (lat, lon) => {
    for (const a in GRZ) {
        const g = GRZ[a], b = g.b;
        if (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3] && pip(lat, lon, g.r)) return a;
    }
    return null;
};
"""

FN_PEGEL_LUBW = r"""// LUBW/HVZ-Stammdatendatei (JS) -> WaterLevelObserved je Landespegel
// Feldpositionen laut hvz_peg_var.js: 0 Kennung, 1 Name, 2 Gewässer, 4 W, 5 Einheit,
// 6 Zeit, 7 Q, 20 Länge, 21 Breite, 30-34 Hochwasser-Meldestufen,
// 40 Mittelwasser, 43 mittleres Niedrigwasser.
if (msg.statusCode >= 400 || typeof msg.payload !== 'string') {
    node.warn('HVZ: keine Daten (' + msg.statusCode + ')');
    return null;
}
const block = msg.payload.match(/PEG_DB\s*=\s*\[([\s\S]*?)\n\];/);
if (!block) { node.warn('HVZ: PEG_DB nicht gefunden (Format geändert?)'); return null; }
const parseRow = line => {
    const out = []; let cur = '', inQ = false;
    for (const c of line) {
        if (c === "'") { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    out.push(cur.trim());
    return out;
};
""" + PIP_ONLY + r"""
const GEM = global.get('bwGemeinden') || [];
const NAME = {}; for (const r of GEM) NAME[r[0]] = r[1];
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
let ohneAgs = 0;
for (const m of block[1].matchAll(/\[([^\[\]]*)\]/g)) {
    const f = parseRow(m[1]);
    if (f.length < 45) continue;
    const lon = num(f[20]), lat = num(f[21]), w = num(f[4]);
    if (lat == null || lon == null || w == null) continue;   // '--' = kein Messwert
    const ags = agsOf(lat, lon);
    if (!ags) { ohneAgs++; continue; }
    const stufen = [30, 31, 32, 33, 34].map(i => num(f[i])).filter(v => v != null && v > 0);
    const mnw = num(f[43]), mw = num(f[40]);
    // Zustand: ab der ersten Meldestufe Hochwasser; unter MNW Niedrigwasser
    let state = 'normal';
    if (stufen.length && w >= stufen[0]) state = 'high';
    else if (mnw != null && w < mnw) state = 'low';
    const e = {
        id: 'urn:ngsi-ld:WaterLevelObserved:bw-hvz-' + f[0],
        type: 'WaterLevelObserved',
        ags: { type: 'Property', value: ags },
        gemeindeName: { type: 'Property', value: NAME[ags] || '' },
        name: { type: 'Property', value: f[1] },
        water: { type: 'Property', value: f[2] },
        level: { type: 'Property', value: w, unitCode: f[5] === 'cm' ? 'CMT' : 'MTR', observedAt: now },
        levelState: { type: 'Property', value: state },
        measuredAt: { type: 'Property', value: f[6] },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'LUBW / Hochwasservorhersagezentrale BW' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
        '@context': ctx
    };
    const q = num(f[7]);
    if (q != null) e.discharge = { type: 'Property', value: q, unitCode: 'MQS', observedAt: now };
    if (stufen.length) e.floodLevels = { type: 'Property', value: stufen };
    if (mw != null) e.meanLevel = { type: 'Property', value: mw, unitCode: 'CMT' };
    if (mnw != null) e.meanLowLevel = { type: 'Property', value: mnw, unitCode: 'CMT' };
    entities.push(e);
}
if (!entities.length) { node.warn('HVZ: keine Entitäten'); return null; }
node.status({ text: entities.length + ' Landespegel (' + ohneAgs + ' außerhalb BW-Polygonen)' });
""" + CHUNK_HELPER + r"""
const geaendert = gateChanged(node, entities, 'hvzSig',
    e => e.level.value + '|' + (e.levelState && e.levelState.value) + '|' + (e.discharge ? e.discharge.value : ''));
if (!geaendert.length) return null;
return [emitChunks(node, msg, geaendert, 50)];"""

inject("udp-rt-pl-inject", Z, "stündlich", 3600, 65, ["udp-rt-pl-get"], 1250)
nodes.append({
    "id": "udp-rt-pl-get", "type": "http request", "z": Z, "name": "LUBW/HVZ Stammdaten",
    "method": "GET", "ret": "txt", "paytoqs": "ignore",
    "url": "https://www.hvz.baden-wuerttemberg.de/js/hvz_peg_stmn.js",
    "persist": False, "authType": "", "senderr": False, "headers": [],
    "x": 400, "y": 1250, "wires": [["udp-rt-pl-fn"]],
})
func("udp-rt-pl-fn", Z, "→ WaterLevelObserved (LUBW, PiP)", FN_PEGEL_LUBW, ["udp-rt-pl-rate"], 1250)
delay_rate("udp-rt-pl-rate", Z, ["udp-rt-pl-post"], 1310)
upsert("udp-rt-pl-post", Z, ["udp-rt-pl-debug"], 1310)
debug("udp-rt-pl-debug", Z, "LUBW-Pegel Ergebnis", 1310)

OVERPASS_UA = "UDP-BW-Dashboard/1.0 (kommunale Referenzplattform; tk@idkev.de)"


FN_RATHAUS_REQ = r"""// Overpass-Anfrage Rathäuser BW (1 Query, wöchentlich)
msg.url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(
  '[out:json][timeout:90][bbox:47.5,7.4,49.9,10.6];(node["amenity"="townhall"];way["amenity"="townhall"];);out tags center;');
msg.headers = { 'User-Agent': '__UA__' };
return msg;"""

FN_RATHAUS_BUILD = r"""// Overpass-Rathäuser -> CivicStructure:bw-<ags>-rathaus (bestes je Gemeinde)
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.elements)) {
    node.warn('Overpass Rathaus: keine Daten (' + msg.statusCode + ')');
    return null;
}
""" + PIP_ONLY + r"""
const best = {}; // ags -> element (bevorzugt: mit opening_hours, Name enthält Rathaus/Bürger)
const score = t => (t.opening_hours ? 2 : 0) + (/rathaus|bürger|stadtverwaltung|gemeindeverwaltung/i.test(t.name || '') ? 1 : 0);
for (const el of msg.payload.elements) {
    const t = el.tags || {};
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null) continue;
    const ags = agsOf(lat, lon);
    if (!ags) continue;
    el._lat = lat; el._lon = lon;
    if (!best[ags] || score(t) > score(best[ags].tags || {})) best[ags] = el;
}
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const clean = x => String(x == null ? '' : x).replace(/'/g, '\u2019');
const entities = Object.keys(best).map(ags => {
    const t = best[ags].tags || {};
    const e = {
        id: 'urn:ngsi-ld:CivicStructure:bw-' + ags + '-rathaus',
        type: 'CivicStructure',
        ags: { type: 'Property', value: ags },
        name: { type: 'Property', value: clean(t.name || 'Rathaus') },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: '© OpenStreetMap contributors (ODbL)' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [best[ags]._lon, best[ags]._lat] } },
        '@context': ctx
    };
    if (t.opening_hours) e.openingHours = { type: 'Property', value: clean(t.opening_hours) };
    if (t.phone || t['contact:phone']) e.telephone = { type: 'Property', value: clean(t.phone || t['contact:phone']) };
    if (t.website || t['contact:website']) e.url = { type: 'Property', value: clean(t.website || t['contact:website']) };
    return e;
});
if (!entities.length) return null;
node.status({ text: entities.length + ' Rathäuser (' + entities.filter(e => e.openingHours).length + ' mit Öffnungszeiten)' });
""" + CHUNK_HELPER + r"""
return [emitChunks(node, msg, entities, 100)];"""

inject("udp-rt-rh-inject", Z, "wöchentlich So 04:40", None, 70, ["udp-rt-rh-req"], 890)
func("udp-rt-rh-req", Z, "Overpass-URL Rathäuser", FN_RATHAUS_REQ.replace("__UA__", OVERPASS_UA), ["udp-rt-rh-get"], 890, x=380)
http_get("udp-rt-rh-get", Z, "Overpass", "", ["udp-rt-rh-build"], 890, x=560)
func("udp-rt-rh-build", Z, "→ CivicStructure (PiP)", FN_RATHAUS_BUILD, ["udp-rt-rh-rate"], 890, x=780)
delay_rate("udp-rt-rh-rate", Z, ["udp-rt-rh-post"], 950)
upsert("udp-rt-rh-post", Z, ["udp-rt-rh-debug"], 950)
debug("udp-rt-rh-debug", Z, "Rathaus Ergebnis", 950)

FN_AUSFLUG_REQ = r"""// 4 Overpass-Abfragen (je Quadrant alle Zielarten), streng serialisiert
// Overpass erlaubt nur wenige Slots je IP und quittiert Überlast mit 504.
// Daher: BW in 4 Quadranten, alle Arten je Quadrant in EINER Abfrage,
// 90 s Abstand (> Antwortzeit). Teilausfälle sind unkritisch — Entitäten
// früherer Läufe bleiben in Orion bestehen.
// Erweiterte Zielarten (hebt datenarme Gemeinden ohne klassische Attraktion) und
// nwr statt node — auch Ways/Relations (Parks, Ruinen, Naturschutzgebiete).
const SEL =
    'nwr["tourism"~"^(attraction|viewpoint|museum|artwork|gallery|theme_park|zoo|aquarium)$"]["name"];' +
    'nwr["historic"~"^(castle|monument|ruins|memorial|archaeological_site|fort|tower)$"]["name"];' +
    'nwr["leisure"~"^(nature_reserve|garden)$"]["name"];' +
    'nwr["natural"~"^(peak|waterfall|cave_entrance)$"]["name"];';
const QUADS = [[48.7, 7.4, 49.9, 9.0], [48.7, 9.0, 49.9, 10.6],
               [47.5, 7.4, 48.7, 9.0], [47.5, 9.0, 48.7, 10.6]];
const msgs = QUADS.map((q, i) => ({
    url: 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(
        '[out:json][timeout:120][bbox:' + q.join(',') + '];(' + SEL + ');out tags center;'),
    headers: { 'User-Agent': '__UA__' },
    kind: 'Q' + (i + 1), parts: { id: msg._msgid, index: i, count: QUADS.length }
}));
return [msgs];"""

FN_AUSFLUG_WRAP = r"""msg.payload = { kind: msg.kind,
    elements: (msg.statusCode < 400 && msg.payload && Array.isArray(msg.payload.elements)) ? msg.payload.elements : [] };
if (!msg.payload.elements.length) node.warn('Overpass ' + msg.kind + ': leer/Fehler (' + msg.statusCode + ')');
return msg;"""

FN_AUSFLUG_BUILD = r"""// Overpass-Ziele -> TouristDestination:bw-<ags> (Top 25 je Gemeinde)
""" + PIP_ONLY + r"""
const TYP = { attraction: 'Sehenswürdigkeit', viewpoint: 'Aussichtspunkt', museum: 'Museum', castle: 'Burg/Schloss' };
const byAgs = {};
for (const part of msg.payload) {
    if (!part || !part.elements) continue;
    for (const el of part.elements) {
        const t = el.tags || {};
        // out tags center: Nodes tragen lat/lon, Ways/Relations den center-Punkt
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (!t.name || lat == null) continue;
        const ags = agsOf(lat, lon);
        if (!ags) continue;
        const typ = TYP[t.tourism] || TYP[t.historic] || TYP[t.leisure] || TYP[t.natural] || 'Ziel';
        // Fix: berechnete Koordinaten speichern (bei Ways/Relations ist el.lat leer).
        (byAgs[ags] = byAgs[ags] || []).push([String(t.name).replace(/'/g, '\u2019').slice(0, 60), typ, lat, lon]);
    }
}
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = Object.keys(byAgs).map(ags => {
    const seen = new Set();
    const ziele = byAgs[ags].filter(z => !seen.has(z[0]) && seen.add(z[0])).slice(0, 25);
    return {
        id: 'urn:ngsi-ld:TouristDestination:bw-' + ags,
        type: 'TouristDestination',
        ags: { type: 'Property', value: ags },
        zielCount: { type: 'Property', value: byAgs[ags].length, unitCode: 'C62' },
        ziele: { type: 'Property', value: ziele, observedAt: now },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: '© OpenStreetMap contributors (ODbL)' },
        '@context': ctx
    };
});
const okKinds = [...new Set(msg.payload.filter(p => p && p.elements && p.elements.length).map(p => p.kind))];
if (!entities.length) { node.warn('Ausflugsziele: keine Entitäten (Quellen ok: ' + okKinds.join(',') + ')'); return null; }
node.status({ text: entities.length + ' Gemeinden · Quellen: ' + okKinds.join(',') });
""" + CHUNK_HELPER + r"""
return [emitChunks(node, msg, entities, 100)];"""

inject("udp-rt-az-inject", Z, "wöchentlich So 05:10", None, 100, ["udp-rt-az-req"], 1010)
func("udp-rt-az-req", Z, "4 Overpass-Abfragen (Quadranten)", FN_AUSFLUG_REQ.replace("__UA__", OVERPASS_UA), ["udp-rt-az-slow"], 1010, x=380)
delay_slow("udp-rt-az-slow", Z, ["udp-rt-az-get"], 1070, 90)
http_get("udp-rt-az-get", Z, "Overpass", "", ["udp-rt-az-wrap"], 1070, x=620)
func("udp-rt-az-wrap", Z, "bündeln", FN_AUSFLUG_WRAP, ["udp-rt-az-join"], 1070, x=840)
join("udp-rt-az-join", Z, 4, ["udp-rt-az-build"], 1130, x=400, timeout=900)
func("udp-rt-az-build", Z, "→ TouristDestination (PiP)", FN_AUSFLUG_BUILD, ["udp-rt-az-rate"], 1130)
delay_rate("udp-rt-az-rate", Z, ["udp-rt-az-post"], 1190)
upsert("udp-rt-az-post", Z, ["udp-rt-az-debug"], 1190)
debug("udp-rt-az-debug", Z, "Ausflugsziele Ergebnis", 1190)

# Familie & Versorgung (OSM): Apotheke, Arztpraxis, Kita, Spielplatz, Defibrillator,
# Trinkwasser — Daseinsvorsorge mit hohem Alltagsnutzen. Gleiches tolerantes
# Quadranten-Muster wie Ausflugsziele; zeitlich versetzt (So 02:40), damit es nicht
# mit ausflug-bw um die knappen Overpass-Slots konkurriert.
FN_POI_REQ = r"""// Overpass-Abfragen über ein FEINES Raster (4×3=12 Kacheln). Die Versorgungs-
// Arten (v. a. Spielplätze/Trinkwasser als Flächenobjekte) sind volumenstark;
// über die 4 groben Quadranten kippte Overpass reproduzierbar in 504. Kleinere
// Kacheln bleiben unter der Timeout-Schwelle; fällt eine aus, retten die
// anderen den Lauf (toleranter Teilausfall).
const SEL =
    'nwr["amenity"~"^(pharmacy|doctors|kindergarten|recycling)$"];' +
    'nwr["leisure"="playground"];' +
    'nwr["emergency"="defibrillator"];' +
    'nwr["amenity"="drinking_water"];';
const LAT0 = 47.5, LAT1 = 49.9, LON0 = 7.4, LON1 = 10.6, NR = 3, NC = 4;
const boxes = [];
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
    boxes.push([LAT0 + (LAT1 - LAT0) * r / NR, LON0 + (LON1 - LON0) * c / NC,
                LAT0 + (LAT1 - LAT0) * (r + 1) / NR, LON0 + (LON1 - LON0) * (c + 1) / NC]);
}
const msgs = boxes.map((q, i) => ({
    url: 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(
        '[out:json][timeout:90][bbox:' + q.join(',') + '];(' + SEL + ');out tags center;'),
    headers: { 'User-Agent': '__UA__' },
    kind: 'K' + (i + 1), parts: { id: msg._msgid, index: i, count: boxes.length }
}));
return [msgs];"""

FN_POI_BUILD = r"""// Overpass-Versorgung -> PublicAmenity:bw-<ags> (Liste + Zählwerte je Art)
""" + PIP_ONLY + r"""
const TYP = { pharmacy: 'Apotheke', doctors: 'Arztpraxis', kindergarten: 'Kita',
    playground: 'Spielplatz', defibrillator: 'Defibrillator', drinking_water: 'Trinkwasser' };
const artOf = t => {
    if (t.amenity === 'recycling') {
        if (t.recycling_type === 'centre') return 'Recyclinghof';
        if (t['recycling:glass'] === 'yes' || t['recycling:glass_bottles'] === 'yes') return 'Altglas';
        return 'Wertstoff-Container';
    }
    return TYP[t.amenity] || TYP[t.leisure] || (t.emergency === 'defibrillator' ? 'Defibrillator' : null);
};
const byAgs = {};
for (const part of msg.payload) {
    if (!part || !part.elements) continue;
    for (const el of part.elements) {
        const t = el.tags || {};
        const art = artOf(t); if (!art) continue;
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (lat == null) continue;
        const ags = agsOf(lat, lon); if (!ags) continue;
        const b = byAgs[ags] = byAgs[ags] || { items: [], counts: {} };
        b.counts[art] = (b.counts[art] || 0) + 1;
        b.items.push([String(t.name || art).replace(/'/g, '’').slice(0, 50), art, lat, lon]);
    }
}
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = Object.keys(byAgs).map(ags => {
    const b = byAgs[ags];
    // Klassenausgewogene Auswahl (Round-Robin): so erscheint auf der Karte ein
    // Mix aller Arten (auch die oft unbenannten Recycling-/AED-Punkte), nicht
    // nur die vielen Spielplätze. Innerhalb einer Art Benannte zuerst.
    const proArt = {};
    for (const it of b.items) (proArt[it[1]] = proArt[it[1]] || []).push(it);
    for (const k in proArt) proArt[k].sort((x, y) => (x[0] === x[1] ? 1 : 0) - (y[0] === y[1] ? 1 : 0));
    const arten = Object.keys(proArt);
    const ausgewahlt = [];
    for (let round = 0; ausgewahlt.length < 50 && arten.some(k => proArt[k].length); round++) {
        for (const k of arten) { if (proArt[k].length && ausgewahlt.length < 50) ausgewahlt.push(proArt[k].shift()); }
    }
    b.items = ausgewahlt;
    return {
        id: 'urn:ngsi-ld:PublicAmenity:bw-' + ags,
        type: 'PublicAmenity',
        ags: { type: 'Property', value: ags },
        amenities: { type: 'Property', value: b.items.slice(0, 50), observedAt: now },
        counts: { type: 'Property', value: b.counts, observedAt: now },
        totalCount: { type: 'Property', value: b.items.length, unitCode: 'C62', observedAt: now },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: '© OpenStreetMap-Mitwirkende (ODbL)' },
        '@context': ctx
    };
});
if (!entities.length) { node.warn('Versorgung: keine Entitäten (Overpass evtl. überlastet)'); return null; }
node.status({ text: entities.length + ' Gemeinden mit Versorgungs-POI' });
""" + CHUNK_HELPER + r"""
return [emitChunks(node, msg, entities, 100)];"""

inject("udp-rt-poi-inject", Z, "wöchentlich So 02:40", None, 130, ["udp-rt-poi-req"], 1250)
nodes[-1]["crontab"] = "40 02 * * 0"; nodes[-1]["repeat"] = ""; nodes[-1]["once"] = False
func("udp-rt-poi-req", Z, "4 Overpass-Abfragen (Versorgung)", FN_POI_REQ.replace("__UA__", OVERPASS_UA), ["udp-rt-poi-slow"], 1250, x=380)
delay_slow("udp-rt-poi-slow", Z, ["udp-rt-poi-get"], 1310, 90)
http_get("udp-rt-poi-get", Z, "Overpass", "", ["udp-rt-poi-wrap"], 1310, x=620)
func("udp-rt-poi-wrap", Z, "bündeln", FN_AUSFLUG_WRAP, ["udp-rt-poi-join"], 1310, x=840)
join("udp-rt-poi-join", Z, 12, ["udp-rt-poi-build"], 1370, x=400, timeout=1500)
func("udp-rt-poi-build", Z, "→ PublicAmenity (PiP)", FN_POI_BUILD, ["udp-rt-poi-rate"], 1370)
delay_rate("udp-rt-poi-rate", Z, ["udp-rt-poi-post"], 1430)
upsert("udp-rt-poi-post", Z, ["udp-rt-poi-debug"], 1430)
debug("udp-rt-poi-debug", Z, "Versorgung Ergebnis", 1430)

FN_KREIS_MSGS = r'''// Gemeinden -> 44 Kreise (Zentroid = Mittelwert) -> 88 Warn-Abfragen (DWD + NINA)
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.gemeinden)) {
    node.warn('BW-Warnungen: bw-gemeinden.json nicht ladbar');
    return null;
}
const kreise = {};
for (const [ags, name, lat, lon, krs] of msg.payload.gemeinden) {
    kreise[krs] = kreise[krs] || { lat: 0, lon: 0, n: 0 };
    kreise[krs].lat += lat; kreise[krs].lon += lon; kreise[krs].n++;
}
const msgs = [];
const keys = Object.keys(kreise).sort();
let i = 0;
for (const krs of keys) {
    const k = kreise[krs];
    const lat = (k.lat / k.n).toFixed(4), lon = (k.lon / k.n).toFixed(4);
    msgs.push({ url: 'https://api.brightsky.dev/alerts?lat=' + lat + '&lon=' + lon,
                kreis: krs, quelle: 'dwd', parts: { id: msg._msgid, index: i++, count: keys.length * 2 } });
    msgs.push({ url: 'https://warnung.bund.de/api31/dashboard/' + krs + '0000000.json',
                kreis: krs, quelle: 'nina', parts: { id: msg._msgid, index: i++, count: keys.length * 2 } });
}
return [msgs];'''

FN_WARN_WRAP = r'''msg.payload = { kreis: msg.kreis, quelle: msg.quelle,
    ok: !(msg.statusCode >= 400), body: msg.payload };
return msg;'''

FN_WARN_BUILD = r'''// 88 Antworten -> Alert:bw-kreis-<krs>-<quelle>
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const RANK = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const entities = [];
for (const part of msg.payload) {
    if (!part || !part.kreis || !part.ok) continue;
    let items = [];
    if (part.quelle === 'dwd') {
        const nowMs = Date.now();
        items = ((part.body && part.body.alerts) || [])
            .filter(a => !a.expires || new Date(a.expires).getTime() > nowMs)
            .map(a => ({ h: clean((a.headline_de || a.event_de || '').slice(0, 60)), sev: (a.severity || '').toLowerCase() }));
    } else {
        items = (Array.isArray(part.body) ? part.body : []).map(w => {
            const d = (w.payload && w.payload.data) || {};
            return { h: clean((d.headline || '').slice(0, 60)), sev: (d.severity || '').toLowerCase() };
        });
    }
    let maxSev = 0;
    for (const it of items) maxSev = Math.max(maxSev, RANK[it.sev] || 0);
    entities.push({
        id: 'urn:ngsi-ld:Alert:bw-kreis-' + part.kreis + '-' + part.quelle,
        type: 'Alert',
        ags: { type: 'Property', value: part.kreis },
        category: { type: 'Property', value: part.quelle === 'dwd' ? 'weather' : 'safety' },
        activeCount: { type: 'Property', value: items.length, unitCode: 'C62', observedAt: now },
        maxSeverity: { type: 'Property', value: maxSev, observedAt: now },
        headlines: { type: 'Property', value: items.slice(0, 3), observedAt: now },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        '@context': ctx
    });
}
if (!entities.length) return null;
node.status({ text: entities.length + ' Kreis-Warnlagen' });
''' + CHUNK_HELPER + r'''
// Warnlagen sind die meiste Zeit unverändert (oft null aktive Warnungen über
// Stunden) — nur bei geändertem Warnbild schreiben. headlines mit in die Signatur,
// damit auch neue/geänderte Meldungen bei gleicher Anzahl durchkommen.
const geaendert = gateChanged(node, entities, 'warnSig',
    e => e.activeCount.value + '|' + e.maxSeverity.value + '|' + JSON.stringify(e.headlines.value));
if (!geaendert.length) return null;
return [emitChunks(node, msg, geaendert, 100)];'''

inject("udp-rt-bk-inject", Z, "alle 30 Minuten", 1800, 150, ["udp-rt-bk-get"], 500)
http_get("udp-rt-bk-get", Z, "bw-gemeinden.json", GEMEINDEN_URL, ["udp-rt-bk-msgs"], 500)
func("udp-rt-bk-msgs", Z, "Kreis-Abfragen (88)", FN_KREIS_MSGS, ["udp-rt-bk-rate"], 500)
delay_rate("udp-rt-bk-rate", Z, ["udp-rt-bk-http"], 560)
http_get("udp-rt-bk-http", Z, "DWD/NINA", "", ["udp-rt-bk-wrap"], 560, x=620)
func("udp-rt-bk-wrap", Z, "bündeln", FN_WARN_WRAP, ["udp-rt-bk-join"], 560, x=840)
join("udp-rt-bk-join", Z, 88, ["udp-rt-bk-build"], 620, x=400, timeout=180)
func("udp-rt-bk-build", Z, "→ Alert je Kreis", FN_WARN_BUILD, ["udp-rt-bk-post"], 620)
upsert("udp-rt-bk-post", Z, ["udp-rt-bk-debug"], 620)
debug("udp-rt-bk-debug", Z, "BW-Warnungen Ergebnis", 620)

FN_RW_BW = r'''// SVZ-BW-Baustellen landesweit -> RoadWork:bw-svz-<id> mit Gemeinde-Zuordnung + Kreis-Summen
const gem = msg.gemeinden;
if (!Array.isArray(gem) || msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.features)) {
    node.warn('BW-Baustellen: Daten unvollständig (' + msg.statusCode + ')');
    return null;
}
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const firstPoint = g => {
    if (!g) return null;
    if (g.type === 'Point') return g.coordinates;
    const flat = c => Array.isArray(c[0]) ? c.map(flat).flat() : [c];
    const pts = flat(g.coordinates);
    return pts[Math.floor(pts.length / 2)] || pts[0];
};
const nearest = (lat, lon) => {
    let best = null, bd = Infinity;
    for (const r of gem) {
        const dy = r[2] - lat, dx = (r[3] - lon) * Math.cos(lat * 0.01745);
        const d = dy * dy + dx * dx;
        if (d < bd) { bd = d; best = r; }
    }
    return best;
};
const entities = [];
const byKreis = {};
let abgelaufen = 0;
for (const f of msg.payload.features) {
    // Bereits beendete Maßnahmen gar nicht erst aufnehmen — der Feed führt sie
    // teilweise noch mit, sie sind für die Kommune aber ohne Belang.
    const ende = (f.properties || {}).endtime;
    if (ende && String(ende).slice(0, 19) < now.slice(0, 19)) { abgelaufen++; continue; }
    const p = firstPoint(f.geometry);
    if (!p) continue;
    const g = nearest(p[1], p[0]);
    if (!g) continue;
    byKreis[g[4]] = (byKreis[g[4]] || 0) + 1;
    const props = f.properties || {};
    const id = String(props.id || props.reference || entities.length).replace(/[^A-Za-z0-9_-]+/g, '-');
    const e = {
        id: 'urn:ngsi-ld:RoadWork:bw-svz-' + id,
        type: 'RoadWork',
        name: { type: 'Property', value: clean((props.name || props.street || props.description || 'Baustelle').slice(0, 90)) },
        ags: { type: 'Property', value: g[0] },
        gemeindeName: { type: 'Property', value: clean(g[1]) },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [p[0], p[1]] } },
        '@context': ctx
    };
    if (props.endtime) e.endDate = { type: 'Property', value: String(props.endtime).slice(0, 19) };
    entities.push(e);
}
for (const krs of Object.keys(byKreis)) {
    entities.push({
        id: 'urn:ngsi-ld:RoadWork:bw-kreis-' + krs + '-summary',
        type: 'RoadWork',
        ags: { type: 'Property', value: krs },
        name: { type: 'Property', value: 'Baustellen Kreis ' + krs + ' (Summe)' },
        activeCount: { type: 'Property', value: byKreis[krs], unitCode: 'C62', observedAt: now },
        '@context': ctx
    });
}
node.status({ text: entities.length + ' Objekte, ' + Object.keys(byKreis).length + ' Kreise'
              + (abgelaufen ? ', ' + abgelaufen + ' beendet übersprungen' : '') });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

FN_RW_PREP = r'''if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.gemeinden)) {
    node.warn('BW-Baustellen: bw-gemeinden.json nicht ladbar');
    return null;
}
msg.gemeinden = msg.payload.gemeinden;
msg.url = 'https://api.mobidata-bw.de/datasets/traffic/roadworks/roadworks_geojson.json';
return msg;'''

inject("udp-rt-br-inject", Z, "alle 6 Stunden", 21600, 200, ["udp-rt-br-get"], 710)
http_get("udp-rt-br-get", Z, "bw-gemeinden.json", GEMEINDEN_URL, ["udp-rt-br-prep"], 710)
func("udp-rt-br-prep", Z, "Roadworks-URL", FN_RW_PREP, ["udp-rt-br-http"], 710)
http_get("udp-rt-br-http", Z, "Baustellen SVZ-BW", "", ["udp-rt-br-fn"], 770, x=400)
func("udp-rt-br-fn", Z, "→ RoadWork BW (Chunks)", FN_RW_BW, ["udp-rt-br-rate"], 770)
delay_rate("udp-rt-br-rate", Z, ["udp-rt-br-post"], 830)
upsert("udp-rt-br-post", Z, ["udp-rt-br-debug"], 830)
debug("udp-rt-br-debug", Z, "BW-Baustellen Ergebnis", 830)

# Aufräumen: Baustellen, deren Ende verstrichen ist, aus dem Broker entfernen.
# Ohne diesen Lauf bleiben sie liegen, sobald der Feed sie nicht mehr ausliefert —
# die Kommune sähe dauerhaft Sperrungen, die es nicht mehr gibt.
FN_RW_EXPIRE = r'''if (msg.statusCode >= 400 || !Array.isArray(msg.payload)) {
    node.warn('Baustellen-Bereinigung: Abfrage fehlgeschlagen (' + msg.statusCode + ')');
    return null;
}
const jetzt = new Date().toISOString().slice(0, 19);
const ids = [];
for (const e of msg.payload) {
    const ende = e.endDate && (e.endDate.value != null ? e.endDate.value : e.endDate);
    if (typeof ende === 'string' && ende.slice(0, 19) < jetzt) ids.push(e.id);
}
if (!ids.length) { node.status({ text: 'nichts abgelaufen' }); return null; }
node.status({ text: ids.length + ' abgelaufene Baustellen gelöscht' });
// Sammel-Löschung in Blöcken, damit die Anfrage klein bleibt
msg.headers = { 'Content-Type': 'application/json' };
msg.payload = ids.slice(0, 200);
return msg;'''

inject("udp-rt-brx-inject", Z, "alle 6 Stunden", 21600, 900, ["udp-rt-brx-get"], 860)
http_get("udp-rt-brx-get", Z, "abgelaufene Baustellen suchen",
         "http://orion-ld:1026/ngsi-ld/v1/entities?type=RoadWork"
         "&idPattern=urn:ngsi-ld:RoadWork:bw-svz-.*&attrs=endDate&limit=1000",
         ["udp-rt-brx-fn"], 860)
func("udp-rt-brx-fn", Z, "abgelaufene ermitteln", FN_RW_EXPIRE, ["udp-rt-brx-del"], 860)
batch_delete("udp-rt-brx-del", Z, ["udp-rt-brx-debug"], 860)
debug("udp-rt-brx-debug", Z, "Baustellen-Bereinigung", 860)

catch("udp-rt-bw1-catch", Z, "udp-rt-bw1-errdebug", 920)
debug("udp-rt-bw1-errdebug", Z, "Fehler", 920, x=380)

# ---------------------------------------------------------------- Tab BW-2: Umwelt & Mobilität
Z = "udp-rt-tab-bw2"
tab(Z, "BW: Umwelt & Mobilität",
    "Landesweite Quellen mit Gemeinde-Zuordnung: UBA-Luftstationen, sensor.community-Mediane "
    "je Gemeinde, ParkAPI-/GBFS-/OCPDB-Aggregate und Eco-Counter-Radzähler aller Kommunen. "
    "Gemeindeliste kommt aus dem global-Kontext (gesetzt vom Stammdaten-/Wetter-Flow).")


FN_UBA_BW_MSGS = r'''// UBA-Stationsliste -> Abfrage je aktiver BW-Station
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.data) {
    node.warn('UBA-BW: Stationsliste nicht ladbar (' + msg.statusCode + ')');
    return null;
}
const iso = d => d.toISOString().slice(0, 10);
const from = iso(new Date(Date.now() - 24 * 3600e3)), to = iso(new Date());
const msgs = [];
for (const key of Object.keys(msg.payload.data)) {
    const s = msg.payload.data[key];
    // [id, code, name, city, synonym, von, bis, lon, lat, ...]
    if (!String(s[1] || '').startsWith('DEBW') || s[6]) continue;
    msgs.push({
        url: 'https://www.umweltbundesamt.de/api/air_data/v3/airquality/json?date_from=' + from +
             '&time_from=1&date_to=' + to + '&time_to=24&station=' + s[0],
        station: { id: s[0], code: s[1], name: s[2], lon: parseFloat(s[7]), lat: parseFloat(s[8]) }
    });
}
msgs.forEach((m, i) => { m.parts = { id: msg._msgid, index: i, count: msgs.length }; m.topic = 'uba' + i; });
node.status({ text: msgs.length + ' BW-Stationen' });
return [msgs];'''

FN_UBA_BW_WRAP = r'''msg.payload = { station: msg.station, ok: !(msg.statusCode >= 400), data: (msg.payload && msg.payload.data) || null };
return msg;'''

FN_UBA_BW_BUILD = r'''// UBA-Antworten -> AirQualityObserved:bw-uba-<code> mit Gemeinde-Zuordnung
''' + NEAREST_HELPER + r'''
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const COMP = { 1: 'pm10', 2: 'co', 3: 'o3', 4: 'so2', 5: 'no2', 9: 'pm25' };
const entities = [];
for (const part of msg.payload) {
    if (!part || !part.ok || !part.station || !part.data) continue;
    const series = part.data[String(part.station.id)];
    if (!series) continue;
    const stamps = Object.keys(series).sort().reverse();
    const latest = {};
    let aqi = null;
    for (const t of stamps) {
        const row = series[t];
        if (aqi === null && row[1] !== null && row[1] !== undefined) aqi = row[1];
        for (let i = 3; i < row.length; i++) {
            const c = COMP[row[i][0]];
            if (c && latest[c] === undefined && row[i][1] !== null) latest[c] = row[i][1];
        }
    }
    if (aqi === null && !Object.keys(latest).length) continue;
    const g = nearest(part.station.lat, part.station.lon);
    const e = {
        id: 'urn:ngsi-ld:AirQualityObserved:bw-uba-' + part.station.code,
        type: 'AirQualityObserved',
        ags: { type: 'Property', value: g ? g[0] : '' },
        stationName: { type: 'Property', value: clean(part.station.name) },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [part.station.lon, part.station.lat] } },
        '@context': CTX
    };
    if (aqi !== null) e.airQualityIndex = P(aqi, '');
    for (const c of Object.keys(latest)) e[c] = P(latest[c], 'GQ');
    entities.push(e);
}
if (!entities.length) return null;
node.status({ text: entities.length + ' Stationen' });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

inject("udp-rt-bu-inject", Z, "stündlich", 3600, 300, ["udp-rt-bu-stations"], 80)
http_get("udp-rt-bu-stations", Z, "UBA-Stationsliste",
         "https://www.umweltbundesamt.de/api/air_data/v3/stations/json?use=airquality&lang=de",
         ["udp-rt-bu-msgs"], 80)
func("udp-rt-bu-msgs", Z, "BW-Stationen (~45)", FN_UBA_BW_MSGS, ["udp-rt-bu-rate"], 80, x=860)
delay_rate("udp-rt-bu-rate", Z, ["udp-rt-bu-get"], 140)
http_get("udp-rt-bu-get", Z, "UBA airquality", "", ["udp-rt-bu-wrap"], 140, x=620)
func("udp-rt-bu-wrap", Z, "bündeln", FN_UBA_BW_WRAP, ["udp-rt-bu-join"], 140, x=840)
join_parts("udp-rt-bu-join", Z, ["udp-rt-bu-build"], 200, x=400, timeout=150)
func("udp-rt-bu-build", Z, "→ AirQualityObserved BW", FN_UBA_BW_BUILD, ["udp-rt-bu-post"], 200)
upsert("udp-rt-bu-post", Z, ["udp-rt-bu-debug"], 200)
debug("udp-rt-bu-debug", Z, "UBA-BW Ergebnis", 200)

FN_SC_BW = r'''// sensor.community BW-Box -> Feinstaub-Median je Gemeinde
if (msg.statusCode >= 400 || !Array.isArray(msg.payload)) {
    node.warn('sensor.community BW: keine Daten (' + msg.statusCode + ')');
    return null;
}
''' + NEAREST_HELPER + r'''
const bySensor = {};
let verworfen = 0;
for (const rec of msg.payload) {
    if (!rec.sensor || !rec.sensor.sensor_type || rec.sensor.sensor_type.name !== 'SDS011') continue;
    const id = rec.sensor.id;
    if (bySensor[id] && bySensor[id].timestamp > rec.timestamp) continue;
    const vals = {};
    for (const v of rec.sensordatavalues || []) {
        const x = parseFloat(v.value);
        if (!isFinite(x) || x < 0 || x > 500) continue;
        if (v.value_type === 'P1') vals.pm10 = x;
        if (v.value_type === 'P2') vals.pm25 = x;
    }
    if (vals.pm10 === undefined && vals.pm25 === undefined) continue;
    // Plausibilität: Ein SDS011 in Sättigung oder mit Defekt meldet beide Kanäle
    // nahe dem Maximum (~500 µg/m³). Reale Werte liegen in BW auch bei
    // Saharastaub deutlich unter 400. PM2,5 ist zudem physikalisch eine
    // Teilmenge von PM10 und kann nie größer sein. Solche Sensoren würden den
    // Gemeindemedian verfälschen — in kleinen Orten mit nur einem Sensor
    // vollständig — und werden daher verworfen.
    if (vals.pm10 > 400 || vals.pm25 > 400) { verworfen++; continue; }
    if (vals.pm10 !== undefined && vals.pm25 !== undefined && vals.pm25 > vals.pm10 * 1.05) { verworfen++; continue; }
    bySensor[id] = { timestamp: rec.timestamp, lat: parseFloat(rec.location.latitude), lon: parseFloat(rec.location.longitude), ...vals };
}
const byGem = {};
for (const id of Object.keys(bySensor)) {
    const s = bySensor[id];
    const g = nearest(s.lat, s.lon);
    if (!g) continue;
    s.ags = g[0];
    byGem[g[0]] = byGem[g[0]] || { pm10: [], pm25: [] };
    if (s.pm10 !== undefined) byGem[g[0]].pm10.push(s.pm10);
    if (s.pm25 !== undefined) byGem[g[0]].pm25.push(s.pm25);
}
const median = a => {
    if (!a.length) return null;
    a.sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2 * 10) / 10;
};
const entities = [];
// Stufe-3-Städte bekommen zusätzlich die Einzelsensoren als Entitäten
// (Kartenebene »Feinstaubsensoren« im Dashboard); Liste aus der Registry.
const DETAIL_AGS = __SENSOR_DETAIL_AGS__;
// Landesweit melden ~930 Sensoren. Sie bei jedem 15-Minuten-Lauf zu schreiben
// würde die Zeitreihen-DB mehr als verdoppeln, ohne dass die Kartenebene davon
// profitiert — deshalb nur zu jedem vierten Lauf, also stündlich.
const takt = ((flow.get('scTakt') || 0) + 1) % 4;
flow.set('scTakt', takt);
const detailLauf = takt === 0;
let nSensor = 0;
for (const id of Object.keys(bySensor)) {
    const s = bySensor[id];
    if (!detailLauf) break;
    if (!s.ags || !(DETAIL_AGS === '*' || DETAIL_AGS.includes(s.ags))) continue;
    const e = {
        id: 'urn:ngsi-ld:AirQualityObserved:bw-sensor-' + s.ags + '-' + id,
        type: 'AirQualityObserved',
        ags: { type: 'Property', value: s.ags },
        name: { type: 'Property', value: 'Sensor ' + id },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [s.lon, s.lat] } },
        '@context': CTX
    };
    if (s.pm10 !== undefined) e.pm10 = P(s.pm10, 'GQ');
    if (s.pm25 !== undefined) e.pm25 = P(s.pm25, 'GQ');
    entities.push(e); nSensor++;
}
for (const ags of Object.keys(byGem)) {
    const d = byGem[ags];
    const e = {
        id: 'urn:ngsi-ld:AirQualityObserved:bw-sc-' + ags,
        type: 'AirQualityObserved',
        ags: { type: 'Property', value: ags },
        sensorCount: P(Math.max(d.pm10.length, d.pm25.length), 'C62'),
        // Zeitstempel, damit das Dashboard veraltete Messwerte erkennt: Fällt der
        // letzte Sensor einer Gemeinde aus oder wird er als unplausibel verworfen,
        // bleibt sonst der alte Wert als vermeintlich aktuell stehen.
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': new Date().toISOString() } },
        '@context': CTX
    };
    const m10 = median(d.pm10), m25 = median(d.pm25);
    if (m10 !== null) e.pm10 = P(m10, 'GQ');
    if (m25 !== null) e.pm25 = P(m25, 'GQ');
    entities.push(e);
}
if (!entities.length) return null;
node.status({ text: (entities.length - nSensor) + ' Gemeinden mit Sensoren · ' + nSensor + ' Einzelsensoren'
              + (verworfen ? ' · ' + verworfen + ' unplausibel verworfen' : '') });
''' + CHUNK_HELPER + r'''
// Median ändert sich alle 15 min oft nur marginal — nur echte Änderungen schreiben.
const geaendert = gateChanged(node, entities, 'feinstaubSig',
    e => (e.pm25 ? e.pm25.value : '') + '|' + (e.pm10 ? e.pm10.value : '') + '|' + (e.sensorCount ? e.sensorCount.value : ''));
if (!geaendert.length) return null;
return [emitChunks(node, msg, geaendert, 100)];'''

inject("udp-rt-bs-inject", Z, "alle 15 Minuten", 900, 60, ["udp-rt-bs-get"], 290)
http_get("udp-rt-bs-get", Z, "sensor.community BW-Box",
         "https://data.sensor.community/airrohr/v1/filter/box=47.5,7.4,49.8,10.6", ["udp-rt-bs-fn"], 290)
func("udp-rt-bs-fn", Z, "→ Median je Gemeinde", FN_SC_BW.replace(
    "__SENSOR_DETAIL_AGS__", json.dumps(REG["feinstaub-bw"].get("sensorDetailFor", []))),
    ["udp-rt-bs-rate"], 290, x=860)
delay_rate("udp-rt-bs-rate", Z, ["udp-rt-bs-post"], 350)
upsert("udp-rt-bs-post", Z, ["udp-rt-bs-debug"], 350)
debug("udp-rt-bs-debug", Z, "Feinstaub-BW Ergebnis", 350)

# --- Parken landesweit (MobiData BW ParkAPI v3) -------------------------------
# Sprint 2.9, Fehlerbild vom 24.08.: Dieser Konnektor war mit ~1,04 Mio Zeilen/Tag
# der mit Abstand größte TRoE-Volumentreiber (rund die Hälfte der gesamten
# Zeitreihen-Datenbank) und deckte dabei 1,6 % des Bestands ab. Drei Fehler
# lagen übereinander:
#   1. Die Seitenaufteilung nutzte &offset=, das die v3-API stillschweigend
#      ignoriert — alle 66 Anfragen lieferten dieselben ersten 500 Datensätze.
#   2. Die Entitäts-IDs wurden aus dem geslugten Anlagennamen gebildet; gleich
#      benannte Anlagen fielen zusammen (500 Datensätze -> 336 IDs).
#   3. Je Lauf gingen alle sieben Attribute jeder Anlage neu heraus.
# Behoben durch: Cursor-Pagination (start=<next_id>), stabile IDs aus der
# ParkAPI-eigenen id und getrennte Statik-/Dynamik-Schreibpfade.

FN_PARK_FETCH = r'''// ParkAPI v3: Cursor-Pagination (start=<next_id>), sequentiell in EINEM Node
//
// Vorher fächerte dieser Schritt 66 Anfragen mit &offset=<n*500> auf. Die v3-API
// ignoriert offset stillschweigend: Die Antworten zu offset=0/500/…/2500 waren
// byteweise identisch (IDs 384–1441). Der Konnektor sah also 500 von 31.909
// Anlagen und schrieb jede davon 66× je Lauf. Paginiert wird über einen Cursor —
// die Antwort trägt total_count, next_id und next_path
// (»?limit=500&start=<next_id>«); fehlt next_id, ist der Bestand durch.
//
// Warum ein Function-Node statt Fan-out/Join: Der Cursor der Folgeseite steht
// erst in der Antwort der Vorseite. Das ist von Natur aus sequentiell und passt
// nicht in das parallele Inject→Split→HTTP→Join-Muster der übrigen Konnektoren.
//
// Warum node:https statt fetch(): Der Function-Node läuft in einem eigenen
// vm-Kontext (Node-RED 4.1, 10-function.js: vm.createContext(sandbox)). Der
// Sandbox enthält console/util/Buffer/URL/Date/RED/setTimeout — die Node-Globals
// werden NICHT vererbt, fetch ist dort undefined. https und zlib kommen über die
// libs-Deklaration des Nodes herein; beides sind Kernmodule, also keine
// zusätzliche npm-Abhängigkeit im Image.
const BASIS = 'https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites';
const PRO_SEITE = 500;
const MAX_SEITEN = 120;   // 31.909/500 ≈ 64 Seiten — Deckel mit Reserve fürs Wachstum
const PAUSE_MS = 1000;    // Höflichkeit gegenüber MobiData BW (wie die frühere 1-Anfrage/s-Node)

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const holen = adresse => new Promise((erfuellen, ablehnen) => {
    const anfrage = https.get(adresse, {
        headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'User-Agent': 'UDP Node-RED Konnektor parken-bw'
        }
    }, antwort => {
        const teile = [];
        antwort.on('data', d => teile.push(d));
        antwort.on('error', ablehnen);
        antwort.on('end', () => {
            try {
                const roh = Buffer.concat(teile);
                const kodierung = String(antwort.headers['content-encoding'] || '');
                erfuellen({
                    status: antwort.statusCode,
                    text: /gzip/i.test(kodierung) ? zlib.gunzipSync(roh).toString('utf8') : roh.toString('utf8')
                });
            } catch (e) { ablehnen(e); }
        });
    });
    anfrage.on('error', ablehnen);
    anfrage.setTimeout(30000, () => anfrage.destroy(new Error('Zeitüberschreitung nach 30 s')));
});

// Kompaktes Positionsarray statt Objekt — bei ~32.000 Anlagen zählt jedes Feld:
// 0 id · 1 lat · 2 lon · 3 Kapazität · 4 Zweck · 5 Name · 6 official_region_code
// 7 source_id · 8 original_uid · 9 modified_at · 10 Echtzeitdaten? · 11 freie Plätze (-1 = unbekannt)
// Apostroph bricht den TRoE-SQL-Insert (bekannter Orion-LD-Bug) -> ersetzen.
const putz = t => String(t == null ? '' : t).replace(/'/g, '’').slice(0, 80);

const gesehen = new Set();
const anlagen = [];
let start = null, seiten = 0, gesamt = null, fertig = false;
while (seiten < MAX_SEITEN) {
    const adresse = BASIS + '?limit=' + PRO_SEITE + (start === null ? '' : '&start=' + encodeURIComponent(start));
    let antwort;
    try {
        antwort = await holen(adresse);
    } catch (e) {
        node.error('ParkAPI: Seite ' + (seiten + 1) + ' nicht abrufbar (' + (e && e.message ? e.message : e) + ')');
        return null;
    }
    if (antwort.status !== 200) {
        node.error('ParkAPI: HTTP ' + antwort.status + ' auf Seite ' + (seiten + 1) + ' (' + adresse + ')');
        return null;
    }
    let seite;
    try { seite = JSON.parse(antwort.text); } catch (e) {
        node.error('ParkAPI: Seite ' + (seiten + 1) + ' ist kein gültiges JSON');
        return null;
    }
    if (!seite || !Array.isArray(seite.items)) {
        node.error('ParkAPI: Seite ' + (seiten + 1) + ' ohne items-Array — Antwortformat geändert?');
        return null;
    }
    seiten++;
    if (gesamt === null && typeof seite.total_count === 'number') gesamt = seite.total_count;

    // Überschneidungsprüfung. Genau dieser Fehler — Seiten, die alle denselben
    // Ausschnitt liefern — blieb einen Monat unentdeckt, weil er still war.
    // Lieber laut abbrechen als noch einmal 66× denselben Bestand schreiben.
    let doppelt = 0;
    for (const i of seite.items) if (gesehen.has(i.id)) doppelt++;
    if (doppelt) {
        node.error('ParkAPI: Seite ' + seiten + ' überschneidet die bisherigen Seiten in '
                   + doppelt + ' von ' + seite.items.length + ' Datensätzen — greift der Cursor »start« nicht mehr? Lauf abgebrochen');
        return null;
    }
    for (const i of seite.items) {
        gesehen.add(i.id);
        if (!i.lat || !i.lon) continue;
        if (i.purpose !== 'CAR' && i.purpose !== 'BIKE') continue;
        const echtzeit = i.has_realtime_data === true;
        anlagen.push([
            i.id, +i.lat, +i.lon, i.capacity || 0, i.purpose, putz((i.name || '').trim()),
            String(i.official_region_code == null ? '' : i.official_region_code),
            i.source_id == null ? null : i.source_id,
            i.original_uid == null ? '' : String(i.original_uid).slice(0, 64),
            i.modified_at || '',
            echtzeit,
            (echtzeit && i.realtime_free_capacity != null) ? i.realtime_free_capacity : -1
        ]);
    }
    node.status({ text: 'Seite ' + seiten + ' · ' + gesehen.size + (gesamt ? '/' + gesamt : '') + ' Datensätze' });

    if (seite.next_id === null || seite.next_id === undefined) { fertig = true; break; }
    if (String(seite.next_id) === String(start)) {
        node.error('ParkAPI: Cursor steht still (next_id ' + seite.next_id + ' wie zuvor) — Lauf abgebrochen');
        return null;
    }
    start = seite.next_id;
    await schlaf(PAUSE_MS);
}
// Niemals stillschweigend abschneiden: Wer den Deckel erreicht, bekommt einen
// Eintrag im Log — sonst wiederholt sich der Fehler von oben mit anderem Vorzeichen.
if (!fertig) {
    node.warn('ParkAPI: Seitendeckel ' + MAX_SEITEN + ' erreicht, Bestand unvollständig ('
              + gesehen.size + (gesamt ? ' von ' + gesamt : '') + ') — MAX_SEITEN anheben');
}
if (gesamt && fertig && gesehen.size < gesamt * 0.9) {
    node.warn('ParkAPI: nur ' + gesehen.size + ' von ' + gesamt + ' angekündigten Datensätzen geholt');
}
if (!anlagen.length) { node.warn('ParkAPI: keine verwertbaren Anlagen im Abzug'); return null; }
node.status({ text: seiten + ' Seiten · ' + gesehen.size + (gesamt ? '/' + gesamt : '') + ' Datensätze · ' + anlagen.length + ' verwertbar' });
msg.payload = anlagen;
msg.parkSeiten = seiten;
msg.parkGesamt = gesamt;
return msg;'''

FN_PARK_BUILD = r'''// ParkAPI-Abzug -> ParkingSummary je Gemeinde + Einzelanlagen (Auto und Rad)
''' + NEAREST_HELPER + r'''
const anlagen = Array.isArray(msg.payload) ? msg.payload.filter(Array.isArray) : [];
if (!anlagen.length) return null;

// Gemeindezuordnung über den Amtlichen Regionalschlüssel statt Punkt-in-Polygon:
// Die ParkAPI führt official_region_code zu 100 % — einen 12-stelligen ARS. Der
// AGS steckt darin, nur an anderer Stelle: AGS = ARS[0..5] + ARS[9..12]
// (Land+RB+Kreis, dann die Gemeinde; die Stellen 6–9 sind der Verbandsschlüssel).
// Beispiele: 081160019019 -> 08116019, 082120000000 -> 08212000. Gegen
// gui/public/bw-gemeinden.json geprüft: 830 von 830 Stichproben getroffen.
// Das ist exakt, kostet nichts und erspart diesem Konnektor die Suche in der
// 1 MB großen Grenzen-GeoJSON aus dem global-Kontext. nearest() bleibt nur der
// Notnagel für Datensätze ohne oder mit unbekanntem ARS.
const arsZuAgs = ars => {
    const s = String(ars || '');
    return /^[0-9]{12}$/.test(s) ? s.slice(0, 5) + s.slice(9, 12) : null;
};
// Umkasten BW: hält Anlagen außerhalb des Landes vom Zentroid-Fallback in
// nearest() fern — der würde sie sonst stumm der nächsten BW-Gemeinde zuschlagen.
const imKasten = (lat, lon) => lat > 47.4 && lat < 49.9 && lon > 7.3 && lon < 10.7;

const byGem = {};
const radAnlagen = [];
const autoAnlagen = [];
let ueberArs = 0, ueberGeo = 0, ausserhalb = 0, ohneZuordnung = 0, frischeQuelle = 0;
const vorTagen = Date.now() - 86400000;
for (const a of anlagen) {
    const lat = a[1], lon = a[2];
    let g = null;
    const ags = arsZuAgs(a[6]);
    if (ags) {
        if (ags.slice(0, 2) !== '08') { ausserhalb++; continue; }   // ARS sagt: nicht Baden-Württemberg
        g = GEMBYAGS[ags] || null;
        if (g) ueberArs++;
    }
    if (!g) {
        if (!imKasten(lat, lon)) { ausserhalb++; continue; }
        g = nearest(lat, lon);
        if (!g || g[0].slice(0, 2) !== '08') { ohneZuordnung++; continue; }
        ueberGeo++;
    }
    if (a[9] && Date.parse(a[9]) > vorTagen) frischeQuelle++;
    if (a[4] === 'BIKE') {
        // Nur Radanlagen mit Echtzeitbelegung — eine reine Kapazitätsangabe ohne
        // freie Plätze trüge im Dashboard nichts bei (B+R-Baustein »br«).
        if (a[11] >= 0) radAnlagen.push([g, a]);
        continue;
    }
    const b = byGem[g[0]] = byGem[g[0]] || { n: 0, cap: 0, rtFree: 0, rtN: 0 };
    b.n++; b.cap += a[3];
    if (a[11] >= 0) { b.rtFree += a[11]; b.rtN++; }
    autoAnlagen.push([g, a]);
}

// Kompakte Wertsignatur. Der flow-Kontext wird über contextStorage
// (settings.js: localfilesystem) auf die Platte geschrieben; bei ~26.000 Anlagen
// wären Rohsignaturen mehrere MB je Schreibvorgang. Zwei FNV-1a-Läufe mit
// verschiedenen Primzahlen ergeben 64 Bit, base36 kodiert ~13 Zeichen je Eintrag.
const hash64 = s => {
    let x = 0x811c9dc5, y = 0x1000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        x = Math.imul(x ^ c, 0x01000193) >>> 0;
        y = Math.imul(y ^ c, 0x85ebca6b) >>> 0;
    }
    return x.toString(36) + y.toString(36);
};

// Statik und Dynamik trennen. Orion-LD schreibt bei options=update je
// mitgesendetem Attribut eine TRoE-Zeile, unabhängig davon, ob sich der Wert
// geändert hat. Der frühere Stand schickte je Anlage und Lauf alle sieben
// Attribute; nur 4,7 % der Anlagen haben überhaupt Echtzeitdaten, die übrigen
// sechs Attribute ändern sich praktisch nie.
//
// Bewusst NICHT modified_at als Auslöser für den Vollschrieb: Das Feld wandert
// bei jedem Neueinlesen der Quelle mit. Im Abzug vom 24.08. trugen 93 von 500
// Datensätzen (darunter alle 32 mit Echtzeitdaten) ein frisches modified_at,
// ohne dass sich fachlich etwas geändert hätte — als Schreibgrund taugt es
// damit nicht, als Betriebsanzeige schon (siehe node.status unten). Maßgeblich
// ist die Wertsignatur der statischen Attribute, dieselbe Idee wie gateChanged().
const statik = flow.get('parkStatik') || {};
const belegung = flow.get('parkFrei') || {};
const neueStatik = {}, neueBelegung = {};
const entities = [];
const ids = new Set();
let voll = 0, nurFrei = 0, unveraendert = 0;
const ANBIETER = 'MobiData BW ParkAPI';

// Stabile Entitäts-IDs aus der ParkAPI-eigenen id (»parkapi-<id>«). Vorher
// stand dort der geslugte Anlagenname, weshalb gleichnamige Anlagen aufeinander
// fielen (42× »hauptbahnhof-westseite«, 36× »list-gymnasium« …). Die AGS gehört
// bewusst NICHT in die ID: sie ist abgeleitet, und eine Neuverortung der Anlage
// würde die Entität samt Zeitreihe verwaisen lassen. Das Frontend fragt über das
// ags-ATTRIBUT ab (gui/public/smartcity-lib.js, byAgs), nie über die ID.
const anlegen = (typ, g, a) => {
    const kennung = 'urn:ngsi-ld:' + typ + ':parkapi-' + a[0];
    const lat = a[1], lon = a[2], kap = a[3], bez = a[5], frei = a[11];
    ids.add(kennung);
    const sig = hash64([g[0], bez, kap, lat.toFixed(5), lon.toFixed(5), a[7], a[8], a[4]].join('|'));
    neueStatik[kennung] = sig;
    if (frei >= 0) neueBelegung[kennung] = frei;
    if (statik[kennung] !== sig) {
        // Erstsichtung oder echte Stammdatenänderung -> volle Entität
        voll++;
        const e = {
            id: kennung,
            type: typ,
            ags: { type: 'Property', value: g[0] },
            name: { type: 'Property', value: bez || (typ === 'BikeParking' ? 'Radabstellanlage' : 'Parkplatz') },
            totalSpotNumber: { type: 'Property', value: kap, unitCode: 'C62' },
            dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': NOW } },
            dataProvider: { type: 'Property', value: ANBIETER },
            location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
            '@context': CTX
        };
        // Fremdschlüssel der Quelle mitschreiben: Sollte MobiData BW seine
        // Datenbank je neu aufbauen und die ids sich neu vergeben, lassen sich
        // die Entitäten darüber wieder zuordnen. Nur setzen, wenn vorhanden —
        // eine Property mit null-Wert nimmt Orion-LD nicht an.
        if (a[7] !== null && a[7] !== undefined) e.sourceId = { type: 'Property', value: a[7] };
        if (a[8]) e.originalUid = { type: 'Property', value: a[8] };
        if (typ === 'ParkingSite') e.category = { type: 'Property', value: 'CAR' };
        if (frei >= 0) e.availableSpotNumber = P(frei, 'C62');
        entities.push(e);
        return;
    }
    // Stammdaten unverändert: nur die Belegung, und nur wenn sie sich bewegt hat.
    // dateObserved wird hier bewusst NICHT aufgefrischt — das wäre je Anlage und
    // Lauf eine Zeile (rund 255.000/Tag), und keine Ansicht wertet das Feld an
    // der Einzelanlage aus.
    if (frei >= 0 && belegung[kennung] !== frei) {
        nurFrei++;
        entities.push({ id: kennung, type: typ, availableSpotNumber: P(frei, 'C62'), '@context': CTX });
        return;
    }
    unveraendert++;
};
for (const [g, a] of autoAnlagen) anlegen('ParkingSite', g, a);
for (const [g, a] of radAnlagen) anlegen('BikeParking', g, a);

// Ganzer Bestand je Lauf -> ersetzen statt mergen (sonst wächst die
// Signaturtabelle im flow-Kontext und damit auf der Platte unbegrenzt).
flow.set('parkStatik', neueStatik);
flow.set('parkFrei', neueBelegung);

// Kardinalitäts-Invariante: Wenn aus n Quelldatensätzen deutlich weniger als n
// Entitäts-IDs werden, kollidieren IDs — genau der Fehler, der hier einen Monat
// lang aus geslugten Namen entstand (500 Datensätze -> 336 IDs).
const quellsaetze = autoAnlagen.length + radAnlagen.length;
if (quellsaetze && ids.size / quellsaetze < 0.95) {
    node.warn('Parken-BW: nur ' + ids.size + ' verschiedene Entitäts-IDs aus ' + quellsaetze
              + ' Quelldatensätzen (' + Math.round(ids.size / quellsaetze * 100) + ' %) — ID-Kollision?');
}

const summen = Object.keys(byGem).map(ags => {
    const b = byGem[ags];
    const e = {
        id: 'urn:ngsi-ld:ParkingSummary:bw-' + ags,
        type: 'ParkingSummary',
        ags: { type: 'Property', value: ags },
        siteCount: P(b.n, 'C62'),
        totalCapacity: P(b.cap, 'C62'),
        '@context': CTX
    };
    if (b.rtN) { e.realtimeFree = P(b.rtFree, 'C62'); e.realtimeSites = P(b.rtN, 'C62'); }
    return e;
});
''' + CHUNK_HELPER + r'''
// Aggregate je Gemeinde: unverändert -> gar nicht schreiben. replace, weil dieser
// Lauf den kompletten Landesbestand sieht (siehe gateChanged).
for (const e of gateChanged(node, summen, 'parkSummenSig',
        x => [x.siteCount.value, x.totalCapacity.value,
              x.realtimeFree ? x.realtimeFree.value : '', x.realtimeSites ? x.realtimeSites.value : ''].join('|'),
        { replace: true })) entities.push(e);

node.status({ text: anlagen.length + ' Anlagen · ' + Object.keys(byGem).length + ' Gemeinden · '
              + voll + ' voll · ' + nurFrei + ' nur Belegung · ' + unveraendert + ' unverändert'
              + ' · ' + frischeQuelle + ' mit frischem modified_at'
              + (ueberGeo ? ' · ' + ueberGeo + ' per Geo-Notnagel' : '')
              + (ohneZuordnung ? ' · ' + ohneZuordnung + ' ohne Zuordnung' : '') });
if (!entities.length) return null;
return [emitChunks(node, msg, entities, 100)];'''

inject("udp-rt-bp-inject", Z, "alle 3 Stunden", 10800, 420, ["udp-rt-bp-fetch"], 440)
# Kein Timeout am Function-Node: Der Cursor-Lauf dauert bei ~64 Seiten und
# 1 s Pause rund 70 s. Der Konnektor läuft alle 3 Stunden, das ist vertretbar.
func("udp-rt-bp-fetch", Z, "ParkAPI (Cursor-Seiten)", FN_PARK_FETCH, ["udp-rt-bp-build"], 440, x=400,
     libs=[{"var": "https", "module": "https"}, {"var": "zlib", "module": "zlib"}])
func("udp-rt-bp-build", Z, "→ ParkingSummary + Einzelanlagen", FN_PARK_BUILD, ["udp-rt-bp-rate"], 440, x=700)
delay_rate("udp-rt-bp-rate", Z, ["udp-rt-bp-post"], 500)
upsert("udp-rt-bp-post", Z, ["udp-rt-bp-debug"], 500)
debug("udp-rt-bp-debug", Z, "Parken-BW Ergebnis", 500)

FN_GBFS_SYS = r'''// GBFS-Systemliste -> je System eine free_bike_status-Abfrage
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.systems)) {
    node.warn('GBFS-BW: Systemliste nicht ladbar');
    return null;
}
const msgs = msg.payload.systems.map(s => ({
    url: s.url.replace(/\/gbfs$/, '/free_bike_status'),
    system: s.id
}));
node.status({ text: msgs.length + ' Systeme' });
return [msgs];'''

FN_GBFS_FF = r'''// free_bike_status -> SharingSummary je Gemeinde und System (frei flottierend)
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.data || !Array.isArray(msg.payload.data.bikes)) return null;
''' + NEAREST_HELPER + r'''
const inBW = b => b.lat > 47.5 && b.lat < 49.8 && b.lon > 7.4 && b.lon < 10.6;
const byGem = {}, posByGem = {};
for (const b of msg.payload.data.bikes) {
    if (!inBW(b) || b.is_disabled || b.is_reserved) continue;
    const g = nearest(b.lat, b.lon);
    if (!g || g[0].slice(0, 2) !== '08') continue;
    byGem[g[0]] = (byGem[g[0]] || 0) + 1;
    // Einzelstandorte für die Kartenanzeige (~1 m gerundet, je Gemeinde gedeckelt,
    // damit die Entität nicht in Großstädten aufbläht).
    const arr = posByGem[g[0]] = posByGem[g[0]] || [];
    if (arr.length < 400) arr.push([+b.lat.toFixed(5), +b.lon.toFixed(5)]);
}
const sys = String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-');
const entities = Object.keys(byGem).map(ags => ({
    id: 'urn:ngsi-ld:SharingSummary:bw-' + ags + '-ff-' + sys,
    type: 'SharingSummary',
    ags: { type: 'Property', value: ags },
    system: { type: 'Property', value: sys },
    availableVehicles: P(byGem[ags], 'C62'),
    vehiclePositions: { type: 'Property', value: posByGem[ags] },
    '@context': CTX
}));
if (!entities.length) return null;
msg.payload = entities;
msg.headers = { 'Content-Type': 'application/ld+json' };
delete msg.url;
return msg;'''

inject("udp-rt-bg-inject", Z, "stündlich", 3600, 540, ["udp-rt-bg-sys"], 650)
http_get("udp-rt-bg-sys", Z, "GBFS-Systeme", "https://api.mobidata-bw.de/sharing/gbfs", ["udp-rt-bg-msgs"], 650)
func("udp-rt-bg-msgs", Z, "Systeme (~110)", FN_GBFS_SYS, ["udp-rt-bg-rate"], 650, x=860)
delay_rate("udp-rt-bg-rate", Z, ["udp-rt-bg-get"], 710)
http_get("udp-rt-bg-get", Z, "free_bike_status", "", ["udp-rt-bg-fn"], 710, x=620)
func("udp-rt-bg-fn", Z, "→ SharingSummary", FN_GBFS_FF, ["udp-rt-bg-post"], 710, x=860)
upsert("udp-rt-bg-post", Z, ["udp-rt-bg-debug"], 770)
debug("udp-rt-bg-debug", Z, "Sharing-BW Ergebnis", 770)

# --- Stationsgebundenes Carsharing landesweit (Stufe-3-Baustein »carsharing-detail«)
# Bisher wertete nur ein Reutlingen-Block einen einzigen Anbieter aus und warf
# alles außerhalb einer festen Bounding-Box weg. Jetzt: alle Systeme der
# Landesliste. Stammdaten (Name, Lage, Kapazität) ändern sich kaum und werden
# täglich geholt und im Flow-Kontext gehalten; nur die Belegung läuft stündlich.
FN_CS_INFO_MSGS = r'''// Systemliste -> je System eine station_information-Abfrage
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.systems)) {
    node.warn('Carsharing: Systemliste nicht ladbar');
    return null;
}
// Zwei Feeds je System: Stationen und Fahrzeugtypen. Letztere entscheiden, ob
// ein Anbieter Autos oder Räder verleiht — RegioRad und Call a Bike stehen in
// derselben Liste wie stadtmobil und dürfen nicht als Carsharing gelten.
const msgs = [];
for (const s of msg.payload.systems) {
    msgs.push({ url: s.url.replace(/\/gbfs$/, '/station_information'), system: s.id, feed: 'info' });
    msgs.push({ url: s.url.replace(/\/gbfs$/, '/vehicle_types'), system: s.id, feed: 'typen' });
}
node.status({ text: msg.payload.systems.length + ' Systeme, ' + msgs.length + ' Abfragen' });
return [msgs];'''

FN_CS_INFO = r'''// station_information / vehicle_types -> Stammdaten in den Flow-Kontext
// Anbieter ohne Stationen (frei flottierend) antworten leer -> still übergehen.
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.data) return null;
const sysId = String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-');
if (msg.feed === 'typen') {
    // Vorherrschende Bauform je Anbieter merken (car | bicycle | cargo_bicycle | …)
    const zahl = {};
    for (const t of msg.payload.data.vehicle_types || []) {
        const f = t.form_factor || 'unbekannt';
        zahl[f] = (zahl[f] || 0) + 1;
    }
    const top = Object.keys(zahl).sort((a, b) => zahl[b] - zahl[a])[0];
    if (top) {
        const bau = flow.get('csBauform') || {};
        bau[sysId] = top;
        flow.set('csBauform', bau);
    }
    return null;
}
if (!Array.isArray(msg.payload.data.stations) || !msg.payload.data.stations.length) return null;
''' + NEAREST_HELPER + r'''
const GRZ2 = global.get('bwGrenzen');
if (!GRZ2) return null;
// Strikte Zuordnung wie bei den Ladesäulen: kein Zentroid-Fallback, sonst
// landen Stationen aus Bayern oder der Schweiz in BW-Gemeinden.
const inBW = (lat, lon) => {
    for (const a in GRZ2) {
        const g = GRZ2[a], b = g.b;
        if (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3] && pip(lat, lon, g.r)) return GEMBYAGS[a] || null;
    }
    return null;
};
const clean = s => String(s == null ? '' : s).replace(/'/g, '’').slice(0, 80);
const sys = String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-');
const cache = flow.get('csStationen') || {};
let n = 0;
for (const st of msg.payload.data.stations) {
    const lat = parseFloat(st.lat), lon = parseFloat(st.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const g = inBW(lat, lon);
    if (!g) continue;
    cache[sys + '::' + st.station_id] = {
        ags: g[0], slug: g[8], name: clean(st.name || st.station_id),
        lat: lat, lon: lon, kap: st.capacity || 0, sys: sys
    };
    n++;
}
flow.set('csStationen', cache);
node.status({ text: sys + ': ' + n + ' Stationen' });
return null;'''

FN_CS_STATUS_MSGS = r'''// Systemliste -> je System eine station_status-Abfrage
if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.systems)) return null;
if (!flow.get('csStationen')) { node.warn('Carsharing: Stammdaten noch nicht geladen — Lauf übersprungen'); return null; }
return [msg.payload.systems.map(s => ({ url: s.url.replace(/\/gbfs$/, '/station_status'), system: s.id }))];'''

FN_CS_STATUS = r'''// station_status -> CarSharingStation je Station + FleetStatus je Gemeinde
if (msg.statusCode >= 400 || !msg.payload || !msg.payload.data
    || !Array.isArray(msg.payload.data.stations) || !msg.payload.data.stations.length) return null;
const cache = flow.get('csStationen') || {};
const bauform = flow.get('csBauform') || {};
const sys = String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-');
const bau = bauform[sys] || 'unbekannt';
// Anbieterkennung lesbar machen: stadtmobil_rhein-neckar -> Stadtmobil Rhein-Neckar
const anbieter = sys.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const now = new Date().toISOString();
const ctx = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const P2 = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: now });
const entities = [];
const byGem = {};
// Wie bei den Ladesäulen: Nur schreiben, was sich geändert hat. Eine Station auf
// dem Land steht Stunden unverändert da — ihr Zeitreihen-Eintrag wäre reine
// Datenmenge ohne Aussage.
const altStand = flow.get('csStand') || {};
const neuStand = {};
for (const st of msg.payload.data.stations) {
    const info = cache[sys + '::' + st.station_id];
    if (!info) continue;                       // außerhalb BW oder ohne Stammdaten
    const frei = st.num_bikes_available != null ? st.num_bikes_available : 0;
    const schl = sys + '::' + st.station_id;
    neuStand[schl] = frei;
    const b0 = byGem[info.ags] = byGem[info.ags] || { frei: 0, kap: 0, n: 0, slug: info.slug };
    b0.frei += frei; b0.kap += info.kap; b0.n++;
    if (altStand[schl] === frei) continue;     // unverändert -> kein Schreibvorgang
    entities.push({
        id: 'urn:ngsi-ld:CarSharingStation:' + info.slug + '-' + sys + '-'
            + String(st.station_id).replace(/[^A-Za-z0-9_-]+/g, '-'),
        type: 'CarSharingStation',
        ags: { type: 'Property', value: info.ags },
        name: { type: 'Property', value: info.name },
        operator: { type: 'Property', value: anbieter },
        vehicleType: { type: 'Property', value: bau },
        availableVehicles: P2(frei, 'C62'),
        capacity: { type: 'Property', value: info.kap, unitCode: 'C62' },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'MobiData BW GBFS' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [info.lon, info.lat] } },
        '@context': ctx
    });
}
// Signaturen MERGEN statt ersetzen: Diese Funktion läuft je GBFS-System; ein
// flow.set(neuStand) würde den Kontext bei jedem System auf dessen Stationen
// reduzieren, sodass die Änderungserkennung nie greift und stündlich fast alle
// ~4.000 Stationen neu geschrieben werden. altStand ist die gespeicherte
// Referenz — Object.assign akkumuliert alle Systeme über die Läufe hinweg.
flow.set('csStand', Object.assign(altStand, neuStand));
for (const ags of Object.keys(byGem)) {
    const b = byGem[ags];
    entities.push({
        id: 'urn:ngsi-ld:FleetStatus:' + b.slug + '-' + sys,
        type: 'FleetStatus',
        ags: { type: 'Property', value: ags },
        operator: { type: 'Property', value: anbieter },
        vehicleType: { type: 'Property', value: bau },
        availableVehicles: P2(b.frei, 'C62'),
        totalVehicles: P2(b.kap, 'C62'),
        stationCount: { type: 'Property', value: b.n, unitCode: 'C62' },
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
        dataProvider: { type: 'Property', value: 'MobiData BW GBFS' },
        '@context': ctx
    });
}
if (!entities.length) return null;
node.status({ text: sys + ': ' + entities.length + ' Objekte' });
msg.payload = entities;
msg.headers = { 'Content-Type': 'application/ld+json' };
delete msg.url;
return msg;'''

# Stammdaten täglich (und bei jedem Neustart, damit der Kontext gefüllt ist)
inject("udp-rt-cs-inject", Z, "täglich", 86400, 120, ["udp-rt-cs-sys"], 830)
http_get("udp-rt-cs-sys", Z, "GBFS-Systeme", "https://api.mobidata-bw.de/sharing/gbfs", ["udp-rt-cs-msgs"], 830)
func("udp-rt-cs-msgs", Z, "station_information je System", FN_CS_INFO_MSGS, ["udp-rt-cs-rate"], 830, x=860)
delay_rate("udp-rt-cs-rate", Z, ["udp-rt-cs-get"], 890)
http_get("udp-rt-cs-get", Z, "station_information", "", ["udp-rt-cs-fn"], 890, x=620)
func("udp-rt-cs-fn", Z, "Stammdaten in den Kontext", FN_CS_INFO, [], 890, x=860)

# Belegung stündlich, versetzt zum Stammdatenlauf
inject("udp-rt-cz-inject", Z, "stündlich", 3600, 900, ["udp-rt-cz-sys"], 950)
http_get("udp-rt-cz-sys", Z, "GBFS-Systeme", "https://api.mobidata-bw.de/sharing/gbfs", ["udp-rt-cz-msgs"], 950)
func("udp-rt-cz-msgs", Z, "station_status je System", FN_CS_STATUS_MSGS, ["udp-rt-cz-rate"], 950, x=860)
delay_rate("udp-rt-cz-rate", Z, ["udp-rt-cz-get"], 1010)
http_get("udp-rt-cz-get", Z, "station_status", "", ["udp-rt-cz-fn"], 1010, x=620)
func("udp-rt-cz-fn", Z, "→ CarSharingStation + FleetStatus", FN_CS_STATUS, ["udp-rt-cz-post"], 1010, x=860)
upsert("udp-rt-cz-post", Z, ["udp-rt-cz-debug"], 1070)
debug("udp-rt-cz-debug", Z, "Carsharing-BW Ergebnis", 1070)

# OCPDB liefert bundesweit 90.572 Standorte; der frühere Vollabzug zog alle
# 95 Seiten und warf 85 % davon weg. Eine Radius-Abfrage um die Landesmitte
# deckt BW mit Reserve ab (Lörrach als entlegenster Punkt liegt bei 152 km)
# und kommt mit 29 Seiten aus — erst dadurch ist ein 30-Minuten-Takt für den
# landesweiten Livestatus vertretbar.
#
# OFFEN (24.08., bewusst NICHT in dieser Änderung behoben): Die Radius-Abfrage
# meldet total_count 29.902, geholt werden 29 × 1000 = 29.000 Standorte — rund
# 902 fallen also still unter den Tisch. Anders als bei der ParkAPI funktioniert
# die offset-Pagination hier nachweislich, es fehlen schlicht Seiten. Der Fix ist
# eine Zeile (OC_SEITEN hoch bzw. an next_path entlanglaufen), gehört aber in
# eine eigene Änderung mit eigener Messung des Volumen-Effekts — 902 zusätzliche
# Ladestandorte schreiben auch zusätzliche TRoE-Zeilen. Nicht vergessen.
OC_SEITEN = 29
FN_OC_KREISE = r'''// OCPDB-Abzug für BW paginiert (Radius 190 km um die Landesmitte)
const msgs = [];
for (let p = 0; p < __SEITEN__; p++) {
    msgs.push({ url: 'https://api.mobidata-bw.de/ocpdb/api/public/v1/locations'
                     + '?lat=48.65&lon=9.0&radius=190000&limit=1000&offset=' + (p * 1000),
                parts: { id: msg._msgid, index: p, count: __SEITEN__ }, topic: 'oc' + p });
}
return [msgs];'''.replace("__SEITEN__", str(OC_SEITEN))

FN_OC_WRAP = r'''if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.items)) {
    msg.payload = [];
    return msg;
}
// Apostroph bricht den TRoE-SQL-Insert (bekannter Orion-LD-Bug)
const clean = s => String(s == null ? '' : s).replace(/'/g, '’').slice(0, 80);
const FREI = ['AVAILABLE'], LAEDT = ['CHARGING', 'BLOCKED', 'RESERVED'], DEFEKT = ['INOPERATIVE', 'OUTOFORDER', 'REMOVED'];
// ACHTUNG: Nicht auf i.state filtern. Genau die Standorte mit Livestatus
// (DATEX-II-Zulieferer) liefern kein state-Feld — der frühere Textfilter hat
// sie deshalb allesamt verworfen, weshalb landesweit nie ein Aggregat
// Livedaten hatte. Grobfilter ist jetzt der BW-Umkasten; die exakte Zuordnung
// macht die Punkt-in-Polygon-Prüfung im Build-Schritt.
const imKasten = i => {
    const c = i.coordinates || {};
    const la = parseFloat(c.latitude), lo = parseFloat(c.longitude);
    return isFinite(la) && isFinite(lo) && la >= 47.4 && la <= 49.9 && lo >= 7.3 && lo <= 10.7;
};
msg.payload = msg.payload.items
    .filter(i => i.coordinates && imKasten(i))
    .map(i => {
        let live = 0, frei = 0, laedt = 0, defekt = 0;
        for (const e of i.evses || []) {
            const st = (e.status || '').toUpperCase();
            if (st === 'STATIC' || !st) continue;
            live++;
            if (FREI.includes(st)) frei++;
            else if (LAEDT.includes(st)) laedt++;
            else if (DEFEKT.includes(st)) defekt++;
        }
        return [i.id, parseFloat(i.coordinates.latitude), parseFloat(i.coordinates.longitude),
                (i.evses || []).length, live, frei, defekt,
                clean(i.name || i.address || ('Ladestation ' + i.id)),
                clean((i.operator && i.operator.name) || 'unbekannt'),
                clean((i.address || '') + ', ' + (i.postal_code || '') + ' ' + (i.city || '')),
                laedt];
    });
return msg;'''

FN_OC_BUILD = r'''// OCPDB-Kreisantworten -> ChargingSummary je Gemeinde (Dedupe über Standort-ID)
''' + NEAREST_HELPER + r'''
const seen = {};
for (const part of msg.payload) {
    if (!Array.isArray(part)) continue;
    for (const row of part) seen[row[0]] = row;
}
// Strikte Zuordnung: nur echte Polygon-Treffer. Der Umkasten aus dem
// Wrap-Schritt zieht auch Bayern, Hessen und die Schweiz herein; der
// Zentroid-Fallback von nearest() würde die stumm der nächstgelegenen
// BW-Gemeinde zuschlagen.
const inBW = (lat, lon) => {
    if (!GRZ) return null;
    for (const a in GRZ) {
        const g = GRZ[a], b = g.b;
        if (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3] && pip(lat, lon, g.r)) return GEMBYAGS[a] || null;
    }
    return null;
};
const byGem = {};
for (const id of Object.keys(seen)) {
    const [, lat, lon, evse, live, frei, defekt, , , , laedt] = seen[id];
    const g = inBW(lat, lon);
    if (!g) continue;
    const b = byGem[g[0]] = byGem[g[0]] || { n: 0, evse: 0, live: 0, frei: 0, laedt: 0, defekt: 0 };
    b.n++; b.evse += evse; b.live += live; b.frei += frei; b.laedt += laedt; b.defekt += defekt;
}
const entities = Object.keys(byGem).map(ags => {
    const b = byGem[ags];
    const e = {
        id: 'urn:ngsi-ld:ChargingSummary:bw-' + ags,
        type: 'ChargingSummary',
        ags: { type: 'Property', value: ags },
        locationCount: P(b.n, 'C62'),
        evseCount: P(b.evse, 'C62'),
        '@context': CTX
    };
    if (b.live) {
        e.liveEvse = P(b.live, 'C62'); e.availableEvse = P(b.frei, 'C62');
        e.chargingEvse = P(b.laedt, 'C62'); e.defectEvse = P(b.defekt, 'C62');
    }
    return e;
});

// --- Einzelstationen für JEDE Gemeinde (Stufe-3-Baustein »laden-detail«/»laden-live«) ---
// Der Abzug enthält die Standorte ohnehin; sie zu verwerfen wäre die eigentliche
// Verschwendung. Damit die Zeitreihen-DB nicht explodiert (ca. 13.000 Standorte
// × 48 Läufe/Tag), wird nur upsertet, was sich seit dem letzten Lauf geändert
// hat. Signatur = Statuswerte; Stammdaten ändern sich praktisch nie.
const alt = flow.get('ocSignatur') || {};
const neu = {};
let geaendert = 0;
for (const id of Object.keys(seen)) {
    const [, lat, lon, evse, live, frei, defekt, name, betreiber, adresse, laedt] = seen[id];
    const g = inBW(lat, lon);
    if (!g) continue;
    const slug = g[8];
    if (!slug) continue;
    const sig = evse + '|' + live + '|' + frei + '|' + laedt + '|' + defekt;
    neu[id] = sig;
    if (alt[id] === sig) continue;      // unverändert -> kein Schreibvorgang
    geaendert++;
    const e = {
        id: 'urn:ngsi-ld:EVChargingStation:' + slug + '-ocpdb-' + id,
        type: 'EVChargingStation',
        ags: { type: 'Property', value: g[0] },
        name: { type: 'Property', value: name },
        operator: { type: 'Property', value: betreiber },
        address: { type: 'Property', value: adresse },
        socketNumber: P(evse, 'C62'),
        dataProvider: { type: 'Property', value: 'MobiData BW OCPDB / Bundesnetzagentur' },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [lon, lat] } },
        '@context': CTX
    };
    // Livewerte nur, wo es sie gibt — sonst bliebe ein reiner Registereintrag
    // fälschlich als »0 frei« stehen statt als »keine Livedaten«.
    if (live) {
        e.liveEvse = P(live, 'C62'); e.availableEvse = P(frei, 'C62');
        e.chargingEvse = P(laedt, 'C62'); e.defectEvse = P(defekt, 'C62');
    }
    entities.push(e);
}
flow.set('ocSignatur', neu);
if (!entities.length) return null;
node.status({ text: Object.keys(seen).length + ' Standorte → ' + Object.keys(byGem).length
              + ' Gemeinden · ' + geaendert + ' Stationen aktualisiert' });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

inject("udp-rt-bo-inject", Z, "stündlich", 3600, 660, ["udp-rt-bo-msgs"], 860)
func("udp-rt-bo-msgs", Z, f"OCPDB-Seiten ({OC_SEITEN})", FN_OC_KREISE, ["udp-rt-bo-rate"], 860, x=380)
# 3 s statt 1 s zwischen den Seiten: Jede Antwort ist ~3 MB groß; im Sekundentakt
# überlappen die Downloads und einzelne Seiten kamen abgeschnitten an
# ("JSON parse error", 11 in 70 min) — die Standorte dieser Seiten fehlten dann
# im jeweiligen Lauf.
delay_slow("udp-rt-bo-rate", Z, ["udp-rt-bo-get"], 920, 3)
http_get("udp-rt-bo-get", Z, "OCPDB", "", ["udp-rt-bo-wrap"], 920, x=620)
func("udp-rt-bo-wrap", Z, "verschlanken", FN_OC_WRAP, ["udp-rt-bo-join"], 920, x=840)
# Betriebsregel: Join-Timeout >= Seitenzahl x Takt, plus Luft für die Downloads
join_parts("udp-rt-bo-join", Z, ["udp-rt-bo-build"], 980, x=400, timeout=420)
func("udp-rt-bo-build", Z, "→ ChargingSummary", FN_OC_BUILD, ["udp-rt-bo-post"], 980)
upsert("udp-rt-bo-post", Z, ["udp-rt-bo-debug"], 980)
debug("udp-rt-bo-debug", Z, "Laden-BW Ergebnis", 980)

FN_ECO_BW = r'''// Eco-Counter v2 (alle Kommunen) -> Zählstellen + Gemeinde-Summen
if (msg.statusCode >= 400 || !Array.isArray(msg.payload)) {
    node.warn('Eco-BW: keine Daten (' + msg.statusCode + ')');
    return null;
}
''' + NEAREST_HELPER + r'''
const clean = s => String(s == null ? '' : s).replace(/'/g, '’');
const entities = [];
const byGem = {};
for (const s of msg.payload) {
    if (!s.latitude || !s.longitude) continue;
    const all = (s.channels || []).filter(c => c.direction === 'ALL' && c.iso_timestamp);
    if (!all.length) continue;
    all.sort((a, b) => a.iso_timestamp < b.iso_timestamp ? -1 : 1);
    const latest = all[all.length - 1];
    const g = nearest(s.latitude, s.longitude);
    if (!g || g[0].slice(0, 2) !== '08') continue;
    const b = byGem[g[0]] = byGem[g[0]] || { total: 0, sites: 0, day: latest.iso_timestamp.slice(0, 10) };
    b.total += latest.counts || 0; b.sites++;
    entities.push({
        id: 'urn:ngsi-ld:TrafficFlowObserved:bw-eco-' + s.counter_site_id,
        type: 'TrafficFlowObserved',
        ags: { type: 'Property', value: g[0] },
        name: { type: 'Property', value: clean(s.counter_site) },
        vehicleType: { type: 'Property', value: 'bicycle' },
        dailyTotal: P(latest.counts, 'C62'),
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': latest.iso_timestamp } },
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [s.longitude, s.latitude] } },
        '@context': CTX
    });
}
for (const ags of Object.keys(byGem)) {
    const b = byGem[ags];
    entities.push({
        id: 'urn:ngsi-ld:TrafficFlowObserved:bw-' + ags + '-summary',
        type: 'TrafficFlowObserved',
        ags: { type: 'Property', value: ags },
        vehicleType: { type: 'Property', value: 'bicycle' },
        siteCount: P(b.sites, 'C62'),
        dailyTotal: P(b.total, 'C62'),
        dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': b.day + 'T00:00:00Z' } },
        '@context': CTX
    });
}
if (!entities.length) return null;
node.status({ text: entities.length + ' Objekte (' + Object.keys(byGem).length + ' Kommunen)' });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

nodes.append({
    "id": "udp-rt-be-inject", "type": "inject", "z": Z, "name": "täglich 06:10 (+ initial)",
    "props": [{"p": "payload"}], "repeat": "", "crontab": "10 06 * * *",
    "once": True, "onceDelay": "780", "topic": "", "payload": "", "payloadType": "date",
    "x": 150, "y": 1070, "wires": [["udp-rt-be-get"]],
})
http_get("udp-rt-be-get", Z, "Eco-Counter Tageswerte",
         "https://mobidata-bw.de/daten/eco-counter/v2/fahrradzaehler_tageswerten.json", ["udp-rt-be-fn"], 1070)
func("udp-rt-be-fn", Z, "→ Radzähler BW", FN_ECO_BW, ["udp-rt-be-rate"], 1070, x=860)
delay_rate("udp-rt-be-rate", Z, ["udp-rt-be-post"], 1130)
upsert("udp-rt-be-post", Z, ["udp-rt-be-debug"], 1130)
debug("udp-rt-be-debug", Z, "Radzähler-BW Ergebnis", 1130)
catch("udp-rt-bw2-catch", Z, "udp-rt-bw2-errdebug", 1220)
debug("udp-rt-bw2-errdebug", Z, "Fehler", 1220, x=380)

# ---------------------------------------------------------------- Tab BW-3: Energie & Puls
Z = "udp-rt-tab-bw3"
tab(Z, "BW: Energie & Puls",
    "MaStR-PV-Rotation (150 Gemeinden je Nacht, Vollzyklus ~1 Woche; Fortschritt im "
    "global-Kontext 'mastrPos') und stündlicher Gemeinde-Puls für alle Gemeinden mit "
    "mindestens 3 Datenkomponenten.")

FN_MASTR_ROT = r'''// Rotation: 150 Gemeinden je Nacht, je 5 Seiten à 2000 (deckt bis 10.000 Anlagen)
const GEM = global.get('bwGemeinden');
if (!Array.isArray(GEM)) { node.warn('bwGemeinden noch nicht im Kontext'); return null; }
const N = 150, PAGES = 10; // 10 Seiten à 2000 decken bis 20.000 Anlagen (Stuttgart: ~17.100)
const pos = global.get('mastrPos') || 0;
const slice = [];
for (let i = 0; i < N; i++) slice.push(GEM[(pos + i) % GEM.length]);
global.set('mastrPos', (pos + N) % GEM.length);
// Adaptive Seitenzahl je Gemeinde: die meisten haben < 2000 Anlagen (1 Seite);
// die feste 10-Seiten-Schleife feuerte ~1.350 Leerabfragen/Nacht gegen die
// Bundesquelle. Anlagenzahl aus dem letzten Lauf cachen; unbekannte Gemeinden
// bekommen einmal die volle Seitenzahl und korrigieren sich danach selbst.
const counts = global.get('mastrCount') || {};
const msgs = [];
let idx = 0;
for (const g of slice) {
    const known = counts[g[0]];
    const pages = known != null ? Math.min(PAGES, Math.max(1, Math.ceil(known / 2000))) : PAGES;
    for (let p = 1; p <= pages; p++) {
        msgs.push({
            url: 'https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung' +
                 '?sort=&pageSize=2000&filter=Energietr%C3%A4ger~eq~%272495%27~and~Gemeinde~eq~%27' +
                 encodeURIComponent(g[1]).replace(/'/g, '%27') + '%27~and~Betriebs-Status~eq~%2735%27&page=' + p,
            ags: g[0], gemName: g[1], page: p, topic: 'ms' + idx
        });
        idx++;
    }
}
// parts.count = tatsächliche Zahl der Abfragen (variabel), sonst wartet der Join ewig.
for (let k = 0; k < msgs.length; k++) msgs[k].parts = { id: msg._msgid, index: k, count: msgs.length };
node.status({ text: 'Position ' + pos + ' → ' + ((pos + N) % GEM.length) + ' · ' + msgs.length + ' Abfragen' });
return [msgs];'''

FN_MASTR_ROT_WRAP = r'''if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.Data)) {
    msg.payload = { ags: msg.ags, page: msg.page, total: 0, rows: [] };
    return msg;
}
msg.payload = {
    ags: msg.ags, page: msg.page, total: msg.payload.Total,
    rows: msg.payload.Data.map(r => {
        const m = /\/Date\((\d+)\)\//.exec(r.InbetriebnahmeDatum || '');
        return [r.Bruttoleistung || 0, m ? new Date(parseInt(m[1], 10)).getUTCFullYear() : 0];
    })
};
return msg;'''

FN_MASTR_ROT_BUILD = r'''// Seiten je Gemeinde aggregieren -> EnergyMonitor:bw-<ags>
const NOW = new Date().toISOString();
const CTX = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const P = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: NOW });
const byAgs = {};
for (const part of msg.payload) {
    if (!part || !part.ags) continue;
    const b = byAgs[part.ags] = byAgs[part.ags] || { total: 0, kw: 0, years: {}, got: 0 };
    b.total = Math.max(b.total, part.total || 0);
    for (const [kw, y] of part.rows) {
        b.kw += kw; b.got++;
        const yy = y && y < 2000 ? 1999 : y;
        if (yy) { b.years[yy] = b.years[yy] || [0, 0]; b.years[yy][0]++; b.years[yy][1] += kw; }
    }
}
const entities = [];
for (const ags of Object.keys(byAgs)) {
    const b = byAgs[ags];
    const additions = Object.keys(b.years).sort().map(y => [parseInt(y, 10), b.years[y][0], Math.round(b.years[y][1])]);
    entities.push({
        id: 'urn:ngsi-ld:EnergyMonitor:bw-' + ags,
        type: 'EnergyMonitor',
        ags: { type: 'Property', value: ags },
        plantCount: P(b.total, 'C62'),
        installedCapacityKw: P(Math.round(b.kw), 'KWT'),
        additionsByYear: { type: 'Property', value: additions.slice(-27), observedAt: NOW },
        complete: { type: 'Property', value: b.got >= b.total },
        '@context': CTX
    });
}
if (!entities.length) return null;
// Anlagenzahl je Gemeinde cachen — steuert im nächsten Lauf die Seitenzahl.
const counts = global.get('mastrCount') || {};
for (const ags of Object.keys(byAgs)) counts[ags] = byAgs[ags].total;
global.set('mastrCount', counts);
node.status({ text: entities.length + ' Gemeinden aggregiert' });
''' + CHUNK_HELPER + r'''
return [emitChunks(node, msg, entities, 100)];'''

nodes.append({
    "id": "udp-rt-bx-inject", "type": "inject", "z": Z, "name": "nachts 02:20 (+ initial)",
    "props": [{"p": "payload"}], "repeat": "", "crontab": "20 02 * * *",
    "once": True, "onceDelay": "900", "topic": "", "payload": "", "payloadType": "date",
    "x": 150, "y": 80, "wires": [["udp-rt-bx-msgs"]],
})
func("udp-rt-bx-msgs", Z, "Rotation (150×5 Seiten)", FN_MASTR_ROT, ["udp-rt-bx-rate"], 80, x=400)
delay_rate("udp-rt-bx-rate", Z, ["udp-rt-bx-get"], 140)
http_get("udp-rt-bx-get", Z, "MaStR-API", "", ["udp-rt-bx-wrap"], 140, x=620)
func("udp-rt-bx-wrap", Z, "verschlanken", FN_MASTR_ROT_WRAP, ["udp-rt-bx-join"], 140, x=840)
join_parts("udp-rt-bx-join", Z, ["udp-rt-bx-build"], 200, x=400, timeout=1000)
func("udp-rt-bx-build", Z, "→ EnergyMonitor je Gemeinde", FN_MASTR_ROT_BUILD, ["udp-rt-bx-post"], 200)
upsert("udp-rt-bx-post", Z, ["udp-rt-bx-debug"], 200)
debug("udp-rt-bx-debug", Z, "MaStR-BW Ergebnis", 200)

FN_PULSE_BW_MSGS = r'''// Aggregat-Typen einsammeln (6 Abfragen)
const Q = [
    'type=PublicTransportStop&attrs=ags,avgDelayMinutes',
    'type=BikeParking&attrs=ags,availableSpotNumber,totalSpotNumber',
    'type=AirQualityObserved&idPattern=urn:ngsi-ld:AirQualityObserved:bw-.*&attrs=ags,pm25,pm10,airQualityIndex',
    'type=ParkingSummary&attrs=ags,realtimeFree,realtimeSites',
    'type=SharingSummary&attrs=ags,availableVehicles',
    'type=ChargingSummary&attrs=ags,liveEvse,availableEvse',
    'type=RoadWork&idPattern=urn:ngsi-ld:RoadWork:bw-svz-.*&attrs=ags',
    'type=Alert&idPattern=urn:ngsi-ld:Alert:bw-kreis-.*&attrs=ags,maxSeverity,activeCount',
];
return [Q.map((q, i) => ({
    url: 'http://orion-ld:1026/ngsi-ld/v1/entities?' + q + '&options=keyValues&limit=1000',
    parts: { id: msg._msgid, index: i, count: Q.length }, topic: 'pq' + i
}))];'''

FN_PULSE_BW_BUILD = r'''// Gemeinde-Puls für alle Gemeinden mit >= 3 Komponenten
const NOW = new Date().toISOString();
const CTX = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld';
const clamp = x => Math.max(0, Math.min(100, x));
const gem = {};
const G = (ags) => gem[ags] = gem[ags] || {};
for (const list of msg.payload) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
        const id = e.id || '';
        const ags = e.ags;
        if (!ags) continue;
        if (id.includes(':PublicTransportStop:')) G(ags).delay = e.avgDelayMinutes;
        else if (id.includes(':BikeParking:')) {
            const g0 = G(ags);
            g0.brFrei = (g0.brFrei || 0) + (e.availableSpotNumber || 0);
            g0.brKap = (g0.brKap || 0) + (e.totalSpotNumber || 0);
        }
        else if (id.includes(':AirQualityObserved:bw-sc-')) {
            // Gleiche Plausibilitätsgrenze wie beim Einlesen (SDS011 in Sättigung
            // meldet ~500 µg/m³). Greift zusätzlich hier, weil Altbestände im
            // Broker nicht überschrieben werden, solange kein Sensor mehr liefert.
            const pm = e.pm25 ?? e.pm10;
            if (typeof pm === 'number' && pm <= 400) G(ags).pm25 = pm;
        }
        else if (id.includes(':AirQualityObserved:bw-uba-')) G(ags).aqi = e.airQualityIndex;
        else if (id.includes(':SharingSummary:')) G(ags).sharing = (G(ags).sharing || 0) + (e.availableVehicles || 0);
        else if (id.includes(':ChargingSummary:') && e.liveEvse) G(ags).laden = (e.availableEvse || 0) / e.liveEvse;
        else if (id.includes(':RoadWork:bw-svz-')) G(ags).baustellen = (G(ags).baustellen || 0) + 1;
        else if (id.includes(':Alert:bw-kreis-')) {
            // Kreis-Warnung auf alle Gemeinden des Kreises anwenden (Präfix)
            G('K' + ags).warnSev = Math.max(G('K' + ags).warnSev || 0, e.maxSeverity || 0);
        }
    }
}
const entities = [];
for (const ags of Object.keys(gem)) {
    if (ags.startsWith('K')) continue;
    const d = gem[ags];
    const kreis = gem['K' + ags.slice(0, 5)] || {};
    const comp = [];
    if (d.pm25 != null) comp.push(['feinstaub', Math.round(clamp(100 - d.pm25 * 4)), 0.3]);
    if (d.aqi != null) comp.push(['luftindex', Math.round(clamp((5 - d.aqi) * 25)), 0.2]);
    if (d.sharing != null) comp.push(['sharing', Math.round(clamp(d.sharing)), 0.1]);
    if (d.laden != null) comp.push(['laden', Math.round(d.laden * 100), 0.15]);
    if (d.baustellen != null) comp.push(['baustellen', Math.round(clamp(100 - d.baustellen * 5)), 0.15]);
    if (d.delay != null) comp.push(['oepnv', Math.round(clamp(100 - d.delay * 8)), 0.2]);
    if (d.brKap) comp.push(['br', Math.round(clamp(d.brFrei / d.brKap * 100)), 0.05]);
    const sev = kreis.warnSev || 0;
    comp.push(['warnungen', [100, 80, 60, 30, 0][sev] ?? 0, 0.2]);
    if (comp.length < 3) continue;
    const wSum = comp.reduce((s, c) => s + c[2], 0);
    const index = Math.round(comp.reduce((s, c) => s + c[1] * c[2], 0) / wSum);
    entities.push({
        id: 'urn:ngsi-ld:CityPulse:bw-' + ags,
        type: 'CityPulse',
        ags: { type: 'Property', value: ags },
        pulseIndex: { type: 'Property', value: index, observedAt: NOW },
        components: { type: 'Property', value: comp, observedAt: NOW },
        '@context': CTX
    });
}
if (!entities.length) return null;
''' + CHUNK_HELPER + r'''
// Stündlicher Lauf, aber die meisten Komponenten ändern sich seltener — ohne Gate
// schrieb jeder Lauf alle Gemeinde-Pulse erneut in die TRoE-Historie (~38k Zeilen/Tag).
const geaendert = gateChanged(node, entities, 'pulseSig',
    e => e.pulseIndex.value + '|' + JSON.stringify(e.components.value));
if (!geaendert.length) { node.status({ text: 'unverändert (' + entities.length + ')' }); return null; }
return [emitChunks(node, msg, geaendert, 100)];'''

inject("udp-rt-bz-inject", Z, "stündlich", 3600, 840, ["udp-rt-bz-msgs"], 300)
func("udp-rt-bz-msgs", Z, "Aggregat-Abfragen (6)", FN_PULSE_BW_MSGS, ["udp-rt-bz-rate"], 300, x=400)
delay_rate("udp-rt-bz-rate", Z, ["udp-rt-bz-get"], 360)
http_get("udp-rt-bz-get", Z, "Orion-Abfrage", "", ["udp-rt-bz-join"], 360, x=620)
join_parts("udp-rt-bz-join", Z, ["udp-rt-bz-build"], 420, x=400, timeout=60)
func("udp-rt-bz-build", Z, "→ CityPulse je Gemeinde", FN_PULSE_BW_BUILD, ["udp-rt-bz-post"], 420)
upsert("udp-rt-bz-post", Z, ["udp-rt-bz-debug"], 420)
debug("udp-rt-bz-debug", Z, "Puls-BW Ergebnis", 420)
catch("udp-rt-bw3-catch", Z, "udp-rt-bw3-errdebug", 510)
debug("udp-rt-bw3-errdebug", Z, "Fehler", 510, x=380)

# ---------------------------------------------------------------- Tab 6: Betriebsmetriken
Z = "udp-rt-tab-ops"
tab(Z, "Plattform: Betriebsmetriken",
    "Serverlast, RAM, Disk und Uptime des Hosts (via /proc, Kernel wird mit dem Container "
    "geteilt) als NGSI-LD-Entität PlatformStatus:udp sowie TRoE-Statistiken aus TimescaleDB "
    "(pg-Modul, PlatformStatus:udp-troe) — Grundlage für das UDP-Hauptdashboard.")

FN_OPS = r'''// /proc-Ausgabe -> PlatformStatus:udp
const parts = String(msg.payload || '').split('---');
if (parts.length < 5) { node.warn('Betriebsmetriken: unerwartete exec-Ausgabe'); return null; }
const num = s => parseFloat(String(s).replace(',', '.'));
const load = parts[0].trim().split(/\s+/);                      // loadavg
const memLine = (parts[1].match(/^Mem:.*$/m) || [''])[0].trim().split(/\s+/); // free -m
const dfLine = parts[2].trim().split('\n').pop().trim().split(/\s+/);         // df -P /data
const uptimeS = num(parts[3].trim().split(/\s+/)[0]);
const cores = parseInt(parts[4].trim(), 10) || 1;
const memTotal = num(memLine[1]), memAvail = num(memLine[6] !== undefined ? memLine[6] : memLine[3]);
const diskPct = num((dfLine[4] || '').replace('%', ''));
const now = new Date().toISOString();
const P = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: now });
msg.payload = [{
    id: 'urn:ngsi-ld:PlatformStatus:udp',
    type: 'PlatformStatus',
    name: { type: 'Property', value: 'UDP-Host Betriebsmetriken' },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    cpuLoad1: P(num(load[0]), 'C62'),
    cpuLoad15: P(num(load[2]), 'C62'),
    cpuCores: P(cores, 'C62'),
    cpuLoadPct: P(Math.round(num(load[0]) / cores * 100), 'P1'),
    memUsedPct: P(memTotal ? Math.round((1 - memAvail / memTotal) * 100) : null, 'P1'),
    memTotalMb: P(memTotal, 'E38'),
    diskUsedPct: P(diskPct, 'P1'),
    diskTotalGb: P(Math.round(num(dfLine[1]) / 1048576), 'E34'),
    uptimeDays: P(Math.round(uptimeS / 86400 * 10) / 10, 'DAY'),
    '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld'
}];
node.status({ text: 'Load ' + load[0] + '/' + cores + ' · RAM ' + (memTotal ? Math.round((1 - memAvail / memTotal) * 100) : '?') + '% · Disk ' + diskPct + '%' });
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;'''

FN_TROE = r'''// TimescaleDB-Statistiken -> PlatformStatus:udp-troe
// Ersetzt die frühere Grafana-Datasource-API: das Hauptdashboard liest diese
// Entität statt selbst SQL zu sprechen (kein öffentlicher SQL-Pfad mehr).
const { Client } = pg;
const client = new Client({
    host: 'timescale', port: 5432, database: 'orion',
    user: env.get('TROE_DB_USER') || 'udp', password: env.get('TROE_DB_PASSWORD'),
    connectionTimeoutMillis: 10000, query_timeout: 60000,
});
await client.connect();
let base, ing, typ;
try {
    base = (await client.query(
        "SELECT pg_database_size('orion') AS db, (SELECT count(*) FROM attributes) AS rows, " +
        "(SELECT count(DISTINCT entityid) FROM attributes) AS ents, " +
        "(SELECT count(*) FROM attributes WHERE ts > (now() AT TIME ZONE 'utc') - interval '24 hours') AS r24, " +
        "(SELECT count(*) FROM attributes WHERE ts > (now() AT TIME ZONE 'utc') - interval '1 hour') AS r1")).rows[0];
    ing = (await client.query(
        "SELECT to_char(date_trunc('hour', ts), 'HH24') AS h, count(*) AS n FROM attributes " +
        "WHERE ts > (now() AT TIME ZONE 'utc') - interval '24 hours' " +
        "GROUP BY date_trunc('hour', ts) ORDER BY date_trunc('hour', ts)")).rows;
    // Ohne LIMIT: Die Budgetprüfung unten muss ALLE Typen sehen. Eine Ausreißer-
    // Reihe braucht nicht unter den Top 14 zu stehen, um ihr Budget zu sprengen.
    // Ins Dashboard gehen weiterhin nur die 14 größten (siehe rowsByType).
    typ = (await client.query(
        "SELECT split_part(entityid, ':', 3) AS typ, count(*) AS n, " +
        "count(*) FILTER (WHERE ts > (now() AT TIME ZONE 'utc') - interval '24 hours') AS n24, " +
        "count(DISTINCT entityid) AS e FROM attributes GROUP BY 1 ORDER BY n DESC")).rows;
} finally {
    await client.end();
}
// Zeilenbudget je Entitätstyp aus der Konnektor-Registry (Feld rowBudget24h,
// optional). Nach dem ParkAPI-Vorfall vom 24.08. — ein Konnektor schrieb einen
// Monat lang ~1,04 Mio Zeilen/Tag, die Hälfte der ganzen Zeitreihen-Datenbank,
// ohne dass irgendetwas Alarm schlug — ist das die stehende Sicherung: Wer sein
// erwartetes Tagesvolumen überschreitet, landet im Node-RED-Log. Typen ohne
// hinterlegtes Budget werden wie bisher nur gezählt, nie beanstandet.
const BUDGET = __ROW_BUDGET__;
const ueberzogen = typ.filter(r => BUDGET[r.typ] && Number(r.n24) > BUDGET[r.typ])
    .map(r => r.typ + ': ' + Number(r.n24) + ' statt max. ' + BUDGET[r.typ]);
if (ueberzogen.length) {
    node.warn('TRoE-Zeilenbudget (24 h) überschritten — ' + ueberzogen.join(' · '));
}
const now = new Date().toISOString();
const P = v => ({ type: 'Property', value: v, observedAt: now });
msg.payload = [{
    id: 'urn:ngsi-ld:PlatformStatus:udp-troe',
    type: 'PlatformStatus',
    name: { type: 'Property', value: 'TRoE-Statistiken (TimescaleDB)' },
    dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': now } },
    dbSizeBytes: P(Number(base.db)),
    troeRows: P(Number(base.rows)),
    troeRows24h: P(Number(base.r24)),
    troeRows1h: P(Number(base.r1)),
    troeEntities: P(Number(base.ents)),
    ingestByHour: P(ing.map(r => [r.h, Number(r.n)])),
    rowsByType: P(typ.slice(0, 14).map(r => [r.typ, Number(r.n), Number(r.n24), Number(r.e)])),
    '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld'
}];
node.status({ text: base.rows + ' Zeilen · +' + base.r1 + '/h' });
msg.headers = { 'Content-Type': 'application/ld+json' };
return msg;'''


# Budgets aus der Registry einsammeln: rowBudget24h ist ein optionales
# {Entitätstyp: Zeilen/Tag}-Objekt je Konnektor. Mehrere Konnektoren dürfen auf
# denselben Typ schreiben — dann summieren sich ihre Budgets.
ROW_BUDGET = {}
for _c in REGISTRY:
    for _typ, _n in (_c.get("rowBudget24h") or {}).items():
        ROW_BUDGET[_typ] = ROW_BUDGET.get(_typ, 0) + int(_n)

inject("udp-rt-db-inject", Z, "alle 10 Minuten", 600, 25, ["udp-rt-db-fn"], 260)
func("udp-rt-db-fn", Z, "→ PlatformStatus:udp-troe (SQL)", FN_TROE.replace(
         "__ROW_BUDGET__", json.dumps(ROW_BUDGET, ensure_ascii=False, sort_keys=True)),
     ["udp-rt-db-post"], 260, x=420,
     libs=[{"var": "pg", "module": "pg"}])
upsert("udp-rt-db-post", Z, ["udp-rt-db-debug"], 260)
debug("udp-rt-db-debug", Z, "TRoE-Statistik Ergebnis", 260)

FN_TROE_RETENTION = r'''// TRoE-Retention: Zeitreihen älter 12 Monate löschen (betrieb.md, Sprint 1.6)
// Nur attributes/subattributes (Volumentreiber); die kleine entities-Tabelle
// bleibt vollständig, damit Mintaka Entitäts-Metadaten rekonstruieren kann.
const { Client } = pg;
const client = new Client({
    host: 'timescale', port: 5432, database: 'orion',
    user: env.get('TROE_DB_USER') || 'udp', password: env.get('TROE_DB_PASSWORD'),
    connectionTimeoutMillis: 10000, query_timeout: 600000,
});
await client.connect();
let a = 0, s = 0;
try {
    // ts-Indizes (idempotent): tragen Retention UND die 10-min-Statistikabfragen
    await client.query("CREATE INDEX IF NOT EXISTS attributes_ts_idx ON attributes (ts)");
    await client.query("CREATE INDEX IF NOT EXISTS subattributes_ts_idx ON subattributes (ts)");
    // (entityid, ts) mit text_pattern_ops: trägt Mintaka-Temporalabfragen je
    // Entität (vorher Seq-Scan über die ganze Tabelle) und die LIKE-Staffeln unten
    await client.query("CREATE INDEX IF NOT EXISTS attributes_entityid_ts_idx ON attributes (entityid text_pattern_ops, ts)");
    a = (await client.query("DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '12 months'")).rowCount;
    s = (await client.query("DELETE FROM subattributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '12 months'")).rowCount;

    // Gestaffelt: Einzelstandorte (Ladesäulen, Carsharing-Stationen, Parkplätze,
    // Bürgersensoren) sind der Volumentreiber des landesweiten Stufe-3-Ausbaus,
    // werden aber nirgends über Monate ausgewertet — die Dashboards zeigen
    // ihren aktuellen Zustand auf der Karte. Aggregate je Gemeinde bleiben die
    // vollen 12 Monate, weil die Verlaufsdiagramme darauf beruhen.
    const kurz = (await client.query(
        "DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '3 months' " +
        "AND (entityid LIKE 'urn:ngsi-ld:EVChargingStation:%' " +
        "  OR entityid LIKE 'urn:ngsi-ld:CarSharingStation:%' " +
        "  OR entityid LIKE 'urn:ngsi-ld:ParkingSite:%' " +
        "  OR entityid LIKE 'urn:ngsi-ld:AirQualityObserved:bw-sensor-%')")).rowCount;
    a += kurz;
    if (kurz) node.warn('Retention: ' + kurz + ' Zeilen aus Einzelstandorten (3-Monats-Staffel)');
    // Verwaiste Reste der abgelösten Reutlingen-Parkpipeline: OffStreetParking wird
    // nirgends mehr geschrieben, liegt aber noch im Temporal-Store (nicht im Broker).
    // Idempotent aufräumen — greift beim ersten Lauf, danach 0 Zeilen.
    const verwaist = (await client.query(
        "DELETE FROM attributes WHERE entityid LIKE 'urn:ngsi-ld:OffStreetParking:%'")).rowCount;
    if (verwaist) node.warn('Retention: ' + verwaist + ' verwaiste OffStreetParking-Zeilen entfernt');
    a += verwaist;
} finally {
    await client.end();
}
node.status({ text: 'gelöscht: ' + a + ' attributes / ' + s + ' subattributes' });
msg.payload = { deletedAttributes: a, deletedSubattributes: s, at: new Date().toISOString() };
return msg;'''

inject("udp-rt-rt-inject", Z, "täglich 03:40", None, 30, ["udp-rt-rt-fn"], 440)
func("udp-rt-rt-fn", Z, "TRoE-Retention (12 Mon. / 3 Mon. Standorte)", FN_TROE_RETENTION, ["udp-rt-rt-debug"], 440, x=420,
     libs=[{"var": "pg", "module": "pg"}])
debug("udp-rt-rt-debug", Z, "Retention Ergebnis", 440, x=650)

inject("udp-rt-op-inject", Z, "alle 2 Minuten", 120, 20, ["udp-rt-op-exec"], 80)
nodes.append({
    "id": "udp-rt-op-exec", "type": "exec", "z": Z, "name": "Host-Metriken (/proc)",
    "command": "sh -c 'cat /proc/loadavg; echo ---; free -m; echo ---; df -P /data; echo ---; cat /proc/uptime; echo ---; nproc'",
    "addpay": "none", "append": "", "useSpawn": "false", "timer": "10",
    "winHide": False, "oldrc": False,
    "x": 400, "y": 80, "wires": [["udp-rt-op-fn"], [], []],
})
func("udp-rt-op-fn", Z, "→ PlatformStatus", FN_OPS, ["udp-rt-op-post"], 80, x=650)
upsert("udp-rt-op-post", Z, ["udp-rt-op-debug"], 80)
debug("udp-rt-op-debug", Z, "Metriken Ergebnis", 80)
catch("udp-rt-op-catch", Z, "udp-rt-op-errdebug", 170)
debug("udp-rt-op-errdebug", Z, "Fehler", 170, x=380)

# ---------------------------------------------------------------- zusammenführen
# ---- Registry-Interpretation: Takt/Cron anwenden, Inaktive entfernen, Abdeckung prüfen ----
def conn_of(node_id):
    for c in REGISTRY:
        for p in c["nodePrefixes"]:
            if node_id.startswith(p):
                return c
    return None

uncovered = []
kept = []
for n in nodes:
    nid = str(n.get("id", ""))
    c = conn_of(nid)
    if c is None:
        # Tabs, Catch-/Fehler-Nodes u. ä. bleiben immer erhalten
        if n.get("type") not in ("tab", "catch", "debug") and not nid.endswith("-errdebug"):
            uncovered.append(nid)
        kept.append(n)
        continue
    if not c.get("active", True):
        continue  # inaktiver Konnektor: Pipeline komplett entfernen
    if n.get("type") == "inject":
        # Seltene Quellen (Overpass u. a.) sollen nicht sofort bei jedem Neustart
        # feuern — sonst laufen Entwicklungs-Restarts in die Rate-Limits der
        # Anbieter. Sie ganz vom Start auszunehmen war aber der falsche Schluss:
        # Wer öfter neu startet als das Abrufintervall lang ist, lässt den
        # Konnektor verhungern (wetter-bw stand nach einem Abend mit vielen
        # Neustarts 11 h ohne Daten da). Deshalb: verzögert feuern statt gar
        # nicht — im Regelbetrieb einmal 10 min nach dem Start, was die
        # Anbieter nicht belastet, aber Datenlücken nach Neustarts ausschließt.
        if c.get("refireOnRestart") is False:
            n["onceDelay"] = "600"
        if c.get("cron"):
            n["crontab"] = c["cron"]
            n["repeat"] = ""
        elif c.get("intervalSeconds"):
            n["repeat"] = str(c["intervalSeconds"])
            n["crontab"] = ""
    kept.append(n)
nodes = kept
if uncovered:
    print("WARNUNG: Nodes ohne Registry-Zuordnung:", ", ".join(sorted(set(uncovered))), file=sys.stderr)

# Status-Export fürs Frontend/Monitoring (ein Pflegeort)
status = [{k: c.get(k) for k in ("id", "name", "scope", "enabledFor", "sollMinutes",
                                 "sampleEntity", "provides", "attribution",
                                 "requiresSecret", "active", "supersededBy", "pending",
                                 "refireOnRestart", "healthUrl")}
          for c in REGISTRY]
# "stand" = Änderungszeit der Registry, nicht die Laufzeit: sonst erzeugt jeder
# Generatorlauf einen Diff, obwohl sich fachlich nichts geändert hat.
_stand = datetime.fromtimestamp(Path(REGISTRY_PATH).stat().st_mtime,
                                timezone.utc).isoformat(timespec="seconds")
with open(STATUS_EXPORT, "w", encoding="utf-8") as f:
    json.dump({"stand": _stand, "connectors": status}, f, ensure_ascii=False, indent=1)
    f.write("\n")

with open(FLOWS, encoding="utf-8") as f:
    existing = json.load(f)

existing = [n for n in existing if not str(n.get("id", "")).startswith("udp-rt-")]
existing.extend(nodes)

with open(FLOWS, "w", encoding="utf-8") as f:
    json.dump(existing, f, indent=4, ensure_ascii=False)
    f.write("\n")

print(f"OK: {len(nodes)} neue Nodes, gesamt {len(existing)}")
