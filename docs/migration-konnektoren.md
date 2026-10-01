# Konnektoren aus Node-RED lösen

Migrationsplan: Die 29 Konnektoren wandern aus dem generierten
`flows.json`-Verdrahtungsdiagramm in einen TypeScript-Dienst
(`platform/connectors/`). Node-RED bleibt als Low-Code-Baustein stehen — nur
nicht mehr als Laufzeit der Ingestion.

Stand: **abgeschlossen.** Alle Phasen (0 bis 6) sind durch; die 29
Konnektoren laufen in Produktion im Konnektordienst, Node-RED läuft nur noch
mit dem Beispielfluss. Das Dokument bleibt als Begründung und Chronik der
Ablösung stehen; der laufende Betrieb steht in `docs/betrieb.md`, Abschnitte
„Konnektordienst“ und „Node-RED“.

## Ziel

- Konnektorlogik in versionierten, einzeln testbaren Modulen statt als String
  in einer 442 KB großen JSON.
- `fetch`, `AbortSignal`, `Promise.allSettled` statt `node:https`-Handarbeit im
  vm-Sandkasten des Function-Nodes.
- Ein Regressionsnetz je Konnektor. Der ParkAPI-Vorfall vom 24.08.2026 wäre
  damit am ersten Tag aufgefallen statt nach einem Monat.
- Typen statt Kommentaren: Die Bedeutung der Positionsarrays steht im Compiler,
  nicht in einer Zeile `// 0 id · 1 lat · 2 lon`.
- Der Registry-Eintrag bleibt der einzige Pflegeort.

## Ausdrücklich nicht

- **Node-RED abschaffen.** B.II.4 der Leistungsbeschreibung 60982-25 nennt es
  namentlich (`docs/anforderungsabdeckung.md`). Container und Beispiel-Tab
  bleiben — die Zusage stimmt danach sogar genauer als heute, weil das Feld
  „vorkonfigurierter Beispielfluss“ dann wirklich beschreibt, was dort läuft.
- **Fachlogik verbessern.** Portiert wird verhaltensgleich. Fachliche
  Änderungen kommen danach, mit dem Netz im Rücken.
- **Big Bang.** Umschaltung je Konnektor, beide Laufzeiten eine Zeit lang
  parallel.

## Warum das überhaupt geht: der Paritäts-Harness

Die alten Function-Bodies sind JS-Strings in `flows.json`. Sie lassen sich in
`node:vm` mit einem nachgebauten Node-RED-Sandkasten ausführen (`msg`,
`node.status/warn/error`, `flow`, `global`, `env`, dazu `https`, `zlib`, `pg`).
Beide Seiten bekommen dieselbe eingecheckte Fixture; verglichen werden die
Entitäts-Arrays, normalisiert um `dateObserved` und `observedAt`.

    fixtures/<id>.json ──┬──▶ vm-runner (flows.json, alter Node) ──┐
                         │                                         ├─▶ deepEqual
                         └──▶ connectors/<id>.ts  bauen()  ────────┘

Damit hat jede Portierung einen mechanischen, offline laufenden Nachweis — das
ist die Voraussetzung dafür, die Arbeit überhaupt aufzuteilen.

Der Altcode bleibt ungetypt, ohne dass dafür ein Loch in die Typisierung
gebohrt wird: Was aus dem vm zurückkommt, hat den Typ `unknown` und wird nie
zugesichert. `deepEqual(unknown, unknown)` braucht keinen Typ.

**Reihenfolge zwingend:** Fixtures werden aufgezeichnet, bevor irgendetwas
gelöscht wird. Sind alle 29 Konnektoren portiert, verschwindet `flows.json` —
Fixtures und Paritätstests bleiben und sind ab dann die Regressionssuite, die
dem Projekt bisher fehlte.

## Zielarchitektur

Siehe `platform/connectors/README.md` für Aufbau, Modulvertrag und die
verbindliche Typdisziplin.

Kurz: ein Dienst, eine Laufzeit-Abhängigkeit (`pg`), alles andere aus der
Node-Standardbibliothek. Übersetzt wird mit `tsc` nach `dist/` (mehrstufiges
Dockerfile, Source-Maps). Node 22 könnte Typen zur Laufzeit auch selbst
entfernen, das ist dort aber noch experimentell und schreibt bei jedem Start
eine Warnung — ausgerechnet in die Logs, die `scripts/healthcheck.sh` nach
`[warn]` durchsucht. `erasableSyntaxOnly` hält den Wechsel für später offen.

Die tragende Regel des Modulvertrags: **Transformation ist eine reine
Funktion.** `bauen(roh, geo, jetzt)` bekommt Rohdaten, Geo-Kontext und einen
Zeitstempel und gibt Entitäten zurück — kein Netz, keine Uhr, kein globaler
Zustand. Nur so ist sie gegen den alten Node-RED-Code diffbar. I/O lebt in
`lauf(ctx)`.

## Phasen

Die Nummerierung ist echte Abhängigkeit: Phase 3 darf erst starten, wenn der
Vertrag steht — sonst portieren sieben Agenten gegen eine Schnittstelle, die
sich noch bewegt.

### Phase 0 — Gerüst ✅

Verzeichnis, `package.json`, `tsconfig.json`, `eslint.config.js` mit der
Typdisziplin, mehrstufiges Dockerfile, SPDX-Köpfe. Einhängen in `tests/run.js`
(scannt zusätzlich `platform/connectors/dist/test/parity/`),
`.githooks/pre-commit` und CI (eigener Job `connectors`, Node 22).

Nachweis: `test/hardening/` — zwei Dateien, die scheitern **müssen**;
`tests/static/type-discipline.test.js` ruft `tsc` und `eslint` darauf auf und
erwartet das Scheitern.

### Phase 1 — Kernel und Vertrag (1 Agent, seriell) ✅

`kernel/types.ts` zuerst; dort steht der Vertrag, alles andere setzt ihn um.
Dann die übrigen `kernel/`-Module plus `stammdaten-bw` und `grenzen-bw` — die
beiden füllen den Geo-Kontext, auf dem fast jeder andere Konnektor sitzt.
Rund 900 Zeilen.

Bewusst nicht parallelisiert: Der Kernel *ist* die Schnittstelle. Zwei Agenten
daran erzeugen zwei Schnittstellen.

*Fertig, wenn* `types.ts` den vollständigen `ctx`-Vertrag trägt, `tsc --noEmit`
und `eslint` sauber durchlaufen und ein Beispielkonnektor damit läuft.

### Phase 2 — Paritäts-Harness (1 Agent, parallel zu Phase 1) ✅

`vm-runner.ts`, ein Aufzeichnungsskript für Fixtures, ein durchgearbeitetes
Beispiel. Hängt nur an `flows.json`, nicht am Kernel.

*Fertig, wenn* ein alter Function-Node und ein neues Modul auf derselben
Fixture nachweislich identische Entitäten liefern.

### Phase 1b — Kernel an den aktuellen Generator angleichen ✅

Während Phase 1 hat sich der Generator auf `main` geändert; der Kernel bildete
danach Hilfsfunktionen ab, die es nicht mehr gab. Nachgezogen:

- **Strikte Gemeindezuordnung** (`GeoStore.forRun`, `GeoIndex.agsAt`):
  Punkt-in-Polygon mit Lückentoleranz, kein Zentroid-Fallback mehr. Ohne
  Grenzen-Cache wird der Lauf übersprungen, außer das Modul erklärt
  `boundaries: "optional"` ausdrücklich.
- **Signaturen erst nach bestätigtem Upsert:** `ChangeGate.check` liefert nur
  vorgemerkte Signaturen, `Orion.upsert` übernimmt sie für die bestätigten IDs.
  Einen Commit-Aufruf, den man vergessen könnte, gibt es nicht.
- **Aufräumen veralteter Entitäten** (`ctx.prune`) mit allen Schutzgrenzen. Der
  Zustand liegt inzwischen in PostgreSQL (siehe „Zustand dauerhaft in
  PostgreSQL“). Ist noch keine 95-%-Referenz der Gemeindezahl gespeichert,
  wird sie aus der Zahl der `Municipality`-Entitäten in Orion gesetzt; solange
  Orion nicht antwortet, wird nicht aufgeräumt.
- **Nach dem Review:** Signaturtabellen je Konnektor getrennt, `retain` statt
  freiem Schreiben, `ungated()` für Schreibvorgänge ohne Gate, `ctx.db` für
  die beiden SQL-Konnektoren, Routen mit eigenem `ctx`, Log-Zeilen gegen
  eingeschleuste Zeilenumbrüche geschützt, `/trigger` nur auf dem Admin-Port
  mit Sperrfrist.

Paritätstests gegen die neuen Flows: `stammdaten-bw`, `grenzen-bw`, strikte
Zuordnung, Signatur-Commit, Aufräumen.

### Sperre: Vertrag eingefroren

Kernel-Review und ein grüner Beispiel-Paritätstest. Erst danach der Fan-out.
Ab hier sind Änderungen am `ctx`-Vertrag teuer — sie treffen sieben laufende
Agenten gleichzeitig. Der Vertrag ist eine Datei, die der Compiler durchsetzt:
Ein Modul, das nicht passt, fällt beim Build durch, bevor ein Mensch die erste
Zeile davon liest.

### Phase 3 — Portierung (7 Agenten, parallel) ✅

Geschnitten nach gemeinsamem Idiom, nicht nach Anzahl.

| Agent | Konnektoren | Gemeinsames Idiom |
|---|---|---|
| A · Betrieb | `ops-host`, `troe-stats`, `troe-retention` | Direktes SQL über `pg`, `child_process` statt exec-Node, kein Geo |
| B · Wetter | `wetter-bw`, `vorhersage-bw`, `pollen-bw`, `hitze-bw` | Open-Meteo-Achterbatch, Fan-out mit `join`-Semantik |
| C · Wasser & Warnungen | `pegel-bw`, `pegel-lubw`, `warnungen-bw`, `baustellen-bw` | Punkt-in-Polygon, 88er-Fan-in (DWD + NINA), Ablauf-Löschung |
| D · Overpass | `rathaus-bw`, `ausflug-bw`, `poi-bw` | Strenge Serialisierung, Kachelraster, harte Anbieterlimits |
| E · Mobilität | `parken-bw`, `sharing-bw`, `carsharing-bw`, `ladesaeulen-bw` | Cursor-Pagination, GBFS-Systemlisten, `gate` mit/ohne `replace` |
| F · Luft & Energie | `uba-bw`, `feinstaub-bw`, `eco-bw`, `mastr-bw`, `puls-bw` | Stationslisten, Medianbildung je Gemeinde |
| G · ÖPNV & Endpunkte | `efa-abfahrten`, `abfahrten-on-demand`, `hystreet`, `wetter-dwd-station`, `/warnungen.ics` | Die HTTP-Endpunkte; `efa-abfahrten` wird von 23 Function- und 46 HTTP-Nodes zu einer Schleife |

Abweichend vom Schnitt ist `/warnungen.ics` mit `warnungen-bw` in Gruppe C
portiert worden, nicht in G: Route und Konnektor teilen sich Modul und `ctx`.

*Fertig je Konnektor:* Modul + Parsefunktion + Fixture + grüner Paritätstest +
`tsc --noEmit` + `eslint` ohne Ausnahmen + Trockenlauf ohne Upsert. Vier der
sechs Punkte prüft die Maschine.

Was die Agenten **nicht** dürfen: Typen im Kernel ändern, `eslint-disable`
setzen, `as` oder `!` verwenden. Klemmt der Vertrag, ist das eine Meldung an
die Review — kein Umweg im eigenen Modul.

### Phase 3b — Vertragslücken schließen ✅

Die Portierung hat Stellen gefunden, an denen der Vertrag klemmte; einige
Module hatten sich lokal beholfen (modulweite `WeakMap<Ctx, …>`, Konstanten
statt Registry-Feldern). Nachgezogen im Kernel, alle Module umgestellt:

- **`ctx.state`** — Zustand je Konnektor (`stateKey(name, initial)`
  in `src/kernel/state.ts`, `ctx.state.slot(key)`), typisiert ohne Assertion,
  geteilt von `run` und den Routen desselben Konnektors. Ersetzt die
  Workarounds in `abfahrten-on-demand`, `efa-abfahrten`, `mastr-bw`,
  `feinstaub-bw`, `carsharing-bw` und `parken-bw`.
- **`SqlParam`** nimmt `readonly string[]`; `troe-retention` bindet das Array
  wieder direkt statt eines selbstgebauten Literals.
- **`ctx.rowBudget`** — die Summe aller `rowBudget24h` der Registry, vom Kernel
  berechnet; `troe-stats` liest die Registry nicht mehr selbst.
- **`RegistryEntry.sensorDetailFor`** — `feinstaub-bw` liest die Liste aus der
  Registry statt aus einer Konstanten. Außerdem nutzen `parken-bw`,
  `sharing-bw`, `carsharing-bw` und `ladesaeulen-bw` für die Prune-Intervalle
  `ctx.intervalMs()` statt fest eingetragener Registry-Werte.
- **Orion-Lesezugriffe ungetaktet** (`find`, `list`, `count`; neue Option
  `FetchOptions.bucket`): Ein Rückstau von Schreib-Chunks (z. B. ~320 von
  `parken-bw`) hält `/warnungen.ics` nicht mehr über das 60-s-Timeout der
  nginx hinaus auf. Schreibzugriffe bleiben getaktet.
- **HEAD, OPTIONS und 304** beantwortet der HTTP-Server für jede GET-Route wie
  Express; `RouteRequest.headers` (Namen klein geschrieben).
- **`maxConcurrent` je Host** im Rate-Limiter; die drei Overpass-Konnektoren
  haben zusammen höchstens eine Anfrage offen.
- **Open-Meteo-Join-Fenster** aus Batchzahl × gemeinsamem 15-s-Takt + Timeout
  abgeleitet (375 s statt 240 s), damit der geteilte Bucket keine unechte
  Teilgruppe erzeugen kann.

### Zustand dauerhaft in PostgreSQL ✅

Entschieden vor der ersten Umschaltung; ersetzt den früheren Plan „in Phase 6
nach Postgres“. Ein Review zeigte: Unter Compose hielt Node-RED Signaturen,
Prune-Buchführung und Kontext auf einem Volume, ein Neustart schrieb fast
nichts. Der Dienst hätte bei **jedem** Neustart alle Gate-Entitäten voll
geschrieben (~400k TRoE-Zeilen, `parken-bw` allein ~230k bei 25k/Tag Budget);
jede Umschaltgruppe braucht einen Neustart, eine Absturzschleife vervielfacht
es. `mastr-bw` hätte seine Rotation jedes Mal bei 0 begonnen.

- **Wo:** dieselbe TimescaleDB wie `ctx.db` (`TROE_DB_*`, Datenbank `orion`),
  eigenes Schema `udp_connectors` (`signatures`, `prune_state`,
  `connector_state`, je Konnektor-id), beim Start idempotent angelegt. Orions
  TRoE-Tabellen bleiben unberührt.
- **Laden vor dem ersten Lauf.** Sobald der Schreib-Lock gehalten wird, lädt
  der Dienst den Zustand aller Konnektoren — beim Start sofort im
  Hintergrund, nicht erst vor dem jeweils nächsten Lauf. Nach einem
  Lock-Verlust (Datenbank-Switchover) bleibt der Speicher maßgeblich und wird
  nachgeschrieben; nur wenn zwischendurch eine andere Instanz den Lock hielt,
  wird mit der Datenbank abgeglichen. Ein gescheitertes
  Laden wird nach 30 s wiederholt. Ohne geladenen Zustand laufen Konnektoren
  mit Gate oder persistiertem `ctx.state` nicht (`[warn]`, der nächste Lauf
  versucht es erneut; ein Lauf wartet auf ein laufendes Laden), Prunes werden
  übersprungen; ungegatete Konnektoren laufen.
- **Durchschreiben:** Verworfene Signaturen gehen *vor* dem Upsert in die
  Datenbank, bestätigte danach (je Chunk). Scheitert das Vorab-Schreiben, geht
  ein gegateter Upsert nicht raus — die Datenbank enthält nie eine Signatur,
  die der Broker nicht bestätigt hat. Fehlgeschlagenes wird beim nächsten
  Schreiben nachgeholt, ein `[warn]` je Fehlerserie.
- **Ein Schreiber:** Advisory-Lock für die Prozesslaufzeit; eine zweite
  Instanz lädt nichts und fährt nur ungegatete Konnektoren. `/healthz` meldet
  `stateStore`.
- **Vertrag:** nur ein optionales drittes Argument, `stateKey(name, initial,
  codec)`. `mastr-bw`, `feinstaub-bw` und `parken-bw` persistieren damit ihre
  Werte; Caches (Haltestellenverzeichnis, Stationscache) bleiben im Prozess.

### Bewusste Abweichungen vom Node-RED-Verhalten

Gesammelt aus den Modulköpfen — das ist, worauf die Beobachtungsfenster in
Phase 4 achten müssen. Nicht aufgeführt: reine Härtung gegen Eingaben, an
denen der alte Node abgestürzt wäre (fehlerhafte Datensätze werden
übersprungen und gezählt statt den Lauf zu verlieren; `Map` statt
Objekt-Literal für Nachschlagetabellen) und englische Log-Texte.

*Querschnitt (Kernel)*

- Takt je **Host** statt je Delay-Node: mehrere Konnektoren gegen denselben
  Anbieter teilen sich den Takt (strenger, nie lockerer); die Warteschlange
  hat eine Obergrenze und meldet den Überlauf.
- Orion-Lesezugriffe ungetaktet, Schreibzugriffe getaktet (s. Phase 3b).
- Prunes werden abgewartet statt „fire and forget“ neben dem Upsert gestartet
  (meist danach; bei `sharing-bw`/`carsharing-bw` vor den Systemen). Ihre
  `keep`-Mengen sind unverändert.
- Signaturen, Prune-Buchführung und persistierter Zustand überleben Neustarts
  auch in Kubernetes (Node-RED startete dort ohne Volume leer); z. B. zählt
  `feinstaub-bw` seinen Takt über Neustarts weiter.
- Antwortgröße gedeckelt (dekomprimiert, Standard 32 MiB, große Quellen mit
  eigenem Deckel); die `http request`-Nodes lasen ohne Grenze.
- Weiterleitungen werden standardmäßig abgelehnt (alt: immer gefolgt); nur
  `uba-bw` und die GBFS-Feeds folgen, jeder Sprung geprüft.
- Orion-Schreibzugriffe mit 120 s Timeout wie die alten Upsert-Nodes (Lesen
  30 s); vorher hatte der Port 30 s.
- `/trigger` nur von Loopback (403 sonst, also per `docker exec`/`kubectl
  exec`); Cooldown mindestens 60 s, nicht abschaltbar.
- nginx: Cache-Schlüssel und Upstream-Anfrage von `/abfahrten` und
  `/warnungen.ics` nur mit `ags` bzw. `kreis`; `limit_req` je Client (30 bzw.
  10 Anfragen/min, darüber 429).
- Upsert-Warnungen nennen bei 207 zuerst die abgelehnten Entitäten mit Fehler
  (höchstens drei, Rest gezählt) statt des abgeschnittenen Rohtexts; ein 207
  mit Ablehnungen warnt auch ohne Signaturen.

*Konnektoren*

- `abfahrten-on-demand`: EFA über den gemeinsamen EFA-Bucket, ohne Retry, 30 s
  Timeout (502 nach 30 s statt nginx-504 nach 60 s); kein JSONP; ein
  Verzeichnis ohne `halte`-Objekt wird verworfen, das alte bleibt.
- `/abfahrten`: gleichzeitige Anfragen je Halt teilen eine EFA-Anfrage, deren
  Antwort 30 s wiederverwendet wird; eigene Warteschlange (2 laufend, 8
  wartend, darüber sofort 503); Abbruch, wenn kein Client mehr wartet;
  EFA-Fehler als gedrosseltes `[warn]`.
- `efa-abfahrten`, `/abfahrten`: Abfahrten zählen nur, wenn EFA den
  angefragten Halt aufgelöst hat (alt: bei unbekannter Id die Abfahrten eines
  erratenen Orts); sonst `[warn]` ohne Schreiben bzw. 502. -4030 „no matching
  departure“ gilt wie -4050 als „keine Abfahrten“.
- `efa-abfahrten`: ohne Echtzeit-Median fehlt `avgDelayMinutes` und wird im
  Broker entfernt (alt: `value: null`, von Orion-LD mit 207 für die ganze
  Entität abgelehnt, Neuversand alle 5 min).
- `rathaus-bw`: auch Relationen abgefragt; Bezirks-/Ortsverwaltungen und
  `townhall:type` district/village abgewertet, city/town/municipality und der
  Gemeindename aufgewertet; Gleichstand nach Nähe zum Ortskern (alt: erstes
  Element; Öffnungszeiten +2, Name +1).
- `efa-abfahrten`: höchstens 2 Anfragen gleichzeitig, 500 ms Abstand (statt 23
  auf einmal); ein Batch-Upsert statt 23; fehlende `stopId` einmal je Prozess
  gewarnt; Halt-Id URL-kodiert (`:` bleibt, heutige URLs bytegleich).
- `warnungen-bw`: Anfrage **ohne Antwort** (DNS, Timeout, abgelehnt) zählt als
  „keine Daten“ — der Kreis behält seinen letzten Wert (alt: „keine
  Warnungen“); Teilgruppe nach Join-Timeout wird gewarnt.
- `/warnungen.ics`: Orion nicht erreichbar oder Fehlerantwort → **503** (alt:
  200 „Keine amtlichen Warnungen“); ein Lesezugriff ohne Retry; Fehler als
  `[warn]` höchstens einmal je Minute (alt: `[error]` je Anfrage); TEXT-Escaping
  auch für ein einzelnes `\r` und Steuerzeichen; Zeilen nach RFC 5545 bei 75
  Oktetten gefaltet.
- `wetter-bw`, `vorhersage-bw`: gemeinsamer 15-s-Takt für `api.open-meteo.com`;
  Join-Fenster 375 s statt 240 s; eine abgeschlossene Gruppe wird sofort
  geschrieben statt den Timer abzuwarten.
- `rathaus-bw`, `ausflug-bw`, `poi-bw`: gemeinsamer 90-s-Takt und höchstens
  eine offene Overpass-Anfrage über alle drei (`rathaus-bw` war ungetaktet);
  Geo-Kontext vor der Anfrage geprüft; kein Join-Timeout — alle Kacheln werden
  abgewartet, keine späte Teilgruppe mehr.
- `parken-bw`: Dienst-User-Agent statt eigenem; 2 Retries bei Netzfehlern
  (alt: Abbruch beim ersten Fehler).
- `sharing-bw`, `carsharing-bw`: Systeme nacheinander statt Fan-out; eine
  Systemliste je Lauf statt zwei (`carsharing-bw`); Feed-URLs aus der
  Systemliste nur unter der GBFS-URL-Regel (https, keine privaten/internen
  Ziele, auch je Weiterleitung), abgelehnte Feeds als ein `[warn]` je Lauf.
- `ladesaeulen-bw`: alle Seiten abgewartet statt Join-Abbruch nach 420 s
  (Ergebnis bei langsamer Quelle gleich: unvollständig, kein Prune).
- `mastr-bw`, `uba-bw`: alle Anfragen abgewartet und einmal geschrieben statt
  Join-Timeout mit Nachzügler-Gruppe.
- `mastr-bw`: eine Gemeinde mit fehlgeschlagener Seite wird ausgelassen und
  behält ihren letzten Wert (alt: 0 Anlagen, 0 kW, „vollständig“, Zählung 0
  gecacht).
- `baustellen-bw`: Ablauf-Löschung am Ende jedes Laufs statt eigenem Inject
  (gleicher Takt, ohne Versatz); ihr Id-Muster verankert und lokal
  nachgeprüft, höchstens 30 % der gelisteten eigenen Baustellen je Lauf
  (mindestens 3, höchstens die alten 200).
- `troe-retention`: Altschema-Bereinigung nur für nachweislich eigene
  `parken-bw`-Altlasten (Anbieter + vor der Umstellung geschrieben, alt: alle
  Nicht-`parkapi-`-Ids inkl. kommunaler B+R); der `OffStreetParking`-Schritt
  entfällt; neu: Autovacuum-Schwellen (1 %) vorab und `VACUUM (ANALYZE)` von
  `attributes`/`subattributes` nach dem Lauf, Fehler nur als `[warn]`.
- `wetter-dwd-station`: ein Batch-Upsert statt einem je Station; Ausfälle als
  ein `[warn]` je Lauf statt `[error]` je Station; Stations-Id URL-kodiert
  (heutige Ids bytegleich).
- `hystreet`: über den Host-Bucket getaktet (alt: ungetaktet); Weiterleitungen
  abgelehnt (das Token folgt keinem `Location`); Standort-Id URL-kodiert.
- `puls-bw`: Kommas in `attrs` URL-kodiert; Fehlertexte der Kernel-Listung.
- `ops-host`: Plattenbelegung aus `df -P /` statt `/data`.
- `pegel-bw`, `pegel-lubw`: Anfrage ohne Antwort ergibt dieselbe Warnung wie
  ein HTTP-Fehler (anderer Wortlaut).

### Phase 4 — Umschaltung ✅

Umgeschaltet wurde per Registry-Feld `"runtime": "app"` je Konnektor: Der
damalige Generator ließ umgeschaltete Konnektoren aus `flows.json` fallen, der
Dienst nahm genau sie auf; Node-RED und Dienst wurden je Gruppe gemeinsam
ausgerollt, die Endpunkte `/abfahrten` und `/warnungen.ics` einzeln in der
Cockpit-nginx umgestellt. In Produktion in **fünf Gruppen** mit
Beobachtungsfenster dazwischen:

1. Betrieb, Pollen, Hitze, Vorhersage, hystreet
2. Wetter, Pegel, Luft, Zählstellen
3. Warnungen, Baustellen, Overpass, MaStR, Retention
4. Parken, Sharing, Laden, ÖPNV (samt `/abfahrten`)
5. Puls, Stammdaten, Grenzen

Den Rückweg (Feld zurückdrehen) hat keine Gruppe gebraucht.

**Was die Umschaltung gelehrt hat:**

- **Datenbank-Switchover bei jedem Release.** Jedes Chart-Release baute alle
  eigenen Images bit-verschieden neu; CloudNativePG vergleicht die
  Image-Referenz als Zeichenkette und rollte deshalb bei jedem Release den
  Datenbank-Cluster samt Primary-Switchover — und der Dienst verlor jedes Mal
  seinen Schreib-Lock. Behoben an zwei Stellen: Die Image-Pipeline verwendet
  unveränderte Images wieder (inhaltsadressiert über einen Hash der
  Build-Eingaben, Tag `inputs-<hash>`), und das Chart referenziert eigene
  Images nur noch per Digest, nicht per wanderndem Tag. Zusätzlich lädt der
  Dienst seinen Zustand nach einem Lock-Verlust sofort im Hintergrund nach.
- **Open-Meteo-Kontingent.** Wetter (alle 4 h) und Vorhersage (alle 2 h)
  stießen zusammen an das Tageskontingent von Open-Meteo (je Lauf 8 Batches
  über alle Gemeinden); beide laufen jetzt alle 6 h.
- **TRoE-Vacuum.** `troe-retention` setzt vorab Autovacuum-Schwellen (1 %) und
  fährt nach dem Lauf `VACUUM (ANALYZE)` auf `attributes`/`subattributes`,
  damit die nächtlichen Löschmengen zügig wieder freigegeben werden.
- **Geo-Bootstrap.** Der Dienst lädt `bw-gemeinden.json` und `bw-grenzen.json`
  beim Start selbst vom Cockpit; so konnten die geo-abhängigen Konnektoren vor
  `stammdaten-bw`/`grenzen-bw` umziehen, und ein Neustart wartet nicht auf
  deren Takt.
- **Zustandsspeicher.** Signaturen, Prune-Buchführung und persistierter
  Zustand in PostgreSQL (s. oben) machten Neustarts billig: Einmalig voll
  geschrieben hat nur der Erstlauf je umgeschaltetem Konnektor.
- **Startverhalten.** Endpunkt-Konnektoren starten sofort (sonst antwortete
  `/abfahrten` nach jedem Neustart minutenlang 503), und das Intervall zählt
  ab dem ersten Lauf statt ab Prozessstart.

### Phase 5 — Betrieb nachziehen (1 Agent) ✅

Umgesetzt, siehe `docs/betrieb.md`, Abschnitt „Konnektordienst“:

- **Compose:** Dienst `connectors` (Container `udp-connectors`), Registry
  read-only aus dem Checkout, 1880 nur im Compose-Netz, 1881 nur auf
  `127.0.0.1` im Container, Healthcheck auf `/healthz` im Container.
- **Helm:** Deployment `connectors` (`replicas: 1`, `Recreate`,
  read-only Root-FS), Service nur mit 1880, NetworkPolicy 1880 nur vom
  Cockpit; der Dienst darf zu Orion-LD, TimescaleDB und zum Cockpit (statische
  Stammdaten), unter `strictEgress` ins Internet. Image `udp-connectors` in der
  Image-Pipeline und im Digest-Pinning.
- **Cockpit-nginx:** je Endpunkt ein Upstream (`UDP_ABFAHRTEN_UPSTREAM`,
  `UDP_WARNUNGEN_UPSTREAM`), damals mit Vorgabe Node-RED — seit Phase 6 ein
  gemeinsamer Upstream `UDP_CONNECTORS_UPSTREAM`.
- **Generator:** `"runtime": "app"` entfernte den Konnektor aus `flows.json`,
  der Status-Export trug `runtime` (beides seit Phase 6 entfallen).
- **Skripte:** `trigger-connector.sh` löst per `POST /trigger/<id>` im
  Container aus; `healthcheck.sh` zeigt den Zustandsspeicher.

`/trigger` und `/healthz` liegen auf dem **Admin-Port** 1881
(`UDP_CONNECTORS_ADMIN_PORT`), nicht auf dem öffentlichen Port 1880. Das Skript
muss den Admin-Port ansprechen. Kein Proxy (nginx, APISIX, Ingress) darf ihn
weiterreichen; in Compose höchstens auf `127.0.0.1` veröffentlichen.

Der Dienst läuft mit **genau einer** Replik: Helm `replicas: 1` und
`strategy: Recreate` (eine zweite Instanz bekäme den Schreib-Lock nicht und
führe keine gegateten Konnektoren). Er braucht `TROE_DB_*` und für das Schema
`udp_connectors` das Recht `CREATE` auf der Datenbank `orion` (oder das Schema
wird vorab angelegt); ein Volume braucht er nicht. Die Liveness-Probe nicht an
`stateStore.healthy` koppeln — ein Neustart repariert keine Datenbank.

### Phase 6 — Abbau ✅

- **Node-RED** läuft auf dem Upstream-Image `nodered/node-red:4.1`;
  `flows.json` ist nur noch der Beispiel-Tab (5 Nodes, eingecheckt, nicht mehr
  generiert). Im Chart kommen `flows.json` und `settings.js` aus der ConfigMap
  `node-red-config` (Kopien unter `helm/udp/files/nodered/`, ein Test hält sie
  gleich), ein initContainer kopiert sie in ein `emptyDir`. `node-red-udp` ist
  aus Image-Matrix und Digest-Pinning gefallen, `platform/config/nodered/
  Dockerfile` gelöscht.
- **`settings.js`** ohne `contextStorage` (localfilesystem) und mit
  `functionExternalModules: false` — beides brauchte nur die Ingestion.
- **Node-RED ohne Ingestion-Rechte:** keine `TROE_DB_*`, kein
  `HYSTREET_API_TOKEN` (Compose und Helm); NetworkPolicy: kein Zugriff auf
  TimescaleDB und `cockpit:8080`, kein Internet unter `strictEgress`; Orion-LD
  bleibt erreichbar (der Beispielfluss schreibt dorthin). Der hystreet-Token
  heißt im Chart jetzt `connectors.hystreetApiToken` bzw.
  `connectors.hystreetExistingSecret`; die alten Schlüssel unter `nodeRed.`
  werden weiter gelesen.
- **Generator → Status-Export:** `scripts/generate-nodered-flows.py` (3.980
  Zeilen) ist ersetzt durch `scripts/export-connector-status.py` (~50 Zeilen),
  das nur `gui/public/connectors-status.json` schreibt (ohne das Feld
  `runtime`). CI-Drift-Check und `deploy/deploy.sh` rufen es auf.
- **Registry:** `runtime` und `nodePrefixes` entfernt. Der Dienst führt jeden
  aktiven Eintrag aus, für den ein Modul existiert
  (`Registry.activeEntries()`); `test/parity/registry.test.ts` hält Registry
  und Module gleich. Die Registry-Prüfung ignoriert die beiden Felder, falls
  ein Fork sie noch trägt.
- **Cockpit-nginx:** ein Upstream `UDP_CONNECTORS_UPSTREAM` (Vorgabe
  `connectors:1880`; Helm `cockpit.connectorsUpstream`, Vorgabe der Service
  `connectors`) für beide Endpunkte. Die Umschalter `UDP_ABFAHRTEN_UPSTREAM`/
  `UDP_WARNUNGEN_UPSTREAM` und `cockpit.endpoints` entfallen — einen Rückweg
  zu Node-RED gibt es nicht mehr. Ein übrig gebliebener Wert wird gemeldet
  (Compose) bzw. bricht das Rendern ab, sofern er nicht `connectors` ist
  (Helm).
- **Skripte:** `trigger-connector.sh` ohne Node-RED-Pfad; `healthcheck.sh`
  zählt nur noch die Logs des Konnektordienstes.
- **Tests:** Generator- und Flow-Tests entfernt. Jede Invariante, die
  Produktionsverhalten schützt, zeigt jetzt auf die portierten Module bzw.
  deren Tests. Die alten Function-Nodes bleiben eingefroren in
  `platform/connectors/test/fixtures/legacy-flows.json` und sind über die
  Paritätstests weiter die Regressionssuite.
- **Anforderungsabdeckung:** B.II.4 beschreibt Node-RED jetzt als
  Low-Code-Werkzeug mit Beispielfluss, die Ingestion im Konnektordienst.

## Risiken und Vorabentscheidungen

Jede Zeile ist eine Stelle, an der eine wörtliche Portierung das Verhalten
trotzdem ändert. Sie gehören in den Vertrag, bevor die Agenten starten.

| Risiko | Was passiert | Entscheidung | Grad |
|---|---|---|---|
| **join-Timeout** | Die neun `join`-Nodes geben nach 60–1500 s *unvollständige* Arrays weiter. `Promise.allSettled` wartet auf alles. | Je Konnektor entscheiden und im Modulkopf begründen. Voreinstellung: Teilergebnis mit gezählter Warnung — wie heute. | hoch |
| **Zeilenbudget** | `rowBudget24h` ist die stehende Sicherung aus dem ParkAPI-Vorfall und hängt im `troe-stats`-Function-Node. | Wandert als Erstes mit (Agent A), nie stillgelegt — auch nicht kurz während der Umschaltung. | hoch |
| **Taktung** | 25 `delay`-Nodes takten mit `drop: false`; die Warteschlange ist unbegrenzt. | Token-Bucket bekommt eine Obergrenze und meldet Überlauf, statt still zu wachsen. | mittel |
| **efa-abfahrten** | 23 Function- plus 46 HTTP-Nodes werden eine Schleife; das Anfrageprofil gegen EFA-BW ändert sich. | Nebenläufigkeit explizit deckeln. | mittel |
| **Signaturspeicher** | Ohne dauerhaften Zustand schreibt jeder Neustart alle Gate-Entitäten voll (~400k TRoE-Zeilen); unter Compose hielt Node-RED ihn auf einem Volume. | Vor der ersten Umschaltung in PostgreSQL (Schema `udp_connectors`): Laden vor dem ersten Lauf, ohne geladenen Zustand kein gegateter Lauf, ein Schreiber per Advisory-Lock. Einmalig voll schreibt nur der Erstlauf je umgeschaltetem Konnektor. | hoch, behoben |
| **Fremddaten-Parser** | 29 Quellen brauchen je eine `unknown`-Parsefunktion; die Versuchung, sie durch ein `as` zu ersetzen, ist groß. | Lint verbietet die Abkürzung technisch; der Kernel liefert Bausteine, damit der ehrliche Weg der kürzeste ist. | mittel |
| **Startverhalten** | `refireOnRestart: false` heißt heute `onceDelay: 600` — verzögert feuern, nicht aussetzen. Wer es als „gar nicht“ nachbaut, lässt vier Konnektoren verhungern. | Im Vertrag ausbuchstabieren, samt Begründung aus `docs/betrieb.md`. | niedrig |
| **B.II.4** | Die Leistungsbeschreibung nennt Node-RED namentlich. | Container und Beispiel-Tab bleiben; Formulierung in Phase 6 nachziehen. | niedrig |

## Was am Ende verschwindet

Stand nach Phase 6: alles umgesetzt.

| Vorher | Danach |
|---|---|
| `flows.json` — 442 KB, 367 Nodes | ~2 KB, 5 Nodes (Beispiel-Tab) |
| `generate-nodered-flows.py` — 3.101 Zeilen | `export-connector-status.py`, ~50 Zeilen, nur noch `connectors-status.json` |
| CI-Drift-Check auf `flows.json` | entfällt (Drift-Check nur noch auf den Status-Export) |
| `node-red-udp` in Image-Matrix + Digest-Pinning | Upstream-Image `nodered/node-red:4.1` |
| `functionExternalModules` + `pg` im Node-RED-Image | entfällt |
| `nodePrefixes` in der Registry | entfällt — Trigger läuft über die id |
| Invarianten per Regex über Quelltext | 29 Paritätstests über Fixtures |
| `// 0 id · 1 lat · 2 lon` — Spaltenkunde als Kommentar | benannte Tupeltypen, vom Compiler geprüft |
| `if (!msg.payload \|\| !Array.isArray(…)) return null` | eine Parsefunktion je Quelle, `unknown` → Typ |

## Aufwand

Phase 0 einen halben Tag. Phasen 1 und 2 laufen parallel, zusammen etwa einen
Tag. Phase 3 ist mit sieben Agenten in ein bis zwei Tagen Wanduhrzeit durch —
das Nadelöhr ist das Review, nicht das Schreiben. Phasen 4 und 5 zusammen einen
Tag, Phase 6 einen halben.

Dazwischen liegt, was sich nicht beschleunigen lässt: je umgeschalteter Gruppe
zwei, drei Tage Beobachtung im Parallelbetrieb. Konnektoren mit Tages- und
Wochentakt zeigen ihr Verhalten schlicht nicht schneller.

Realistisch gut eine Arbeitswoche aktive Arbeit, verteilt über zwei bis drei
Kalenderwochen.
