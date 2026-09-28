# Konnektoren aus Node-RED lösen

Migrationsplan: Die 29 Konnektoren wandern aus dem generierten
`flows.json`-Verdrahtungsdiagramm in einen TypeScript-Dienst
(`platform/connectors/`). Node-RED bleibt als Low-Code-Baustein stehen — nur
nicht mehr als Laufzeit der Ingestion.

Stand: **Phasen 0, 1, 1b, 2, 3 und 3b abgeschlossen** (Gerüst, Kernel und
Vertrag, Paritäts-Harness, alle 29 Konnektoren portiert, Vertragslücken
geschlossen). Es ingestiert noch nichts — die Umschaltung ist Phase 4.

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
  Zustand bleibt im Speicher. Die 95-%-Referenz der Gemeindezahl wird nach
  einem Start aus der Zahl der `Municipality`-Entitäten in Orion gesetzt;
  solange Orion nicht antwortet, wird nicht aufgeräumt. Postgres folgt später
  zusammen mit dem Signaturspeicher.
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

- **`ctx.state`** — Zustand je Konnektor im Speicher (`stateKey(name, initial)`
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

Signaturspeicher, Prune-Buchführung und `ctx.state` liegen weiter im Speicher
und ziehen in Phase 6 **gemeinsam** nach Postgres.

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

*Konnektoren*

- `abfahrten-on-demand`: EFA über den gemeinsamen EFA-Bucket, ohne Retry, 30 s
  Timeout (502 nach 30 s statt nginx-504 nach 60 s); kein JSONP; ein
  Verzeichnis ohne `halte`-Objekt wird verworfen, das alte bleibt.
- `efa-abfahrten`: höchstens 2 Anfragen gleichzeitig, 500 ms Abstand (statt 23
  auf einmal); ein Batch-Upsert statt 23; fehlende `stopId` einmal je Prozess
  gewarnt.
- `warnungen-bw`: Anfrage **ohne Antwort** (DNS, Timeout, abgelehnt) zählt als
  „keine Daten“ — der Kreis behält seinen letzten Wert (alt: „keine
  Warnungen“); Teilgruppe nach Join-Timeout wird gewarnt.
- `/warnungen.ics`: Orion nicht erreichbar oder Fehlerantwort → **503** (alt:
  200 „Keine amtlichen Warnungen“); ein Lesezugriff ohne Retry.
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
  Systemliste je Lauf statt zwei (`carsharing-bw`).
- `ladesaeulen-bw`: alle Seiten abgewartet statt Join-Abbruch nach 420 s
  (Ergebnis bei langsamer Quelle gleich: unvollständig, kein Prune).
- `mastr-bw`, `uba-bw`: alle Anfragen abgewartet und einmal geschrieben statt
  Join-Timeout mit Nachzügler-Gruppe; `mastr-bw` verliert Rotation und
  Anlagenzahlen beim Neustart (wie K8s, anders als Compose).
- `baustellen-bw`: Ablauf-Löschung am Ende jedes Laufs statt eigenem Inject
  (gleicher Takt, ohne Versatz).
- `wetter-dwd-station`: ein Batch-Upsert statt einem je Station; Ausfälle als
  ein `[warn]` je Lauf statt `[error]` je Station.
- `hystreet`: über den Host-Bucket getaktet (alt: ungetaktet).
- `puls-bw`: Kommas in `attrs` URL-kodiert; Fehlertexte der Kernel-Listung.
- `ops-host`: Plattenbelegung aus `df -P /` statt `/data`.
- `pegel-bw`, `pegel-lubw`: Anfrage ohne Antwort ergibt dieselbe Warnung wie
  ein HTTP-Fehler (anderer Wortlaut).

### Phase 4 — Umschaltung

Je Konnektor ein Feld `"runtime": "app"` in `platform/config/connectors.json`.
Der Generator lässt umgeschaltete Konnektoren aus `flows.json` fallen, der
Dienst nimmt genau sie auf. Gruppenweise, mit Beobachtungsfenster dazwischen
(worauf zu achten ist: „Bewusste Abweichungen“ oben). Rückweg: Feld
zurückdrehen.

`scripts/healthcheck.sh` muss dafür nicht angefasst werden — es misst die
Frische der Entitäten in Orion, nicht die Laufzeit, die sie geschrieben hat.

### Phase 5 — Betrieb nachziehen (1 Agent)

`trigger-connector.sh` auf `POST /trigger/:id` (id statt Präfixsuche über
`/flows`), Log-Grep in `healthcheck.sh`, Compose- und Helm-Dienst,
`UDP_NODERED_UPSTREAM` in der Cockpit-nginx, NetworkPolicy, `docs/betrieb.md`
und `docs/staedte-hinzufuegen.md`.

`/trigger` und `/healthz` liegen auf dem **Admin-Port** 1881
(`UDP_CONNECTORS_ADMIN_PORT`), nicht auf dem öffentlichen Port 1880. Das Skript
muss den Admin-Port ansprechen. Kein Proxy (nginx, APISIX, Ingress) darf ihn
weiterreichen; in Compose höchstens auf `127.0.0.1` veröffentlichen.

### Phase 6 — Abbau

Signaturspeicher, Prune-Buchführung und `ctx.state` ziehen zusammen aus dem
Speicher nach Postgres (siehe Risiko „Signaturspeicher“).

`flows.json` schrumpft auf die fünf Beispiel-Nodes und passt damit wieder in
eine ConfigMap — womit `node-red-udp` aus Image-Matrix und Digest-Pinning fällt
und Node-RED auf dem Upstream-Image läuft. `settings.js` verliert
`functionExternalModules` und `contextStorage`, das Dockerfile das `pg`-Modul.
`docs/anforderungsabdeckung.md` wird auf den tatsächlichen Stand umformuliert.

## Risiken und Vorabentscheidungen

Jede Zeile ist eine Stelle, an der eine wörtliche Portierung das Verhalten
trotzdem ändert. Sie gehören in den Vertrag, bevor die Agenten starten.

| Risiko | Was passiert | Entscheidung | Grad |
|---|---|---|---|
| **join-Timeout** | Die neun `join`-Nodes geben nach 60–1500 s *unvollständige* Arrays weiter. `Promise.allSettled` wartet auf alles. | Je Konnektor entscheiden und im Modulkopf begründen. Voreinstellung: Teilergebnis mit gezählter Warnung — wie heute. | hoch |
| **Zeilenbudget** | `rowBudget24h` ist die stehende Sicherung aus dem ParkAPI-Vorfall und hängt im `troe-stats`-Function-Node. | Wandert als Erstes mit (Agent A), nie stillgelegt — auch nicht kurz während der Umschaltung. | hoch |
| **Taktung** | 25 `delay`-Nodes takten mit `drop: false`; die Warteschlange ist unbegrenzt. | Token-Bucket bekommt eine Obergrenze und meldet Überlauf, statt still zu wachsen. | mittel |
| **efa-abfahrten** | 23 Function- plus 46 HTTP-Nodes werden eine Schleife; das Anfrageprofil gegen EFA-BW ändert sich. | Nebenläufigkeit explizit deckeln. | mittel |
| **Signaturspeicher** | Die Änderungserkennung verliert ihren Stand heute bei jedem Neustart (in K8s bewusst, kein Volume auf `/data`). Postgres würde das beheben. | Erst *nach* grüner Parität umstellen — vorher verfälscht es genau die Diffs, mit denen geprüft wird. | mittel |
| **Fremddaten-Parser** | 29 Quellen brauchen je eine `unknown`-Parsefunktion; die Versuchung, sie durch ein `as` zu ersetzen, ist groß. | Lint verbietet die Abkürzung technisch; der Kernel liefert Bausteine, damit der ehrliche Weg der kürzeste ist. | mittel |
| **Startverhalten** | `refireOnRestart: false` heißt heute `onceDelay: 600` — verzögert feuern, nicht aussetzen. Wer es als „gar nicht“ nachbaut, lässt vier Konnektoren verhungern. | Im Vertrag ausbuchstabieren, samt Begründung aus `docs/betrieb.md`. | niedrig |
| **B.II.4** | Die Leistungsbeschreibung nennt Node-RED namentlich. | Container und Beispiel-Tab bleiben; Formulierung in Phase 6 nachziehen. | niedrig |

## Was am Ende verschwindet

| Heute | Danach |
|---|---|
| `flows.json` — 442 KB, 367 Nodes | ~2 KB, 5 Nodes (Beispiel-Tab) |
| `generate-nodered-flows.py` — 3.101 Zeilen | ~150 Zeilen, nur noch `connectors-status.json` |
| CI-Drift-Check auf `flows.json` | entfällt |
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
