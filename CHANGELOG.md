# Changelog

Chronik der Veröffentlichungen (neueste zuerst). Details: `git log`.

## Unveröffentlicht — ÖPNV-Halte und Rathäuser

- `oepnv-halte.json` neu erzeugt: nur BW-Halte im eigenen Kreis (bis 5 km
  vom Gemeindemittelpunkt, Nachbarkreis nur ohne eigenen und bis 2 km),
  zentrale Halte im Hauptort bevorzugt, mit Koordinate. Keine Treffer mehr in AT/CH/FR oder anderen
  Bundesländern; Gemeinden ohne gültigen Halt fehlen.
- `rathaus-bw`: der Rathaus-Sitz statt Bezirksrathaus oder Ortsverwaltung
  (Relationen, `townhall:type`, Gemeindename, Nähe zum Gemeindemittelpunkt).
- `efa-abfahrten`: Halte ohne Echtzeit werden wieder geschrieben —
  `avgDelayMinutes: null` ließ Orion-LD die ganze Entität ablehnen (207,
  Neuversand alle 5 min); ohne Median wird das Attribut entfernt.
- Upsert-Warnungen nennen die abgelehnten Entitäten und den Fehler.
- Abfahrten nur vom angefragten Halt: Für eine unbekannte Halt-ID liefert
  EFA die Abfahrten eines erratenen Orts — jetzt „gestört“ statt falscher
  Tafel. „no matching departure“ (-4030) zeigt „Derzeit keine Abfahrten“.

## Unveröffentlicht — Kachelwerte

- Kachel „E-Scooter“ heißt „Sharing“: alle frei flottierenden Fahrzeuge, im
  Hinweis nach Art aufgeteilt (neues Attribut `vehiclesByFormFactor` aus GBFS
  `vehicle_types`, eine TRoE-Zeile mehr je SharingSummary und Lauf).
  Angedockte Räder und Autos stationsgebundener Anbieter zählen nicht mehr
  mit (Gemeindeseite: „Leihräder“ bzw. „Carsharing“); die vorherrschende
  Fahrzeugart bestimmen beide GBFS-Konnektoren gleich.
- „Familie & Versorgung“ und „Ausflugsziele“ zeigen die Gesamtzahl statt der
  gekappten Liste; jedes OSM-Objekt zählt einmal.
- Hitze: nur ab „gering“ (heute oder morgen), Farbe nach heute,
  Vertreterstadt mit Entfernung im Hinweis (ab 50 km „regional“). `hitze-bw`
  schreibt den Vorhersagetag (`forecastDay`) und die Ausgabezeit als
  `dateObserved` und läuft um 07:40/11:40 nach der DWD-Aktualisierung; eine
  Datei vom Vortag gilt mit ihrem „morgen“ als heute.
- Pollenflug auch für den Landkreis Konstanz (Teilregion 112); Hauptwert ist
  die Stufe, die Art steht im Hinweis.
- Parken zeigt freie Plätze, solange die Echtzeit aktuell ist (Gemeinde und
  Kreis); ÖPNV die nächste noch anstehende Abfahrt; Warnungen den
  Kreisnamen; Luftfeuchte und Radverkehr Entfernung bzw. Zähltag.
- `/abfahrten`: Abfahrtszeiten in deutscher Ortszeit statt UTC.
- Leere „Noch nicht verfügbar“-Kacheln stehen hinter allen Datenkacheln.
- `.gitattributes`: `*.template` mit LF (nginx-Test auf Windows-Checkouts).

## Unveröffentlicht — Fehler sichtbar statt stiller Lücken

- Dashboards: fehlgeschlagene Abfragen (5xx, Netzfehler, 429) werden einmal
  wiederholt (`Retry-After` beachtet; nicht bei 504 und Zeitüberschreitung,
  15 s je Versuch) und von „keine Daten“ unterschieden.
  Kacheln, die die Kommune sonst hat, zeigen dann „Daten derzeit nicht
  abrufbar“; bei mehreren Fehlern erscheint ein Hinweis oben.
- `/abfahrten`: EFA-Antwort ohne Abfahrten für den angefragten Halt ist 200
  mit leerer Liste statt 502 (unbekannte Halte und andere EFA-Fehler bleiben
  502); die Stadtseite zeigt „Derzeit keine Abfahrten“ bzw.
  „Fahrplanauskunft derzeit gestört“.
- Cockpit-nginx: leere Antworten der Kontext-API nur noch 10 s im Cache
  (Loopback-Hop, s. `docs/betrieb.md`); `worker_connections` 4096.
- Stadtseite fragt `WasteContainer` nur ab, wo ein Konnektor `fuellstand`
  liefert oder `dashboards.json` es für die Kommune freischaltet
  (`"fuellstand": true`).

## Unveröffentlicht — Wetter: Open-Meteo-Kontingent

- Wetter und Vorhersage laufen auf festen Slots (Registry
  `intervalOffsetSeconds`): Wetter 00:10/06:10/12:10/18:10 UTC, Vorhersage
  3 h später. 8.824 Aufrufe je Tag, auch mit Neustarts.
- Neustarts: Konnektoren mit `refireOnRestart: false` laufen nicht erneut,
  wenn ihr letzter Lauf (persistiert) jünger als ihr Intervall ist.
- Tageszähler je Host im Zustandsspeicher (UTC-Tag), weiche Grenze 9.000
  (`UDP_OPEN_METEO_DAILY_CAP`); die Vorhersage lässt den heute noch fälligen
  Wetterläufen Vorrang.
- Höchstens 600 Koordinaten je Minute: Batches ≤ 150, 20 s Abstand.
- HTTP 429: `Retry-After` pausiert den gemeinsamen Bucket, danach genau eine
  Wiederholung; ein zweites 429 beendet den Lauf. Fehlende Batches werden mit
  Nummer und Gemeindezahl gemeldet, alte Werte bleiben.
- Tageslimit (429 mit „Daily …“): keine Wiederholung, Pause bis 00:00 UTC,
  der Rest des Tages wird ohne Aufruf übersprungen.
- Tageswerte (Max/Min/UV) kommen wieder mit jedem Wetterlauf.
- Stadtseite: Wetter, Wind und UV zeigen nach 13 h „Stand: …“; Taktangaben
  korrigiert.
- `sharing-bw` meldet jeden Lauf mit einer Info-Zeile.

## Unveröffentlicht — TRoE als Hypertable

> **Upgrade:**
>
> - Bestehende Installationen behalten `attributes` als gewöhnliche Tabelle
>   (WARNING des initContainers `troe-schema` bei jedem Start von `orion-ld`).
>   Umstellung mit `scripts/migrate-troe-hypertable.sh`, vorher ggf. das
>   Datenbank-Volume vergrößern oder die Low-Disk-Variante nutzen –
>   DEPLOY.md §10d.
> - Die neuen PostgreSQL-Parameter (`shared_buffers` u. a.) und die höhere
>   Speicheranforderung (2Gi) starten die Datenbank-Instanzen einmal neu
>   (Switchover); die Knoten brauchen den Speicher tatsächlich.
> - Wer `timescale.resources.requests.memory` überschreibt, muss ihn
>   mindestens so groß wie `shared_buffers` setzen (oder `shared_buffers`
>   mit überschreiben) – sonst lehnt CloudNativePG das Upgrade ab.

- **TRoE-Schema:** `helm/udp/files/postgres/troe-schema.sql` legt das Schema
  von Orion-LD vor dem Broker an – Helm als initContainer, Compose als Dienst
  `troe-schema`. `attributes` ist eine Hypertable (7-Tage-Chunks) ohne
  Primärschlüssel, neu `entities_id_ts_idx` (bestehende Installationen
  bekommen ihn beim Umschalten).
- **Migration:** `scripts/migrate-troe-hypertable.sh` kopiert die Historie
  tageweise im laufenden Betrieb, verwirft unveränderte Wiederholungen,
  tauscht die Tabellen in kurzer Auszeit; Rückweg bis `finalize`.
  Low-Disk-Variante (`export`, `swap-lowdisk`, `import`), wenn alte und neue
  Tabelle nicht nebeneinander passen: Historie über lokale Dateien, kurze
  Auszeit, Import neueste Tage zuerst.
- **Retention:** 12-Monats-Staffel per `drop_chunks` auf der Hypertable,
  3-Monats-Staffel je Präfix, Typsummen ohne `count(DISTINCT)`.
  `troe-stats` schätzt die Zeilen mit `approximate_row_count`.
- **Helm:** Vorgaben für `timescale.parameters`, bemessen auf die
  Vorgabe-Ressourcen; Speicheranforderung der Datenbank 2Gi.
- **Compose:** Healthcheck der Datenbank über TCP, `troe-schema` mit
  Wiederholungen.
- `migrate-timescale-cnpg.sh` nimmt auch `connectors` vom Netz und nennt bei
  Hypertables die richtige Reihenfolge.

## Unveröffentlicht — Webanalyse, Impressum, Datenschutz und Logo

- Helm: `cockpit.analytics.headHtml` bindet den Einbettungscode einer beliebigen
  Webanalyse auf allen öffentlichen Seiten ein (Cockpit nur mit
  `includeCockpit`), `cockpit.legal.impressumUrl` / `datenschutzUrl` verlinken
  Impressum und Datenschutzerklärung in der Fußzeile. Standard leer; s.
  `docs/betrieb.md`.
- Helm: `cockpit.branding` liefert Logo (Seitenkopf, Cockpit) und Favicon des
  Betreibers selbst aus; alle Seiten verweisen dafür auf `/favicon`.

## Unveröffentlicht — Konnektordienst: Zustand und Schreibvolumen

- Schreib-Lock: gilt nur noch als verloren, wenn die Datenbank das bestätigt
  (kein clientseitiges Query-Timeout mehr, Abgleich über `pg_locks`). Nach
  einem echten Verlust bleiben die Signaturen im Speicher und werden
  nachgeschrieben, statt ältere Stände darüberzuladen; hielt zwischenzeitlich
  eine andere Instanz den Lock, überleben nur übereinstimmende Signaturen.
  Schreibvorgänge prüfen die Writer-Generation (neue Tabelle
  `udp_connectors.writer`).
- Leere Signaturtabellen (Neuinstallation, Zustandsverlust) werden bei
  Parken, Laden und Carsharing aus dem Broker befüllt – kein Vollschrieb.
- Ladepunkte, Ladesummen und Carsharing-Stationen trennen Stammdaten von
  Messwerten: Statusänderungen schreiben nur die geänderten Werte plus
  `dateObserved`. Zeilenbudgets neu: `EVChargingStation` 460.000,
  `ChargingSummary` 95.000, `CarSharingStation` 180.000 (docs/betrieb.md).
  Ladesummen frischen `dateObserved` wie die Ladepunkte alle 3 h auf; die
  Stadtseite zeigt sie bis 6 h als aktuell.
- Prune: Altbestand (älter als 7 Tage) wird in Portionen von 1.000 je Lauf
  abgebaut, erst nach einer Woche lückenlosen Laufs; der 30-%-Deckel gilt
  nur noch für frisch Verschwundenes. Ein Massenverlust, der den Deckel
  auslöst, wird nie automatisch gelöscht: Er bleibt in `/healthz`
  (`stateStore.blockedPrunes`) und im Log, bis er zurückkommt oder per
  `scripts/release-prunes.sh <id>` freigegeben wird (erst, wenn der Deckel
  wieder passt, sonst HTTP 409). Versuchte Löschungen
  verwerfen ihre Signaturen, auch unbestätigte.
- Carsharing löscht Stationen, die zwei Läufe in Folge in der vollständigen
  Stationsliste ihres Systems fehlen (nur geschriebene, je System höchstens
  50 %).
- Laden und Carsharing schreiben jede Entität einmal je Woche voll, damit
  aus dem Broker verschwundene Entitäten nicht als Gerippe stehen bleiben
  (~15.500, ~800 und ~5.200 Zeilen/Tag zusätzlich).
- Ein 207 auf ein Delete ohne `success`/`errors` zählt nicht mehr als
  gelöscht.
- Log: je Gate-Schreibvorgang „geändert/gesamt“; Warnung, wenn mehr als die
  Hälfte trotz gespeicherter Signaturen als geändert gilt.

> **Upgrade:**
>
> - Neue Tabelle `udp_connectors.writer`. Wurde das Schema vorab angelegt,
>   braucht der Datenbanknutzer `CREATE` auf dem Schema; sonst übernimmt
>   der Dienst den Schreib-Lock nicht und meldet ein `[error]`.
> - Der erste Lauf füllt die neuen Signaturtabellen von Laden und Carsharing
>   aus dem Broker (einige Listenabrufe, keine Schreiblast).
> - Der Abbau von Altbestand beginnt frühestens eine Woche nach dem Upgrade,
>   danach höchstens 1.000 Löschungen je Prune und Lauf; ein großer
>   Altbestand ist so bei stündlichen Läufen nach wenigen Stunden abgebaut.

## Unveröffentlicht — Cockpit-Durchsatz

- Cockpit-nginx liefert vorkomprimierte statische Dateien aus (`gzip_static`),
  puffert das Access-Log und hält Dateien offen – ein Mehrfaches an
  Seitenaufrufen je CPU. CPU-Limit des Cockpits 250m → 1.
- Kontext-API: 404 wird 10 s gecacht.
- Gecachte Gateway-Routen reichen `Fiware-Service` nicht mehr durch – der
  Mandant stand nicht im Cache-Schlüssel (Mandant nur per `NGSILD-Tenant`).

## Unveröffentlicht — Datenbank-Backup nach S3

Das pg_dump-Backup lag auf einem PVC im selben Cluster – bei dessen Verlust
wären auch die Sicherungen weg.

- **Backup in S3-kompatiblen Objektspeicher** über das Barman-Cloud-Plugin
  von CloudNativePG: WAL-Archiv plus tägliche Basissicherung,
  Wiederherstellung auf jeden Zeitpunkt der letzten 30 Tage
  (`backup.*`, DEPLOY.md §2). Standard aus.
- **Wiederherstellung**: ganzer Cluster über `timescale.recovery`, einzelne
  Datenbanken über einen Zweitcluster; `scripts/restore-timescale.sh`
  führt durch beides (DEPLOY.md §10c).
- **Entfernt**: Deployment `db-backup` (pg_dump). Das Upgrade bricht ab, bis
  S3 konfiguriert oder `backup.acknowledgeNoBackup` gesetzt ist; das PVC
  `db-backup-data` bleibt und kann danach gelöscht werden. Compose behält
  seine lokalen Dumps.
- Datenbank-Metriken (`:9187`) für den Monitoring-Namespace freigegeben.

## 1.3.0 — Ingestion im Konnektordienst

Alle 29 Konnektoren laufen im Konnektordienst (`platform/connectors`,
TypeScript) statt in generierten Node-RED-Flows. Node-RED bleibt als
Low-Code-Baustein mit dem Beispielfluss.

> **Upgrade:**
>
> - Helm – Werte von `node-red-udp` unter `nodeRed.image` (`name`, Tags wie
>   `main`/`sha-…`/`pr-…`/Chart-Version) und `cockpit.endpoints` entfernen; das
>   Chart bricht sonst mit einem Hinweis ab. Ebenso bei hystreet-Token **und**
>   -Secret zugleich, leerem `networkPolicies.ingressControllerNamespaceLabel`
>   und `connectors.enabled=false` ohne `connectors.disableIngestion=true`.
>   `helm upgrade --reuse-values` scheitert an diesen Prüfungen –
>   `--reset-then-reuse-values` verwenden.
> - Eigene Images werden nur noch per Digest referenziert. Die Image-Strings
>   ändern sich dadurch einmal: Das erste Upgrade löst noch **einen**
>   Switchover der Datenbank aus (und startet ein noch vorhandenes altes
>   StatefulSet neu).
> - Der erste Lauf von `troe-retention` führt `VACUUM (ANALYZE)` auf den
>   TRoE-Tabellen von Orion-LD aus. Auf einer großen, nie gevakuumten Tabelle
>   schreibt das WAL in der Größenordnung der Tabelle (Replikations-Verzug,
>   Archiv-Verkehr, Plattenplatz) – das Upgrade entsprechend einplanen.
> - Air-gapped: `nodered/node-red` spiegeln (vorher das eigene `node-red-udp`).
> - Compose – `UDP_ABFAHRTEN_UPSTREAM` und `UDP_WARNUNGEN_UPSTREAM` aus
>   `platform/.env` streichen (werden ignoriert). Node-RED ist nur noch auf
>   `127.0.0.1` veröffentlicht (`WORKFLOW_BIND`).

- **Konnektordienst:** Compose-Dienst und Helm-Deployment `connectors` (eine
  Replik, `Recreate`, read-only). Zustand (Signaturen, Prune-Buchführung) in
  PostgreSQL, Schema `udp_connectors`. Port 1880 nur für das Cockpit, der
  Admin-Port 1881 (`/healthz`, `/trigger`) nirgends veröffentlicht.
- **Node-RED** auf dem Upstream-Image `nodered/node-red:4.1`, Beispielfluss
  und `settings.js` in Helm aus einer ConfigMap; `node-red-udp` entfällt.
  Keine Datenbank- oder hystreet-Zugangsdaten mehr, `functionExternalModules`
  aus; Internet nur noch ohne `strictEgress`. Der Beispielfluss ist
  deaktiviert ausgeliefert (schrieb Zufallswerte in den Broker). Optionale
  Anmeldung am Editor (`NODE_RED_ADMIN_USER`/`NODE_RED_ADMIN_PASSWORD_HASH`,
  Helm `nodeRed.adminAuth`); keine NetworkPolicy-Freigabe mehr, Compose
  bindet an `127.0.0.1`.
- **Cockpit:** `/abfahrten` und `/warnungen.ics` gehen an den Konnektordienst
  (`UDP_CONNECTORS_UPSTREAM`, Helm `cockpit.connectorsUpstream`).
- **Registry:** `runtime` und `nodePrefixes` entfallen; jeder aktive Eintrag
  mit Modul läuft. `scripts/export-connector-status.py` ersetzt den
  Flow-Generator und schreibt nur noch `connectors-status.json`.
- **Helm:** hystreet-Token unter `connectors.hystreetApiToken` bzw.
  `.hystreetExistingSecret` im Secret `udp-hystreet` (die Schlüssel unter
  `nodeRed.` werden weiter gelesen).
- **Image-Pipeline:** unveränderte Images behalten ihren Digest, das Chart
  referenziert eigene Images nur per Digest – ein Release rollt die Datenbank
  nicht mehr grundlos neu aus.
- **Skripte:** `trigger-connector.sh` löst im Dienst aus, `healthcheck.sh`
  zählt dessen Logs und zeigt den Zustandsspeicher.
- Wetter und Vorhersage (Open-Meteo) alle 6 h statt 4 bzw. 2 h
  (Tageskontingent); `troe-retention` mit Autovacuum-Schwellen und
  gebremstem `VACUUM (ANALYZE)`, `lock_timeout` (hält keine Orion-Schreibzugriffe
  mehr auf), `CREATE INDEX` nur noch für fehlende Indizes und Überlappungsschutz.
- **Registry:** `fireOnStart: false` – `troe-retention` und `mastr-bw` laufen
  nicht mehr bei jedem Dienststart, nur per Cron.
- **Compose-Cockpit:** Entrypoint-Skripte werden eingebunden; `nginx -t`
  scheiterte vorher an `${UDP_REALIP_FROM}`. `UDP_TRUSTED_PROXIES` ist über
  `.env` einstellbar.

## 1.2.0 — Hochverfügbarkeit des öffentlichen Pfads, Datenqualität, Lastkapazität

> **Upgrade bestehender Kubernetes-Installationen:** ohne neue Werte bleibt
> MongoDB eine Einzelinstanz (jetzt mit Journaling). Wer das Replica Set
> einschaltet, stellt in einem **eigenen** `helm upgrade` mit `--wait` um, nicht
> mit `--atomic` – vorher `mongodump` (DEPLOY.md §10b). Ist das Replica Set
> einmal aktiv, darf kein älteres Chart mehr ausgerollt werden: es startete
> MongoDB wieder als Einzelinstanz. docker compose ist nicht betroffen.

### Hochverfügbarkeit des öffentlichen Pfads

- **MongoDB als Replica Set** (`mongo.replicaSet.enabled`): drei
  Datenmitglieder oder zwei plus Arbiter (`replicaSet.arbiter`, eigenes
  Scheduling, z. B. auf einem Control-Plane-Knoten). Failover in Sekunden, ein
  PDB über alle Stimmen, Readiness erst nach dem Aufholen. Bestehende
  Installationen werden per `helm upgrade` umgestellt, `mongo-0` behält seine
  Daten (DEPLOY.md §10b).
- **Journaling** für MongoDB immer an (vorher `--nojournal`).
- **Verteilung** konfigurierbar: `global.spread.mode: required` hält
  Replikate auf verschiedenen Knoten; Deployments rollen dann ohne Surge aus,
  damit es auch mit so vielen Knoten wie Replikaten geht.
- **Cockpit** liefert `/abfahrten` und `/warnungen.ics` bei
  Node-RED-Ausfall aus dem Cache weiter (eigene Cache-Zone, 24 h).
- `minReadySeconds: 10` für Cockpit, APISIX und Mintaka: kein kurzes 503 mehr
  beim Rollout ohne Surge.
- `global.clusterDomain` für abweichende Cluster-DNS-Domänen.

### Datenqualität der Gemeindeseiten

Objekte außerhalb Baden-Württembergs landeten in der nächstgelegenen
BW-Gemeinde (Leihräder aus Basel, Feinstaubsensoren aus dem Elsass).

- **Strikte Gemeindezuordnung** per Punkt-in-Polygon ohne Zentroid-Fallback
  für Sharing, Feinstaub, Parken, Baustellen und Radzähler; kleine Toleranz
  für Lücken zwischen den vereinfachten Grenzen. Ohne Grenzen-Cache wird der
  Lauf übersprungen statt geraten.
- DWD-Stationen, Pegel, Overpass-Daten, Ladesäulen und Carsharing nutzen
  dieselbe Zuordnung mit kleiner Grenztoleranz.
- **Baustellen**: Zuordnung per Polygon statt nächstem Gemeindezentrum,
  vertauschte Koordinaten werden korrigiert.
- **Automatisches Aufräumen** veralteter eigener Entitäten nach vollständigen
  Läufen, mit Schutz: plausible Stammdaten, lückenlose Vorläufe, Karenzzeit
  bzw. 24 h Bestätigung, höchstens 30 % des Bestands, nur eigene ID-Muster.
- **Compose**: Node-RED lädt Stammdaten über `http://cockpit:8080` (vorher
  Port 80, dort lauscht das Cockpit nicht); Helm-Service zusätzlich auf 8080.
- **Keine eingefrorenen Werte mehr**: Änderungssignaturen gelten erst nach
  bestätigtem Upsert (2xx, bei 207 je Entität). Bei Orion-Ausfällen gehen die
  Werte im nächsten Lauf erneut heraus, statt wochenlang stehen zu bleiben.
- **Frische**: Parkanlagen und B+R mit Echtzeitwerten, Carsharing-Stationen,
  Ladepunkte mit Livestatus, Parken-Summen und Gemeinde-Puls tragen ein
  aktuelles `dateObserved`. Reine Stammdaten-Einträge bleiben ohne.
- **Sharing**: Gemeinden ohne Fahrzeuge eines Anbieters erhalten einmal 0
  statt bis zum Aufräumen die alte Zahl.
- **Aufräumen** verschwundener Carsharing-Stationen und -Flotten, Ladepunkte,
  Ladesummen und Gemeinde-Pulse; einmalig auch Parkanlagen im Alt-ID-Schema
  (nur nach vollständigem Lauf, 7 Tage unverändert).
- **Ladepunkte**: alle OCPDB-Seiten laut `total_count` (vorher fest 29 von 32,
  rund 1.300 BW-Standorte fehlten).
- **Gemeinde-Puls**: mindestens drei echte Komponenten (Warnlage zählt nicht),
  keine Baustelle = 100, Sharing je 1.000 Einwohner, veraltete Feinstaubwerte
  ignoriert, alle Abfragen paginiert. Methode: `docs/framework-dashboards.md`.
- **Gemeindeseite**: Parken, B+R, Ladepunkte und Carsharing zeigen bei
  veralteten Werten „Stand: TT.MM. HH:MM“ statt „Echtzeit“; veraltete
  Gemeinde-Pulse werden markiert, der Kreis-Mittelwert zählt nur aktuelle.
- **Ladesummen** nur noch bei Änderung voll geschrieben, OCPDB-Upserts
  gedrosselt; neue Zeilenbudgets für Ladepunkte, Ladesummen, Carsharing und
  Gemeinde-Puls.

### Lastkapazität des Dashboards

Ein Lasttest zeigte: Schon wenige gleichzeitige Besucher brachten die
Gemeindeseiten auf Ladezeiten im zweistelligen Sekundenbereich – jede
Dashboard-Abfrage war ein Vollscan in MongoDB, dazu zählte die TRoE-Statistik
alle 10 Minuten die komplette Zeitreihentabelle.

- **MongoDB-Index** `udp_type_ags` (Typ + ags) per Helm-Hook-Job nach jedem
  Install/Upgrade, auch für alle Mandanten-Datenbanken (`mongo.indexes`).
  Probes nur noch TCP, CPU-Limit 2.
- **TRoE-Statistik** zählt alle 10 Minuten nur die letzten 24 h;
  Gesamtwerte je Typ kommen aus dem nächtlichen Lauf (Dashboard: „Stand …“).
  Server-seitiger Timeout, keine überlappenden Läufe mehr.
- **Rate-Limit je Client** auf `/ngsi-ld` und `/temporal` statt eines
  gemeinsamen Topfs für alle Besucher (`apisix.rateLimit`, HTTP 429).
- **Cockpit-Cache**: Schlüssel enthält den Mandanten (vorher konnten Mandanten
  fremde Antworten erhalten); bei kurzen Orion-Ausfällen wird die letzte
  Antwort ausgeliefert.
- **Compose:** APISIX (Port 8780) nur noch auf `127.0.0.1` veröffentlicht
  (`PROXY_BIND`); externer API-Zugriff über das Cockpit (`/gateway/…`).
- Neuer Lasttest `tests/load/municipality-page.js` (k6), siehe
  [Betrieb](docs/betrieb.md#lasttest-dashboard).

## 1.1.0 — Hochverfügbare Datenbank, Kubernetes-Härtung, Parken-Konnektor

> **Upgrade bestehender Kubernetes-Installationen:** PostgreSQL läuft jetzt als
> CloudNativePG-Cluster. Vorher den CNPG-Operator installieren (DEPLOY.md §2)
> und die Daten nach DEPLOY.md §10a umziehen – ein direktes `helm upgrade`
> verweigert das Chart, statt eine leere Datenbank zu starten. docker compose
> ist nicht betroffen.

### Kubernetes: hochverfügbare Datenbank (CloudNativePG)

- **PostgreSQL/TimescaleDB als CloudNativePG-Cluster** statt einzelnem
  StatefulSet: Primary und Standby in verschiedenen Zonen, Umschaltung vor
  jedem Knoten-Drain, automatische Übernahme bei Ausfall. Ein Knoten-Update
  ist damit kein Datenbank-Ausfall mehr. Voraussetzung: CNPG-Operator.
- Neues Image `postgres-timescale-cnpg` (CNPG-PostGIS 3.6 + TimescaleDB OSS);
  Hostname `timescale`, Rollen und MD5-Passwörter bleiben.
- **Bestehende Installationen** ziehen per `scripts/migrate-timescale-cnpg.sh`
  um (DEPLOY.md §10a); das Chart verweigert ein Upgrade, das eine leere
  Datenbank starten würde.

### Kubernetes: Probes, NetworkPolicies, Orion-LD

- **Orion-LD blieb hängen** („socket descriptor (1024) is not less than
  FD_SETSIZE“): ohne Leerlauf-Timeout sammelten sich Keep-Alive-Verbindungen
  bis zur `select()`-Grenze. Jetzt `-reqTimeout 60 -maxConnections 900`
  (Helm und Compose), APISIX-Keep-Alive auf 30 s.
- **Mosquitto** war im Cluster nur auf `127.0.0.1` erreichbar – die
  `mosquitto.conf` wird jetzt eingehängt.
- **Probes** für alle Dienste, Timings unter `<komponente>.probes`.
- **NetworkPolicies** pro Komponente statt „alles im Namespace“; Monitoring-
  Namespace und Internet-Egress (strictEgress) konfigurierbar.
- Mintaka mit festem `-Xmx`, Postgres mit Fast-Shutdown und größerem
  `/dev/shm`, APISIX mit 2 statt „auto“ Workern, `enableServiceLinks: false`,
  PDB für Mintaka, Node-RED mit `Recreate`.
- Orion-LD wartet per Init-Container auf MongoDB/TimescaleDB (sonst SIGSEGV
  und CrashLoopBackOff nach jedem DB-Neustart); replizierte Dienste rollen mit
  `maxUnavailable: 0` aus. MongoDB-Liveness per TCP statt `mongosh`.
- Postgres-Image baut wieder: `bullseye-security` liefert 404, die Quelle
  entfällt für den Build.

### Parken-Konnektor (ParkAPI) repariert

`parken-bw` schrieb **~1,04 Mio TRoE-Zeilen/Tag** — rund die Hälfte der
Zeitreihen-Datenbank — und deckte dabei 1,6 % der Quelldaten ab. Drei Fehler
lagen übereinander: `&offset=` wird von der ParkAPI v3 ignoriert (alle 66
Anfragen je Lauf lieferten denselben Ausschnitt), die Entitäts-IDs entstanden
aus geslugten Anlagennamen (500 Datensätze → 336 Entitäten), und je Lauf gingen
alle Attribute neu heraus.

Jetzt: Cursor-Pagination (`start=<next_id>`), stabile IDs aus dem
ParkAPI-Primärschlüssel und getrennte Schreibpfade für Stamm- und
Bewegungsdaten. Ergebnis rund 24.900 statt 336 Parkanlagen bei grob 6.000 statt
1,04 Mio Zeilen/Tag. Gegen Wiederholung: Zeilenbudget je Konnektor
(`rowBudget24h`), Kardinalitäts-Prüfung und Tests unter `tests/`.

Nachgezogen aus dem Betrieb des Referenzclusters:

- Retention räumt den Alt-Bestand des Konnektors ab (hier 23,8 Mio Zeilen).
- Service-Worker: Cacheversion folgt der Chart-Version, Shell wird aufgefrischt.
- MongoDB-Liveness-Probe: 10 s statt Vorgabe 1 s — sie riss Orion-LD mit.

## 1.0.1 — Chart-Veröffentlichung korrigiert

Keine funktionalen Änderungen an der Plattform. Der Release-Lauf zu `v1.0.0`
baute die vier eigenen Images, brach aber vor dem Chart-Push ab: `version:` in
`helm/udp/Chart.yaml` stammte noch aus der internen Zählung und passte nicht
zum Release-Tag. Die Chart-Version folgt jetzt wieder dem Tag, `v1.0.1`
veröffentlicht damit das erste Chart unter
`oci://ghcr.io/idk-ev/udp_public/charts/udp`.

## 1.0.0 — Erste öffentliche Veröffentlichung unter EUPL-1.2

Erstveröffentlichung der Urbanen Datenplattform als Open Source. Die
Entwicklungshistorie vor diesem Stand ist nicht Teil des öffentlichen
Repositorys.

Enthalten:

- **Context Broker** — FIWARE Orion-LD (NGSI-LD) mit TRoE-Zeitreihen in
  PostgreSQL/PostGIS, Temporal API über Mintaka.
- **Ingestion** — Node-RED-Flows aus einer Konnektor-Registry
  (`platform/config/connectors.json`, 29 Konnektoren) für offene Landes- und
  Bundesquellen: DWD, PEGELONLINE, LUBW/HVZ, Umweltbundesamt, MobiData BW,
  Marktstammdatenregister, BBK/NINA, sensor.community, OpenStreetMap/Overpass,
  EFA-BW.
- **Dashboards** — Cockpit-SPA sowie statisch erzeugte Seiten für alle 1.103
  Gemeinden und 35 Landkreise Baden-Württembergs.
- **Open-Data-Portal** — CKAN mit DCAT-AP.de-Profil.
- **Geodienste** — GeoServer (OGC WMS/WFS/WPS), FROST-Server (OGC
  SensorThings), optional Masterportal.
- **Sensorik** — MQTT über Mosquitto und FIWARE IoT-Agent JSON.
- **Zugriff und Identität** — Apache APISIX als API-Gateway, Keycloak für
  Identitäten, Rollen und Mandanten.
- **Betrieb** — Docker-Compose-Stack und Helm-Chart für Kubernetes,
  Uptime-Kuma-Monitoring als eigenständiges Deployment, Backup-Sidecar.
- **Architektur** konform zu DIN SPEC 91357 (Referenzarchitekturmodell Offene
  Urbane Plattformen), mandantenfähig über NGSI-LD-Tenants.

Lizenz: [EUPL-1.2](LICENSE) · Fremdkomponenten:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
