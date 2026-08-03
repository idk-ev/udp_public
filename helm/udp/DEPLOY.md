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
| Persistenz      | MongoDB (StatefulSet), PostGIS/Timescale (StatefulSet)   |
| Context Broker  | Orion-LD (NGSI-LD), Mintaka (Temporal API)               |
| IoT             | Mosquitto (MQTT), IoT-Agent-JSON, FROST (SensorThings)   |
| API & Identität | APISIX (Gateway), Keycloak (OIDC)                        |
| Open Data       | CKAN (DCAT-AP.de) + Solr + Valkey *(`ckan.enabled`)*     |
| Geo             | GeoServer *(`geoserver.enabled`)*, Masterportal *(aus)*  |
| Anwendungen     | Node-RED, Cockpit                                        |
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
| `/abfahrten`, `/warnungen.ics` | Cockpit-nginx → Node-RED (exakte Pfade) | offen |
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

Prüfen:
```bash
kubectl version --short
helm version
kubectl get ingressclass
kubectl get storageclass
# NetworkPolicy-Durchsetzung? (z. B. Calico)
kubectl get pods -n kube-system | grep -Ei 'calico|cilium'
```

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
per NetworkPolicy nur für `orion-ld`, `mintaka`, `frost` und `keycloak`
geöffnet. Es gibt daher keinen Grund, es manuell zu vergeben.

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
`udp-db` und `udp-keycloak` mit starken Zufallspasswörtern an, **idempotent**
(vorhandene Secrets werden nicht überschrieben, kein versehentliches Rotieren).
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
kubectl -n udp create secret generic udp-db \
  --from-literal=POSTGRES_USER=udp \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)"
kubectl -n udp create secret generic udp-keycloak \
  --from-literal=KEYCLOAK_ADMIN=admin \
  --from-literal=KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 24)"
```
… oder – noch besser – per **Sealed Secrets** (Secrets verschlüsselt in Git):
```bash
kubectl -n udp create secret generic udp-db \
  --from-literal=POSTGRES_USER=udp \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --dry-run=client -o yaml | kubeseal --format yaml > sealed-udp-db.yaml
kubectl apply -f sealed-udp-db.yaml
```
… oder per **External Secrets Operator** / **Vault** (Referenz auf externen
Secret-Store).

</details>

In allen Fällen müssen die Schlüsselnamen exakt so heißen:
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`.

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

> `values-prod.yaml` gehört **nicht** mit echten Secrets in Git. Passwörter über
> Weg B (Abschnitt 4), nicht in dieser Datei.

---

## 6. Eigene Images

Vier der Images gibt es nicht als Upstream-Image. Gebaut und gepusht werden sie
von der GitHub Action **`.github/workflows/build-images.yml`** nach
`ghcr.io/idk-ev/udp/…`:

| Value | Image | Inhalt |
|-------|-------|--------|
| `cockpit.image` | `cockpit` | Eigenentwicklung: SPA + nginx-Konfiguration |
| `ckan.image` | `ckan-dcat` | CKAN 2.10 + `ckanext-dcat` (DCAT-AP.de) |
| `timescale.image` | `postgres-timescale-oss` | PostGIS **und** TimescaleDB Apache Edition |
| `nodeRed.image` | `node-red-udp` | Node-RED + generierte Datenflüsse, gehärtete `settings.js`, `pg` |

> Node-RED bekommt seine Flows aus dem Image, nicht aus einer ConfigMap oder
> einem Volume: `flows.json` ist ein generiertes Artefakt
> (`scripts/generate-nodered-flows.py`), liegt bei ~420 KB und wächst mit jedem
> Konnektor – die etcd-Grenze für ConfigMaps liegt bei 1 MiB. Deshalb hat
> Node-RED auch **kein PVC**: `/data` kommt aus dem Image, ein Volume darüber
> würde die Flows verdecken. Ein Neustart verwirft damit die Signatur-Historie
> der Änderungserkennung – der erste Zyklus danach schreibt einmalig alle
> Entitäten neu. Flow-Änderungen brauchen einen neuen Image-Build, kein
> `helm upgrade` mit neuer ConfigMap.

> Das Datenbank-Image ist Pflicht, kein Komfort: `files/postgres/01-databases.sql`
> legt `CREATE EXTENSION timescaledb` an – mit einem reinen `postgis/postgis`
> bricht der DB-Init ab und der Pod kommt nie hoch.

| Anlass | Tag |
|---|---|
| Push auf `main` | `main`, `sha-<commit>` |
| GitHub-Release `v1.0.0` | `1.0.0`, `1.0`, `latest` |
| Pull Request #42 | `pr-42` (wandert mit jedem Push), `pr-42-<sha>` (fest) |
| PR aus einem Fork | wird nur gebaut, **nicht** gepusht (read-only Token) |

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
> unter GitHub → Packages → \<image\> → Manage versions aufräumen.

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

---

## 11. Deinstallation

```bash
helm -n udp --kube-context "$KUBE_CONTEXT" uninstall udp
```
Bleibt erhalten (bewusst, gegen Datenverlust):
- Secrets `udp-db` / `udp-keycloak` / `udp-ckan` / `udp-geoserver` (`resource-policy: keep`)
- StatefulSet-PVCs von mongo/timescale/solr/geoserver (von Helm nicht verwaltet)
- PVC `db-backup-data` mit den letzten Dumps (`resource-policy: keep`)

Wird mit entfernt: PVC `ckan-data` – vorher sichern. Node-RED hat kein PVC
(Flows kommen aus dem Image), es geht dort also nichts verloren.
Vollständig aufräumen:
```bash
kubectl -n udp delete pvc --all
kubectl -n udp delete secret udp-db udp-keycloak udp-ckan udp-geoserver
kubectl delete namespace udp
```

Das Monitoring hat ein eigenes Release und wird separat entfernt
(`helm -n udp-monitoring uninstall uptime-kuma`); sein PVC trägt
`resource-policy: keep`, damit die Verfügbarkeitshistorie erhalten bleibt.

> **Beim Upgrade von einem Chart-Stand ≤ 1.0.0**: Uptime Kuma war früher Teil
> dieses Charts. Das nächste `helm upgrade` entfernt Deployment, Service **und
> das PVC `kuma-data`**. Vorher aus Helms Zugriff nehmen:
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
- [ ] **strictEgress** erproben und aktivieren (`networkPolicies.strictEgress`),
      wenn kein Pod ungewollten Außenverkehr braucht.
- [ ] **Monitoring:** Zugriff auf APISIX-Metrics `:9091` per NetworkPolicy für
      euren Prometheus-Namespace ergänzen.
- [ ] **Backups** für mongo/timescale-Volumes einrichten (Velero/Snapshots).
- [ ] **Ressourcen/HPA** nach Last justieren; PDBs sind bereits gesetzt.
- [ ] **readOnlyRootFilesystem** je Dienst testen und wo möglich aktivieren.

---

## 13. Troubleshooting

| Symptom | Ursache / Lösung |
|---------|------------------|
| Pods `CrashLoopBackOff` mit „runAsNonRoot“ | Image braucht andere UID → in Values `podSecurityContext.runAsNonRoot: false` oder passende `runAsUser` setzen. |
| DB-Pods `Pending` | Keine (passende) StorageClass → `global.storageClass` setzen, `kubectl get pvc -n udp`. |
| Dienste erreichen DB nicht | NetworkPolicy zu streng oder CNI setzt nicht durch → `kubectl describe netpol`, CNI prüfen. |
| Kein externer Zugriff | Ingress-Controller-Namespace-Label stimmt nicht (`networkPolicies.ingressControllerNamespaceLabel`) oder DNS/TLS fehlt. |
| Keycloak startet nicht | DB `keycloak` nicht angelegt → Postgres-Init-Logs prüfen (`kubectl logs sts/timescale`). |
| `timescale` `CrashLoopBackOff`, Log „extension timescaledb is not available“ | Falsches Image. `timescale.image` muss `ghcr.io/idk-ev/udp/postgres-timescale-oss` sein, nicht `postgis/postgis`. |
| `/gateway/…` → 502, `/ngsi-ld/…` läuft | `cockpit.gatewayUpstream` ist kein FQDN (siehe Abschnitt 9). |
| Login leitet auf `localhost` statt auf die Plattform | Cockpit läuft mit der Compose-Konfiguration aus dem Image. `kubectl -n udp get cm cockpit-config -o jsonpath='{.data.config\.js}'` prüfen und ob der Pod sie unter `/usr/share/nginx/html/config.js` gemountet hat; `ingress.host` bzw. `cockpit.publicUrl` müssen den öffentlichen Hostnamen nennen. |
| Keycloak: „Invalid parameter: redirect_uri“ | Die Redirect-URIs des Clients `udp-cockpit` passen nicht zum Host. Der Realm-Import setzt sie beim **ersten** Start aus `ingress.host`; bei einer bestehenden Keycloak-DB in der Admin-Konsole nachziehen (Clients → udp-cockpit → Valid redirect URIs) oder den Realm löschen und Keycloak neu starten. Zusätzliche URIs: `keycloakApp.extraRedirectUris`. |
| CKAN `CrashLoopBackOff` | DB `ckan`/`ckan_datastore` oder Benutzer `ckan_ro` fehlt → Postgres-Init lief nicht durch; Solr/Valkey erreichbar? (`kubectl logs deploy/ckan`). |
| `helm upgrade` erzeugt neues Passwort | Nur wenn Secret zwischenzeitlich gelöscht wurde; `resource-policy: keep` verhindert das normalerweise. |
