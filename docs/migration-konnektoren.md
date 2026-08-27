# Konnektoren aus Node-RED lösen

Migrationsplan: Die 29 Konnektoren wandern aus dem generierten
`flows.json`-Verdrahtungsdiagramm in einen TypeScript-Dienst
(`platform/connectors/`). Node-RED bleibt als Low-Code-Baustein stehen — nur
nicht mehr als Laufzeit der Ingestion.

Stand: **Phase 0 abgeschlossen** (Gerüst). Es ingestiert noch nichts.

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

### Phase 1 — Kernel und Vertrag (1 Agent, seriell)

`kernel/types.ts` zuerst; dort steht der Vertrag, alles andere setzt ihn um.
Dann die übrigen `kernel/`-Module plus `stammdaten-bw` und `grenzen-bw` — die
beiden füllen den Geo-Kontext, auf dem fast jeder andere Konnektor sitzt.
Rund 900 Zeilen.

Bewusst nicht parallelisiert: Der Kernel *ist* die Schnittstelle. Zwei Agenten
daran erzeugen zwei Schnittstellen.

*Fertig, wenn* `types.ts` den vollständigen `ctx`-Vertrag trägt, `tsc --noEmit`
und `eslint` sauber durchlaufen und ein Beispielkonnektor damit läuft.

### Phase 2 — Paritäts-Harness (1 Agent, parallel zu Phase 1)

`vm-runner.ts`, ein Aufzeichnungsskript für Fixtures, ein durchgearbeitetes
Beispiel. Hängt nur an `flows.json`, nicht am Kernel.

*Fertig, wenn* ein alter Function-Node und ein neues Modul auf derselben
Fixture nachweislich identische Entitäten liefern.

### Sperre: Vertrag eingefroren

Kernel-Review und ein grüner Beispiel-Paritätstest. Erst danach der Fan-out.
Ab hier sind Änderungen am `ctx`-Vertrag teuer — sie treffen sieben laufende
Agenten gleichzeitig. Der Vertrag ist eine Datei, die der Compiler durchsetzt:
Ein Modul, das nicht passt, fällt beim Build durch, bevor ein Mensch die erste
Zeile davon liest.

### Phase 3 — Portierung (7 Agenten, parallel)

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

*Fertig je Konnektor:* Modul + Parsefunktion + Fixture + grüner Paritätstest +
`tsc --noEmit` + `eslint` ohne Ausnahmen + Trockenlauf ohne Upsert. Vier der
sechs Punkte prüft die Maschine.

Was die Agenten **nicht** dürfen: Typen im Kernel ändern, `eslint-disable`
setzen, `as` oder `!` verwenden. Klemmt der Vertrag, ist das eine Meldung an
die Review — kein Umweg im eigenen Modul.

### Phase 4 — Umschaltung

Je Konnektor ein Feld `"runtime": "app"` in `platform/config/connectors.json`.
Der Generator lässt umgeschaltete Konnektoren aus `flows.json` fallen, der
Dienst nimmt genau sie auf. Gruppenweise, mit Beobachtungsfenster dazwischen.
Rückweg: Feld zurückdrehen.

`scripts/healthcheck.sh` muss dafür nicht angefasst werden — es misst die
Frische der Entitäten in Orion, nicht die Laufzeit, die sie geschrieben hat.

### Phase 5 — Betrieb nachziehen (1 Agent)

`trigger-connector.sh` auf `POST /trigger/:id` (id statt Präfixsuche über
`/flows`), Log-Grep in `healthcheck.sh`, Compose- und Helm-Dienst,
`UDP_NODERED_UPSTREAM` in der Cockpit-nginx, NetworkPolicy, `docs/betrieb.md`
und `docs/staedte-hinzufuegen.md`.

### Phase 6 — Abbau

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
