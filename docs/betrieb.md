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

## Datensicherung & Disaster Recovery

- **Täglich** automatisierte Dumps aller PostgreSQL-Datenbanken
  (Compose-Referenz: Dienst `backup`; Kubernetes: CronJob) mit Aufbewahrung
  14 Tage / 8 Wochen / 3 Monate (die TRoE-Historie ist append-only und steckt
  in jedem Voll-Dump erneut — längere Monats-Staffeln wären fast nur
  redundantes Volumen).
- **Kontinuierlich**: WAL-Archivierung (PITR) für PostgreSQL; Volume-
  Snapshots für MongoDB und Node-RED; Kopie in zweite Brandzone/Region
  (3-2-1-Regel). Das Monitoring sichert sein `/app/data` (SQLite mit der
  Verfügbarkeitshistorie) im eigenen Deployment mit – s. `monitoring/`.
- **Konfiguration**: vollständig im Git (GitOps) – Wiederaufbau des Clusters
  aus Repository + Backups.
- **DR-Übung**: halbjährliche Wiederherstellungsprobe mit Protokoll;
  Ziele RTO ≤ 4 h, RPO ≤ 24 h (Dumps) bzw. ≤ 15 min (PITR).

## Updates & Wartung

- Monatliches Patch-Fenster (Minor-/Security-Updates), quartalsweise
  Komponenten-Upgrades; Security-Advisories der Projekte werden laufend
  ausgewertet (CVE-Feed).
- Staging-Verprobung → Rolling Update in Produktion → automatischer Rollback
  bei fehlschlagender Readiness.
- Plausibilitätsprüfungen: Node-RED-Validierungsflüsse und ML-basierte
  Anomalieerkennung der Fachanwendungen können als Module ergänzt werden;
  Basis-Plausibilisierung (Schema-Validierung NGSI-LD) erfolgt im Broker.

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
   Node-RED-Ingestion-Flows: Freitextfelder externer Quellen mit
   `s.replace(/'/g, '’')` sanitisieren (siehe `clean()`-Helfer in
   `platform/config/nodered/flows.json`). Umlaute sind unkritisch.
2. **Compound-Werte über ~2 KB** (JSON-serialisiert) werden verworfen
   (16 Objekte ≈ 1,9 KB ok, 20 ≈ 2,4 KB nicht). Gegenmaßnahme: Arrays
   kappen und lange Strings kürzen (Beispiel ÖPNV-Flow: max. 10
   Abfahrten, Ziel auf 40 Zeichen).

Diagnose bei Verdacht: `SELECT count(*) FROM attributes WHERE entityid =
'<id>';` in der Datenbank `orion` — 0 Zeilen trotz vorhandener Entität im
Broker deutet auf einen der beiden Fälle.

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

## Konnektoren und Node-RED-Neustarts

Inject-Nodes feuern standardmäßig beim Start (`once`), damit ein frisch
aufgesetzter Stack sofort Daten hat. Für **seltene Quellen mit
Anbieter-Limits** ist das schädlich — mehrere Neustarts hintereinander laufen
in HTTP 429/504 (so geschehen 21.07. bei Overpass und Open-Meteo). Solche
Konnektoren tragen in der Registry `"refireOnRestart": false` (aktuell
`rathaus-bw`, `ausflug-bw`, `wetter-bw`, `vorhersage-bw`) und laufen
ausschließlich nach Zeitplan. Open-Meteo kam am 21.07. durch mehrere
Neustarts hintereinander auf HTTP 429 — je Lauf gehen acht Batch-Abfragen
heraus.

Erstbefüllung oder Nachziehen nach Änderungen:

    bash scripts/trigger-connector.sh ausflug-bw

Das Skript löst die Inject-Node über die Node-RED-Admin-API aus (ohne
Neustart, ohne Deploy).

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
   (`options=update` lässt den Broker-Rest unangetastet).
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
   (`{"ParkingSite": 25000, …}`) hinterlegen. Der Flow-Generator summiert die
   Budgets aller Konnektoren und übergibt sie an die TRoE-Statistik
   (`troe-stats`, alle 10 Minuten); wer sein Tagesvolumen überschreitet,
   erscheint als Warnung im Node-RED-Log. Konnektoren ohne das Feld verhalten
   sich unverändert.
5. **Lautes Scheitern statt stiller Lücken.** Der ParkAPI-Abruf prüft, ob sich
   zwei Seiten überschneiden, und bricht den Lauf mit `node.error` ab, statt
   denselben Ausschnitt erneut zu schreiben; ein erreichter Seitendeckel
   erzeugt eine Warnung. Der Aufbauschritt vergleicht zusätzlich die Zahl der
   verschiedenen Entitäts-IDs mit der Zahl der Quelldatensätze und warnt bei
   unter 95 % — das ist die Signatur einer ID-Kollision.

**Retention ist aktiv** (Sprint 1.6): Der Registry-Konnektor
`troe-retention` löscht täglich 03:40 via Node-RED/pg aus `attributes` und
`subattributes` (die kleine `entities`-Tabelle bleibt für Mintaka-Metadaten)
und pflegt idempotente Indizes (`ts` sowie `(entityid, ts)` mit
`text_pattern_ops` — Letzterer trägt die Mintaka-Temporalabfragen je Entität
und die LIKE-Staffeln der Retention). `drop_chunks` ist bewusst NICHT im
Einsatz — TRoE nutzt einfache Tabellen, keine Hypertables.

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
  daher als veraltete Doppelgänger auf den Parken-Karten. Einmalig entfernen:

  ```sh
  # IDs im Alt-Schema sammeln (Orion-LD kann »nicht parkapi-« nicht filtern)
  curl -s 'http://orion-ld:1026/ngsi-ld/v1/entities?type=ParkingSite&limit=1000&attrs=ags' \
    | jq -r '.[].id' | grep -v ':parkapi-' > alt-ids.txt
  # in Stapeln zu 100 löschen (entityOperations/delete nimmt ein ID-Array)
  split -l 100 alt-ids.txt stapel- && for f in stapel-*; do
    jq -Rn '[inputs]' < "$f" | curl -s -X POST \
      'http://orion-ld:1026/ngsi-ld/v1/entityOperations/delete' \
      -H 'Content-Type: application/json' --data-binary @- ; done
  ```

  Ein Wiederauftreten ist ausgeschlossen: Der Konnektor bildet IDs nur noch aus
  dem ParkAPI-Schlüssel, und `tests/static/flow-invarianten.test.js` verbietet
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
