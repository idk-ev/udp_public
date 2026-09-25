{{/*
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
*/}}

{{/*
=============================================================================
Gemeinsame Template-Helfer der UDP
=============================================================================
*/}}

{{/* Chart-Name/Version für Labels */}}
{{- define "udp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Versionsstabile Labels für POD-TEMPLATES. Bewusst OHNE helm.sh/chart und
app.kubernetes.io/version: die stehen im Pod-Template sonst bei jedem
Versions-Bump im Chart.yaml auf einem neuen Wert und rollen damit JEDEN Pod
neu, obwohl sich am Container nichts geändert hat.
Aufruf: {{ include "udp.podLabels" (dict "ctx" . "component" "orion-ld") }}
*/}}
{{- define "udp.podLabels" -}}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/part-of: urbane-datenplattform
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/component: {{ .component }}
{{- /* stabiles Selektor-Label, damit template.labels den (unveränderlichen) Selektor matcht */}}
app: {{ .component }}
{{- end -}}

{{/*
Vollständige Labels für OBJEKT-Metadaten (Deployment, Service, ConfigMap, …) –
podLabels plus Chart-/Versionsangaben. NICHT in Pod-Templates verwenden.
Aufruf: {{ include "udp.labels" (dict "ctx" . "component" "orion-ld") }}
*/}}
{{- define "udp.labels" -}}
helm.sh/chart: {{ include "udp.chart" .ctx }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
{{ include "udp.podLabels" . }}
{{- end -}}

{{/*
Selector-Labels – MÜSSEN stabil bleiben (Selektoren sind unveränderlich) und
entsprechen den Namen der ursprünglichen Kustomize-Manifeste, damit
komponentenübergreifende DNS-Referenzen (Service-Namen) gültig bleiben.
Aufruf: {{ include "udp.selectorLabels" "orion-ld" }}
*/}}
{{- define "udp.selectorLabels" -}}
app: {{ . }}
{{- end -}}

{{/*
Voll aufgelöster Image-Verweis inkl. optionalem globalem Registry-Prefix.
Aufruf: {{ include "udp.image" (dict "ctx" . "image" .Values.mongo.image) }}
*/}}
{{- define "udp.image" -}}
{{- $reg := .ctx.Values.global.imageRegistry -}}
{{- if $reg -}}
{{- printf "%s/%s:%s" $reg .image.repository .image.tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository .image.tag -}}
{{- end -}}
{{- end -}}

{{/*
Bild-Referenz für die drei SELBST GEBAUTEN Images (cockpit, ckan-dcat,
postgres-timescale-oss). Registry und Tag kommen aus global.udpRegistry /
global.udpTag, können aber pro Komponente überschrieben werden – so pinnt man
in Produktion einzelne Images auf ihren Digest.

global.imageRegistry wird hier bewusst NICHT vorangestellt: udpRegistry ist
bereits ein vollständiger Registry-Pfad. Wer die eigenen Images spiegelt, biegt
udpRegistry auf den Mirror um.

Aufruf: {{ include "udp.ownImage" (dict "ctx" . "image" .Values.cockpit.image) }}
*/}}
{{- define "udp.ownImage" -}}
{{- $reg := .image.registry | default .ctx.Values.global.udpRegistry -}}
{{- $tag := .image.tag | default .ctx.Values.global.udpTag -}}
{{- printf "%s/%s:%s" $reg .image.name $tag -}}
{{- end -}}

{{/*
imagePullPolicy für die SELBST GEBAUTEN Images. global.udpTag ist im
Normalbetrieb ein BEWEGLICHER Tag ("main", "pr-<nr>"): derselbe Tag zeigt nach
jedem Build auf ein neues Image. Mit dem Kubernetes-Default IfNotPresent
behaelt ein Knoten, der den Tag schon einmal gezogen hat, für immer den alten
Stand – das Release rollt dann zwar aus, startet aber weiter das alte Image.
Deshalb Always. Wer in Produktion auf den Digest pinnt (values-prod.yaml), darf
das über global.udpPullPolicy auf IfNotPresent zurückdrehen; ein Digest ist
unveraenderlich, ein erneuter Pull also überfluessig.
*/}}
{{- define "udp.ownImagePullPolicy" -}}
imagePullPolicy: {{ .Values.global.udpPullPolicy | default "Always" }}
{{- end -}}

{{/*
Pod-SecurityContext = security.podSecurityContext (global) gemerged mit dem
komponentenspezifischen Override.
Aufruf: {{ include "udp.podSecurityContext" (dict "ctx" . "override" .Values.mongo.podSecurityContext) }}
*/}}
{{- define "udp.podSecurityContext" -}}
{{- $base := .ctx.Values.security.podSecurityContext | default dict -}}
{{- $override := .override | default dict -}}
{{- $merged := mergeOverwrite (deepCopy $base) $override -}}
{{- toYaml $merged -}}
{{- end -}}

{{/*
Container-SecurityContext = security.containerSecurityContext gemerged mit
komponentenspezifischem Override.
*/}}
{{- define "udp.containerSecurityContext" -}}
{{- $base := .ctx.Values.security.containerSecurityContext | default dict -}}
{{- $override := .override | default dict -}}
{{- $merged := mergeOverwrite (deepCopy $base) $override -}}
{{- toYaml $merged -}}
{{- end -}}

{{/*
Name des DB-Secrets (extern oder vom Chart verwaltet).
*/}}
{{- define "udp.dbSecretName" -}}
{{- if .Values.db.existingSecret -}}
{{- .Values.db.existingSecret -}}
{{- else -}}
udp-db
{{- end -}}
{{- end -}}

{{/*
Name des Keycloak-Secrets.
*/}}
{{- define "udp.keycloakSecretName" -}}
{{- if .Values.keycloak.existingSecret -}}
{{- .Values.keycloak.existingSecret -}}
{{- else -}}
udp-keycloak
{{- end -}}
{{- end -}}

{{/*
Name des CKAN-Secrets (extern oder vom Chart verwaltet).
*/}}
{{- define "udp.ckanSecretName" -}}
{{- if .Values.ckan.existingSecret -}}
{{- .Values.ckan.existingSecret -}}
{{- else -}}
udp-ckan
{{- end -}}
{{- end -}}

{{/*
Name des GeoServer-Secrets (extern oder vom Chart verwaltet).
*/}}
{{- define "udp.geoserverSecretName" -}}
{{- if .Values.geoserver.existingSecret -}}
{{- .Values.geoserver.existingSecret -}}
{{- else -}}
udp-geoserver
{{- end -}}
{{- end -}}

{{/*
Öffentliche Basis-Adresse der Plattform (Schema + Host des Ingress), OHNE
abschließenden Slash. Alles, was der BROWSER aufruft, muss daraus gebaut werden:
die Keycloak-URL des Cockpits, die Redirect-URIs im Realm, die Modul-Kacheln.
Ein im Image vorbelegter localhost-Wert schickt den Anwender sonst auf seinen
eigenen Rechner statt auf die Plattform.

cockpit.publicUrl überschreibt (nötig, wenn der Ingress des Charts aus ist und
davor ein eigener Proxy/anderer Hostname steht).
*/}}
{{- define "udp.publicUrl" -}}
{{- if .Values.cockpit.publicUrl -}}
{{- .Values.cockpit.publicUrl | trimSuffix "/" -}}
{{- else -}}
{{- $scheme := ternary "https" "http" .Values.ingress.tls.enabled -}}
{{- printf "%s://%s" $scheme .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{/*
Öffentliche Adresse von Keycloak = Basis-Adresse + Kontextpfad
(KC_HTTP_RELATIVE_PATH, gleichzeitig der Ingress-Pfad).
*/}}
{{- define "udp.keycloakUrl" -}}
{{- printf "%s%s" (include "udp.publicUrl" .) (.Values.keycloakApp.relativePath | trimSuffix "/") -}}
{{- end -}}

{{/*
Öffentliche Adresse des CKAN-Katalogs. Explizit gesetzt gewinnt; sonst aus
ingress.host + /catalog abgeleitet (Schema abhängig von ingress.tls.enabled).
CKAN baut daraus alle absoluten Links und die DCAT-URIs – ein falscher Wert
erzeugt Metadaten mit unerreichbaren URLs.
*/}}
{{- define "udp.ckanSiteUrl" -}}
{{- if .Values.ckan.siteUrl -}}
{{- .Values.ckan.siteUrl -}}
{{- else -}}
{{- printf "%s/catalog" (include "udp.publicUrl" .) -}}
{{- end -}}
{{- end -}}

{{/*
Inhalt von /usr/share/nginx/html/config.js im Cockpit-Container (überschreibt
die auf Compose vorbelegte Datei aus dem Image, s. templates/configmaps.yaml).

Alle Adressen sind ABSOLUT und zeigen auf den öffentlichen Host: der Browser
löst sie auf, nicht der Pod. gatewayUrl bleibt der relative Pfad /gateway – den
proxyt der nginx des Cockpits cluster-intern weiter (gleicher Origin, kein CORS).

Module ohne Ingress-Route (Node-RED) und solche, die dieses Chart gar nicht
ausrollt (Uptime Kuma, s. monitoring/), bleiben leer; die Modul-Kachel wird dann
als deaktiviert dargestellt statt ins Leere zu führen. Über
cockpit.extraModuleUrls lassen sie sich nachtragen, sobald sie veröffentlicht sind.
*/}}
{{- define "udp.cockpitConfigJs" -}}
{{- $public := include "udp.publicUrl" . -}}
{{- /* Die Modul-Ziele müssen den TATSÄCHLICH veröffentlichten Pfaden folgen:
     ohne ingress.exposeComponentPaths sind /catalog und /geoserver nur noch
     lesend unter /gateway/… erreichbar, FROST ebenso. Kacheln, die ins Leere
     zeigen würden, bleiben leer (= deaktiviert dargestellt). */ -}}
{{- $apiBase := ternary $public (printf "%s/gateway" $public) (has "/FROST-Server" (.Values.ingress.apiPaths | default list)) -}}
{{- $modules := dict
      "hauptdashboard" "/dashboard.html"
      "smartcity"      "/reutlingen"
      "frost"          (printf "%s/FROST-Server/v1.1" $apiBase)
-}}
{{- if .Values.cockpit.authEnabled }}{{- $_ := set $modules "keycloakAdmin" (printf "%s/admin/udp/console/" (include "udp.keycloakUrl" .)) }}{{- end }}
{{- if and .Values.ckan.enabled .Values.ingress.exposeComponentPaths }}{{- $_ := set $modules "ckan" (printf "%s/catalog" $public) }}{{- end }}
{{- if and .Values.geoserver.enabled .Values.ingress.exposeComponentPaths }}{{- $_ := set $modules "geoserver" (printf "%s/geoserver" $public) }}{{- end }}
{{- if and .Values.masterportal.enabled .Values.ingress.exposeComponentPaths }}{{- $_ := set $modules "masterportal" (printf "%s/portal" $public) }}{{- end }}
{{- $modules = mergeOverwrite $modules (.Values.cockpit.extraModuleUrls | default dict) -}}
{{- $cfg := dict
      "gatewayUrl"  "/gateway"
      "authEnabled" .Values.cockpit.authEnabled
      "keycloak"    (dict "url" (include "udp.keycloakUrl" .) "realm" "udp" "clientId" "udp-cockpit")
      "module"      $modules
      "tenants"     .Values.cockpit.tenants
-}}
// Von Helm erzeugt (ConfigMap cockpit-config) – NICHT im Container bearbeiten.
window.UDP_CONFIG = {{ toPrettyJson $cfg | trim }};
{{- end -}}

{{/*
Pod-spec fields shared by every workload of the chart. Base indentation 0 –
position it at the call site with "| nindent 6".
Call: {{- include "udp.podSpec" (dict "ctx" . "cfg" .Values.mongo) | nindent 6 }}

enableServiceLinks: false – otherwise Kubernetes injects <SERVICE>_PORT etc.
for EVERY service of the namespace into every container. With services named
ckan, keycloak, redis or mongo these collide with variables the images read
themselves (CKAN_* is parsed by ckanext-envvars, Micronaut maps MONGO_PORT to a
property). All components address each other by DNS name, nothing needs them.
*/}}
{{- define "udp.podSpec" -}}
{{- $g := .ctx.Values.global -}}
serviceAccountName: udp
automountServiceAccountToken: false
enableServiceLinks: false
{{- with $g.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- with (.cfg.priorityClassName | default $g.priorityClassName) }}
priorityClassName: {{ . }}
{{- end }}
{{- with .cfg.terminationGracePeriodSeconds }}
terminationGracePeriodSeconds: {{ . }}
{{- end }}
{{- with (.cfg.nodeSelector | default $g.nodeSelector) }}
nodeSelector:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- with (.cfg.tolerations | default $g.tolerations) }}
tolerations:
{{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
{{- include "udp.podSecurityContext" (dict "ctx" .ctx "override" .cfg.podSecurityContext) | nindent 2 }}
{{- end -}}

{{/*
Scheduling spread. An explicit <component>.affinity wins. Otherwise components
running more than one replica get soft anti-affinity per node plus a soft
spread across zones – both "preferred"/"ScheduleAnyway", so a single-node
cluster still schedules everything. Nodes without a zone label are ignored by
the zone constraint.
Call: {{- include "udp.spread" (dict "component" "orion-ld" "cfg" .Values.orionLd) | nindent 6 }}
*/}}
{{- define "udp.spread" -}}
{{- if .cfg.affinity -}}
affinity:
{{- toYaml .cfg.affinity | nindent 2 }}
{{- else if gt (int (.cfg.replicas | default 1)) 1 -}}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              {{- include "udp.selectorLabels" .component | nindent 14 }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "udp.selectorLabels" .component | nindent 8 }}
{{- end -}}
{{- end -}}

{{/*
Rollout strategy for replicated Deployments: never take a ready pod away
before its replacement is ready (maxUnavailable 0) – the Service keeps at least
the full replica count during an update. Needs room for one extra pod
(maxSurge 1); if the cluster has none, the rollout waits instead of degrading.
Call: {{- include "udp.rollingUpdate" .Values.orionLd | nindent 2 }}
*/}}
{{- define "udp.rollingUpdate" -}}
strategy:
  type: RollingUpdate
  rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
{{- end -}}

{{/*
startup/readiness/liveness probes from <component>.probes. Each probe is a plain
Kubernetes probe object, so every field can be tuned via values; set a probe to
null to drop it. Base indentation 0 – call with "| nindent 10".
Call: {{- include "udp.probes" .Values.mongo.probes | nindent 10 }}
*/}}
{{- define "udp.probes" -}}
{{- with .startup }}
startupProbe:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- with .readiness }}
readinessProbe:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- with .liveness }}
livenessProbe:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
preStop delay for services behind a Service/Ingress. Endpoint removal reaches
kube-proxy and the ingress controller only after the pod has already received
SIGTERM; without a short delay in-flight connections hit a closed port during
every rollout or node drain. Needs a "sleep" binary in the image.
*/}}
{{- define "udp.preStopSleep" -}}
lifecycle:
  preStop:
    exec: { command: ["sleep", "{{ . | default 5 }}"] }
{{- end -}}

{{/*
Per-client rate limit for the public read routes (s. apisix.rateLimit).
Behind the ingress controller and the cockpit nginx, remote_addr is always a
proxy's pod address – keyed on that, all visitors shared ONE bucket. The
cockpit resolves the client address itself (nginx realip, trusting only the
cluster network) and sends it as X-Real-IP, overwriting whatever a client sent.
Requests without the header (cluster-internal callers) fall back to
remote_addr. (APISIX' real-ip plugin did not change remote_addr in 3.17 in
testing, hence this route.)
Base indentation 0 – call with "| nindent 6" inside a route's plugins map.
*/}}
{{- define "udp.apisixRateLimit" -}}
{{- $rl := .Values.apisix.rateLimit -}}
limit-req:
  rate: {{ $rl.rate }}
  burst: {{ $rl.burst }}
  key_type: var_combination
  key: "$http_x_real_ip"
  # Without nodelay, requests above "rate" are DELAYED until they fit – a
  # municipality page (~25 parallel requests) would crawl in behind each
  # other. nodelay serves everything within burst at once and answers only
  # the excess with 429.
  nodelay: true
  rejected_code: 429
{{- end -}}

{{/*
StorageClass-Auflösung: Komponente > global > weglassen (Cluster-Default).
Aufruf: {{ include "udp.storageClass" (dict "ctx" . "override" .Values.mongo.persistence.storageClass) }}
*/}}
{{- define "udp.storageClass" -}}
{{- $sc := .override | default .ctx.Values.global.storageClass -}}
{{- if $sc -}}
storageClassName: {{ $sc }}
{{- end -}}
{{- end -}}
