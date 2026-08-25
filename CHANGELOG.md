# Changelog

Chronik der Veröffentlichungen (neueste zuerst). Details: `git log`.

## Unveröffentlicht — Parken-Konnektor (ParkAPI) repariert

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
