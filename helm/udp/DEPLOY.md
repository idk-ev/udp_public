# UDP – Deployment per Helm

Schritt-für-Schritt-Anleitung, um die Urbane Datenplattform (UDP) sicher auf
einen Kubernetes-Cluster zu bringen. Das Chart liegt in `helm/udp/`.

> Kurzfassung für Eilige (Details siehe unten):
> ```bash
> cd helm/udp
> KUBE_CONTEXT="prod-cluster"        # Zielcluster explizit wählen (Abschnitt 2)
> # Secrets: nichts zu tun – Zufallspasswörter entstehen beim Install (Abschnitt 4)
> helm lint .
> helm upgrade --install udp . -n udp --create-namespace \
>   --kube-context "$KUBE_CONTEXT" -f values-prod.yaml
> kubectl --context "$KUBE_CONTEXT" -n udp get pods -w
> ```

---

## 1. Was dieses Chart deployt

| Tier            | Komponenten                                              |
|-----------------|----------------------------------------------------------|
| Persistenz      | MongoDB (StatefulSet, optional Replica Set), PostGIS/Timescale (CNPG) |
| Context Broker  | Orion-LD (NGSI-LD), Mintaka (Temporal API)               |
| IoT             | Mosquitto (MQTT), IoT-Agent-JSON, FROST (SensorThings)   |
| API & Identität | APISIX (Gateway), Keycloak (OIDC)                        |
| Open Data       | CKAN (DCAT-AP.de) + Solr + Valkey *(`ckan.enabled`)*     |
| Geo             | GeoServer *(`geoserver.enabled`)*, Masterportal *(aus)*  |
| Anwendungen     | Konnektordienst *(`connectors.enabled`)*, Node-RED (Low-Code, Beispielfluss), Cockpit |
| Betrieb         | DB-Backup (pg_dump) *(`backup.enabled`)*                 |
| Netzwerk        | Ingress, NetworkPolicies, PodDisruptionBudgets           |

Damit deckt das Chart denselben Funktionsumfang ab wie
`platform/docker-compose.yml` – bis auf Superset (Compose-Profil `analytics`).

Das **Verfügbarkeits-Monitoring (Uptime Kuma)** ist bewusst nicht Teil dieses
Charts: ein Monitoring, das mit der überwachten Plattform ausgerollt wird und
mit ihr ausfällt, kann deren Ausfall nicht melden. Eigenes Release, eigener
Namespace – siehe [`monitoring/README.md`](../../monitoring/README.md). Dort ist
auch beschrieben, wie ein bestehendes PVC `kuma-data` übernommen wird.

Die Konfigurationsdateien (APISIX-Routen, Keycloak-Realm, Postgres-Init) sind
unter `helm/udp/files/` gebündelt und werden als ConfigMaps ausgerollt.
`files/apisix/apisix.yaml.tpl` wird dabei durch `tpl` gerendert: Upstreams und
Routen abgeschalteter Komponenten fallen mit heraus.

### Öffentliche Pfade

In der Standardauslieferung ist von außen **nur der lesende Weg über das
Cockpit** offen. Grund: die APISIX-Routen werten noch kein OIDC-Token aus — als
bare Ingress-Pfade wären sie anonym beschreibbar (POST/PATCH/DELETE direkt in
den Context Broker).

| Pfad | Ziel | Standard |
|------|------|----------|
| `/` | Cockpit (SPA + generierte Kommunenseiten) | offen |
| `/gateway/…` | Cockpit-nginx → APISIX, **nur GET/HEAD/OPTIONS** (Micro-Cache) | offen |
| `/abfahrten`, `/warnungen.ics` | Cockpit-nginx → Konnektordienst (exakte Pfade, `cockpit.connectorsUpstream`) | offen |
| `/ngsi-ld`, `/temporal`, `/FROST-Server` | APISIX | aus (`ingress.apiPaths: []`) |
| `/iot`, `/ingest` | APISIX → IoT-Agent | aus (`iotAgentJson.exposeRoutes: false`) |
| `/catalog`, `/geoserver`, `/portal` | APISIX → CKAN / GeoServer / Masterportal | aus (`ingress.exposeComponentPaths: false`) |
| `/auth` | Keycloak (`KC_HTTP_RELATIVE_PATH`) | aus (`cockpit.authEnabled: false`) |

Alle abgeschalteten Komponenten laufen weiter und sind cluster-intern
erreichbar — es entfällt nur die öffentliche Route. Zum Öffnen nach Einführung
der OIDC-Absicherung genügt der jeweilige Wert in `values-prod.yaml`; die
Ingress-Pfade entsprechen dann wieder exakt den APISIX-Routen (kein Rewrite).

> **Achtung beim Öffnen von `/FROST-Server`:** `frost.serviceRootUrl` muss auf
> denselben Pfad zeigen, sonst laufen die `@iot.selfLink`-Verweise ins Leere.

---

## 2. Voraussetzungen

| Werkzeug / Feature        | Zweck                                          |
|---------------------------|------------------------------------------------|
| Kubernetes ≥ 1.25         | Zielcluster (`kubectl cluster-info` erreichbar)|
| Helm ≥ 3.8                | Deployment                                     |
| Ingress-Controller        | z. B. ingress-nginx – externer Zugriff         |
| **CNI mit NetworkPolicy** | Calico / Cilium – sonst greifen die Policies nicht |
| Default StorageClass      | für die PVCs (oder in Values gesetzt)          |
| cert-manager *(optional)* | automatisches TLS-Zertifikat                   |
| **CloudNativePG-Operator ≥ 1.26** | betreibt die PostgreSQL-Datenbank `timescale` (Primary + Standby) |

Prüfen:
```bash
kubectl version --short
helm version
kubectl get ingressclass
kubectl get storageclass
# NetworkPolicy-Durchsetzung? (z. B. Calico)
kubectl get pods -n kube-system | grep -Ei 'calico|cilium'
```

### CloudNativePG-Operator

Die Datenbank (PostgreSQL + PostGIS + TimescaleDB) läuft als
CloudNativePG-Cluster mit `timescale.instances` Instanzen: ein Primary, die
übrigen als Standby per Streaming-Replikation. Vor dem Drain des
Primary-Knotens schaltet der Operator auf einen Standby um, bei einem Ausfall
übernimmt er automatisch. Der Operator ist clusterweit und wird **einmal vor
dem Chart** installiert (das Chart bricht ohne seine CRDs ab):

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace   --kube-context "$KUBE_CONTEXT" -f cnpg-values.yaml
```

`cnpg-values.yaml` mit zwei Operator-Replikaten in verschiedenen Zonen –
fällt der Knoten des Operators zusammen mit dem Primary aus, gibt es sonst
niemanden, der umschaltet:

```yaml
replicaCount: 2
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: topology.kubernetes.io/zone
        labelSelector:
          matchLabels: { app.kubernetes.io/name: cloudnative-pg }
# Mit "required" und genau zwei Zonen findet ein dritter Pod keinen Platz –
# Rollouts deshalb ohne Surge.
updateStrategy:
  type: RollingUpdate
  rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }
```

Die übrigen Werte des Operator-Charts passen.

Was das in der Praxis bedeutet (gemessen mit zwei Knoten in zwei Zonen):
Drain des Primary-Knotens (Knoten-Update) ~5 s ohne Schreibzugriff,
Absturz des Primary-Pods ~3 s, **Ausfall des ganzen Knotens ~60 s** – der
Operator schaltet erst um, wenn Kubernetes den Knoten als `Unknown` markiert
(`node-monitor-grace-period`, 40 s). Bestätigte Schreibvorgänge gingen in
keinem Fall verloren (synchrone Replikation, solange der Standby läuft). Namespace/Labels abweichend? → `networkPolicies.cnpgOperator`.
Hochverfügbar ist die Datenbank nur mit mindestens zwei Knoten (bei
zonengebundenen Volumes: zwei Zonen, dazu `timescale.affinity.podAntiAffinityType:
required`).

> **Wichtig:** Ohne policy-fähiges CNI (z. B. bei reinem Flannel) werden die
> NetworkPolicies stillschweigend ignoriert – die Segmentierung greift dann
> nicht. In dem Fall Calico/Cilium nachrüsten oder das Risiko akzeptieren.

### Zielcluster explizit wählen (Mehrere kubeconfigs/Contexts)

> ⚠️ **Nie auf den falschen Cluster deployen.** Wer mehrere Cluster in seiner
> kubeconfig hat, sollte den **current-context nicht implizit** verwenden.
> Alle `helm`- und `kubectl`-Befehle unten setzen den Kontext explizit; das
> Secrets-Skript **verlangt** `--context`.

```bash
# Verfügbare Kontexte anzeigen und den gewünschten in eine Variable legen:
kubectl config get-contexts
KUBE_CONTEXT="prod-cluster"        # <- Zielcluster (Bash)
```
```powershell
$KubeContext = "prod-cluster"      # <- Zielcluster (PowerShell)
```
Optional statt `--context` eine dedizierte Datei erzwingen:
`export KUBECONFIG=~/.kube/prod.yaml` (Bash) bzw.
`$env:KUBECONFIG = "C:\kube\prod.yaml"` (PowerShell).

---

## 3. Sicherheits-Architektur (Überblick)

Das Chart ist „secure by default“ ausgelegt:

- **Container-Härtung überall:** `allowPrivilegeEscalation: false`,
  `capabilities: drop [ALL]`, `seccompProfile: RuntimeDefault`. Datenbanken,
  Keycloak, Mosquitto & Node-RED laufen als **Non-Root** mit fester UID/fsGroup.
  (Bei einigen Upstream-Images – Orion-LD, APISIX, FROST – ist Non-Root noch
  nicht möglich; sie sind als TODO markiert und über Values umstellbar.)
- **Netzwerksegmentierung:** Default-deny-Ingress; Dienste erreichen sich nur
  intra-namespace; **Datenspeicher nur durch benannte Clients**; von außen sind
  ausschließlich Cockpit/APISIX/Keycloak über den Ingress-Controller erreichbar.
- **Least-Privilege-Identität:** ein dedizierter ServiceAccount ohne
  eingehängtes API-Token (`automountServiceAccountToken: false`).
- **Secrets:** werden nicht im Klartext ausgeliefert. Entweder zufällig beim
  Install erzeugt (stabil bei Upgrades) **oder** – empfohlen – extern verwaltet.
- **Transport:** Ingress erzwingt TLS + HSTS/Security-Header.

---

## 4. Secrets (in der Regel: nichts zu tun)

**Grundsatz: Was nicht selbst festgelegt werden muss, wird automatisch als
starkes Zufallspasswort erzeugt.** Das DB-Passwort ist eine reine App-zu-App-
Zugangsdatei – die Datenbank ist von außen nicht erreichbar (kein Ingress) und
per NetworkPolicy nur für die Dienste geöffnet, die sie tatsächlich nutzen
(Matrix in `templates/networkpolicy.yaml`). Es gibt daher keinen Grund, es manuell zu vergeben.

### Weg A – Automatisch erzeugte Zufallspasswörter (Default, auch für Produktion)

`secrets.create: true` (Default). Beim **ersten** Install werden für alle leeren
Passwortfelder 32-stellige Zufallspasswörter erzeugt (`secrets.passwordLength`,
alphanumerisch ≈ 190 Bit) und danach über Helms `lookup` **stabil gehalten** –
ein `helm upgrade` rotiert sie also nicht. Zusätzlich schützt
`helm.sh/resource-policy: keep` die Secrets vor `helm uninstall`.

Es ist **nichts einzutragen**. Passwörter bei Bedarf auslesen:
```bash
kubectl --context "$KUBE_CONTEXT" -n udp get secret udp-db \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d; echo
kubectl --context "$KUBE_CONTEXT" -n udp get secret udp-keycloak \
  -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d; echo
```
Ein bestimmtes Passwort erzwingen (nur wenn wirklich nötig) – z. B. weil eine
Alt-Datenbank bereits existiert:
```bash
helm upgrade --install udp . -n udp --kube-context "$KUBE_CONTEXT" \
  -f values-prod.yaml --set db.password='<vorhandenes-passwort>'
```

> ⚠️ Einschränkung: Die Stabilität beruht auf Helms `lookup`, das nur bei
> `helm install/upgrade` gegen einen echten Cluster funktioniert. Bei einem
> GitOps-Flow via `helm template | kubectl apply` (kein Cluster-Zugriff beim
> Rendern) würde bei jedem Lauf ein neues Passwort erzeugt – dort **Weg B**
> verwenden.

### Weg B – Secrets extern verwalten (nur bei Compliance-Vorgabe oder GitOps)
Nötig, wenn Secrets ausschließlich außerhalb des Clusters verwaltet werden
müssen (SealedSecrets / External-Secrets-Operator / Vault) oder bei
`helm template | kubectl apply`. Dazu in den Values `secrets.create: false` und
die `existingSecret`-Namen setzen (auskommentierter Block in
`values-prod.example.yaml`) und die Secrets vorab anlegen.

**Am einfachsten per Helfer-Skript** (`scripts/create-secrets.{sh,ps1}`) – legt
`udp-db` und `udp-keycloak` mit starken Zufallspasswörtern an, dazu die
CNPG-Rollen-Secrets `timescale-role-<user>` (Default `timescale-role-udp`) und
`timescale-role-ckan-ro` – immer mit **demselben Passwort wie `udp-db`**
(bei vorhandenem `udp-db` aus diesem übernommen). **Idempotent**
(vorhandene Secrets werden nicht überschrieben, kein versehentliches Rotieren;
`--force` rotiert `udp-db` samt Rollen-Secrets).
Der **Zielcluster muss explizit** über `--context` angegeben werden (Schutz vor
Deploy auf den falschen Cluster); vor dem Anlegen wird Cluster + Namespace zur
Bestätigung angezeigt.
```bash
# Linux/macOS/Git-Bash – verfügbare Kontexte: kubectl config get-contexts
./scripts/create-secrets.sh --context prod-cluster
./scripts/create-secrets.sh --context prod-cluster --namespace udp-prod
./scripts/create-secrets.sh --context prod-cluster --kubeconfig ~/.kube/prod.yaml
./scripts/create-secrets.sh --context prod-cluster --force    # Passwörter rotieren
./scripts/create-secrets.sh --context prod-cluster --sealed   # SealedSecret-YAML
```
```powershell
# Windows PowerShell (-Context ist Pflicht):
./scripts/create-secrets.ps1 -Context prod-cluster
./scripts/create-secrets.ps1 -Context prod-cluster -Namespace udp-prod
./scripts/create-secrets.ps1 -Context prod-cluster -Kubeconfig C:\kube\prod.yaml
./scripts/create-secrets.ps1 -Context prod-cluster -Force
./scripts/create-secrets.ps1 -Context prod-cluster -Sealed
```
Das Skript zeigt das erzeugte Keycloak-Admin-Passwort einmalig an und erklärt,
wie sich beide Passwörter später auslesen lassen.

<details><summary>Alternativ manuell (ohne Skript)</summary>

```bash
kubectl create namespace udp
DB_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
kubectl -n udp create secret generic udp-db \
  --from-literal=POSTGRES_USER=udp \
  --from-literal=POSTGRES_PASSWORD="$DB_PASS"
kubectl -n udp create secret generic udp-keycloak \
  --from-literal=KEYCLOAK_ADMIN=admin \
  --from-literal=KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 24)"
# CNPG-Rollen: basic-auth, gleiches Passwort wie udp-db. Ohne die Annotation
# speichert CNPG einen SCRAM-Hash -> Orion-LD kann sich nicht anmelden.
for role in udp ckan_ro; do
  name="timescale-role-${role//_/-}"
  kubectl -n udp create secret generic "$name" --type=kubernetes.io/basic-auth \
    --from-literal=username="$role" --from-literal=password="$DB_PASS"
  kubectl -n udp label secret "$name" cnpg.io/reload=true
  kubectl -n udp annotate secret "$name" cnpg.io/passwordPassthrough=enabled
done
unset DB_PASS
```
… oder – noch besser – per **Sealed Secrets** (Secrets verschlüsselt in Git):
```bash
kubectl -n udp create secret generic udp-db \
  --from-literal=POSTGRES_USER=udp \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --dry-run=client -o yaml | kubeseal --format yaml > sealed-udp-db.yaml
kubectl apply -f sealed-udp-db.yaml
```
Die Rollen-Secrets ebenso versiegeln – Label und Annotation müssen dabei im
YAML stehen (am einfachsten: `create-secrets.sh --sealed`).
… oder per **External Secrets Operator** / **Vault** (Referenz auf externen
Secret-Store).

</details>

In allen Fällen müssen die Schlüsselnamen exakt so heißen:
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`;
die Rollen-Secrets `timescale-role-<user>` / `timescale-role-ckan-ro`
(`<user>` = `POSTGRES_USER`, `_` → `-`) mit `username` (= Rollenname, also
`<user>` bzw. `ckan_ro`) und `password` (= `POSTGRES_PASSWORD`), Typ
`kubernetes.io/basic-auth`, Label `cnpg.io/reload: "true"` und Annotation
`cnpg.io/passwordPassthrough: "enabled"`.

---

## 5. Eigene Values anlegen

```bash
cd helm/udp
cp values-prod.example.yaml values-prod.yaml
```
Mindestens anpassen:
- `ingress.host` – die echte Domain (z. B. `udp.meine-stadt.de`)
- `ingress.clusterIssuer` – oder `ingress.tls.enabled: false`, falls kein TLS
- `global.storageClass` – passende Klasse für die DBs
- `cockpit.image` – euer selbst gebautes, in eure Registry gepushtes Image
- `frost.serviceRootUrl` – auf den echten Host zeigen
- `networkPolicies.ingressControllerNamespaceLabel` – Namespace eures Ingress-
  Controllers (Default: `ingress-nginx`)
- `networkPolicies.monitoringNamespaceLabel` – Namespace von Uptime Kuma /
  Prometheus, sonst erreicht das Monitoring die Dienste nicht (leer = aus)

> `values-prod.yaml` gehört **nicht** mit echten Secrets in Git. Passwörter über
> Weg B (Abschnitt 4), nicht in dieser Datei.

---

## 6. Eigene Images

Diese Images gibt es nicht als Upstream-Image. Gebaut und gepusht werden sie
von der GitHub Action **`.github/workflows/build-images.yml`** nach
`ghcr.io/idk-ev/udp/…`:

| Value | Image | Inhalt |
|-------|-------|--------|
| `cockpit.image` | `cockpit` | Eigenentwicklung: SPA + nginx-Konfiguration |
| `ckan.image` | `ckan-dcat` | CKAN 2.10 + `ckanext-dcat` (DCAT-AP.de) |
| `timescale.image` | `postgres-timescale-oss` | PostGIS **und** TimescaleDB Apache Edition |
| `connectors.image` | `udp-connectors` | Konnektordienst (`platform/connectors`) samt Konnektor-Registry |

> **Node-RED** läuft auf dem Upstream-Image `nodered/node-red` (`nodeRed.image`,
> kein eigenes Image mehr): Low-Code-Baustein mit einem Beispielfluss, keine
> Ingestion. `flows.json` und `settings.js` kommen aus der ConfigMap
> `node-red-config` (`helm/udp/files/nodered/`); ein initContainer kopiert sie
> in ein `emptyDir` auf `/data`, damit Deploys aus dem Editor funktionieren –
> sie überleben keinen Pod-Neustart. Kein PVC, keine Ingress-Route (Editor per
> `kubectl port-forward`). Ein alter Digest-Pin von `node-red-udp` unter
> `nodeRed.image` lässt das Rendern mit einem Hinweis abbrechen – entfernen.

> **Konnektordienst** (Deployment `connectors`): die Ingestion der Plattform.
> Er führt jeden aktiven Eintrag der Registry aus (im Image) und beantwortet
> `/abfahrten` und `/warnungen.ics` für das Cockpit. Immer **eine** Replik mit
> `strategy: Recreate` (Zustand in TimescaleDB, Schema `udp_connectors`, ein
> Schreiber per Advisory-Lock; der DB-Nutzer braucht `CREATE` auf `orion`).
> Der Service zeigt nur Port 1880 (die beiden Endpunkte), die NetworkPolicy
> lässt dort nur das Cockpit zu; der Admin-Port 1881 (`/healthz`, `/trigger`)
> steht in keinem Service. Kein PVC, Root-Dateisystem read-only. Der
> hystreet-Token steht unter `connectors.hystreetApiToken` bzw.
> `connectors.hystreetExistingSecret` (die früheren Schlüssel unter `nodeRed.`
> werden weiter gelesen). Auslösen eines Konnektors:
> `CONNECTORS_EXEC="kubectl -n <ns> exec deploy/connectors --" bash scripts/trigger-connector.sh <id>`.
>
> **Admin-Port 1881:** lauscht auf allen Interfaces (für die Kubelet-Probes)
> und ist nur durch zwei Dinge geschützt – die NetworkPolicy (keine Regel öffnet
> 1881) und die Loopback-Prüfung von `/trigger`. Deshalb den Pod **nie** hinter
> einen Service-Mesh-Sidecar (oder anderen Proxy) stellen, der eingehenden
> Verkehr von 127.0.0.1 an die Anwendung weiterreicht: dann sieht jeder Aufrufer
> wie Loopback aus und `/trigger` steht offen. Mit
> `networkPolicies.enabled=false` ist 1881 clusterweit erreichbar – `/trigger`
> lehnt Nicht-Loopback-Aufrufer weiterhin ab, `/healthz` ist aber für jeden
> lesbar.

> Das Datenbank-Image ist Pflicht, kein Komfort: `files/postgres/01-databases.sql`
> legt `CREATE EXTENSION timescaledb` an – mit einem reinen `postgis/postgis`
> bricht der DB-Init ab und der Pod kommt nie hoch.

| Anlass | Tag |
|---|---|
| Push auf `main` | `main`, `sha-<commit>` |
| GitHub-Release `v1.0.0` | `1.0.0`, `1.0`, `latest` |
| Pull Request #42 | `pr-42` (wandert mit jedem Push), `pr-42-<sha>` (fest) |
| PR aus einem Fork | wird nur gebaut, **nicht** gepusht (read-only Token) |
| jeder Lauf | zusätzlich `inputs-<hash>` (Hash der Build-Eingaben) |

**Unveränderte Images behalten ihren Digest.** Jeder Lauf hasht je Image dessen
Build-Eingaben: Dockerfile, die per `COPY`/`ADD` übernommenen Dateien, die
aktuellen Digests der `FROM`-Basis-Images und das Build-Rezept. Existiert
`inputs-<hash>` schon, wird nicht gebaut – der vorhandene Digest bekommt nur die
Tags des Laufs und wird so ins Chart gepinnt. Ein Chart-Release rollt damit nur
die Komponenten neu aus, die sich wirklich geändert haben (ohne das bekäme z. B.
die Datenbank bei jedem Release ein neues Image und CloudNativePG einen
Switchover des Primary). Neu gebaut wird, wenn sich eine Eingabe ändert oder ein
Basis-Image upstream aktualisiert wurde. Pakete, die `RUN`-Schritte ungepinnt
aus dem Netz holen (apt, pip, npm), frischt ein manueller Lauf mit
*Run workflow → force_rebuild* auf. Ob ein Image gebaut oder wiederverwendet
wurde, steht in der Job-Zusammenfassung.

### Einen PR-Stand testen

Die Job-Zusammenfassung des PR-Laufs enthält den fertigen Aufruf. Nur das
jeweils geänderte Image umstellen, der Rest bleibt auf `global.udpTag`:
```bash
helm upgrade --install udp helm/udp -n udp -f values-prod.yaml \
  --set cockpit.image.tag=pr-42
```
Reproduzierbar auf genau einen Commit statt auf den PR-Kopf:
`--set cockpit.image.tag=pr-42-a1b2c3d`.

Zurück auf den regulären Stand: `--set cockpit.image.tag=` (leer → `udpTag`)
oder den `--set` beim nächsten Upgrade weglassen.

> Die `pr-*`-Tags bleiben nach dem Merge in der Registry liegen. Gelegentlich
> unter GitHub → Packages → \<image\> → Manage versions aufräumen – aber **nur
> Versionen löschen, die ausschließlich `pr-*`-Tags tragen**: durch die
> Wiederverwendung kann dieselbe Version auch `main`-, SemVer- oder
> `inputs-*`-Tags tragen und in einem ausgerollten Chart gepinnt sein.

Registry und Tag gelten für alle drei gemeinsam – `global.udpRegistry` und
`global.udpTag`. Wer die Images spiegelt, ändert nur `udpRegistry`
(`global.imageRegistry` betrifft ausschließlich die Upstream-Images).

Die Image-Digests stehen in der Job-Zusammenfassung des Action-Laufs
(*Actions → Images → Summary*). Für Produktion gehört je Image ein Digest-Pin
nach `values-prod.yaml`, damit kein beweglicher Tag deployt wird:
```yaml
cockpit:   { image: { tag: "1.0.0@sha256:…" } }
ckan:      { image: { tag: "1.0.0@sha256:…" } }
timescale: { image: { tag: "1.0.0@sha256:…" } }
```

Manuell bauen (z. B. für einen Test ohne CI) – beim Cockpit ist der
**Build-Kontext das Repo-Root**, weil `gui/Dockerfile` zusätzlich
`platform/config/nginx/cockpit.conf.template` kopiert:
```bash
docker build -f gui/Dockerfile -t ghcr.io/idk-ev/udp/cockpit:test .
docker build -t ghcr.io/idk-ev/udp/ckan-dcat:test              platform/config/ckan
docker build -t ghcr.io/idk-ev/udp/postgres-timescale-oss:test platform/config/postgres
```

GHCR-Pakete sind anfangs **privat**. Entweder die Pakete einmalig auf *Public*
stellen (GitHub → Packages → \<image\> → Package settings → Change visibility) –
dann braucht der Cluster kein Pull-Secret – oder ein Pull-Secret anlegen und in
`global.imagePullSecrets` referenzieren:
```bash
kubectl --context "$KUBE_CONTEXT" -n udp create secret docker-registry ghcr-cred \
  --docker-server=ghcr.io \
  --docker-username=<github-user> --docker-password=<PAT mit read:packages>
```

---

## 7. Trockenlauf (Rendern & Prüfen)

Immer erst rendern und lint laufen lassen, bevor etwas in den Cluster geht:
```bash
cd helm/udp
helm lint .
# Vollständiges Manifest ansehen (rein lokal, kein Cluster nötig):
helm template udp . -n udp -f values-prod.yaml | less
# Server-seitige Validierung ohne Anwendung (auf dem GEWÄHLTEN Cluster):
helm upgrade --install udp . -n udp --create-namespace \
  --kube-context "$KUBE_CONTEXT" \
  -f values-prod.yaml --dry-run=server
```

---

## 8. Installation

```bash
helm upgrade --install udp . \
  -n udp --create-namespace \
  --kube-context "$KUBE_CONTEXT" \
  -f values-prod.yaml \
  --atomic --timeout 10m
```
- `--kube-context` wählt den Zielcluster explizit (siehe Abschnitt 2).
- `--atomic` rollt bei Fehlern automatisch zurück.
- `--timeout 10m` gibt den Datenbanken Zeit zum Initialisieren.

> Tipp: Vor dem Install kurz gegenprüfen, worauf `$KUBE_CONTEXT` zeigt:
> `kubectl config view --context "$KUBE_CONTEXT" --minify -o jsonpath='{.clusters[0].cluster.server}'; echo`

Rollout beobachten:
```bash
kubectl --context "$KUBE_CONTEXT" -n udp get pods -w
kubectl --context "$KUBE_CONTEXT" -n udp rollout status deploy/keycloak
```
Erwartete Reihenfolge: **mongo/timescale** werden zuerst „Ready“, danach
**orion-ld/keycloak/frost** (sie warten auf die DB), zuletzt **apisix/cockpit**.

---

## 9. Verifikation

```bash
# Alles läuft?
kubectl -n udp get pods,svc,ingress

# Context Broker erreichbar (im Cluster):
kubectl -n udp exec deploy/orion-ld -- curl -s localhost:1026/ngsi-ld/ex/v1/version

# Extern über den Ingress (nach DNS + TLS):
curl -sSI https://udp.meine-stadt.de/                             # Startseite (Mitmachen)
curl -sSI https://udp.meine-stadt.de/cockpit                      # Cockpit-SPA
curl -sS  https://udp.meine-stadt.de/gateway/ngsi-ld/v1/entities  # Weg der SPA (Cockpit-nginx)

# Absicherung gegenprüfen — alle vier MÜSSEN fehlschlagen:
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     https://udp.meine-stadt.de/gateway/ngsi-ld/v1/entities       # erwartet 403
curl -sS -o /dev/null -w '%{http_code}\n' \
     https://udp.meine-stadt.de/ngsi-ld/v1/entities               # erwartet 404
curl -sS -o /dev/null -w '%{http_code}\n' \
     https://udp.meine-stadt.de/iot/services                      # erwartet 404
curl -sS -o /dev/null -w '%{http_code}\n' \
     https://udp.meine-stadt.de/auth/realms/udp                   # erwartet 404

# NetworkPolicies aktiv?
kubectl -n udp get networkpolicy
```

Liefert `/gateway/…` einen 502, obwohl `/ngsi-ld/…` funktioniert, löst der
nginx im Cockpit den Upstream nicht auf: `cockpit.gatewayUpstream` muss ein
**voll qualifizierter** Servicename sein (`apisix.<ns>.svc.cluster.local:9080`).
nginx wendet auf Namen, die es über den `resolver` auflöst, die `search`-Domains
aus `/etc/resolv.conf` nicht an.
Prüfen, dass die Segmentierung greift (sollte **scheitern**, wenn Policies
durchgesetzt werden – Cockpit darf die DB nicht erreichen):
```bash
kubectl -n udp exec deploy/cockpit -- sh -c 'nc -zv -w3 timescale 5432' || echo "korrekt blockiert"
```

---

## 10. Upgrades & Rollback

```bash
# Werte/Version ändern, dann:
helm upgrade udp . -n udp --kube-context "$KUBE_CONTEXT" -f values-prod.yaml --atomic

# Historie / Rollback:
helm -n udp --kube-context "$KUBE_CONTEXT" history udp
helm -n udp --kube-context "$KUBE_CONTEXT" rollback udp <REVISION>
```
Bei generierten Secrets (Weg A) bleiben Passwörter über Upgrades **stabil**
(via `lookup`). Config-Änderungen unter `files/` lösen dank Checksum-Annotation
automatisch einen Rolling-Restart der betroffenen Pods aus.

### 10a. Migration der Datenbank auf CloudNativePG (Upgrade von Chart ≤ 1.0.x)

Bis Chart 1.0.x lief die Datenbank als einzelnes StatefulSet `timescale`; ihr
Volume ist an einen Knoten (je nach Speicher auch an eine Zone) gebunden, jeder
Neustart dieses Knotens war ein Ausfall. Das Chart legt heute einen
CNPG-Cluster an – mit **leerer** Datenbank. Ein einfaches `helm upgrade`
verweigert es deshalb, solange die Daten noch im alten StatefulSet liegen.

Umzug in Phasen (`timescale.migration.phase`), dazwischen
`scripts/migrate-timescale-cnpg.sh`. Die Plattform steht nur zwischen `copy`
und `resume` – die Dauer hängt von der Datenmenge ab, vorher mit `rehearse` messen.
Die neuen Volumes brauchen nur Platz für die Daten selbst: die Kopie läuft als
Strom `pg_dump | pg_restore`, ohne Zwischendatei.

Vorher prüfen:

- Das alte StatefulSet läuft in `prepare` mit **seinem bisherigen Image**
  weiter (das Chart übernimmt es aus dem Cluster) – kein Neustart.
- Wer `timescale.image.tag` in den eigenen Values auf einen Digest gepinnt
  hat: dieser Wert gilt jetzt dem **neuen** Image `postgres-timescale-cnpg`.
  Den alten Pin entfernen bzw. nach `timescale.legacy.image.tag` verschieben,
  sonst zieht der CNPG-Cluster ein falsches Image und `wait` läuft ins Leere.
- **Knoten-Neustarts pausieren** (kured), solange `copy` läuft – ein Drain
  würde den Kopier-Pod oder den Primary mitten in der Kopie verschieben:
  `kubectl -n kube-system annotate ds kured weave.works/kured-node-lock='{"nodeID":"manual"}'`,
  danach wieder `…annotate ds kured weave.works/kured-node-lock-`.
- Die `helm upgrade`-Aufrufe der Phasen **ohne `--atomic`**: ein
  automatisches Zurückrollen des Umschaltens müsste den Service `timescale`
  wieder headless machen, was Kubernetes verweigert – das Release bliebe
  halb zurückgerollt. Zurück geht es über `$S rollback`.

```bash
export NAMESPACE=udp KUBECONFIG=~/.kube/<cluster>.yaml
S=scripts/migrate-timescale-cnpg.sh

# 0. Neues Chart, altes StatefulSet bedient weiter, CNPG-Cluster startet leer daneben
helm upgrade udp <chart> -n udp -f values-prod.yaml --set timescale.migration.phase=prepare
$S wait

# 1. Optional: Probelauf ohne Stillstand (misst die Dauer), danach leeren
$S rehearse && $S reset

# 2. Ausfall beginnt: Clients auf 0, alte DB schreibgeschützt, Kopie, Zeilenvergleich
$S copy

# 3. Umschalten: "timescale" zeigt auf den CNPG-Primary, Clients wieder hoch
$S cutover
helm upgrade udp <chart> -n udp -f values-prod.yaml --set timescale.migration.phase=cutover
$S resume          # Ausfall endet

# 4. Nach ein paar Tagen Regelbetrieb: altes StatefulSet entfernen
helm upgrade udp <chart> -n udp -f values-prod.yaml      # phase ""
kubectl -n udp delete pvc data-timescale-0              # erst wenn sicher
```

Zurück: nach einer gescheiterten Kopie `$S unfreeze` (alte DB wieder
beschreibbar, Clients hoch) und ggf. `$S reset`. Nach dem Umschalten
`$S rollback`, dann `helm upgrade … --set timescale.migration.phase=prepare`
und `$S resume` – **Schreibvorgänge im neuen Cluster seit dem Umschalten gehen
dabei verloren.** Das Chart prüft jede Phase gegen den Cluster: `cutover`
nur nach vollständiger Kopie (Annotation am Cluster), Phase `""` erst, wenn
`timescale` nicht mehr auf das alte StatefulSet zeigt.

Was sich ändert: gleiche Datenbanken, Rollen und Passwörter (MD5, wegen
Orion-LD), gleicher Hostname `timescale`, Sortierung `en_US.UTF-8` wie bisher;
PostGIS 3.5 → 3.6, TimescaleDB 2.26 → aktuelle 2.x (Apache-Edition, keine
Hypertables im Einsatz – das Skript bricht sonst ab), Datenprüfsummen an.

### 10b. Hochverfügbarkeit: Verteilung und MongoDB-Replica-Set

Damit der öffentliche Pfad (Cockpit → APISIX → Orion-LD/Mintaka → Datenbanken)
Knoten-Neustarts (z. B. kured, ein Knoten nach dem anderen) übersteht, braucht
es zweierlei: Replikate auf **verschiedenen** Knoten und eine MongoDB ohne
Single Point of Failure. Beides ist per Default aus, damit
Ein-Knoten-Installationen weiter funktionieren.

Zwei Varianten, je nach Zahl der Knoten für Daten:

```yaml
# a) drei Daten-Knoten: drei Datenmitglieder (PSS)
global: { spread: { mode: required } }
mongo:
  replicas: 3
  replicaSet: { enabled: true, name: rs0 }
```

```yaml
# b) zwei Daten-Knoten + ein dritter Knoten für den Arbiter (PSA),
#    z. B. ein Control-Plane-Knoten mit Taint
global: { spread: { mode: required } }
mongo:
  replicas: 2
  replicaSet:
    enabled: true
    name: rs0
    arbiter:
      enabled: true
      nodeSelector: { node-role.kubernetes.io/control-plane: "true" }
      tolerations: [{ key: CriticalAddonsOnly, operator: Exists, effect: NoExecute }]
      # empfohlen: nur Zonen ohne Datenknoten (s. „Arbiter“ unten)
      # affinity:
      #   nodeAffinity:
      #     requiredDuringSchedulingIgnoredDuringExecution:
      #       nodeSelectorTerms:
      #         - matchExpressions:
      #             - { key: topology.kubernetes.io/zone, operator: In, values: [<zone-c>] }
```

Ein Primary braucht die Mehrheit der Stimmen; das Chart verlangt deshalb eine
ungerade Zahl von mindestens drei Stimmen (`replicas: 3` oder `replicas: 2` mit
Arbiter) und bricht sonst ab. Beide Varianten überstehen den Ausfall **eines**
Knotens.

#### Verteilung und Rollouts

`global.spread.mode` (pro Komponente `<komponente>.spread.mode`): `preferred`
(Default) weicht nur aus, wenn Platz ist – nach einem Drain können alle
Replikate auf einem Knoten landen, der nächste Drain trifft dann alle.
`required` erzwingt verschiedene Knoten; es braucht mindestens so viele Knoten
wie Replikate. Ein explizites `<komponente>.affinity` ersetzt die Regel ganz.

Mit `required` rollen Deployments mit mehr als einem Replikat **ohne Surge**
aus (`maxSurge: 0`, `maxUnavailable: 1`): Bei genau so vielen Knoten wie
Replikaten fände ein zusätzlicher Pod keinen Platz, der Rollout hinge
dauerhaft (im Test nachgestellt). Stattdessen wird ein Replikat nach dem
anderen ersetzt; der Dienst läuft währenddessen mit einem Replikat weniger.
Wer freie Knoten hat, holt den Surge pro Komponente zurück:
`<komponente>.rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }`.

Bei einem Drain wartet das verdrängte Replikat (`Pending`), bis sein Knoten
zurück ist; die PDBs (`minAvailable: 1`) lassen den Drain zu.

#### MongoDB-Replica-Set

Datenmitglieder `mongo-0..n` (StatefulSet `mongo`), optional ein Arbiter
`mongo-arbiter-0` (eigenes StatefulSet ohne Volume). Fällt der Primary weg,
wählen die übrigen binnen Sekunden einen neuen. Orion-LD, IoT-Agent und
Index-Job bekommen automatisch einen Verbindungsstring mit allen
**Datenmitgliedern**; der Arbiter steht nicht darin (er liefert keine Daten,
die Treiber erfahren von ihm über das Set und überwachen ihn nur – die
NetworkPolicy lässt das zu).

- **Sidecar `replset`** je Datenmitglied (`files/mongo/replset.js`): initiiert
  das Set, nimmt Mitglieder und Arbiter auf, entfernt überzählige. `mongo-0`
  initiiert nur, wenn **jedes** andere Datenmitglied antwortet und keinem Set
  angehört – ein `mongo-0` mit leerem Volume legt so nie ein zweites Set an.
  Den Arbiter nimmt es erst auf, wenn alle Datenmitglieder PRIMARY/SECONDARY
  sind und ihren Initial Sync beendet haben (sonst wären die Stimmen während
  des Syncs nur `mongo-0` + Arbiter).
- **Readiness** eines Datenmitglieds: bereit nur als PRIMARY oder als SECONDARY
  mit höchstens `replicaSet.reconciler.maxLagSeconds` (30 s) Rückstand. Ein
  zurückkehrendes Mitglied ist während STARTUP2/RECOVERING, beim Warten auf
  seine Konfiguration und beim Aufholen **nicht** bereit (im Test nach einem
  Drain: „410 s Rückstand – nicht bereit“, bereit erst nach dem Aufholen).
  Ohne sichtbaren Primary ist auch ein Secondary nicht bereit. Folge: ohne
  Mehrheit bleibt ein StatefulSet-Rollout stehen (er ersetzt keinen nicht
  bereiten Pod) – dann den betroffenen Pod von Hand löschen.
- **PDB `mongo`** (`maxUnavailable: 1`) umfasst **alle Stimmen** –
  Datenmitglieder und Arbiter. Solange eine davon fehlt oder nicht bereit ist,
  blockiert es jeden weiteren Drain (im Test: Arbiter weg → Drain eines
  Datenknotens verweigert). Getrennte Budgets ließen genau das zu: zwei von drei
  Stimmen weg, kein Primary. Kann der Arbiter dauerhaft nirgends laufen,
  blockiert das PDB die Drains der Datenknoten – gewollt, ein weiterer Ausfall
  hieße Stillstand.
- **Arbiter:** eigene Werte (`replicaSet.arbiter.image`, `nodeSelector`,
  `tolerations`, `affinity`, `priorityClassName`, `resources`) und fest eine
  harte Anti-Affinität gegen die Datenmitglieder – je Knoten **und je Zone**
  (`topology.kubernetes.io/zone`): ein Standortausfall darf nie Arbiter und
  Datenmitglied zugleich treffen. Knoten ohne Zonen-Label fallen nicht unter die
  Zonenregel (der Scheduler wertet ein fehlendes Label als „kein Konflikt“),
  dort gilt nur die Knotenregel. Die Regel wirkt in beide Richtungen: Landet der
  Arbiter in einer Zone, während deren Datenmitglied gerade weg ist, kann dieses
  nicht zurück (Volume zonengebunden) – daher den Arbiter per
  `arbiter.affinity.nodeAffinity` fest auf die Zone(n) **ohne** Datenknoten
  legen. `emptyDir` statt Volume, Root-Dateisystem schreibgeschützt: nach einem
  Neustart (auch auf einem anderen Knoten) holt er sich die Konfiguration vom
  Primary; bereit erst im Zustand ARBITER (Probe mit der schlanken
  `mongo`-Shell des Images).
- **Image-Wechsel:** `replicaSet.arbiter.image` ist bewusst getrennt von
  `mongo.image`. StatefulSet-Rollouts beachten keine PDBs – ein gemeinsamer
  Wechsel startete Arbiter und erstes Datenmitglied gleichzeitig neu (zwei von
  drei Stimmen weg). Erst `mongo.image` ändern und den Rollout abwarten, dann
  in einem eigenen Upgrade `arbiter.image`. Das gilt ebenso für andere
  Änderungen, die beide Pod-Vorlagen betreffen (z. B. `mongo.podSecurityContext`).
- **Journaling** immer an (vorher `--nojournal`). Wie bisher ohne
  Authentifizierung – erreichbar nur für die freigegebenen Clients und die
  Mitglieder untereinander (NetworkPolicies `allow-mongo`,
  `allow-mongo-arbiter`), daher auch kein Keyfile.

**Besonderheiten mit Arbiter (PSA, MongoDB 5.0):**

- **Write Concern:** Ein Arbiter ändert den impliziten Default von `majority`
  auf `1`; MongoDB verweigert diese Änderung, solange kein clusterweiter
  Default gesetzt ist (geprüft: „Reconfig attempted to install a config that
  would change the implicit default write concern“). Das Sidecar setzt deshalb
  vor dem Aufnehmen des Arbiters `setDefaultRWConcern {w: 1}` – nur wenn noch
  keiner gesetzt ist. Folge: Schreiben läuft weiter, wenn ein Datenmitglied
  fehlt (`majority` käme dann nie zustande, der Arbiter bestätigt keine
  Schreibvorgänge). Preis: Stürzt der Primary ab, bevor ein Schreibvorgang
  repliziert ist, wird dieser beim Failover zurückgerollt. Ein geordneter Drain
  ist unkritisch (der Primary tritt beim Beenden zurück und lässt den Secondary
  aufholen); Konnektoren schreiben ohnehin im nächsten Lauf erneut.
- **Commit-Punkt:** Fehlt ein Datenmitglied, steht der „majority“-Commit-Punkt
  still (`enableMajorityReadConcern` ist in 5.0 immer an). Der Primary hält bis
  zur Rückkehr Historie in Cache und auf Platte. Für einen Neustart unkritisch;
  fehlt ein Mitglied **Stunden**, es vorübergehend stimmlos machen und nach der
  Rückkehr zurückstellen:
  `cfg = rs.conf(); cfg.members[<i>].votes = 0; cfg.members[<i>].priority = 0; rs.reconfig(cfg)`.
- **Flow Control** würde in dieser Lage jeden Schreibvorgang auf das Minimum
  drosseln (gemessen: 5000 Inserts 2,5 s → 24,5 s), ohne Nutzen – es gibt
  keinen Secondary, der aufholen könnte. Mit Arbiter daher abgeschaltet
  (`replicaSet.arbiter.disableFlowControl`).

**Bekannte Grenze – Orion-LD beim Failover:** Orion-LD 1.6.0 bricht beim
Rücktritt des Primary mit einer unbehandelten Ausnahme seines alten
C++-Treibers ab (`nextSafe(): not master and slaveOk=false`, Exit 139) und
startet neu. Im Test (Drain des Primary-Knotens) war Orion-LD dadurch ~10 s
nicht erreichbar; lesend überbrückt der Cockpit-Cache bereits gecachte
Anfragen. Mit Orion-LDs `-mongocOnly` (experimentell, ohne alten Treiber) trat
der Absturz im selben Test nicht auf – nur Schreibvorgänge scheiterten ~7 s
während der Wahl –, der Schalter ist aber nicht für den vollen Funktionsumfang
(u. a. Registrierungen) freigegeben und daher nicht Teil des Charts.

#### Umstellung einer bestehenden Installation

Standalone mit Daten in `data-mongo-0`: ein einziges `helm upgrade` mit den
Werten oben – StatefulSet, Service und Volume-Vorlage bleiben dieselben, nichts
muss gelöscht werden.

- `mongo.persistence.size` darf dabei **nicht** geändert werden (die
  Volume-Vorlage eines StatefulSets ist unveränderlich, das Upgrade bräche ab).
- Ablauf: die neuen Datenmitglieder und der Arbiter starten leer, danach
  startet `mongo-0` einmal neu – mit seinen Daten, jetzt als Mitglied –, das
  Sidecar initiiert das Set mit `mongo-0` als erstem Primary und nimmt die
  übrigen auf; neue Datenmitglieder kopieren die Daten (Initial Sync).
- **Ausfall:** der Neustart von `mongo-0` bis zur Initiierung, im Test ~15 s.
  Orion-LD und IoT-Agent rollen wegen des neuen Verbindungsstrings neu aus; die
  alten Pods können bis dahin Fehler liefern (lesend puffert der Cockpit-Cache).
  Schreibende Konnektoren holen das im nächsten Lauf nach.
- **Als eigenes Upgrade mit `--wait`, nicht mit `--atomic`.** Helm wartet,
  bis alle Datenmitglieder den Initial Sync beendet haben (`--timeout` bei
  großen Beständen erhöhen). Ein automatisches Zurückrollen nach einem Timeout
  setzte `mongo-0` wieder standalone, während `data-mongo-1…` die Kopie aus dem
  Set behalten – beim nächsten Versuch könnten diese veralteten Kopien mit
  einem frischen Arbiter die Mehrheit bilden und Primary werden.
- Vorher sichern (Snapshot von `data-mongo-0` oder `mongodump`).

```bash
helm upgrade udp <chart> -n udp -f values-prod.yaml --wait --timeout 30m
kubectl -n udp logs mongo-0 -c replset        # "initiated …", "added …", "in sync"
kubectl -n udp exec mongo-0 -c mongo -- mongosh --quiet --eval \
  'rs.status().members.map(m => m.name + " " + m.stateStr)'
```

**Zurück zum Standalone** (bewusst oder per `helm rollback`): vorher
sicherstellen, dass `mongo-0` Primary ist (sonst `rs.stepDown()` auf dem
Primary), dann `mongo.replicaSet.enabled: false`, `mongo.replicas: 1`. Ohne die
übrigen Stimmen verliert `mongo-0` seine Mehrheit, ist nicht mehr bereit und
der StatefulSet-Rollout bleibt stehen: `kubectl -n udp delete pod mongo-0`,
danach läuft es mit seinen Daten als Einzelinstanz weiter.

**Vor dem erneuten Einschalten** `kubectl -n udp delete pvc data-mongo-1 …`
(alle außer `data-mongo-0`): diese Volumes kennen die Schreibvorgänge der
Standalone-Zeit nicht (sie stehen in keinem Oplog). Das Chart verweigert das
Einschalten, solange das laufende StatefulSet standalone ist und solche Volumes
existieren; startet ein solches Mitglied trotzdem, hält das Sidecar es
eingefroren und nicht bereit („STALE“ im Log). Beides im Test nachgestellt;
nach dem Löschen lief die Umstellung sauber durch, inklusive der
Standalone-Schreibvorgänge.

**Verkleinern:** überzählige Mitglieder entfernt das Sidecar, solange die
verbleibenden eine Mehrheit bilden. Auf ein einzelnes Mitglied fehlt diese
Mehrheit: vorher auf dem Primary austragen, erst dann die Werte ändern:

```bash
kubectl -n udp exec mongo-0 -c mongo -- mongosh --quiet --eval '
  rs.remove("mongo-arbiter-0.mongo-arbiter.udp.svc.cluster.local:27017");
  rs.remove("mongo-1.mongo.udp.svc.cluster.local:27017")'
```

Geht das Volume von `mongo-0` verloren, während die anderen laufen, wird es vom
Set neu befüllt. Sind dagegen **alle** Mitglieder gleichzeitig weg und
`mongo-0` startet mit leerem Volume, legt es ein neues, leeres Set an – dann
aus dem Backup bzw. den Volumes der anderen Mitglieder wiederherstellen.

---

## 11. Deinstallation

```bash
helm -n udp --kube-context "$KUBE_CONTEXT" uninstall udp
```
Bleibt erhalten (bewusst, gegen Datenverlust):
- Secrets `udp-db` / `udp-keycloak` / `udp-ckan` / `udp-geoserver` (`resource-policy: keep`)
- StatefulSet-PVCs von mongo/solr/geoserver (von Helm nicht verwaltet)
- der CNPG-Cluster `timescale` samt ImageCatalog und seinen PVCs `timescale-1`,
  `timescale-2` (`resource-policy: keep`; die Instanzen laufen weiter; ein erneutes `helm install` desselben Releases
  übernimmt ihn wieder, Daten bleiben erhalten. Entfernen:
  `kubectl -n udp delete cluster timescale` – **löscht die Daten**)
- PVC `db-backup-data` mit den letzten Dumps (`resource-policy: keep`)

Wird mit entfernt: PVC `ckan-data` – vorher sichern. Node-RED hat kein PVC
(Beispielfluss aus der ConfigMap), es geht dort also nichts verloren.
Vollständig aufräumen:
```bash
kubectl -n udp delete cluster timescale
kubectl -n udp delete pvc --all
kubectl -n udp delete secret udp-db udp-keycloak udp-ckan udp-geoserver
kubectl delete namespace udp
```

Das Monitoring hat ein eigenes Release und wird separat entfernt
(`helm -n udp-monitoring uninstall uptime-kuma`); sein PVC trägt
`resource-policy: keep`, damit die Verfügbarkeitshistorie erhalten bleibt.

> **Beim Upgrade von einem Chart-Stand, der Uptime Kuma noch enthielt**: Das
> nächste `helm upgrade` entfernt Deployment, Service **und das PVC
> `kuma-data`**. Vorher aus Helms Zugriff nehmen:
> `kubectl -n udp annotate pvc kuma-data helm.sh/resource-policy=keep`
> — Details in [`monitoring/README.md`](../../monitoring/README.md).

---

## 12. Härtung für den Produktivbetrieb (Checkliste)

- [x] **Keine Passwörter in Git** – interne Zugangsdaten (DB, Keycloak-Admin)
      werden automatisch als starke Zufallspasswörter erzeugt (Weg A). Externe
      Verwaltung (Weg B) nur bei Compliance-Vorgabe oder GitOps nötig.
- [ ] **Image-Digests** pinnen (`repo:tag@sha256:…`) statt beweglicher Tags.
- [ ] **Eigene/gespiegelte Registry** nutzen (`global.imageRegistry`).
- [ ] **MQTT absichern:** `mosquitto.conf` derzeit `allow_anonymous true`.
      Für Produktion Passwort-Datei/TLS aktivieren und IoT-Agent-Credentials
      hinterlegen (siehe `docs/betrieb.md`).
- [ ] **APISIX-Routen mit OIDC** (Keycloak) schützen – die Standalone-Config
      enthält CORS `*` und offene Routen; pro Route `openid-connect`-Plugin.
- [ ] **CORS einschränken:** `global_rules` `allow_origins: "*"` → echte Origins.
- [ ] **strictEgress** erproben und aktivieren (`networkPolicies.strictEgress`).
      Internetzugang behalten dann nur `networkPolicies.internetEgress.components`
      (Default: Konnektordienst, Orion-LD, IoT-Agent, CKAN; Node-RED nur, wenn
      eigene Flüsse externe Quellen abrufen).
- [ ] **Monitoring:** `networkPolicies.monitoringNamespaceLabel` setzen – öffnet
      die HTTP-Dienste und APISIX-Metrics `:9091` für diesen Namespace.
- [ ] **Backups** für mongo/timescale-Volumes einrichten (Velero/Snapshots).
- [ ] **Ressourcen/HPA** nach Last justieren; PDBs sind für die replizierten
      Dienste gesetzt (nur bei `replicas > 1`).
- [x] **Probes:** jeder Dienst hat Readiness- und Liveness-Probe, langsam
      startende zusätzlich eine Startup-Probe. Timings pro Komponente unter
      `<komponente>.probes` anpassbar, `null` schaltet eine Probe ab.
- [ ] **readOnlyRootFilesystem** je Dienst testen und wo möglich aktivieren.

---

## 13. Troubleshooting

| Symptom | Ursache / Lösung |
|---------|------------------|
| Pods `CrashLoopBackOff` mit „runAsNonRoot“ | Image braucht andere UID → in Values `podSecurityContext.runAsNonRoot: false` oder passende `runAsUser` setzen. |
| DB-Pods `Pending` | Keine (passende) StorageClass → `global.storageClass` setzen, `kubectl get pvc -n udp`. |
| Dienste erreichen DB nicht | NetworkPolicy zu streng oder CNI setzt nicht durch → `kubectl describe netpol`, CNI prüfen. |
| Release hängt, ein StatefulSet-Pod bleibt `0/1` (z. B. nach falscher Probe) | StatefulSets ersetzen einen nicht bereiten Pod nicht – auch nicht beim Rollback. Pod von Hand löschen (`kubectl -n udp delete pod <name>-0`), dann startet er mit der aktuellen Revision. |
| Neuer Dienst/Aufrufer bekommt Timeouts | Jede Komponente ist nur für ihre bekannten Aufrufer offen → Zeile in `templates/networkpolicy.yaml` ergänzen oder `networkPolicies.extraFrom.<app>` setzen. |
| Orion-LD antwortet nicht mehr, Log „New connection socket descriptor (1024) is not less than FD_SETSIZE“ | Leerlaufende Keep-Alive-Verbindungen haben die 1024 Dateideskriptoren von `select()` aufgebraucht. `orionLd.reqTimeout`/`maxConnections` verhindern das; die Liveness-Probe startet den Pod sonst nach rund einer Minute neu. `ulimit` hilft nicht. |
| Dashboard langsam, MongoDB am CPU-Limit | Index fehlt. Der Job `mongo-indexes` läuft nach jedem Install/Upgrade und wird bei Erfolg gelöscht (kein `kubectl logs job/…` mehr). Prüfen: `kubectl -n udp exec sts/mongo -- mongosh --quiet orion --eval 'db.entities.getIndexes().map(i => i.name)'` – `udp_type_ags` muss dabei sein. Indizes: `mongo.indexes`. |
| API antwortet mit HTTP 429 | Rate-Limit je Client auf `/ngsi-ld` und `/temporal` greift. Anpassen über `apisix.rateLimit.rate` / `.burst` (Default 30/s, 150). |
| Viele/alle Besucher bekommen HTTP 429 | Die Client-IP kommt nicht an: Load Balancer/Ingress liefern ihre eigene Adresse (z. B. `externalTrafficPolicy: Cluster` ohne Proxy-Protocol) – dann teilen sich alle Besucher einen Topf. Client-IP durchreichen (Proxy-Protocol bzw. `externalTrafficPolicy: Local`), vertrauenswürdige Proxy-Netze über `cockpit.trustedProxies` eingrenzen. Bei `ingress.apiPaths` geht der Ingress direkt an APISIX und muss `X-Real-IP` selbst setzen (ingress-nginx und Traefik tun das). |
| Kein externer Zugriff | Ingress-Controller-Namespace-Label stimmt nicht (`networkPolicies.ingressControllerNamespaceLabel`) oder DNS/TLS fehlt. |
| Keycloak startet nicht | DB `keycloak` nicht angelegt → Postgres-Init-Logs prüfen (`kubectl logs sts/timescale`). |
| `timescale` `CrashLoopBackOff`, Log „extension timescaledb is not available“ | Falsches Image. `timescale.image` muss `ghcr.io/idk-ev/udp/postgres-timescale-oss` sein, nicht `postgis/postgis`. |
| `/gateway/…` → 502, `/ngsi-ld/…` läuft | `cockpit.gatewayUpstream` ist kein FQDN (siehe Abschnitt 9). |
| Login leitet auf `localhost` statt auf die Plattform | Cockpit läuft mit der Compose-Konfiguration aus dem Image. `kubectl -n udp get cm cockpit-config -o jsonpath='{.data.config\.js}'` prüfen und ob der Pod sie unter `/usr/share/nginx/html/config.js` gemountet hat; `ingress.host` bzw. `cockpit.publicUrl` müssen den öffentlichen Hostnamen nennen. |
| Keycloak: „Invalid parameter: redirect_uri“ | Die Redirect-URIs des Clients `udp-cockpit` passen nicht zum Host. Der Realm-Import setzt sie beim **ersten** Start aus `ingress.host`; bei einer bestehenden Keycloak-DB in der Admin-Konsole nachziehen (Clients → udp-cockpit → Valid redirect URIs) oder den Realm löschen und Keycloak neu starten. Zusätzliche URIs: `keycloakApp.extraRedirectUris`. |
| CKAN `CrashLoopBackOff` | DB `ckan`/`ckan_datastore` oder Benutzer `ckan_ro` fehlt → Postgres-Init lief nicht durch; Solr/Valkey erreichbar? (`kubectl logs deploy/ckan`). |
| `helm upgrade` erzeugt neues Passwort | Nur wenn Secret zwischenzeitlich gelöscht wurde; `resource-policy: keep` verhindert das normalerweise. |
