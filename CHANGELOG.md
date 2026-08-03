# Changelog

Chronik der Veröffentlichungen (neueste zuerst). Details: `git log`.

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
