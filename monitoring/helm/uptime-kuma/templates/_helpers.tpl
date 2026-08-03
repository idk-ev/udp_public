{{/*
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
*/}}

{{/*
=============================================================================
Template-Helfer – Uptime Kuma
=============================================================================
*/}}

{{/* Basisname (durch nameOverride/Release-Name begrenzt auf 63 Zeichen) */}}
{{- define "uptime-kuma.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Voll qualifizierter Name. Heißt das Release wie das Chart (der Normalfall:
`helm install uptime-kuma .`), bleibt es beim schlichten "uptime-kuma" – so
stimmen Service-DNS und die Namen aus dem früheren UDP-Chart überein.
*/}}
{{- define "uptime-kuma.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Chart-Name/Version für Labels */}}
{{- define "uptime-kuma.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Gemeinsame Labels */}}
{{- define "uptime-kuma.labels" -}}
helm.sh/chart: {{ include "uptime-kuma.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: urbane-datenplattform
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/name: {{ include "uptime-kuma.name" . }}
app.kubernetes.io/component: monitoring
{{- /* stabiles Selektor-Label, damit template.labels den (unveränderlichen) Selektor matcht */}}
app: {{ include "uptime-kuma.fullname" . }}
{{- end -}}

{{/* Selector-Labels – MÜSSEN stabil bleiben (Selektoren sind unveränderlich) */}}
{{- define "uptime-kuma.selectorLabels" -}}
app: {{ include "uptime-kuma.fullname" . }}
{{- end -}}

{{/* Voll aufgelöster Image-Verweis inkl. optionalem globalem Registry-Prefix */}}
{{- define "uptime-kuma.image" -}}
{{- $reg := .Values.global.imageRegistry -}}
{{- if $reg -}}
{{- printf "%s/%s:%s" $reg .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{/* imagePullSecrets-Block (nur wenn gesetzt) – am Aufrufort mit nindent setzen */}}
{{- define "uptime-kuma.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets -}}
imagePullSecrets:
{{ toYaml . }}
{{- end -}}
{{- end -}}

{{/* Name des ServiceAccounts */}}
{{- define "uptime-kuma.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "uptime-kuma.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{/* Name des Daten-PVC (eigenes oder vorhandenes) */}}
{{- define "uptime-kuma.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "uptime-kuma.fullname" .)) -}}
{{- end -}}
