# Verfügbarkeits-Monitoring (Uptime Kuma)

Eigenständiges Deployment der Außensicht auf die Urbane Datenplattform:
HTTP-Monitore auf alle öffentlichen Endpunkte, Statusseiten, Alarmierung
(E-Mail, Webhook, MS Teams) und die monatliche Verfügbarkeitsstatistik, die
den SLA-Nachweis nach [`docs/betrieb.md`](../docs/betrieb.md) trägt.

## Warum getrennt vom Plattform-Stack?

Das Monitoring lag früher in `platform/docker-compose.yml` bzw. im Chart
`helm/udp`. Damit teilte es Lebenszyklus und Fehlerbereich mit dem, was es
überwachen soll: Es startete, stoppte und rollte mit der Plattform aus – und
konnte deren Ausfall genau dann nicht melden, wenn es darauf ankam. Ein Wartungs-
fenster der Plattform nahm die Statusseite gleich mit.

Getrennt ausgerollt, idealerweise **auf einem anderen Host bzw. in einem anderen
Cluster/Namespace**, bleibt die Außensicht bestehen, während die Plattform neu
ausgerollt wird oder ausfällt.

## Docker Compose

```bash
cd monitoring
cp .env.example .env
docker compose up -d
```

Oberfläche: <http://localhost:3701> (Port über `KUMA_PORT`).

Beim **ersten Aufruf** legt Uptime Kuma das Administratorkonto an – es gibt
dafür bewusst keine Umgebungsvariable. Den Dienst deshalb erst veröffentlichen,
wenn das Konto steht.

Läuft das Monitoring auf demselben Host wie die Plattform und sollen zusätzlich
interne Endpunkte geprüft werden (die am Host nicht veröffentlicht sind), hängt
ein Override den Container zusätzlich ins Plattform-Netz `udp`:

```bash
docker compose -f docker-compose.yml -f docker-compose.udp-network.yml up -d
```

Die Monitore auf die **öffentlichen** Adressen (über das Gateway) bleiben dann
trotzdem Pflicht – die internen dienen nur der Fehlereingrenzung.

## Kubernetes (Helm)

```bash
helm -n udp-monitoring upgrade --install uptime-kuma monitoring/helm/uptime-kuma \
  --create-namespace \
  --set ingress.enabled=true --set ingress.host=status.example.org
```

Wichtige Werte (vollständig in
[`helm/uptime-kuma/values.yaml`](helm/uptime-kuma/values.yaml)):

| Value | Default | Bedeutung |
|-------|---------|-----------|
| `image.tag` | `1` | in Produktion auf Digest pinnen |
| `persistence.size` | `2Gi` | SQLite + Historie |
| `persistence.keepOnDelete` | `true` | PVC überlebt `helm uninstall` (Nachweis!) |
| `persistence.existingClaim` | `""` | vorhandenes PVC übernehmen (z. B. `kuma-data`) |
| `ingress.enabled` | `false` | Statusseite veröffentlichen |
| `ingress.host` | `status.example.org` | öffentliche Domain |
| `networkPolicies.enabled` | `false` | Default-deny **ingress** (Egress bleibt offen) |

Ingress erst aktivieren, **nachdem** das Administratorkonto angelegt ist
(`kubectl port-forward svc/uptime-kuma 3701:3001`) – oder vorher BasicAuth bzw.
eine IP-Allowlist am Ingress-Controller davorschalten.

`networkPolicies` filtert bewusst nur eingehenden Verkehr. Eine Egress-Allowlist
würde jeden neuen Monitor in einen Fehlalarm verwandeln.

## Migration bestehender Installationen

**Compose.** Der Stack heißt jetzt `udp-monitoring` statt `udp`, das Volume
entsprechend `udp-monitoring_kuma-data` statt `udp_kuma-data`. Alten Datenstand
übernehmen:

```bash
docker compose -f ../platform/docker-compose.yml stop uptime-kuma   # falls noch aktiv
docker volume create udp-monitoring_kuma-data
docker run --rm -v udp_kuma-data:/from -v udp-monitoring_kuma-data:/to alpine \
  sh -c 'cd /from && cp -a . /to'
cd monitoring && docker compose up -d
docker volume rm udp_kuma-data      # erst nach erfolgreicher Prüfung
```

**Helm.** Das Chart `helm/udp` rollt Uptime Kuma nicht mehr aus. Beim nächsten
`helm upgrade` verschwinden Deployment und Service `uptime-kuma`; das PVC
`kuma-data` wird **mit entfernt** – vorher sichern oder aus der Helm-Verwaltung
lösen und dem neuen Release übergeben:

```bash
# 1. PVC vor dem Plattform-Upgrade aus Helms Zugriff nehmen
kubectl -n udp annotate pvc kuma-data helm.sh/resource-policy=keep

# 2. Plattform aktualisieren (Uptime Kuma faellt heraus)
helm -n udp upgrade udp helm/udp

# 3. Monitoring als eigenes Release – im selben Namespace mit dem alten PVC:
helm -n udp upgrade --install uptime-kuma monitoring/helm/uptime-kuma \
  --set persistence.existingClaim=kuma-data
```

Für einen eigenen Namespace (empfohlen) stattdessen `/app/data` aus dem alten
Pod sichern und im neuen Release wieder einspielen.

## Was überwacht wird

Monitore, 60-s-Intervall, jeweils mit zugewiesener Benachrichtigung:

| Monitor | Ziel |
|---|---|
| Context Broker | `https://<host>/ngsi-ld/v1/types` |
| Temporal API | `https://<host>/temporal/` |
| OGC SensorThings | `https://<host>/FROST-Server/v1.1/` |
| Open-Data-Katalog | `https://<host>/catalog` |
| GeoServer | `https://<host>/geoserver/web/` |
| Cockpit | `https://<host>/` |
| Identität | `https://<keycloak-host>/realms/udp/.well-known/openid-configuration` |

Ohne zugewiesene Notification meldet ein Monitor nichts – das ist der häufigste
Einrichtungsfehler.

## Modulkachel im Cockpit

Das Cockpit verlinkt das Monitoring auf der Seite „Module".

- Compose: `module.uptimeKuma` in [`gui/public/config.js`](../gui/public/config.js)
- Helm: `cockpit.extraModuleUrls.uptimeKuma` im Chart `helm/udp`

Leer lassen, wenn die Statusseite nicht veröffentlicht ist – die Kachel wird
dann als deaktiviert dargestellt statt ins Leere zu führen.

## Lizenz

Uptime Kuma steht unter MIT (s. [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)),
die Konfiguration dieses Verzeichnisses unter EUPL-1.2.
