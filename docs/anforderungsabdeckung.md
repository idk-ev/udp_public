# Anforderungsabdeckung – Leistungsbeschreibung 60982-25, Abschnitt B.II

Nachweis der Erfüllung aller Anforderungen an die Urbane Datenplattform
(„Kommunale Anwendung“). Der Teil B.III (Starkregen-Frühalarmsystem) ist
bewusst nicht Gegenstand dieser Referenzimplementierung; die Plattform ist so
ausgelegt, dass er als weitere Anwendung (eigener Mandant + eigene Module)
aufgesetzt werden kann.

## B.II.1 Allgemein

| Anforderung | Umsetzung |
|---|---|
| Offene, modulare **Multimandantenlösung** | NGSI-LD-Tenants (Orion-LD/Mintaka), Keycloak-Gruppenbaum (Kreis → Kommune), Tenant-Umschalter im Cockpit; jede Komponente einzeln austausch-/erweiterbar |
| **Verfügbarkeit ≥ 99,5 %** | Managed Kubernetes, ≥ 2 Replikate zustandsloser Dienste, Pod-Anti-Affinity, PodDisruptionBudgets, HA-Datenbankbetrieb per Operator; Monitoring + Alarmierung (Uptime Kuma, getrennt deployt in `monitoring/`); Nachweis über monatliche Verfügbarkeitsberichte (docs/betrieb.md) |
| Modulare Struktur, künftige Erweiterungen/Mandanten | Container-/Microservice-Architektur, deklarative Konfiguration (GitOps), neue Mandanten ohne Neuinstallation (Header + Realm-Gruppe) |
| Höchste Anforderungen an Betrieb/Doku/Aktualisierung | docs/betrieb.md (Patch-/Update-Prozess, Backup/DR, Incident Management) |

## B.II.2 Architektur und Open Source

| Anforderung | Umsetzung |
|---|---|
| Vollständiger Aufbau + Funktionsdemonstration | Schnellstart (README), reproduzierbar per Compose (Demo) und Kustomize (Produktion) |
| Durchgängig **Open-Source-Technologien** | Sämtliche Komponenten quelloffen, siehe THIRD-PARTY-NOTICES.md |
| Hosting agnostisch in **Kubernetes** | kubernetes/base (Kustomize), lauffähig auf jedem CNCF-konformen Cluster |
| Mandantenfähiges **Rollen-/Rechtemanagement** | Keycloak-Realm „udp“: 5 Rollen, Gruppen je Gebietskörperschaft, OIDC/PKCE, Tenant-Claim im Token |
| **Copyleft-Lizenz, vorzugsweise EUPL 1.2** | Gesamtwerk unter EUPL-1.2 (LICENSE); „Public Money – Public Code“ erfüllt |
| Integration weiterer kommunaler Anwendungen | NGSI-LD-Datenmodelle + offene APIs; Module (Liegenschaften, Energie, Mobilität) docken als eigene Typen/Mandanten/Routen an |

## B.II.3 Interoperabilität und Standards

| Anforderung | Umsetzung |
|---|---|
| **DIN SPEC 91357**-Konformität | Schichtenmapping in docs/architektur.md; Nachweisweg über KTS/BBSR-Veröffentlichung (März 2025) im Angebot |
| **FIWARE Context Broker** | Orion-LD 1.5 (NGSI-LD 1.6) |
| **NGSI-LD** | Vollständige NGSI-LD-API über Gateway-Route `/ngsi-ld`, Temporal API (Mintaka) über `/temporal` |
| **SensorThings** | FROST-Server (OGC SensorThings API v1.1) über `/FROST-Server` |
| Standardisierte APIs, medienbruchfreie Integration | REST/JSON(-LD) durchgängig; OGC WMS/WFS/WPS (GeoServer); MQTT; DCAT-AP (CKAN); Prometheus-Metriken |
| **FIWARE Smart Data Models** + individuelle Modelle | Beispielentitäten (WeatherObserved, OffStreetParking, …); NGSI-LD @context erlaubt kommunale Modelle ohne Plattformänderung |

## B.II.4 Datenmanagement und Dokumentation

| Anforderung | Umsetzung |
|---|---|
| Low-Code-Datenfluss-Management (**Node-RED**), ETL | Node-RED mit vorkonfiguriertem Beispielfluss (Open Data → NGSI-LD-Upsert) |
| **DCAT-AP.de**-Metadatenkatalog mit Open-Data-Portal (**CKAN**) | CKAN 2.10 + ckanext-dcat (RDF-Endpunkte, DCAT-AP-Profil), benutzerfreundliche Oberfläche + API |
| Open-Source-**API-Management (Apisix)** | Apache APISIX, deklarative Routen (GitOps), granulare Zugriffskontrolle (OIDC-Plugin), Rate-Limiting, Prometheus-Monitoring, dokumentierte Schnittstellen |
| **PostgreSQL** mit **PostGIS** und **TimescaleDB** (Apache-Edition) | Zentrale Instanz: TRoE-Zeitreihen (Orion-LD), FROST- und CKAN-Datenbanken, PostGIS für Georeferenzierung, TimescaleDB-Zeitreihenfunktionen für die Temporal-API |
| Performante, skalierbare, ausfallsichere Speicherung | Indizierte Zeitreihen (Hypertables möglich), Kubernetes-Operator-Betrieb, Backup/DR-Konzept |

## B.II.5 Betrieb, Sicherheit und Wartung

| Anforderung | Umsetzung |
|---|---|
| Managed-Kubernetes-Umgebung | kubernetes/README.md (Anbieteranforderungen) |
| ISO-27001-Rechenzentrum + ISMS (BSI-Grundschutz) | Betreiberauswahlkriterium; Nachweis dem Angebot beizufügen (docs/betrieb.md, Kap. Hosting) |
| Monatliche Verfügbarkeit ≥ 99,5 %, dokumentiert | Uptime-Kuma-Monitore + monatlicher Report (docs/betrieb.md) |
| Tägliche Backups, Disaster Recovery | Backup-Dienst (täglich, 14 T/8 W/12 M Aufbewahrung), WAL-Archivierung + Volume-Snapshots in K8s, dokumentierte Wiederherstellung |
| Uptime-Monitoring (z. B. **Uptime Kuma**) mit Alarmierung, Service-Desk-Integration | Uptime Kuma: Statusseiten, Benachrichtigungen (E-Mail/Webhook/Teams etc.), Webhooks an Ticketsysteme; eigenständiges Deployment (`monitoring/`, Compose + Helm) außerhalb des Plattform-Lebenszyklus |
| Incident Management | Prozessbeschreibung in docs/betrieb.md |
| Pflege/Wartung über Projektlaufzeit, Updates/Upgrades | Versionierte Images, Rolling Updates, Update-Prozess dokumentiert |

## B.II.6 Visualisierung

| Anforderung | Umsetzung |
|---|---|
| Verständlich, **barrierearm**, handlungsorientiert für Fachanwender **und** Öffentlichkeit | UDP-Cockpit (deutsch, WCAG 2.1 AA-orientiert: Kontraste, Fokusführung, Skip-Link, Tastaturbedienung, Tabellenalternative zu Diagrammen, reduzierte Bewegung) |
| Interaktive Karten und Dashboards auf **Masterportal, GeoServer, Apache Superset oder Grafana** | Cockpit-Dashboards (Kommune/Kreis/Betrieb, Eigenentwicklung), GeoServer (WMS/WFS), Masterportal (Profil viz-extra, vorkonfiguriert), Superset (Profil analytics); zusätzlich Cockpit-Karte (MapLibre) |
| **BITV 2.0**-gerechte Oberflächen, CI-konforme Einbindung | Cockpit-Theme über Design-Tokens (CSS-Variablen) an kommunale CI anpassbar; BITV-Prüfung als Abnahmeschritt vorgesehen |
| Modular, skalierbar, neue Datenquellen/Darstellungen ergänzbar | Komponentenarchitektur; neue Layer/Dashboards ohne Codeänderung (Provisionierung/Portal-Konfiguration) |
| Warnstufen-Darstellung konform zu DWD-Vorgaben, konfigurierbare Layer/Filter/Zeitachsen | Status-Farbsystem (4 Stufen) im Cockpit vorhanden; Karten-Layer und Zeitfilter implementiert; DWD-Warnlayer als WMS einbindbar |
| Standardisierte Schnittstellen (**WMS, WFS, REST**) | GeoServer (WMS/WFS/WPS), durchgängige REST-APIs über APISIX |

## Geforderte Lizenzen – Zusammenfassung

- **Plattform-Veröffentlichung**: EUPL-1.2 (Copyleft, wie gefordert) für alle
  Eigenanteile: GUI, Konfigurationen, Manifeste, Skripte, Dokumentation.
- **Komponenten**: OSI-/FSF-anerkannte Open-Source-Lizenzen (Übersicht mit
  Kompatibilitätsbewertung: THIRD-PARTY-NOTICES.md). Keine proprietären
  Abhängigkeiten, keine Lizenzkosten.
- **Dokumentierte Ausnahme MongoDB (SSPL-1.0)**: Der FIWARE-Broker Orion-LD
  1.6 setzt MongoDB ≤ 5.0 zwingend voraus (Legacy-Treiber, md5-Auth). Die
  SSPL ist nicht OSI-anerkannt; ihre Bedingungen greifen hier jedoch nicht,
  da MongoDB ausschließlich als interner Zustandsspeicher dient und nicht
  als Dienst angeboten wird — es entstehen weder Lizenzkosten noch
  Weitergabepflichten. Die Apache-lizenzierte Alternative FerretDB wurde am
  20.07.2026 getestet und ist mit Orion-LD 1.6 nachweislich inkompatibel
  (Legacy-OP_QUERY-Protokoll; Testprotokoll in THIRD-PARTY-NOTICES.md).
  Neubewertung erfolgt mit dem nächsten Orion-LD-Versionssprung.
