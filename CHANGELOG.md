# Changelog

Chronik der Veröffentlichungen (neueste zuerst). Details: `git log`.

## Unveröffentlicht — Lastkapazität des Dashboards

Ein Lasttest zeigte: Schon wenige gleichzeitige Besucher brachten die
Gemeindeseiten auf Ladezeiten im zweistelligen Sekundenbereich – jede
Dashboard-Abfrage war ein Vollscan in MongoDB, dazu zählte die TRoE-Statistik
alle 10 Minuten die komplette Zeitreihentabelle.

- **MongoDB-Index** `udp_type_ags` (Typ + ags) per Helm-Hook-Job nach jedem
  Install/Upgrade, auch für alle Mandanten-Datenbanken (`mongo.indexes`).
  Probes nur noch TCP, CPU-Limit 2.
- **TRoE-Statistik** zählt alle 10 Minuten nur die letzten 24 h;
  Gesamtwerte je Typ kommen aus dem nächtlichen Lauf (Dashboard: „Stand …“).
  Server-seitiger Timeout, keine überlappenden Läufe mehr.
- **Rate-Limit je Client** auf `/ngsi-ld` und `/temporal` statt eines
  gemeinsamen Topfs für alle Besucher (`apisix.rateLimit`, HTTP 429).
- **Cockpit-Cache**: Schlüssel enthält den Mandanten (vorher konnten Mandanten
  fremde Antworten erhalten); bei kurzen Orion-Ausfällen wird die letzte
  Antwort ausgeliefert.
- **Compose:** APISIX (Port 8780) nur noch auf `127.0.0.1` veröffentlicht
  (`PROXY_BIND`); externer API-Zugriff über das Cockpit (`/gateway/…`).
- Neuer Lasttest `tests/load/municipality-page.js` (k6), siehe
  [Betrieb](docs/betrieb.md#lasttest-dashboard).

## 1.1.0 — Hochverfügbare Datenbank, Kubernetes-Härtung, Parken-Konnektor

> **Upgrade bestehender Kubernetes-Installationen:** PostgreSQL läuft jetzt als
> CloudNativePG-Cluster. Vorher den CNPG-Operator installieren (DEPLOY.md §2)
> und die Daten nach DEPLOY.md §10a umziehen – ein direktes `helm upgrade`
> verweigert das Chart, statt eine leere Datenbank zu starten. docker compose
> ist nicht betroffen.

### Kubernetes: hochverfügbare Datenbank (CloudNativePG)

- **PostgreSQL/TimescaleDB als CloudNativePG-Cluster** statt einzelnem
  StatefulSet: Primary und Standby in verschiedenen Zonen, Umschaltung vor
  jedem Knoten-Drain, automatische Übernahme bei Ausfall. Ein Knoten-Update
  ist damit kein Datenbank-Ausfall mehr. Voraussetzung: CNPG-Operator.
- Neues Image `postgres-timescale-cnpg` (CNPG-PostGIS 3.6 + TimescaleDB OSS);
  Hostname `timescale`, Rollen und MD5-Passwörter bleiben.
- **Bestehende Installationen** ziehen per `scripts/migrate-timescale-cnpg.sh`
  um (DEPLOY.md §10a); das Chart verweigert ein Upgrade, das eine leere
  Datenbank starten würde.

### Kubernetes: Probes, NetworkPolicies, Orion-LD

- **Orion-LD blieb hängen** („socket descriptor (1024) is not less than
  FD_SETSIZE“): ohne Leerlauf-Timeout sammelten sich Keep-Alive-Verbindungen
  bis zur `select()`-Grenze. Jetzt `-reqTimeout 60 -maxConnections 900`
  (Helm und Compose), APISIX-Keep-Alive auf 30 s.
- **Mosquitto** war im Cluster nur auf `127.0.0.1` erreichbar – die
  `mosquitto.conf` wird jetzt eingehängt.
- **Probes** für alle Dienste, Timings unter `<komponente>.probes`.
- **NetworkPolicies** pro Komponente statt „alles im Namespace“; Monitoring-
  Namespace und Internet-Egress (strictEgress) konfigurierbar.
- Mintaka mit festem `-Xmx`, Postgres mit Fast-Shutdown und größerem
  `/dev/shm`, APISIX mit 2 statt „auto“ Workern, `enableServiceLinks: false`,
  PDB für Mintaka, Node-RED mit `Recreate`.
- Orion-LD wartet per Init-Container auf MongoDB/TimescaleDB (sonst SIGSEGV
  und CrashLoopBackOff nach jedem DB-Neustart); replizierte Dienste rollen mit
  `maxUnavailable: 0` aus. MongoDB-Liveness per TCP statt `mongosh`.
- Postgres-Image baut wieder: `bullseye-security` liefert 404, die Quelle
  entfällt für den Build.

### Parken-Konnektor (ParkAPI) repariert

`parken-bw` schrieb **~1,04 Mio TRoE-Zeilen/Tag** — rund die Hälfte der
Zeitreihen-Datenbank — und deckte dabei 1,6 % der Quelldaten ab. Drei Fehler
lagen übereinander: `&offset=` wird von der ParkAPI v3 ignoriert (alle 66
Anfragen je Lauf lieferten denselben Ausschnitt), die Entitäts-IDs entstanden
aus geslugten Anlagennamen (500 Datensätze → 336 Entitäten), und je Lauf gingen
alle Attribute neu heraus.

Jetzt: Cursor-Pagination (`start=<next_id>`), stabile IDs aus dem
ParkAPI-Primärschlüssel und getrennte Schreibpfade für Stamm- und
Bewegungsdaten. Ergebnis rund 24.900 statt 336 Parkanlagen bei grob 6.000 statt
1,04 Mio Zeilen/Tag. Gegen Wiederholung: Zeilenbudget je Konnektor
(`rowBudget24h`), Kardinalitäts-Prüfung und Tests unter `tests/`.

Nachgezogen aus dem Betrieb des Referenzclusters:

- Retention räumt den Alt-Bestand des Konnektors ab (hier 23,8 Mio Zeilen).
- Service-Worker: Cacheversion folgt der Chart-Version, Shell wird aufgefrischt.
- MongoDB-Liveness-Probe: 10 s statt Vorgabe 1 s — sie riss Orion-LD mit.

## 1.0.1 — Chart-Veröffentlichung korrigiert

Keine funktionalen Änderungen an der Plattform. Der Release-Lauf zu `v1.0.0`
baute die vier eigenen Images, brach aber vor dem Chart-Push ab: `version:` in
`helm/udp/Chart.yaml` stammte noch aus der internen Zählung und passte nicht
zum Release-Tag. Die Chart-Version folgt jetzt wieder dem Tag, `v1.0.1`
veröffentlicht damit das erste Chart unter
`oci://ghcr.io/idk-ev/udp_public/charts/udp`.

## 1.0.0 — Erste öffentliche Veröffentlichung unter EUPL-1.2

Erstveröffentlichung der Urbanen Datenplattform als Open Source. Die
Entwicklungshistorie vor diesem Stand ist nicht Teil des öffentlichen
Repositorys.

Enthalten:

- **Context Broker** — FIWARE Orion-LD (NGSI-LD) mit TRoE-Zeitreihen in
  PostgreSQL/PostGIS, Temporal API über Mintaka.
- **Ingestion** — Node-RED-Flows aus einer Konnektor-Registry
  (`platform/config/connectors.json`, 29 Konnektoren) für offene Landes- und
  Bundesquellen: DWD, PEGELONLINE, LUBW/HVZ, Umweltbundesamt, MobiData BW,
  Marktstammdatenregister, BBK/NINA, sensor.community, OpenStreetMap/Overpass,
  EFA-BW.
- **Dashboards** — Cockpit-SPA sowie statisch erzeugte Seiten für alle 1.103
  Gemeinden und 35 Landkreise Baden-Württembergs.
- **Open-Data-Portal** — CKAN mit DCAT-AP.de-Profil.
- **Geodienste** — GeoServer (OGC WMS/WFS/WPS), FROST-Server (OGC
  SensorThings), optional Masterportal.
- **Sensorik** — MQTT über Mosquitto und FIWARE IoT-Agent JSON.
- **Zugriff und Identität** — Apache APISIX als API-Gateway, Keycloak für
  Identitäten, Rollen und Mandanten.
- **Betrieb** — Docker-Compose-Stack und Helm-Chart für Kubernetes,
  Uptime-Kuma-Monitoring als eigenständiges Deployment, Backup-Sidecar.
- **Architektur** konform zu DIN SPEC 91357 (Referenzarchitekturmodell Offene
  Urbane Plattformen), mandantenfähig über NGSI-LD-Tenants.

Lizenz: [EUPL-1.2](LICENSE) · Fremdkomponenten:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
