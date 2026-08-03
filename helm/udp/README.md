# UDP Helm Chart

Helm-Chart der **Urbanen Datenplattform (UDP)** – FIWARE-basierte Smart-City-
Plattform (NGSI-LD Context Broker, IoT, API-Gateway, Identität, Persistenz,
Anwendungsdienste). Funktional äquivalent zu den Kustomize-Manifesten unter
`kubernetes/base/`, jedoch parametrierbar und mit Sicherheits-Härtung.

## Schnellstart

```bash
cd helm/udp
helm lint .
helm upgrade --install udp . -n udp --create-namespace
kubectl -n udp get pods -w
```

Vollständige, sicherheitsorientierte Anleitung: **[DEPLOY.md](DEPLOY.md)**.

## Struktur

```
helm/udp/
├── Chart.yaml
├── values.yaml                 # alle Parameter + Sicherheits-Defaults
├── values-prod.example.yaml    # Vorlage für Produktion (kopieren -> values-prod.yaml)
├── DEPLOY.md                   # Schritt-für-Schritt-Deployment
├── files/                      # gebündelte Configs (APISIX, Keycloak, Postgres)
└── templates/
    ├── _helpers.tpl
    ├── serviceaccount.yaml
    ├── secrets.yaml            # generiert ODER extern (secrets.create)
    ├── configmaps.yaml
    ├── persistence.yaml        # mongo + timescale (StatefulSets)
    ├── context-broker.yaml     # orion-ld + mintaka
    ├── iot.yaml                # mosquitto + iot-agent-json + frost
    ├── api-identity.yaml       # apisix + keycloak
    ├── catalog.yaml            # ckan + solr + redis (ckan.enabled)
    ├── geo.yaml                # geoserver (+ masterportal, optional)
    ├── apps.yaml               # node-red + cockpit
    ├── backup.yaml             # logische DB-Dumps (backup.enabled)
    ├── ingress.yaml
    ├── networkpolicy.yaml      # default-deny + segmentierte Freigaben
    ├── pdb.yaml
    └── NOTES.txt
```

## Eigene Images

Drei Images sind Eigenbau und werden von
[`.github/workflows/build-images.yml`](../../.github/workflows/build-images.yml)
nach `ghcr.io/idk-ev/udp/…` gebaut und gepusht:

| Value | Image | Warum kein Upstream-Image |
|-------|-------|---------------------------|
| `cockpit.image` | `cockpit` | Eigenentwicklung (SPA + nginx-Konfiguration) |
| `ckan.image` | `ckan-dcat` | CKAN 2.10 plus `ckanext-dcat` für DCAT-AP.de |
| `timescale.image` | `postgres-timescale-oss` | PostGIS **und** TimescaleDB Apache Edition; das Init-Skript legt die Extension an, Mintaka braucht `last()` |

Registry und Tag stehen für alle drei an **einer** Stelle:

```yaml
global:
  udpRegistry: "ghcr.io/idk-ev/udp"   # eigene Registry? nur hier ändern
  udpTag: "main"                      # "1.0.0" für ein Release
```

Pro Image überschreibbar – so pinnt man in Produktion einzelne Digests:

```yaml
cockpit:
  image:
    tag: "1.0.0@sha256:…"   # registry bleibt global.udpRegistry
    # registry: "harbor.example.org/udp"   # nur dieses Image woanders
```

`global.imageRegistry` betrifft ausschließlich die **Upstream**-Images
(Orion-LD, Keycloak, APISIX …) – `udpRegistry` ist bereits ein vollständiger
Registry-Pfad und wird nicht zusätzlich präfigiert.

## Abschaltbare Komponenten

| Value | Default | Wirkung |
|-------|---------|---------|
| `ckan.enabled` | `true` | CKAN + Solr + Valkey, Gateway-Route `/catalog`, Ingress-Pfad `/catalog` |
| `geoserver.enabled` | `true` | GeoServer, Gateway-Route `/geoserver` |
| `masterportal.enabled` | `false` | Geoportal – braucht ein Image mit fertigem Portal-Build |
| `backup.enabled` | `true` | tägliche `pg_dump`-Sicherung aller Plattform-DBs |

Ein `false` entfernt jeweils auch die zugehörige APISIX-Route und den
Ingress-Pfad – es bleibt keine Route stehen, die ins Leere zeigt.

## Wichtige Parameter (Auszug)

| Value | Default | Zweck |
|-------|---------|-------|
| `secrets.create` | `true` | Chart erzeugt starke Zufallspasswörter (Default, auch Prod) |
| `secrets.passwordLength` | `32` | Länge der generierten Passwörter (alphanumerisch) |
| `ingress.host` | `udp.example.org` | öffentliche Domain |
| `ingress.apiPaths` | `/ngsi-ld`, `/temporal`, … | Pfade, die direkt auf APISIX gehen (müssen den APISIX-Routen entsprechen) |
| `keycloakApp.relativePath` | `/auth` | Kontextpfad von Keycloak (`KC_HTTP_RELATIVE_PATH`) **und** Ingress-Pfad |
| `keycloakApp.extraRedirectUris` | `[]` | zusätzliche Redirect-URIs des Clients `udp-cockpit` (der Ingress-Host ist immer eingetragen) |
| `cockpit.publicUrl` | `""` | öffentliche Basis-URL für SPA-Konfiguration und Redirect-URIs (leer → aus `ingress.host`) |
| `cockpit.extraModuleUrls` | `{}` | zusätzliche Ziele der Modul-Kacheln (z. B. Node-RED, Uptime Kuma aus `monitoring/`) |
| `cockpit.tenants` | Standard/lkrt/lktue | Mandanten-Auswahl im Cockpit |
| `cockpit.gatewayUpstream` | `""` | FQDN von APISIX für den nginx-Proxy im Cockpit (leer → `apisix.<ns>.svc.cluster.local:9080`) |
| `ingress.clusterIssuer` | `letsencrypt` | cert-manager für TLS |
| `networkPolicies.enabled` | `true` | Netzsegmentierung (CNI mit Policy nötig) |
| `networkPolicies.strictEgress` | `false` | zusätzlich Egress-Default-deny |
| `global.imageRegistry` | `""` | Registry-Prefix für Upstream-Images (Mirror) |
| `global.udpRegistry` | `ghcr.io/idk-ev/udp` | Registry der drei eigenen Images |
| `global.udpTag` | `main` | Tag der drei eigenen Images |
| `global.storageClass` | `""` | StorageClass für alle PVCs |

Alle Parameter mit Kommentaren siehe [values.yaml](values.yaml).

## Sicherheit auf einen Blick

- Container: `drop ALL caps`, `no privilege escalation`, `seccomp RuntimeDefault`;
  Non-Root wo das Image es erlaubt (DBs, Keycloak, Mosquitto, Node-RED).
- NetworkPolicies: Default-deny-Ingress, Datenspeicher nur für benannte Clients,
  extern nur Cockpit/APISIX/Keycloak über den Ingress-Controller.
- ServiceAccount ohne API-Token-Mount.
- Secrets: interne App-zu-App-Zugangsdaten (DB, Keycloak-Admin) werden beim
  ersten Install als starke Zufallspasswörter erzeugt und stabil gehalten –
  nichts einzutragen, keine Klartext-Passwörter in Git. Externe Verwaltung
  (SealedSecrets/ESO/Vault) optional per `secrets.create: false`.
- Ingress erzwingt TLS + Security-Header.

Produktions-Härtung: Checkliste in [DEPLOY.md](DEPLOY.md#12-h%C3%A4rtung-f%C3%BCr-den-produktivbetrieb-checkliste).
