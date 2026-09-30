# Betriebskonzept (LB B.II.5)

## Hosting-Anforderungen

- **Managed Kubernetes** bei einem Anbieter mit **ISO-27001-zertifiziertem
  Rechenzentrum** in Deutschland/EU; der Zertifikatsnachweis des Betreibers
  ist dem Angebot beizufügen.
- Betreiber-ISMS orientiert am **BSI-IT-Grundschutz**; Auftragsverarbeitung
  nach Art. 28 DSGVO.
- Empfohlene Zonen-Trennung: Produktions- und Staging-Cluster; getrennte
  Namespaces je Umgebung.

## Verfügbarkeit (SLA ≥ 99,5 % monatlich)

| Maßnahme | Wirkung |
|---|---|
| ≥ 2 Replikate zustandsloser Kerne (Broker, Gateway, GUI) mit Anti-Affinity | kein Single Point of Failure auf Knotenebene |
| PodDisruptionBudgets | Verfügbarkeit bei Wartung/Node-Drain |
| DB-Operatoren (CloudNativePG/Patroni, MongoDB ReplicaSet) | automatisches Failover der Datenhaltung |
| Rolling Updates + Readiness-Probes | unterbrechungsfreie Releases |
| Uptime Kuma: HTTP-Monitore auf alle externen Endpunkte, 60-s-Intervall | Störungserkennung < 2 min |

**Nachweis**: Uptime Kuma erzeugt je Monitor Verfügbarkeitsstatistiken
(30/365 Tage). Monatlicher Verfügbarkeitsbericht (PDF/Statusseite) an die
Auftraggeber; Grenzwert-Alarm bei Unterschreitung von 99,5 % im laufenden
Monat.

Uptime Kuma wird als **eigenständiges Deployment** betrieben – getrennt vom
Plattform-Stack, idealerweise auf anderem Host bzw. in anderem Cluster/
Namespace. Ein Monitoring im selben Lebenszyklus und Fehlerbereich wie das
Überwachte rollt mit ihm aus und fällt mit ihm aus; es meldet den Ausfall dann
genau nicht. Compose und Helm: [`monitoring/`](../monitoring/README.md).

## Monitoring, Alarmierung, Incident Management

1. **Erkennen**: Uptime Kuma (Außensicht, eigenes Deployment) +
   Prometheus-Metriken von APISIX und Kubernetes (Innensicht).
2. **Alarmieren**: Uptime-Kuma-Notifications (E-Mail, Webhook, MS Teams,
   Signal u. a.) an die Rufbereitschaft; Webhook-Integration in das
   Service-Desk-/Ticketsystem des Betreibers (z. B. Zammad/OTOBO – Ticket je
   Störung, automatische Eskalation).
3. **Beheben**: Priorisierung P1–P4; P1 (Plattform nicht erreichbar):
   Reaktion ≤ 1 h, Statuskommunikation über öffentliche Statusseite.
4. **Nachbereiten**: Post-Mortem im Repository (`docs/incidents/`),
   Maßnahmen-Tracking.

### Lasttest Dashboard

`tests/load/municipality-page.js` (k6): Jeder virtuelle Nutzer lädt
zufällige Gemeindeseiten mit ~25 parallelen API-Anfragen wie
`gui/public/stadt.html`.

```bash
docker run --rm -e VUS=10 -e BASE=https://<host> \
  -v "$PWD/tests/load:/s" -v "$PWD/gui/public/bw-gemeinden.json:/g/bw-gemeinden.json:ro" \
  grafana/k6 run -q /s/municipality-page.js
```

- **Ziel:** 20 VUs, Seiten-p95 < 3 s, < 1 % Fehler.
- **Vorsicht:** erzeugt echte Last auf der Zielinstanz – nur bewusst und
  außerhalb der Hauptnutzungszeit, nicht in CI. Bricht bei mehr als 30 %
  Fehlern selbst ab.
- **Rate-Limit:** Alle VUs teilen sich die IP des Testrechners, das
  Client-Limit (`apisix.rateLimit`) greift also mit. Für Kapazitätstests
  darüber hinaus das Limit vorübergehend anheben.

## Datensicherung & Disaster Recovery

- **Kubernetes – kontinuierlich**: WAL-Archivierung und tägliche
  Basissicherung aller PostgreSQL-Datenbanken in S3-kompatiblen
  Objektspeicher (CloudNativePG, Barman-Cloud-Plugin); Wiederherstellung auf
  jeden Zeitpunkt der letzten 30 Tage, einzeln je Datenbank oder als ganzer
  Cluster (`scripts/restore-timescale.sh`, `helm/udp/DEPLOY.md` §10c).
  Bucket bei einem anderen Anbieter/Standort als der Cluster (3-2-1-Regel).
- **Compose**: täglich Dumps aller PostgreSQL-Datenbanken (Dienst `backup`)
  mit Aufbewahrung 14 Tage / 8 Wochen / 3 Monate.
- **Volume-Snapshots** für MongoDB und das CKAN-Dateiverzeichnis
  (`ckan-data`) – nicht Teil des S3-Backups. Das Monitoring sichert sein
  `/app/data` (SQLite mit der Verfügbarkeitshistorie) im eigenen Deployment
  mit – s. `monitoring/`.
- **Konfiguration**: vollständig im Git (GitOps) – Wiederaufbau des Clusters
  aus Repository + Backups.
- **DR-Übung**: halbjährliche Wiederherstellungsprobe mit Protokoll;
  Ziele RTO ≤ 4 h, RPO ≤ 5 min (WAL-Archiv, Kubernetes) bzw. ≤ 24 h
  (Dumps, Compose).

## Updates & Wartung

- Monatliches Patch-Fenster (Minor-/Security-Updates), quartalsweise
  Komponenten-Upgrades; Security-Advisories der Projekte werden laufend
  ausgewertet (CVE-Feed).
- Staging-Verprobung → Rolling Update in Produktion → automatischer Rollback
  bei fehlschlagender Readiness.
- Plausibilitätsprüfungen: Validierungsflüsse (Node-RED) und ML-basierte
  Anomalieerkennung der Fachanwendungen können als Module ergänzt werden;
  Basis-Plausibilisierung (Schema-Validierung NGSI-LD) erfolgt im Broker.

**Ein Deploy allein macht die Dashboards nicht neu.** Die Seiten registrieren
einen Service-Worker (`gui/public/sw.js`, PWA/Offline-Kiosk). Seiten und
`/gateway`-Abfragen laufen netz-zuerst und sind sofort aktuell; die statische
Shell (`smartcity-lib.js`, `smartcity-theme.css`, `dashboards.json`,
`connectors-status.json`, Leaflet) kommt aus dem Cache und wird seit Sprint 2.9
im Hintergrund aufgefrischt — sichtbar wird eine Änderung dort also erst beim
**zweiten** Aufruf nach dem Deploy. Die Cacheversion `V` in `sw.js` ist an die
Chart-Version gekoppelt (`tests/static/sw-cache.test.js` prüft das): Ein
Release verwirft damit den Cache seines Vorgängers vollständig. Bis Sprint 2.9
stand dort ein handgepflegtes `"udp-v2"`, das nie erhöht wurde und
wiederkehrende Browser dauerhaft auf den Dateien ihres ersten Besuchs
festhielt. Bei Verdacht auf einen hängenden Client: harter Reload, ersatzweise
DevTools → Application → Service Workers → Unregister.

## Härtung (Auszug)

- TLS überall (Ingress, cert-manager), HSTS; interne Netzsegmentierung über
  NetworkPolicies.
- Mosquitto in Produktion: Authentifizierung + TLS, kein `allow_anonymous`.
- Keycloak: Brute-Force-Schutz aktiv, MFA für administrative Rollen.
- APISIX: OIDC-Pflicht auf allen schreibenden Routen, Rate-Limits, IP-Allow-
  Listen für Admin-Endpunkte.
- Secrets ausschließlich über Kubernetes-Secrets/External-Secrets, nie im
  Repository (Beispielwerte sind als solche markiert und zu ersetzen).

## Bekannte Einschränkungen Orion-LD TRoE (1.6.0)

Zwei Bugs lassen den TRoE-Insert einer Entität **stillschweigend**
scheitern — Orion-LD antwortet 201/204, MongoDB ist korrekt, aber in
TimescaleDB fehlen die Zeilen; es gibt keinen Log-Eintrag:

1. **Apostroph `'` in einem beliebigen String-Wert** (auch tief in
   Compound-Werten) bricht das SQL-Escaping. Gegenmaßnahme in allen
   Konnektoren: Freitextfelder externer Quellen laufen durch `clean()`
   (`platform/connectors/src/kernel/ngsi.ts`, ersetzt `'` durch `’`); eigene
   Node-RED-Flüsse müssen das selbst tun. Umlaute sind unkritisch.
2. **Compound-Werte über ~2 KB** (JSON-serialisiert) werden verworfen
   (16 Objekte ≈ 1,9 KB ok, 20 ≈ 2,4 KB nicht). Gegenmaßnahme: Arrays
   kappen und lange Strings kürzen (Beispiel ÖPNV-Flow: max. 10
   Abfahrten, Ziel auf 40 Zeichen).

Diagnose bei Verdacht: `SELECT count(*) FROM attributes WHERE entityid =
'<id>';` in der Datenbank `orion` — 0 Zeilen trotz vorhandener Entität im
Broker deutet auf einen der beiden Fälle.

### Neustartschleife MongoDB → Orion-LD (Kubernetes)

Orion-LD 1.6.0 beendet sich mit **SIGSEGV**, wenn MongoDB unter ihm
verschwindet — es fängt den Verbindungsabbruch nicht ab. Jeder Mongo-Neustart
reißt damit alle Broker-Replikate mit, und während des Wiederanlaufs schreibt
kein Konnektor. Das ist harmlos, solange MongoDB stabil läuft, und fatal, wenn
es das nicht tut.

Genau das trat auf dem Referenzcluster ein: Die Liveness-Probe rief
`mongosh --eval "db.adminCommand('ping').ok"` mit dem Kubernetes-Vorgabewert
`timeoutSeconds: 1` auf. `mongosh` ist ein Node-CLI und braucht allein zum
Starten rund eine Sekunde — die Probe scheiterte also an ihrer eigenen
Startzeit, nicht an der Datenbank. Bilanz bis 26.08.2026: 102 Neustarts von
`mongo-0`, 1622 von `orion-ld`, dazu eine **fünftägige Ingestion-Lücke
(19.–23.08.2026)** ohne eine einzige TRoE-Zeile. Der Fehler ist still: Beide
Pods stehen durchgehend auf `Running`, nur die Restart-Zähler wachsen.

Behoben in `helm/udp/templates/persistence.yaml` mit `timeoutSeconds: 10`.
Compose ist nicht betroffen — Dockers Vorgabewert für `healthcheck.timeout`
liegt bei 30 s. Zur Diagnose taugt der Restart-Zähler, nicht der Pod-Status:

```sh
kubectl -n udp get pods -o wide            # RESTARTS von mongo-0 / orion-ld
kubectl -n udp get events --sort-by=.lastTimestamp | grep -i unhealthy
# Ingestion-Lücken sichtbar machen:
psql -U udp -d orion -c \
  "SELECT ts::date, count(*) FROM attributes GROUP BY 1 ORDER BY 1;"
```

## Secrets

`platform/.env` ist verpflichtend: Seit 21.07. sind alle Passwörter in
`docker-compose.yml` als Pflichtangaben (`${VAR:?…}`) hinterlegt. Ein Start
ohne `.env` bricht mit einer klaren Meldung ab, statt still mit den früheren
Vorgabewerten hochzufahren — die standen als Fallback im versionierten
Compose-File und wären damit öffentlich dokumentierte Zugangsdaten gewesen.

## Deployment und Aktualisierung

`bash deploy/deploy.sh` ist der einzige Weg, den Stand eines Hosts zu
aktualisieren: Es zieht den Stand aus `idk-ev/UDP` über den SSH-Deploy-Key
(Host-Alias `github-udp`, Schlüssel `~/.ssh/id_ed25519_udp`), regeneriert die
abgeleiteten Artefakte, baut die GUI und startet den Stack über den
systemd-User-Service neu. Es bricht ab, wenn im Arbeitsverzeichnis
uncommittete Änderungen liegen — damit kann ein Deployment keine lokalen
Anpassungen überschreiben.

Der Deploy-Key ist ein **Repository-Deploy-Key**: Er authentifiziert nur den
Git-Transport über SSH. Für die GitHub-REST-API (z. B. Status der
Actions-Läufe) ist er wirkungslos — dafür braucht es ein Token.

Die systemd-Unit ist unter `deploy/systemd/udp-stack.service` versioniert und
wird beim Deployment mit dem tatsächlichen Pfad instanziiert; Änderungen daran
gehören ins Repo, nicht direkt nach `~/.config/systemd/user/`.

## Konnektoren und Neustarts

Der Konnektordienst startet jeden Konnektor kurz nach dem eigenen Start
(gestaffelt, Endpunkt-Konnektoren sofort), damit ein frisch aufgesetzter Stack
sofort Daten hat; danach zählt das Intervall ab diesem ersten Lauf. Für
**seltene Quellen mit Anbieter-Limits** ist ein Lauf bei jedem Neustart
schädlich — mehrere Neustarts hintereinander laufen in HTTP 429/504 (so
geschehen 21.07. bei Overpass und Open-Meteo). Solche Konnektoren tragen in
der Registry `"refireOnRestart": false` und laufen dann frühestens
**10 Minuten** nach dem Start — und ohne Zusatzlauf, wenn ihr letzter
abgeschlossener Lauf (im Zustandsspeicher, `kernel.lastRunMs`) jünger als ihr
Intervall ist: Der Startlauf wartet dann, bis das Intervall um ist; bei
Cron-Konnektoren (Intervall = 1 Tag) entfällt er. Ohne bekannten letzten Lauf
(Erststart, Datenbank nicht erreichbar) bleibt es bei den 10 Minuten.
Verzögert, nicht ausgelassen: Ein Konnektor, der öfter neu gestartet wird, als
sein Intervall lang ist, läuft trotzdem, sobald sein Intervall um ist.

`"intervalOffsetSeconds"` legt ein Intervall auf feste Uhrzeiten: Vielfache
des Intervalls ab 00:00 UTC plus Versatz, statt „Start + Intervall“. So
behalten `wetter-bw` und `vorhersage-bw` ihren Abstand über jeden Neustart
(s. [Open-Meteo-Kontingent](#open-meteo-kontingent)). Ein Slot, der seinen
Lauf schon hatte (bis 5 min Vorlauf zählen mit), bekommt nach einem Neustart
keinen zweiten; ein verpasster wird einmal nachgeholt, wenn danach noch
mindestens das halbe Intervall bis zum nächsten Slot bleibt (bei unbekanntem
letztem Lauf: höchstens eine Stunde). Ein durch Herunterfahren abgebrochener
Lauf gilt nicht als gelaufen.

Nächtliche Jobs, denen ihr Cron genügt, tragen dagegen `"fireOnStart": false`
und laufen beim Dienststart **gar nicht**: `troe-retention` (Indizes,
Löschläufe und `VACUUM` der TRoE-Tabellen) und `mastr-bw` (~1.500 Anfragen an
das Marktstammdatenregister je Lauf). Die Registry lehnt das Feld bei einem
Eintrag ohne Intervall oder Cron ab.

Erstbefüllung oder Nachziehen nach Änderungen:

    bash scripts/trigger-connector.sh ausflug-bw

Das Skript löst den Konnektor im Konnektordienst aus, ohne Neustart
(s. unten).

### Open-Meteo-Kontingent

`wetter-bw` und `vorhersage-bw` holen je Lauf alle 1.103 Gemeinden in
8 Batches (7 × 138, 1 × 137 Koordinaten). Die freie Stufe von Open-Meteo
erlaubt 600 Aufrufe je Minute, 5.000 je Stunde und 10.000 je Tag und zählt
**jede Koordinate** als Aufruf; mehr als 10 Variablen oder 14 Tage kosten
anteilig mehr. Wetter (7 Variablen, 1 Tag) und Vorhersage (10 Variablen,
4 Tage) bleiben bei Gewicht 1 — ein Test hält das fest.

| | Wetter | Vorhersage |
|---|---|---|
| Slots (UTC) | 00:10, 06:10, 12:10, 18:10 | 03:10, 09:10, 15:10, 21:10 |
| Aufrufe je Lauf | 1.103 | 1.103 |

- **Minute:** Batches starten im Abstand von 20 s aus einem gemeinsamen
  Token-Bucket beider Konnektoren; in jedes geschlossene 60-s-Fenster passen
  höchstens 4 Starts, also 4 × 138 = 552 (Batches sind auf 150 Koordinaten
  begrenzt, 4 × 150 = 600). Auch wenn beide zugleich laufen (manueller
  Auslöser), bleibt es dabei.
- **Stunde:** ein Lauf, 1.103 — die Läufe liegen 3 h auseinander. Weiche
  Grenze 4.500 je gleitender Stunde (nur im Speicher).
- **Tag:** 8 Läufe × 1.103 = **8.824** je UTC-Tag. Ein Neustart ändert daran
  nichts (kein Zusatzlauf, s. oben); ein verpasster Slot wird nur ersetzt.
  Weiche Grenze **9.000** (`UDP_OPEN_METEO_DAILY_CAP`, Helm
  `connectors.openMeteoDailyCap`), gezählt je Host im
  Zustandsspeicher, Tageswechsel 00:00 UTC (Open-Meteo nennt keine Uhrzeit;
  UTC ist angenommen, die Reserve bis 10.000 deckt Abweichungen). Ein Batch,
  der die Grenze überschreiten würde, wird nicht gesendet, ebenso der Rest
  des Laufs. **Aktuelles Wetter hat Vorrang:** Die Vorhersage hält die heute
  noch fälligen Wetterläufe frei — ein aktueller Wert ist nach Stunden
  falsch, eine Vorhersage vom Vorlauf noch weitgehend richtig. Ein
  zusätzlicher manueller Lauf (+1.103) kostet deshalb am selben Tag in der
  Regel den letzten Vorhersagelauf, nie einen Wetterlauf.
- **HTTP 429:** `Retry-After` (Sekunden oder HTTP-Datum, sonst 60 s) pausiert
  den gemeinsamen Bucket; der Batch wird danach **einmal** wiederholt. Ein
  zweites 429 im Lauf oder eine Pause über 5 min beendet den Lauf; folgende
  Läufe überspringen, solange die Pause gilt.

Nicht geholte Batches stehen mit Nummer und Gemeindezahl im Log
(`batch 3/8 (138 municipalities) failed …`, `batches 5, 6 of 8 skipped …`);
diese Gemeinden behalten ihre bisherigen Werte. Die Stadtseite zeigt Wetter
und Vorhersage nach 13 h (zwei ausgefallene Läufe plus Reserve) mit
„Stand: …“ und neutralem Status.

## Konnektordienst

`platform/connectors` (TypeScript) ist die Ingestion der Plattform: Er führt
jeden aktiven Eintrag der Registry `platform/config/connectors.json` aus, für
den ein Modul existiert, und beantwortet `/abfahrten` und `/warnungen.ics` für
das Cockpit. Node-RED läuft daneben nur noch als Low-Code-Baustein mit einem
Beispielfluss (s. unten; Geschichte der Ablösung:
[`migration-konnektoren.md`](migration-konnektoren.md)).

| | Compose | Kubernetes (Helm) |
|---|---|---|
| Dienst | Container `udp-connectors`, Image aus `platform/connectors/Dockerfile` | Deployment `connectors`, Image `udp-connectors` (`connectors.image`) |
| Registry | `platform/config/connectors.json`, read-only eingebunden | im Image |
| Port 1880 | nicht veröffentlicht, im Compose-Netz für alle Container erreichbar | Service `connectors:1880`, NetworkPolicy nur vom Cockpit |
| Port 1881 | nur `127.0.0.1` im Container | in keinem Service, keine NetworkPolicy-Regel |

- **Ports:** 1880 trägt nur die Endpunkte `/abfahrten` und `/warnungen.ics`,
  die die Cockpit-nginx weiterreicht (`UDP_CONNECTORS_UPSTREAM`, Helm
  `cockpit.connectorsUpstream`, Vorgabe der Dienst `connectors`). Der
  Admin-Port 1881 (`/healthz`, `/trigger/<id>`, `/release-prunes/<id>`)
  wird nie veröffentlicht und von keinem Proxy weitergereicht: Ein Trigger
  lässt den Dienst eine Quelle abrufen und nach Orion schreiben, eine
  Freigabe gibt blockierte Löschungen frei. `/trigger` und
  `/release-prunes` antworten zusätzlich nur auf Loopback, werden also im
  Container ausgelöst. Kein Sidecar (Service-Mesh-Proxy o. Ä.) darf den
  Port abfangen — aus dessen Sicht käme jede Anfrage von Loopback. Prüfen
  die Probes per `exec` statt per HTTP, den Port mit
  `UDP_CONNECTORS_ADMIN_HOST=127.0.0.1` nur an Loopback binden.
- **Zustand:** Änderungssignaturen, Prune-Buchführung und persistierter
  Konnektorzustand liegen in der TimescaleDB, Datenbank `orion`, Schema
  `udp_connectors` (Zugang über `TROE_DB_*`, dieselben Zugangsdaten wie
  Orion-LD). Das Schema legt der Dienst beim Start selbst an; der
  Datenbanknutzer braucht dafür `CREATE` auf der Datenbank, sonst das Schema
  vorab anlegen und `CREATE` auf dem Schema gewähren (auch für später
  hinzukommende Tabellen wie `writer`; fehlt es, meldet der Dienst ein
  `[error]` und übernimmt den Lock nicht). Ein Volume braucht der Dienst
  nicht (Root-Dateisystem read-only).
- **Genau eine Instanz:** Ein Advisory-Lock macht die laufende Instanz zum
  einzigen Schreiber. Helm fest mit `replicas: 1` und `strategy: Recreate`;
  eine zweite Instanz führte nur die ungegateten Konnektoren aus — doppelt.
  Jede Übernahme des Locks zählt eine Generation hoch (Tabelle
  `udp_connectors.writer`); daran erkennt der Dienst, ob zwischen zwei
  eigenen Lock-Phasen jemand anderes geschrieben hat. Jeder Schreibvorgang
  prüft sie: Hat eine andere Instanz übernommen, schreibt die alte nichts
  mehr, auch wenn ihre Lock-Verbindung noch lebendig aussieht; vor jedem
  gegateten Upsert prüft sie das ebenfalls.
- **Prune:** Löscht eigene Entitäten, die die Quelle nicht mehr liefert. Der
  30-%-Deckel gilt nur für kürzlich (unter 7 Tagen) Verschwundenes, gemessen
  am frischen Bestand; Älteres („Altbestand“) baut der Dienst in Portionen
  von höchstens 1.000 je Lauf ab, ältestes zuerst — erst nachdem der Prune
  eine Woche ohne Lücke gelaufen ist (nach einem Ausfall beginnt die Woche
  neu; sonst sähe nach langer Pause alles eine Woche alt aus) und nur
  solange der frische Bestand nicht unter 95 % seines Referenzwerts fällt
  (der folgt Wachstum sofort, Schrumpfen nur um 2 % je Lauf). „Verschwunden
  seit“ misst bei Prunes mit Karenzzeit der letzte Schreibzeitpunkt, bei
  Prunes über die vollständige Liste (Laden, Parken) die Dauer als Kandidat
  in Folge.

  **Blockierter Prune:** Überspringt der Deckel einen Prune, merkt sich der
  Dienst den Beginn der Sperre. Ab dem dritten Überspringen in Folge ist das
  ein `[error]`, `/healthz` nennt ihn unter `stateStore.blockedPrunes`. Was
  mit diesem Massenverlust verschwand (ab einem Tag vor der Sperre), löscht
  der Dienst nie von selbst — auch nicht, wenn es später zum Altbestand
  wird: Er hält es zurück (`heldBack`), meldet in jedem Lauf ein `[error]`
  und `scripts/healthcheck.sh` zeigt „PRUNE BLOCKED“. Bei Prunes über die
  vollständige Liste (Laden, Parken) betrifft das alles, was nach der Sperre
  verschwindet, auch gewöhnliche Abgänge. Kommen die Entitäten zurück
  (Quelle wieder vollständig), hebt sich die Sperre selbst auf. Ist der
  Verlust echt (etwa ein Anbieter hat den Feed verlassen), nach Prüfung der
  Quelle freigeben:

      bash scripts/release-prunes.sh <konnektor-id>

  (Kubernetes: mit `CONNECTORS_EXEC` wie beim Auslösen.) Solange der Prune
  noch über dem Deckel liegt, lehnt der Dienst ab (HTTP 409) — er würde
  sofort wieder sperren; freigeben, sobald der Verlust zum Altbestand
  geworden ist (7 Tage) und der Deckel wieder passt. Ab dem nächsten Lauf
  gelten die zurückgehaltenen Entitäten dann als normale Kandidaten.
  Älterer Bestand aus der Zeit vor der Sperre wird davon unabhängig
  abgebaut (bei Prunes mit Karenzzeit).
  Carsharing löscht zusätzlich Stationen, die zwei Läufe in Folge in der
  vollständigen Stationsliste ihres Systems fehlen (freischwebende
  „virtuelle Stationen“ erhalten je Parkvorgang eine neue Id).
- **Auslösen:** `bash scripts/trigger-connector.sh <id>`. Unter Compose läuft
  der Aufruf per `docker exec udp-connectors`, in Kubernetes mit
  `CONNECTORS_EXEC="kubectl -n <namespace> exec deploy/connectors --"`.
  Antworten: 202 gestartet, 429 Sperrfrist (60 s) oder Lauf aktiv, 404
  unbekannt, inaktiv oder ohne Modul.
- **Gesundheit:** `/healthz` (Admin-Port) meldet die eingeplanten Konnektoren,
  den Zustandsspeicher (`stateStore.healthy`, `reason`, `writer`) und den
  Geo-Kontext (`geo`: Gemeinden, Grenzen, `boundariesDegraded`, letzter
  Ladezeitpunkt und Fehler je Datei). Nicht gesund ist der Zustandsspeicher
  ohne Schreib-Lock, bei scheiterndem Laden oder Schreiben oder wenn ein
  Konnektor außerhalb eines laufenden Nachladens nicht geladen ist; `reason`
  nennt dann den Grund. Der Lock gilt erst als verloren, wenn die Datenbank
  das bestätigt (Verbindung weg oder nicht in `pg_locks`); eine langsame
  Prüfung zählt nicht. Nach einem echten Verlust (Datenbank-Switchover)
  bleibt der Zustand im Speicher und wird nachgeschrieben, sobald der Lock
  zurück ist. Hielt ihn zwischendurch eine andere Instanz, gleicht der
  Dienst jeden Konnektor mit der Datenbank ab — die Sekunden, in denen das
  läuft (`reloading`), zählen als gesund. `blockedPrunes` nennt Prunes, die
  ihr Anteilsdeckel überspringt oder die einen Verlust zurückhalten
  (`connector`, `prune`, `consecutiveSkips`, `blockedSince`, `heldBack`;
  Freigabe siehe Prune). Die Antwort bleibt 200, auch wenn die
  Datenbank klemmt — Liveness-Probe und Compose-Healthcheck prüfen nur, ob der
  Prozess lebt; ein Neustart repariert keine Datenbank.
  `scripts/healthcheck.sh` zeigt den Zustandsspeicher an und schlägt fehl,
  wenn er nicht gesund ist, `/healthz` nicht antwortet oder der Container
  fehlt.
- **Logs:** Zeilen `<Zeit> [warn] [udp-connectors:<konnektor>] …`;
  `scripts/healthcheck.sh` zählt `[error]`/`[warn]` der letzten 70 Minuten
  und nennt die häufigsten Warnquellen.
- **Aktualisieren:** Unter Compose baut `deploy/deploy.sh` das Image bei jedem
  Deployment neu; eine Takt- oder Aktivierungsänderung in der Registry braucht
  nur `docker compose restart connectors`. In Kubernetes kommt das Image
  samt Registry aus der Image-Pipeline, per Digest im Chart gepinnt.
- **Status-Export:** `scripts/export-connector-status.py` schreibt aus der
  Registry `gui/public/connectors-status.json` (Hauptdashboard, Stadtseiten,
  `healthcheck.sh`); `deploy/deploy.sh` ruft es auf, die CI prüft den Stand.

## Node-RED

Low-Code-Baustein (B.II.4) auf dem Upstream-Image `nodered/node-red` mit
einem vorkonfigurierten Beispielfluss (`platform/config/nodered/flows.json`:
NGSI-LD-Entität `WeatherObserved` → Upsert in Orion-LD alle 10 Minuten) und
`settings.js`. Der Beispielfluss ist **deaktiviert** ausgeliefert: Er schriebe
Zufallswerte (`urn:ngsi-ld:WeatherObserved:demo-station-1`) in den
produktiven Broker. Zum Ausprobieren im Editor die Flow-Eigenschaften öffnen,
aktivieren und deployen — danach wieder deaktivieren und die Demo-Entität
löschen.

Unter Compose sind beide Dateien aus dem Checkout eingebunden (Editor unter
`WORKFLOW_PORT`, Vorgabe 4900, nur auf `127.0.0.1` — `WORKFLOW_BIND`; ein
Deploy im Editor schreibt in den Checkout). Im Chart liefert die ConfigMap
`node-red-config` dieselben Dateien (`helm/udp/files/nodered/`, ein
statischer Test hält beide gleich); ein initContainer kopiert sie in ein
`emptyDir` — was im Editor deployt wird, überlebt also keinen Pod-Neustart.
Keine Ingress-Route und keine NetworkPolicy-Regel: Der Editor ist per
`kubectl port-forward` erreichbar.

**Den Editor nie ohne Anmeldung veröffentlichen.** Wer ihn erreicht, deployt
Flows mit beliebigem Code. `settings.js` liest die Anmeldung aus
`NODE_RED_ADMIN_USER` und `NODE_RED_ADMIN_PASSWORD_HASH` (bcrypt; Compose:
`.env`, Helm: `nodeRed.adminAuth`); beide leer = offen, nur eines gesetzt =
Node-RED startet nicht. Hash erzeugen:

    docker run --rm -it --entrypoint node-red nodered/node-red:4.1 admin hash-pw

(oder `npx node-red-admin hash-pw`). In `.env` den Hash in einfache
Anführungszeichen setzen, sonst ersetzt Compose seine `$`-Teile.

Node-RED bekommt keine Datenbank- und keine hystreet-Zugangsdaten und lädt
keine npm-Module für Function-Nodes nach (`functionExternalModules: false`).
Ins Internet darf es nur ohne Einschränkung, solange keine Egress-Policy
greift: Unter Compose und im Chart ohne `strictEgress` erreicht es jedes Ziel;
mit `strictEgress` nichts außerhalb des Namespace (für eigene Flüsse mit
externen Quellen `node-red` in `networkPolicies.internetEgress.components`
aufnehmen).

## Zeitreihen-Retention (TRoE)

Mit der BW-weiten Ingestion wuchs die TRoE-Tabelle `attributes` um ~416 k
Zeilen/Tag (20.07.2026). Der Stufe-3-Ausbau auf alle Kommunen (21.07.) hob
das gemessen auf **~1,2 Mio Zeilen/Tag**.

**Korrektur der Ursachenzuschreibung (24.08.2026):** An dieser Stelle stand
lange, Einzelstandorte seien der Treiber — Ladestationen, Carsharing-Stationen
und Bürgersensoren. Das war falsch. Die Messung am 24.08. hat den Löwenanteil
einem einzigen fehlerhaften Konnektor zugeordnet: `parken-bw` schrieb allein
**~1,04 Mio Zeilen/Tag**, rund die Hälfte der gesamten Zeitreihen-Datenbank,
und deckte dabei 1,6 % der Quelldaten ab. Drei Fehler lagen übereinander:

* Die Seitenaufteilung ging mit `&offset=` gegen die MobiData-BW-ParkAPI v3.
  Die API ignoriert den Parameter stillschweigend — alle 66 Anfragen je Lauf
  lieferten dieselben ersten 500 von 31.908 Datensätzen zurück, und jeder
  dieser Datensätze wurde 66× je Lauf geschrieben.
* Die Entitäts-IDs entstanden aus dem geslugten Anlagennamen. Gleich benannte
  Anlagen fielen zusammen: aus 500 sichtbaren Datensätzen wurden 336 Entitäten
  (42× »Hauptbahnhof Westseite«, 36× »List-Gymnasium« …).
* Je Lauf gingen alle sieben Attribute jeder Anlage neu heraus, obwohl nur
  1,6 % der Anlagen in BW überhaupt Echtzeitdaten führen und die übrigen sechs
  Attribute sich praktisch nie ändern.

Behoben (Sprint 2.9) durch Cursor-Pagination (`start=<next_id>` statt
`offset=`), stabile IDs aus dem ParkAPI-eigenen Primärschlüssel
(`urn:ngsi-ld:ParkingSite:parkapi-<id>`) und einen getrennten Schreibpfad für
Stamm- und Bewegungsdaten. Der Konnektor deckt seither statt 336 Entitäten
rund 24.900 Parkanlagen in Baden-Württemberg ab und schreibt im eingeschwungenen
Zustand grob **6.000 Zeilen/Tag**. Der erste Lauf nach dem Deploy legt einmalig
rund 226.000 Zeilen an — die Erstsichtung aller Anlagen — und löst dabei
erwartungsgemäß eine Budgetwarnung aus; ab dem zweiten Lauf ist Ruhe.

Die drei ursprünglichen Gegenmaßnahmen bleiben richtig und in Kraft — sie
zielten nur auf den kleineren Teil des Volumens:

1. **Nur Änderungen schreiben.** Ladestationen und Carsharing-Stationen
   werden gegen die letzte Statussignatur geprüft; eine Station, deren
   Belegung sich nicht geändert hat, erzeugt keinen Eintrag. Dasselbe Gate
   trägt die CityPulse-Aggregate (unveränderte Gemeinde-Pulse entfallen),
   und der ÖPNV-Abfahrtsmonitor dedupliziert je Attribut: Stammdaten wie
   `name`/`location`/`stopCode` gehen nur mit, wenn sie sich geändert haben
   (`options=update` lässt den Broker-Rest unangetastet). Eine Signatur gilt
   erst, wenn der Broker den Schreibvorgang bestätigt hat (2xx, bei 207 je
   Entität); scheitert oder hängt der Upsert, geht der Wert im nächsten Lauf
   erneut heraus. Vorher froren Werte bei Orion-Hängern wochenlang ein.
   Unveränderte Einzelstandorte mit Echtzeitwerten frischen nur `dateObserved`
   auf: Parkanlagen in jedem Lauf (~3.000 Zeilen/Tag, dazu ~800 für die
   Parken-Summen), Ladepunkte, Ladesummen und Carsharing-Stationen mit
   Livewerten reihum etwa alle 3 h. Reine Registereinträge ohne Echtzeitwert
   bekommen keinen Zeitstempel.

   **Stammdaten getrennt von Messwerten.** Ladepunkte, Ladesummen und
   Carsharing-Stationen führen wie die Parkanlagen zwei Signaturen: eine über
   die Stammdaten (Name, Adresse, Lage, Betreiber, Anzahl Ladepunkte bzw.
   Kapazität, AGS) und eine über die Messwerte (Livezähler bzw. verfügbare
   Fahrzeuge). Nur neue Standorte und geänderte Stammdaten gehen voll heraus;
   ändert sich nur ein Messwert, schreibt der Dienst die geänderten Attribute
   plus `dateObserved` (`options=update` ersetzt nur die gesendeten Attribute).
   Vorher schrieb jede Statusänderung eines Ladepunkts alle 12 Attribute.
   Einmal je Woche geht jede dieser Entitäten trotzdem voll heraus: Fehlt
   sie im Broker (gelöscht, Wiederherstellung), entstünde sonst aus den
   Teilschreibvorgängen ein Gerippe ohne Name und Lage.
2. **Takt an den Nutzen angepasst.** Der OCPDB-Abzug läuft stündlich statt
   halbstündlich, die Feinstaub-Einzelsensoren stündlich statt alle 15 min
   (die Gemeindemediane bleiben im 15-Minuten-Takt).
3. **Gestaffelte Aufbewahrung.** Aggregate je Gemeinde bleiben 12 Monate —
   auf ihnen beruhen die Verlaufsdiagramme. Einzelstandorte
   (`EVChargingStation`, `CarSharingStation`,
   `AirQualityObserved:bw-sensor-*`) werden nach 3 Monaten gelöscht; sie
   werden nirgends über Monate ausgewertet, die Dashboards zeigen ihren
   aktuellen Zustand auf der Karte. `ParkingSite` stand hier ebenfalls, solange
   der Konnektor ~1,04 Mio Zeilen/Tag schrieb, und ist seit Sprint 2.9 wieder
   heraus: Bei grob 6.000 Zeilen/Tag spart die Staffel nichts, löscht aber die
   einmalig geschriebenen Stammdaten einer Anlage, die nicht nachwachsen.

Damit sich ein solcher Fehler nicht wieder einen Monat lang verstecken kann,
sind seit Sprint 2.9 zwei Sicherungen eingezogen:

4. **Zeilenbudget je Entitätstyp.** Ein Konnektor kann in
   `platform/config/connectors.json` ein optionales `rowBudget24h`
   (`{"ParkingSite": 25000, …}`) hinterlegen. Der Konnektordienst summiert die
   Budgets aller Konnektoren je Typ und übergibt sie an die TRoE-Statistik
   (`troe-stats`, alle 10 Minuten); wer sein Tagesvolumen überschreitet,
   erscheint als Warnung im Log des Konnektordienstes. Konnektoren ohne das Feld verhalten
   sich unverändert. Budgets sind grob das Doppelte des geschätzten
   Regelbetriebs und fangen nur Ausreißer. Schätzung (stündliche Läufe,
   gemessene Änderungsraten):

   | Typ | Bestand mit Livewerten | Änderung/h | Zeilen/Tag | Budget |
   |---|---|---|---|---|
   | `EVChargingStation` | ~6.100 (+ ~6.400 nur Register) | 46 % | ~244.000 | 460.000 |
   | `ChargingSummary` | ~900 | 50 % | ~48.000 | 95.000 |
   | `CarSharingStation` | ~4.400 | 29 % | ~91.000 (+ neue Stationen) | 180.000 |

   Rechnung je Stunde: geänderte Standorte × (geänderte Messwerte +
   `dateObserved`) plus unveränderte × ⅓ Frische. Ladepunkt: 2.806 × 3 +
   3.294 ⁄ 3 ≈ 9.500 (bei einem Statuswechsel ändern sich meist zwei Zähler);
   Ladesumme: 450 × 4 + 450 ⁄ 3 ≈ 1.950 (drei Zähler, eine Summe fasst
   mehrere Standorte); Carsharing: 1.276 × 2 + 3.124 ⁄ 3 ≈ 3.600. Dazu
   kommt der wöchentliche Vollschrieb jeder Entität (heilt Entitäten, die
   hinter einer gespeicherten Signatur aus dem Broker verschwunden sind):
   je Entität einmal die Woche alle Attribute statt der sonst in diesem Lauf
   erwarteten Zeilen (Teilschrieb oder Frische, Ladepunkt mit Livewerten
   ≈ 1,6, Ladesumme ≈ 2,2, Carsharing ≈ 0,8). Ladepunkte 6.100 × 10,4 +
   6.400 × 7 ≈ 108.000 je Woche ≈ 15.500/Tag, Ladesummen 900 × 5,8 +
   200 × 3 ≈ 800/Tag, Carsharing 4.400 × 8,2 ≈ 5.200/Tag. Mit dem früheren Vollschrieb waren es ~834.000, ~97.000 und
   ~300.000 Zeilen/Tag.
   `CityPulse` 100.000 (bis 1.103 Gemeinden × 24 Läufe × Frische plus
   Änderungen).

   Leere Signaturtabellen (Neuinstallation, verlorener Zustand, Umstellung
   einer Tabelle) füllen Parken, Laden und Carsharing vor dem ersten Schreiben
   aus dem Broker: Der Dienst liest die Entitäten mit genau den Attributen,
   aus denen die Signatur besteht, und schreibt danach nur, was sich
   geändert hat. Scheitert oder bricht die Liste ab, bleibt es beim
   einmaligen Vollschrieb. Andere Konnektoren schreiben wenige hundert
   Entitäten und brauchen das nicht. Warnt ein Lauf, dass mehr als die Hälfte
   der Entitäten „geändert“ sei, obwohl Signaturen gespeichert waren
   (`change state lost?`), ist Zustand verloren gegangen.
5. **Lautes Scheitern statt stiller Lücken.** Der ParkAPI-Abruf prüft, ob sich
   zwei Seiten überschneiden, und bricht den Lauf mit einem Fehler ab, statt
   denselben Ausschnitt erneut zu schreiben; ein erreichter Seitendeckel
   erzeugt eine Warnung. Der Aufbauschritt vergleicht zusätzlich die Zahl der
   verschiedenen Entitäts-IDs mit der Zahl der Quelldatensätze und warnt bei
   unter 95 % — das ist die Signatur einer ID-Kollision.

**Retention ist aktiv** (Sprint 1.6): Der Registry-Konnektor
`troe-retention` löscht täglich 03:40 per SQL aus `attributes` und
`subattributes` (die kleine `entities`-Tabelle bleibt für Mintaka-Metadaten)
und pflegt idempotente Indizes (`ts` sowie `(entityid, ts)` mit
`text_pattern_ops` — Letzterer trägt die Mintaka-Temporalabfragen je Entität
und die LIKE-Staffeln der Retention). `drop_chunks` ist bewusst NICHT im
Einsatz — TRoE nutzt einfache Tabellen, keine Hypertables.

**Vacuum:** Die Retention setzt vorab (nur bei Abweichung) je Tabelle
`autovacuum_vacuum_insert_scale_factor` und `autovacuum_analyze_scale_factor`
auf 0,01 und fährt nach dem Lauf `VACUUM (ANALYZE)` auf `attributes` und
`subattributes` (eigene Sitzung, 45 min Timeout, gebremst wie Autovacuum mit
`vacuum_cost_delay = 2ms`, Fehler nur `[warn]`) — sonst bleibt die Tabelle
nach einem Switchover (Statistikzähler zurückgesetzt) unvacuumiert und
`troe-stats` läuft in seinen Timeout. `VACUUM` wirkt nur als Eigentümer der
Tabellen: Ist `TROE_DB_USER` es nicht, überspringt PostgreSQL sie mit einer
WARNING, die als `[warn]` im Log landet. Der erste Lauf auf einer großen, nie
gevakuumten Tabelle schreibt WAL in der Größenordnung der Tabelle.

**Orion-Schreibzugriffe werden nie aufgehalten:** Orion-LD schreibt rund um
die Uhr in `attributes`; eine Anweisung, die auf eine Sperre wartet, ließe
alle folgenden Inserts hinter sich warten. Deshalb laufen die Sitzungen der
Retention mit `lock_timeout` (5 s; `VACUUM` 60 s) — ein Schritt, der seine
Sperre nicht bekommt, wird mit einem `[warn]` übersprungen, der Rest der Nacht
läuft. `CREATE INDEX` geht nur noch für fehlende Indizes raus. Läuft noch eine
andere `udp-troe-retention*`-Sitzung oder ein nicht nachgebendes `VACUUM` auf
den beiden Tabellen, fällt die Nacht mit einem `[info]` aus. Beim
Dienststart läuft die Retention nicht (`"fireOnStart": false`).

**Alt-Schema-Reste von `parken-bw` (einmalig, ab Sprint 2.9):** Die Entitäten
aus der Zeit vor dem Fix tragen IDs aus geslugten Anlagennamen
(`urn:ngsi-ld:ParkingSite:karlsruhe-parkgarage-fasanengarten`) statt
`…:parkapi-<id>`. Sie wachsen nicht nach, werden aber auch nie wieder
geschrieben, und seit ParkingSite aus der 3-Monats-Staffel heraus ist, altern
sie nicht mehr von selbst weg. Zwei getrennte Aufräumschritte:

* **Zeitreihen** — die Retention räumt sie ab dem ersten Lauf nach dem Deploy
  selbst weg, höchstens 5 Mio Zeilen je Nacht (auf dem Referenzcluster
  23,8 Mio Zeilen, 47 % der Tabelle → rund fünf Nächte). Die betroffenen IDs
  holt sie aus der kleinen `entities`-Tabelle und löscht dann gezielt über
  `entityid = ANY(...)`; ein `NOT LIKE` direkt auf `attributes` wäre nicht
  indizierbar und würde die 22 GB jede Nacht erneut sequenziell lesen, auch
  im Leerlauf. Ein `DELETE` gibt den Platz nur zur Wiederverwendung frei; das
  ist gewollt — `VACUUM FULL` bräuchte fast so viel freien Platz wie die
  Tabelle groß ist (dort 22 GB bei 17 GB frei).
* **Broker** — die Entitäten selbst stehen in Orion-LD und werden von der
  Retention (nur `pg`) nicht angefasst. Sie tragen ein `ags` und erscheinen
  daher als veraltete Doppelgänger auf den Parken-Karten. Seit der
  Datenfrische-Überarbeitung räumt `parken-bw` sie selbst ab, höchstens einmal
  täglich und nur nach einem vollständigen Lauf: gelöscht werden nur IDs im
  Alt-Schema (Zeichen `[a-z0-9.-]`, beginnend mit einem bekannten
  Gemeinde-Slug, nicht `parkapi-`, Datenlieferant »MobiData BW ParkAPI«), die
  seit mindestens 7 Tagen unverändert sind. Kommunale Konnektoren mit
  Slug-Präfix-IDs bleiben dadurch unberührt, ebenso alles, was nach der
  Umstellung am 25.08.2026 angelegt wurde (`createdAt`). Der sonst übliche
  30-%-Deckel greift hier bewusst nicht – keine dieser
  Entitäten wird je wieder bestätigt. Die erste tägliche Prüfung merkt sich nur
  den Zeitpunkt, gelöscht wird ab der zweiten. Findet ein vollständiger Lauf
  keine Alt-Entität mehr, schaltet sich die Prüfung ab.

  Ein Wiederauftreten ist ausgeschlossen: Der Konnektor bildet IDs nur noch aus
  dem ParkAPI-Schlüssel, und `tests/static/connector-invariants.test.js` verbietet
  Entitäts-IDs aus geslugtem Freitext.

Zu beobachten: Der Plattenbedarf im eingeschwungenen Zustand wurde bei
~1,2 Mio Zeilen/Tag mit grob 100–150 GB veranschlagt (bei ~390 Byte je Zeile).
Ohne den `parken-bw`-Fehler fällt gut die Hälfte dieses Volumens weg; die Zahl
ist nach ein paar Wochen Regelbetrieb neu zu messen, statt sie hier
fortzuschreiben. Der Punkt gehört so oder so ins Kapazitätsmonitoring — bei
einem produktiven Betrieb mit mehreren Mandanten ist die Staffelung neu zu
bewerten.

(Voraussetzung: `attributes` als Hypertable partitioniert; im
Referenz-Setup von Orion-LD als normale Tabelle angelegt — dann stattdessen
periodisch `DELETE FROM attributes WHERE ts < now() - interval '12 months'`
+ `VACUUM`.)
