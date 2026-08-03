# Third-Party Notices

Die eigenen Bestandteile dieses Werks (UDP-Cockpit und Dashboards, Konfigurationen,
Helm-Chart, Skripte, Dokumentation) stehen unter der **EUPL-1.2** — siehe
[`LICENSE`](LICENSE).

Dieses Dokument listet alle Fremdkomponenten mit ihrer jeweiligen Lizenz. Punkte,
die eine Entscheidung oder Bestätigung erfordern, sind als **REVIEW NEEDED**
gekennzeichnet und in [§8](#8-offene-punkte--review-needed) gesammelt.

**Stand:** 2026-08-03 · npm-Baum per `license-checker-rseidelsohn` (175 Pakete,
davon 32 im Auslieferungsbaum), Container und einkopierte Dateien manuell geprüft.

---

## 1. Zur EUPL-Kompatibilität

Die EUPL-1.2 nennt in ihrem Anhang ausdrücklich kompatible Lizenzen (u. a. GPL-2.0/3.0,
AGPL-3.0, LGPL-2.1/3.0, MPL-2.0, EPL-1.0, CeCILL, OSL, LiLiQ). Diese Liste regelt den
Fall, dass EUPL-Code mit fremdem Code zu einem **abgeleiteten Werk** verschmilzt.

Für dieses Projekt gilt zusätzlich:

- **Permissive Lizenzen** (MIT, ISC, BSD-2/3-Clause, Apache-2.0, MIT-0, BlueOak-1.0.0,
  CC0-1.0) stehen einer Einbindung in ein EUPL-Werk nicht entgegen. Sie erscheinen
  nicht im EUPL-Anhang, weil sie keine Copyleft-Wirkung entfalten, die eine
  Kompatibilitätsregel nötig machen würde.
- **Container-Komponenten** (§4) werden **unverändert als eigenständige Prozesse**
  betrieben und nicht mit eigenem Code gelinkt. Es entsteht kein abgeleitetes Werk;
  die Copyleft-Pflichten von AGPL/GPL greifen für den Eigenanteil dieser Plattform
  nicht. Jede Komponente behält ihre Lizenz.
- Im Auslieferungsbaum des Frontends befindet sich **kein Copyleft-Code**.

---

## 2. Frontend — ausgelieferte Abhängigkeiten (npm, `gui/`)

Diese 31 Pakete (plus das Projekt selbst) landen im Browser-Bundle.
**Alle permissiv lizenziert, kein Copyleft.**

| Paket | Version | Lizenz |
|---|---|---|
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-router | 7.18.1 | MIT |
| react-router-dom | 7.18.1 | MIT |
| scheduler | 0.27.0 | MIT |
| keycloak-js | 26.2.4 | Apache-2.0 |
| maplibre-gl | 6.0.0 | BSD-3-Clause |
| @maplibre/maplibre-gl-style-spec | 26.2.1 | ISC |
| @maplibre/geojson-vt | 6.1.1 | ISC |
| @maplibre/vt-pbf | 4.3.2 | MIT |
| @maplibre/mlt | 1.1.12 | MIT OR Apache-2.0 |
| @mapbox/jsonlint-lines-primitives | 2.0.3 | MIT |
| @mapbox/point-geometry | 1.1.0 | ISC |
| @mapbox/tiny-sdf | 2.2.0 | BSD-2-Clause |
| @mapbox/unitbezier | 1.0.0 | BSD-2-Clause |
| @mapbox/vector-tile | 3.0.0 | BSD-3-Clause |
| pbf | 5.1.2 | BSD-3-Clause |
| protocol-buffers-schema | 3.6.1 | MIT |
| resolve-protobuf-schema | 2.1.0 | MIT |
| earcut | 3.2.3 | ISC |
| gl-matrix | 3.4.4 | MIT |
| kdbush | 4.1.0 | ISC |
| potpack | 2.1.0 | ISC |
| quickselect | 3.0.0 | ISC |
| tinyqueue | 3.0.0 | ISC |
| murmurhash-js | 1.0.0 | MIT |
| json-stringify-pretty-compact | 4.0.0 | MIT |
| minimist | 1.2.8 | MIT |
| cookie | 1.1.1 | MIT |
| set-cookie-parser | 2.7.2 | MIT |
| @types/geojson | 7946.0.16 | MIT |

## 3. Build- und Testwerkzeuge (npm `devDependencies`)

Nicht Teil der Auslieferung — sie erzeugen bzw. prüfen das Bundle nur.
143 weitere Pakete, Verteilung:

| Lizenz | Pakete |
|---|---|
| MIT | 118 |
| Apache-2.0 | 16 |
| ISC | 15 |
| BSD-2-Clause | 10 |
| BSD-3-Clause | 6 |
| MPL-2.0 | 3 (`lightningcss` und dessen Plattform-Binaries, transitiv über Vite) |
| MIT-0 | 2 |
| BlueOak-1.0.0 | 2 |
| CC0-1.0 | 1 |

Direkte Werkzeuge: Vite (MIT), TypeScript (Apache-2.0), ESLint (MIT),
typescript-eslint (MIT), Prettier (MIT), jsdom (MIT), @vitejs/plugin-react (MIT).

MPL-2.0 ist dateibezogenes Copyleft und laut EUPL-Anhang kompatibel; da
`lightningcss` unverändert als Build-Werkzeug genutzt und nicht ausgeliefert wird,
entstehen keine weitergehenden Pflichten.

**Die Python-Skripte unter `scripts/` verwenden ausschließlich die
Standardbibliothek** (`argparse`, `collections`, `datetime`, `json`, `pathlib`,
`shutil`, `sys`, `time`, `urllib`) — es gibt keine Python-Abhängigkeiten und keine
`requirements.txt`.

---

## 4. Einkopierte Fremddateien im Repository

Diese Dateien liegen als Kopie im Repo und werden mit ihm weitergegeben.

| Datei(en) | Komponente | Lizenz | Hinweis |
|---|---|---|---|
| `gui/public/vendor/leaflet.js`, `leaflet.css` | Leaflet 1.9.4 | BSD-2-Clause | © 2010–2023 Vladimir Agafonkin, © 2010–2011 CloudMade. Copyright-Vermerk im `@preserve`-Header der Datei erhalten. |
| `gui/public/vendor/images/marker-icon.png`, `marker-icon-2x.png`, `marker-shadow.png`, `layers.png`, `layers-2x.png` | Leaflet-Standardgrafiken | BSD-2-Clause | gleicher Rechteinhaber; die Grafiken tragen selbst keinen Vermerk — die Nennung erfolgt hier. |

BSD-2-Clause verlangt, dass Copyright-Vermerk und Lizenztext bei Weitergabe
erhalten bleiben. Für den Code geschieht das im Dateikopf, für die Bilddateien
durch diesen Abschnitt.

**Nicht im Repository enthalten:** Das **Masterportal** (Geowerkstatt Hamburg, MIT)
wird optional per `scripts/get-masterportal.sh` von Bitbucket geladen und liegt unter
`platform/config/masterportal/` — dieser Pfad ist in `.gitignore` ausgeschlossen.

**Keine Schriftarten:** Das Projekt bindet keine Webfonts ein (keine `@font-face`,
keine Google Fonts) und nutzt ausschließlich Systemschriften.

**Keine CDN-Einbindungen:** Alle Assets werden lokal ausgeliefert; ein statischer
Test (`tests/static/pages-parse.test.js`) sichert das ab.

---

## 5. Laufzeitkomponenten (Container)

Diese Dienste werden **unverändert** von ihren offiziellen Registries bezogen und als
eigenständige Container betrieben. Sie sind nicht Teil dieses Repositorys.

| Komponente | Image | Rolle | Lizenz | OSI |
|---|---|---|---|---|
| FIWARE Orion-LD | `fiware/orion-ld:1.6.0` | NGSI-LD Context Broker | AGPL-3.0 | ✅ |
| FIWARE Mintaka | `fiware/mintaka:0.7.0` | NGSI-LD Temporal API | AGPL-3.0 | ✅ |
| FIWARE IoT-Agent JSON | `fiware/iotagent-json:3.14.0-distroless` | MQTT/HTTP → NGSI-LD | AGPL-3.0 | ✅ |
| MongoDB Community | `mongo:5.0` | Zustandsspeicher des Brokers | **SSPL-1.0** | ❌ (§6.1) |
| FROST-Server | `fraunhoferiosb/frost-server:2.7.3` | OGC SensorThings API | LGPL-3.0 | ✅ |
| Eclipse Mosquitto | `eclipse-mosquitto:2.0` | MQTT-Broker | EPL-2.0 / EDL-1.0 | ✅ |
| Apache APISIX | `apache/apisix:3.17.0-debian` | API-Gateway | Apache-2.0 | ✅ |
| Keycloak | `quay.io/keycloak/keycloak:26.7` | Identität, Rollen, Mandanten | Apache-2.0 | ✅ |
| Apache Solr | `ckan/ckan-solr:2.10-solr9` | CKAN-Suchindex | Apache-2.0 | ✅ |
| Valkey | `valkey/valkey:8-alpine` | CKAN-Queues/Sessions | BSD-3-Clause | ✅ |
| GeoServer | `docker.osgeo.org/geoserver:2.28.4` | OGC WMS/WFS/WPS | GPL-2.0 | ✅ |
| Apache Superset (optional) | `apache/superset:6.1.0` | Self-Service-BI | Apache-2.0 | ✅ |
| nginx | `nginx:1.30-alpine`, `nginxinc/nginx-unprivileged:1.30-alpine` | Auslieferung/Proxy | BSD-2-Clause | ✅ |
| postgres-backup-local | `prodrigestivill/postgres-backup-local:16-alpine` | Dump-Sidecar | MIT | ✅ |
| Uptime Kuma | `louislam/uptime-kuma:1` | Monitoring (`monitoring/`, eigenes Deployment) | MIT | ✅ |

## 6. Selbst gebaute Images

Diese vier Images entstehen aus Dateien dieses Repositorys und werden vom Workflow
`.github/workflows/build-images.yml` in die GitHub Container Registry
veröffentlicht — sie werden also **weiterverbreitet**.

| Image | Basis | Zusatz | Lizenzlage |
|---|---|---|---|
| `cockpit` | `nginxinc/nginx-unprivileged:1.30-alpine` (BSD-2-Clause), Build mit `node:24-alpine` (MIT) | eigenes GUI-Bundle | Eigenanteil EUPL-1.2 + permissive Basis — unkritisch |
| `node-red-udp` | `nodered/node-red:4.1` (Apache-2.0) | `pg@8` (MIT) | permissiv — unkritisch |
| `ckan-dcat` | `ckan/ckan-base:2.10.10` (**AGPL-3.0**) | `ckanext-dcat>=1.7.0` (AGPL-3.0) | **REVIEW NEEDED** (§8.1) |
| `postgres-timescale-oss` | `postgis/postgis:16-3.5` — PostgreSQL-Lizenz + PostGIS (**GPL-2.0**) | TimescaleDB **Apache Edition** (`timescaledb-2-oss`, Apache-2.0) | **REVIEW NEEDED** (§8.1) |

### 6.1 Dokumentierte Ausnahme: MongoDB (SSPL-1.0)

MongoDB 5.0 steht unter der SSPL — **keine OSI-Lizenz**; die Version ist zudem
End-of-Life. Sie dient ausschließlich als interner Zustandsspeicher des Brokers und
wird nicht als Dienst an Dritte angeboten, wodurch die SSPL-Bedingung (§13) nicht
greift. Das Image wird unverändert von Docker Hub bezogen und **nicht** von diesem
Projekt weiterverbreitet.

Der Zwang zu Version ≤ 5.0 kommt von Orion-LD 1.6, dessen Legacy-C++-Treiber
md5-Auth und das alte `OP_QUERY`-Protokoll verwendet. FerretDB (Apache-2.0, auf
PostgreSQL) wurde als Ersatz getestet und ist damit inkompatibel (der Broker startet
nicht: „Unsupported OP_QUERY command: buildinfo"). Neubewertung bei einem
Orion-LD-Upgrade ohne Legacy-Treiber. **REVIEW NEEDED** (§8.2) — die EOL-Version ist
unabhängig von der Lizenzfrage ein Sicherheitsthema.

### 6.2 TimescaleDB — Apache Edition

Das eigene Image installiert `timescaledb-2-oss` (**Apache-2.0**), nicht das
Fertigimage `timescale/timescaledb-ha` (Timescale License, nicht OSI). Die
Apache-Edition enthält Hypertables, `time_bucket` und `first()`/`last()`; die
TSL-Funktionen (Compression, Continuous Aggregates) fehlen und werden nicht genutzt.
Gebraucht wird die Erweiterung, weil Mintaka für typ-skopierte Temporal-Abfragen
`last()` voraussetzt.

> Hinweis: Eine ältere interne Lizenzübersicht führte TimescaleDB als vollständig
> abgelöst. Das trifft auf den aktuellen Stand nicht zu — maßgeblich ist dieses
> Dokument.

---

## 7. Karten, Daten und Grafiken

### 7.1 Kartengrundlagen

| Quelle | Nutzung | Lizenz / Bedingungen |
|---|---|---|
| **basemap.de (BKG)** | aktive Basiskarte aller Dashboards (WMS) | dl-de/by-2-0 — Attribution „© basemap.de / BKG (dl-de/by-2-0)" im Code gesetzt |
| OpenStreetMap-Kacheln | nur Rückfallebene bei Ausfall von basemap.de | Daten **ODbL**; Attribution „© OpenStreetMap contributors" gesetzt. Die OSMF-Tile-Policy untersagt produktive Nutzung — deshalb bewusst nur Fallback. |

### 7.2 Datenquellen

| Quelle | Nutzung | Lizenz / Bedingungen |
|---|---|---|
| DWD via BrightSky | Warnungen, Stationsdaten | GeoNutzV / dl-de/by-2-0 |
| DWD Pollenflug-Gefahrenindex | Pollenflug je Teilregion | GeoNutzV |
| WSV/PEGELONLINE | Pegelstände Bundeswasserstraßen | dl-de/by-2-0 |
| LUBW / HVZ Baden-Württemberg | Pegelstände Landesgewässer, Meldestufen | dl-de/by-2-0 |
| Umweltbundesamt (Luft-API) | Luftqualitätsindex, NO₂/O₃/PM | dl-de/by-2-0 |
| MobiData BW (ParkAPI, GBFS, OCPDB, Eco-Counter, SVZ-BW) | Parken, Sharing, Laden, Rad, Baustellen | dl-de/by-2-0 |
| Marktstammdatenregister | PV-Leistung | dl-de/by-2-0 |
| BBK/NINA | Bevölkerungsschutz-Warnungen | offene Warn-API des Bundes |
| Wikidata | Einwohnerzahlen | CC0-1.0 |
| opendatasoft georef (BKG/EuroGeographics) | Gemeindegrenzen und -stammdaten | © EuroGeographics/BKG |
| OpenStreetMap via Overpass API | Rathäuser, Ausflugsziele, Versorgungs-POIs | **ODbL** — Abfragen bewusst selten und mit kennzeichnendem User-Agent gemäß Overpass-Nutzungsrichtlinie |
| sensor.community | Feinstaub (Median und Einzelsensoren) | **ODbL** |
| Open-Meteo | Wetter und Vorhersage | CC-BY 4.0, freie API-Stufe — **REVIEW NEEDED** (§8.3) |
| EFA-BW (NVBW) | ÖPNV-Abfahrten | kein formal offenes Lizenzmodell — **REVIEW NEEDED** (§8.4) |
| hystreet.com | Passantenfrequenz (optional, Token nötig) | **proprietär** — Nutzungsvereinbarung erforderlich; von der Weitergabe über CKAN ausgenommen |

**ODbL-Hinweis:** OSM-, Overpass- und sensor.community-Daten stehen unter ODbL. Werden
abgeleitete Datenbanken öffentlich bereitgestellt (z. B. über den CKAN-Katalog), gilt
die Share-alike-Pflicht der ODbL für diese Datenbank. Das betrifft die Daten, nicht
den EUPL-lizenzierten Programmcode.

### 7.3 Grafiken und Symbole

| Element | Herkunft | Lizenz |
|---|---|---|
| Karten-Piktogramme in `gui/public/stadt.html` (`ICON`, `AMEN_ICON`) | als 24×24-Strichsymbole im Projekt gezeichnet | Eigenanteil, EUPL-1.2 — **REVIEW NEEDED** (§8.5) |
| Diagramm-SVGs in `gui/public/smartcity-lib.js` (Thermometer, Gauges, Sparklines, Windrose) | zur Laufzeit aus Messwerten berechnet | Eigenanteil, EUPL-1.2 |
| `gui/public/icon.svg` | Projektsymbol | Eigenanteil, EUPL-1.2 |
| Leaflet-Marker und Layer-Grafiken | siehe §4 | BSD-2-Clause |

Zum **Markenrecht:** Für Apotheken wird bewusst ein neutrales Mörser-Symbol verwendet —
das rote „Apotheken-A" mit Äskulapnatter ist eine geschützte Kollektivmarke der ABDA
und Apotheken vorbehalten (Kommentar in `stadt.html:243`). E-Scooter-Anbieter werden mit
Namen und Markenfarbe dargestellt; das ist beschreibende (nominative) Nutzung zur
Kennzeichnung des tatsächlichen Anbieters und begründet keine Markenrechtsverletzung.

---

## 8. Offene Punkte — REVIEW NEEDED

### 8.1 Copyleft-Basis in weiterverbreiteten Images

`ckan-dcat` (AGPL-3.0) und `postgres-timescale-oss` (PostGIS, GPL-2.0) werden über
`ghcr.io` **veröffentlicht**. Damit greifen die Quellcode-Pflichten von GPL-2.0 §3 und
AGPL-3.0 §6 für die enthaltenen Fremdkomponenten. In der Praxis wird das erfüllt, indem
auf die unveränderten Upstream-Quellen verwiesen wird — die Images fügen nur Pakete
hinzu, verändern aber keinen Quellcode der Copyleft-Komponenten.

**Zu tun:** In der Image-Beschreibung (OCI-Label `org.opencontainers.image.source`)
oder im Release-Text auf die Upstream-Quellen von CKAN, ckanext-dcat und PostGIS
verweisen. Der Eigenanteil bleibt davon unberührt EUPL-1.2, da die Dockerfiles die
Komponenten nur zusammenstellen.

### 8.2 MongoDB 5.0 ist End-of-Life

Unabhängig von der SSPL-Frage: Version 5.0 erhält keine Sicherheitsupdates mehr. Der
Wechsel hängt an einem Orion-LD-Upgrade ohne Legacy-Treiber.

### 8.3 Open-Meteo bei kommerzieller Nutzung

Open-Meteo stellt Daten unter CC-BY 4.0 bereit, die **freie API-Stufe** ist jedoch auf
nicht-kommerzielle Nutzung mit begrenztem Anfragevolumen beschränkt. Für einen
kommerziellen Betrieb der Plattform ist ein kostenpflichtiger API-Zugang nötig. Die
bisherige Doku führte dies als „Annahme" — das sollte verbindlich geklärt und im
Betriebskonzept festgehalten werden.

### 8.4 EFA-BW ohne formales Lizenzmodell

Die ÖPNV-Abfahrtsdaten der NVBW werden über eine öffentlich erreichbare Schnittstelle
bezogen, für die kein offenes Lizenzmodell veröffentlicht ist. Die Nutzungsbedingungen
der NVBW sind einzuholen und zu dokumentieren, bevor Dritte die Plattform auf dieser
Basis produktiv betreiben.

### 8.5 Eigenständigkeit der Karten-Piktogramme bestätigen

Die Symbole in `stadt.html` folgen dem verbreiteten Stil quelloffener Icon-Sets
(24×24-Raster, `stroke`-basiert, wie Feather oder Lucide). Ein Abgleich der Pfaddaten
ergab **keine Übereinstimmung** mit Feather- oder Lucide-Pfaden — sie wirken
eigenständig gezeichnet. Da keine Herkunftsangabe im Code steht, sollte der Autor
bestätigen, dass sie nicht aus einem fremden Set übernommen wurden. Falls doch:
Feather ist MIT, Lucide ISC — beides wäre unkritisch, verlangt aber eine Nennung hier.

### 8.6 `gui/package.json` meldet sich als UNLICENSED

Das Feld `"license": "EUPL-1.2"` ist gesetzt, wegen `"private": true` melden
Werkzeuge wie `license-checker` das Paket dennoch als `UNLICENSED`. Für die
Veröffentlichung sollte `"private"` überdacht werden — die Angabe verhindert ein
versehentliches `npm publish`, verschleiert aber die Lizenz in automatisierten
Auswertungen. Alternativ genügt der Hinweis, dass die Lizenz aus dem `license`-Feld
und der Repo-`LICENSE` hervorgeht.

---

## 9. Zusammenfassung

- **Kein Copyleft-Code im ausgelieferten Frontend-Bundle** — 32 Pakete, ausschließlich
  MIT/ISC/BSD/Apache-2.0.
- **Keine GPL-/AGPL-Abhängigkeit im Build** — 175 Pakete geprüft, strengste Lizenz
  ist MPL-2.0 (Build-Werkzeug, EUPL-kompatibel).
- **Keine Python-Abhängigkeiten**, keine Webfonts, keine CDN-Einbindungen.
- **Eine einzige einkopierte Fremdkomponente** (Leaflet, BSD-2-Clause) — hier
  nachgewiesen.
- **Copyleft-Komponenten laufen als eigenständige Container** und begründen kein
  abgeleitetes Werk; der Eigenanteil bleibt EUPL-1.2.
- **Eine dokumentierte Nicht-OSI-Ausnahme**: MongoDB (SSPL), nicht weiterverbreitet.
- Offene Punkte: §8.
