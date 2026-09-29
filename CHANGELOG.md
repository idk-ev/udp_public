# Changelog

Chronik der Veröffentlichungen (neueste zuerst). Details: `git log`.

## Unveröffentlicht — Ingestion im Konnektordienst

Alle 29 Konnektoren laufen im Konnektordienst (`platform/connectors`,
TypeScript) statt in generierten Node-RED-Flows. Node-RED bleibt als
Low-Code-Baustein mit dem Beispielfluss.

> **Upgrade:** Helm – einen Digest-Pin von `node-red-udp` unter
> `nodeRed.image` und `cockpit.endpoints` aus den eigenen Values entfernen
> (das Chart bricht sonst mit einem Hinweis ab). Compose – `UDP_ABFAHRTEN_UPSTREAM`
> und `UDP_WARNUNGEN_UPSTREAM` aus `platform/.env` streichen (werden ignoriert).

- **Konnektordienst:** Compose-Dienst und Helm-Deployment `connectors` (eine
  Replik, `Recreate`, read-only). Zustand (Signaturen, Prune-Buchführung) in
  PostgreSQL, Schema `udp_connectors`. Port 1880 nur für das Cockpit, der
  Admin-Port 1881 (`/healthz`, `/trigger`) nirgends veröffentlicht.
- **Node-RED** auf dem Upstream-Image `nodered/node-red:4.1`, Beispielfluss
  und `settings.js` in Helm aus einer ConfigMap; `node-red-udp` entfällt.
  Keine Datenbank-, hystreet- oder Internet-Rechte mehr,
  `functionExternalModules` aus.
- **Cockpit:** `/abfahrten` und `/warnungen.ics` gehen an den Konnektordienst
  (`UDP_CONNECTORS_UPSTREAM`, Helm `cockpit.connectorsUpstream`).
- **Registry:** `runtime` und `nodePrefixes` entfallen; jeder aktive Eintrag
  mit Modul läuft. `scripts/export-connector-status.py` ersetzt den
  Flow-Generator und schreibt nur noch `connectors-status.json`.
- **Helm:** hystreet-Token unter `connectors.hystreetApiToken` bzw.
  `.hystreetExistingSecret` im Secret `udp-hystreet` (die Schlüssel unter
  `nodeRed.` werden weiter gelesen).
- **Image-Pipeline:** unveränderte Images behalten ihren Digest, das Chart
  referenziert eigene Images nur per Digest – ein Release rollt die Datenbank
  nicht mehr grundlos neu aus.
- **Skripte:** `trigger-connector.sh` löst im Dienst aus, `healthcheck.sh`
  zählt dessen Logs und zeigt den Zustandsspeicher.
- Wetter und Vorhersage (Open-Meteo) alle 6 h statt 4 bzw. 2 h
  (Tageskontingent); `troe-retention` mit Autovacuum-Schwellen und
  `VACUUM (ANALYZE)`.
- **Compose-Cockpit:** Entrypoint-Skripte werden eingebunden; `nginx -t`
  scheiterte vorher an `${UDP_REALIP_FROM}`. `UDP_TRUSTED_PROXIES` ist über
  `.env` einstellbar.

## 1.2.0 — Hochverfügbarkeit des öffentlichen Pfads, Datenqualität, Lastkapazität

> **Upgrade bestehender Kubernetes-Installationen:** ohne neue Werte bleibt
> MongoDB eine Einzelinstanz (jetzt mit Journaling). Wer das Replica Set
> einschaltet, stellt in einem **eigenen** `helm upgrade` mit `--wait` um, nicht
> mit `--atomic` – vorher `mongodump` (DEPLOY.md §10b). Ist das Replica Set
> einmal aktiv, darf kein älteres Chart mehr ausgerollt werden: es startete
> MongoDB wieder als Einzelinstanz. docker compose ist nicht betroffen.

### Hochverfügbarkeit des öffentlichen Pfads

- **MongoDB als Replica Set** (`mongo.replicaSet.enabled`): drei
  Datenmitglieder oder zwei plus Arbiter (`replicaSet.arbiter`, eigenes
  Scheduling, z. B. auf einem Control-Plane-Knoten). Failover in Sekunden, ein
  PDB über alle Stimmen, Readiness erst nach dem Aufholen. Bestehende
  Installationen werden per `helm upgrade` umgestellt, `mongo-0` behält seine
  Daten (DEPLOY.md §10b).
- **Journaling** für MongoDB immer an (vorher `--nojournal`).
- **Verteilung** konfigurierbar: `global.spread.mode: required` hält
  Replikate auf verschiedenen Knoten; Deployments rollen dann ohne Surge aus,
  damit es auch mit so vielen Knoten wie Replikaten geht.
- **Cockpit** liefert `/abfahrten` und `/warnungen.ics` bei
  Node-RED-Ausfall aus dem Cache weiter (eigene Cache-Zone, 24 h).
- `minReadySeconds: 10` für Cockpit, APISIX und Mintaka: kein kurzes 503 mehr
  beim Rollout ohne Surge.
- `global.clusterDomain` für abweichende Cluster-DNS-Domänen.

### Datenqualität der Gemeindeseiten

Objekte außerhalb Baden-Württembergs landeten in der nächstgelegenen
BW-Gemeinde (Leihräder aus Basel, Feinstaubsensoren aus dem Elsass).

- **Strikte Gemeindezuordnung** per Punkt-in-Polygon ohne Zentroid-Fallback
  für Sharing, Feinstaub, Parken, Baustellen und Radzähler; kleine Toleranz
  für Lücken zwischen den vereinfachten Grenzen. Ohne Grenzen-Cache wird der
  Lauf übersprungen statt geraten.
- DWD-Stationen, Pegel, Overpass-Daten, Ladesäulen und Carsharing nutzen
  dieselbe Zuordnung mit kleiner Grenztoleranz.
- **Baustellen**: Zuordnung per Polygon statt nächstem Gemeindezentrum,
  vertauschte Koordinaten werden korrigiert.
- **Automatisches Aufräumen** veralteter eigener Entitäten nach vollständigen
  Läufen, mit Schutz: plausible Stammdaten, lückenlose Vorläufe, Karenzzeit
  bzw. 24 h Bestätigung, höchstens 30 % des Bestands, nur eigene ID-Muster.
- **Compose**: Node-RED lädt Stammdaten über `http://cockpit:8080` (vorher
  Port 80, dort lauscht das Cockpit nicht); Helm-Service zusätzlich auf 8080.
- **Keine eingefrorenen Werte mehr**: Änderungssignaturen gelten erst nach
  bestätigtem Upsert (2xx, bei 207 je Entität). Bei Orion-Ausfällen gehen die
  Werte im nächsten Lauf erneut heraus, statt wochenlang stehen zu bleiben.
- **Frische**: Parkanlagen und B+R mit Echtzeitwerten, Carsharing-Stationen,
  Ladepunkte mit Livestatus, Parken-Summen und Gemeinde-Puls tragen ein
  aktuelles `dateObserved`. Reine Stammdaten-Einträge bleiben ohne.
- **Sharing**: Gemeinden ohne Fahrzeuge eines Anbieters erhalten einmal 0
  statt bis zum Aufräumen die alte Zahl.
- **Aufräumen** verschwundener Carsharing-Stationen und -Flotten, Ladepunkte,
  Ladesummen und Gemeinde-Pulse; einmalig auch Parkanlagen im Alt-ID-Schema
  (nur nach vollständigem Lauf, 7 Tage unverändert).
- **Ladepunkte**: alle OCPDB-Seiten laut `total_count` (vorher fest 29 von 32,
  rund 1.300 BW-Standorte fehlten).
- **Gemeinde-Puls**: mindestens drei echte Komponenten (Warnlage zählt nicht),
  keine Baustelle = 100, Sharing je 1.000 Einwohner, veraltete Feinstaubwerte
  ignoriert, alle Abfragen paginiert. Methode: `docs/framework-dashboards.md`.
- **Gemeindeseite**: Parken, B+R, Ladepunkte und Carsharing zeigen bei
  veralteten Werten „Stand: TT.MM. HH:MM“ statt „Echtzeit“; veraltete
  Gemeinde-Pulse werden markiert, der Kreis-Mittelwert zählt nur aktuelle.
- **Ladesummen** nur noch bei Änderung voll geschrieben, OCPDB-Upserts
  gedrosselt; neue Zeilenbudgets für Ladepunkte, Ladesummen, Carsharing und
  Gemeinde-Puls.

### Lastkapazität des Dashboards

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
