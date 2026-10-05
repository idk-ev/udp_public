# Architektur der Urbanen Datenplattform

## Leitprinzipien

1. **Offene Standards zuerst**: NGSI-LD (ETSI), OGC SensorThings, OGC
   WMS/WFS/WPS, DCAT-AP.de, OpenID Connect, MQTT. Kein proprietäres Format an
   einer Systemgrenze.
2. **Modularität**: Jede Fähigkeit ist eine austauschbare Komponente hinter
   einer Standard-Schnittstelle. Neue Anwendungen (Mobilität, Energie,
   Liegenschaften – oder ein Starkregen-Frühalarmsystem) docken an, ohne
   Bestehendes zu verändern.
3. **Mandantenfähigkeit durchgängig**: vom Token-Claim (Keycloak) über den
   `NGSILD-Tenant`-Header (Gateway/Broker) bis zur getrennten Persistenz.
4. **GitOps**: Gateway-Routen, Realm, Dashboards, Flows und Manifeste liegen
   versioniert im Repository; Compose und Kubernetes nutzen dieselben Quellen.

## Mapping auf DIN SPEC 91357 (Offene Urbane Plattform)

| DIN-SPEC-91357-Schicht | Komponenten dieser UDP |
|---|---|
| Geräte-/Sensorschicht (Edge) | LPWAN-Sensorik der Fachanwendungen (extern; via LoRa/NB-IoT/LTE-M/Mioty) |
| Konnektivität / Datenaufnahme | Mosquitto (MQTT), FIWARE IoT-Agent JSON, HTTP-Ingest über APISIX (`/ingest`), Konnektordienst (Pull-Quellen, `platform/connectors`), Node-RED (Low-Code-Flüsse/ETL) |
| Daten- & Kontextmanagement | **Orion-LD** (NGSI-LD Context Broker), **Mintaka** (Temporal), FIWARE Smart Data Models + kommunale Modelle via @context |
| Datenhaltung | **PostgreSQL** + **PostGIS** + **TimescaleDB** in der Apache-Edition (Zeitreihen/TRoE als Hypertable, Geodaten; `last()` für Mintaka), MongoDB (Broker-Zustand) |
| Dienste-/Anwendungsschicht | FROST-Server (SensorThings), GeoServer (OGC), CKAN (Open Data/DCAT-AP.de), Superset, Fachanwendungen |
| Übergreifend: API-Management | **Apache APISIX**: ein Einstiegspunkt, Zugriffskontrolle (OIDC), Rate-Limits, Metriken, dokumentierte Routen |
| Übergreifend: Identität & Sicherheit | **Keycloak** (OIDC/SAML, Rollen, Mandanten-Gruppen), TLS am Ingress, Security-Header |
| Übergreifend: Betrieb | Kubernetes, Backups, Prometheus-Metriken; Uptime Kuma als **getrenntes** Deployment (`monitoring/`), damit die Außensicht nicht mit der Plattform ausrollt und ausfällt |
| Präsentation | **UDP-Cockpit** (Eigenentwicklung, EUPL-1.2), Masterportal |

Der Konformitätsnachweis gegenüber der Vergabestelle erfolgt gemäß
Leistungsbeschreibung über die Einschätzung der Koordinierungs- und
Transferstelle Modellprojekte Smart Cities (KTS) bzw. den Verweis auf die
BBSR-Veröffentlichung von März 2025.

## Datenflüsse

### Sensor → Plattform → Anwendung (Echtzeit)

```
Sensor ──LoRaWAN/NB-IoT──▶ Netzwerk-Server ──MQTT──▶ Mosquitto
      ──▶ IoT-Agent JSON (Payload→NGSI-LD, Geräteverwaltung)
      ──▶ Orion-LD  ──TRoE──▶ PostgreSQL   (Historie)
                 │
                 ├─ Subscriptions (Push an Anwendungen/Node-RED)
                 └─ NGSI-LD Query (Cockpit, Fachanwendungen via APISIX)
```

### Offene Daten (Pull/ETL)

```
DWD / GDI / MobiData BW / … ──HTTP──▶ Konnektordienst (Transformation, Validierung)
      ──▶ Orion-LD (Kontext)
Fachverfahren / eigene Quellen ──HTTP──▶ Node-RED (Low-Code-Fluss)
      ──▶ Orion-LD (Kontext)  und/oder  ──▶ CKAN (Datensatz + DCAT-AP.de-Metadaten)
```

Referenzimplementierung dieses Pfads ist die Integration **„Smart City
Reutlingen"** bzw. landesweit Baden-Württemberg: Der **Konnektordienst**
(`platform/connectors`, TypeScript) liest mit 29 Konnektoren offene Quellen
(DWD, UBA, sensor.community, MobiData BW ParkAPI/GBFS/OCPDB, EFA-BW, …)
zyklisch ein und upsertet Smart-Data-Model-Entitäten nach Orion-LD. Takt,
Aktivierung und Monitoring stehen in der Registry
`platform/config/connectors.json`; je Konnektor gibt es ein Modul mit
Paritäts- bzw. Unit-Test. Darstellung über die Cockpit-Dashboards
(`/<kommune>` je Gemeinde, `/kreis-<slug>` je Landkreis, Kommunen-Suche auf
der Startseite `/`, Betrieb unter `/dashboard.html` nur mit Anmeldung); Betriebs- und TRoE-Statistiken liefert der
Konnektordienst als PlatformStatus-Entitäten, Zeitreihen die Temporal-API
(Mintaka). Node-RED bleibt als Low-Code-Werkzeug mit einem Beispielfluss
(Open Data → NGSI-LD → Orion-LD) für eigene Datenflüsse.

### Veröffentlichung

- Echtzeit/Kontext: NGSI-LD über `GET /ngsi-ld/v1/entities…` (Gateway)
- Zeitreihen: `GET /temporal/…` (Mintaka) bzw. SensorThings `Observations`
- Geodaten: WMS/WFS aus GeoServer (Layer aus PostGIS)
- Offene Daten: CKAN-Portal + `catalog.rdf` (DCAT-AP), API `package_search`

## Mandantenmodell

```
Keycloak-Gruppe            NGSI-LD-Tenant     Persistenz
/lahn-dill-kreis      →    ldk            →   orion_ldk (Mongo) + DB-Schema (TS)
/lahn-dill-kreis/wetzlar → ldk_wetzlar    →   …
/vogelsbergkreis      →    vbk            →   …
```

- Der Tenant-Claim des Tokens wird vom Gateway als `NGSILD-Tenant`-Header
  gesetzt bzw. validiert (openid-connect + serverless-Filter in APISIX).
- Übergreifende Auswertungen (Kreis-/Landesebene) erfolgen über die Rolle
  `plattform-admin` mit expliziter Mandantenwahl im Cockpit.

## Skalierung & Hochverfügbarkeit

- Zustandslos (Orion-LD, Mintaka, APISIX, Cockpit, FROST): horizontal über
  Replikate/HPA.
- Zustandsbehaftet: PostgreSQL/PostGIS via Operator (Streaming-Replikation,
  automatisches Failover), MongoDB als ReplicaSet, Solr/Redis je nach
  Lastprofil.
- Lastabhängiges Up-/Down-Scaling über Kubernetes HPA + Cluster-Autoscaler.
