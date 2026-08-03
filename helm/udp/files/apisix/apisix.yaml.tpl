{{/*
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
*/}}

# =============================================================================
# API-Management der Urbanen Datenplattform (LB B.II.4)
# Alle Plattform-Schnittstellen werden zentral, dokumentiert und kontrolliert
# über das Gateway bereitgestellt. Zugriffskontrolle: Keycloak (OIDC) –
# Aktivierung der openid-connect-Plugins pro Route, siehe docs/betrieb.md.
#
# HINWEIS: Diese Datei wird vom Helm-Chart durch `tpl` gerendert (siehe
# templates/configmaps.yaml). Die if-Blöcke koppeln Upstreams und Routen an die
# enabled-Flags in values.yaml – abgeschaltete Komponenten hinterlassen so keine
# Route, die ins Leere zeigt. Die Compose-Variante liegt unverändert unter
# platform/config/apisix/apisix.yaml; dort sind alle Dienste vorhanden.
# =============================================================================

global_rules:
  - id: cors-all
    plugins:
      cors:
        allow_origins: "*"
        # Nur lesende Methoden: die Routen sind noch nicht per OIDC abgesichert
        # (s. Kopfkommentar). Schreibzugriff erfolgt bis dahin cluster-intern,
        # nicht aus dem Browser.
        allow_methods: "GET,OPTIONS"
        allow_headers: "*"
        expose_headers: "*"
      prometheus: {}

upstreams:
  - id: orion
    nodes:
      "orion-ld:1026": 1
    type: roundrobin
  - id: mintaka
    nodes:
      "mintaka:8080": 1
    type: roundrobin
  - id: frost
    nodes:
      "frost:8080": 1
    type: roundrobin
{{- if .Values.iotAgentJson.exposeRoutes }}
  - id: iot-agent
    nodes:
      "iot-agent-json:4041": 1
    type: roundrobin
  - id: iot-http
    nodes:
      "iot-agent-json:7896": 1
    type: roundrobin
{{- end }}
{{- if .Values.ckan.enabled }}
  - id: ckan
    nodes:
      "ckan:5000": 1
    type: roundrobin
{{- end }}
{{- if .Values.geoserver.enabled }}
  - id: geoserver
    nodes:
      "geoserver:8080": 1
    type: roundrobin
{{- end }}
{{- if .Values.masterportal.enabled }}
  - id: masterportal
    nodes:
      "masterportal:80": 1
    type: roundrobin
{{- end }}

routes:
  # NGSI-LD Context Broker (Echtzeit-Kontextdaten)
  - id: ngsi-ld
    uris: ["/ngsi-ld/*"]
    upstream_id: orion
    plugins:
      limit-req:
        rate: 200
        burst: 100
        key: remote_addr

  # NGSI-LD Temporal API (Zeitreihenabfragen)
  - id: temporal
    uris: ["/temporal/*"]
    upstream_id: mintaka
    plugins:
      proxy-rewrite:
        regex_uri: ["^/temporal/(.*)", "/$1"]

  # OGC SensorThings API
  - id: sensorthings
    uris: ["/FROST-Server/*"]
    upstream_id: frost

{{- if .Values.iotAgentJson.exposeRoutes }}
  # IoT-Geräteprovisionierung (Admin) – NUR mit OIDC-Absicherung veröffentlichen.
  # Ohne Authentifizierung kann jeder Geräte anlegen, ändern und auslesen;
  # deshalb standardmäßig aus (iotAgentJson.exposeRoutes=false).
  - id: iot-provisioning
    uris: ["/iot/*"]
    upstream_id: iot-agent
    plugins:
      proxy-rewrite:
        regex_uri: ["^/iot/(.*)", "/iot/$1"]

  # IoT-HTTP-Ingest (Sensoren → Plattform) – schreibender Pfad in den Broker.
  - id: iot-ingest
    uris: ["/ingest/*"]
    upstream_id: iot-http
    plugins:
      proxy-rewrite:
        regex_uri: ["^/ingest/(.*)", "/iot/$1"]
      limit-req:
        rate: 500
        burst: 200
        key: remote_addr
{{- end }}

{{- if .Values.ckan.enabled }}
  # Open-Data-Katalog (CKAN, DCAT-AP.de)
  - id: open-data
    uris: ["/catalog/*"]
    upstream_id: ckan
    plugins:
      proxy-rewrite:
        regex_uri: ["^/catalog/(.*)", "/$1"]
{{- end }}
{{- if .Values.geoserver.enabled }}

  # OGC WMS/WFS/WPS (GeoServer, nativer Kontextpfad /geoserver)
  - id: geo
    uris: ["/geoserver/*"]
    upstream_id: geoserver
{{- end }}
{{- if .Values.masterportal.enabled }}

  # Masterportal (statisches Geoportal, Profil viz-extra)
  - id: masterportal
    uris: ["/portal", "/portal/*"]
    upstream_id: masterportal
    plugins:
      proxy-rewrite:
        regex_uri: ["^/portal/?(.*)", "/$1"]
{{- end }}
#END
