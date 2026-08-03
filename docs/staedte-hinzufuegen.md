# Manifest: Wie man eine Stadt hinzufügt

Ein Dokument, eine Regel: **Jede Stadt baut auf derselben Datenbasis auf.** Es gibt
genau eine landesweite Ingestion (Node-RED → Orion-LD/TRoE, Zuordnung per
Amtlichem Gemeindeschlüssel/AGS mit Punkt-in-Polygon). Alle Dashboards sind
**Filter** auf diese Basis — kein Dashboard bringt eine eigene Ingestion mit.
Reutlingen (`/reutlingen`) ist die Referenz-Ausbaustufe und dient als **Template**
für alle 1.103 Gemeinden; das gemeinsame Template ist `gui/public/stadt.html`.

Die vier Stufen entsprechen dem Aufwand, nicht der Technik — die Datenbasis bleibt
dieselbe.

## Was das Template automatisch zeigt

`stadt.html` rendert **datengetrieben**: Jedes Element erscheint genau dann, wenn
die zugehörigen Entitäten zur AGS existieren. Es gibt keinen Reutlingen-Sonderfall
im Code — Reutlingen hat nur die vollständigste Datenlage.

| Element | Erscheint, wenn … |
|---|---|
| **Kacheln** Puls, Temperatur, Wind, Heute, Warnungen, Baustellen | immer (Landesbasis, alle 1.103 Gemeinden) |
| Kacheln Feinstaub, Luftqualität, NO₂, Parken, Sharing, Ladepunkte, Radverkehr, PV | Landesbasis-Entität zur AGS vorhanden (z. B. ~360 Gemeinden Feinstaub) |
| Kacheln Gefühlt, UV-Index, Morgen, Amtliche Station, Luftfeuchte, Ladepunkte-Livestatus, Carsharing, Leihräder, Ø ÖPNV-Verspätung, Abfahrtstafel | **seit 21.07. Landesbasis** — alle 1.103 Gemeinden, kein eigener Konnektor mehr nötig |
| Kacheln B+R, Passanten | weiterhin kommunenspezifisch (Datenquelle der Kommune bzw. Vertrag, s. Bauanleitung) |
| **Sichtbare Chart-Karten** (24 h, Klick → 24 h/48 h/7 Tage): Temperatur & Wind (mit DWD-Vergleich), Feinstaub amtlich vs. Bürgersensoren, NO₂/O₃ je UBA-Station, Sharing, Freie Parkplätze, Radverkehr-Tagessummen, PV-Zubau, B+R, Carsharing, Passanten | jeweilige Zeitreihe vorhanden — Reihenfolge/Auswahl in `CHART_ORDER` in `stadt.html` |
| **Karte mit abschaltbaren Ebenen** (Legende klickbar): Stationen (ÖPNV/Wetter/UBA), Ladestationen (Markerfarbe = Livestatus: grün frei / gelb belegt / rot defekt / grau ohne Livedaten), Carsharing, B+R, Feinstaubsensoren, Baustellen, Radzählstellen. Kräftige, ebenenweise unterscheidbare Farben (`MAP_C` in `stadt.html`); deckungsgleiche Pins werden im Kreis aufgefächert; sehr dichte Ebenen (> 80 Marker) starten eingeklappt | Standort-Entitäten zur Stadt vorhanden; Stations-IDs tragen den Slug als Präfix (`…:<slug>-…`) |
| Kacheln **Pollenflug** (DWD-Teilregion), **Pegel** (Messstelle im Ort, sonst die nächstgelegene bis 20 km — Gewässer enden nicht an Gemeindegrenzen; LUBW/HVZ + WSV), **Ausflugsziele** (OSM), **CO₂ vermieden** (aus PV berechnet) | Landesbasis — erscheinen automatisch, sobald zur AGS Daten vorliegen |
| Kachel **Hitzebelastung** (DWD Thermischer Gefahrenindex) | Landesbasis — nächstgelegene von 5 Vertreterstädten, erscheint nur bei Belastung |
| Kachel + Kartenebene **Familie & Versorgung** (Apotheke, Arzt, Kita, Spielplatz, AED, Trinkwasser) | Landesbasis `poi-bw` (OSM/ODbL), sobald Overpass-Ingest gelaufen |
| **Vier Bürgerservice-Kacheln** Rathaus & Bürgerbüro · Mängel melden · Müllabfuhr · Veranstaltungen | **immer, auf jeder Gemeinde.** Rathaus: OSM-Öffnungszeiten (»geöffnet«, sonst »ab 14:00« bzw. »heute zu«), sonst amtliche Website (Wikidata P856, `gemeinde-services.json`). Die übrigen drei: kuratierter Link aus `dashboards.json` (`links{}`), sonst leere **Potenzial-Kachel** (gestrichelt, Klick → `mitmachen.html`) als sichtbarer Ausbau-Hinweis |
| **Themen-Gruppierung** | Kacheln werden nach Thema sortiert dargestellt (Überblick → Wetter → Umwelt → Mobilität → Energie → Service), passend zur Filterleiste. Zahlen einheitlich deutsch (Tausenderpunkt, Dezimalkomma) |
| Vorhersage-Karte (4 Tage) + Kacheln »Morgen«, »Gefühlt«, »UV-Index« | **Landesbasis** (`vorhersage-bw`, 2-h-Takt, alle 1.103) |
| Abfahrtstafel + Ø ÖPNV-Verspätung | **Landesbasis** — beim Seitenaufruf über `/abfahrten?ags=…` abgefragt (EFA-BW, sekundenaktuell). Voraussetzung ist ein Halt in `gui/public/oepnv-halte.json` (erzeugt `scripts/efa-haltestellen.py`) |

Vergleichswerte heute: Reutlingen 22 Kacheln + 8 Chart-Karten + 8 Kartenebenen,
Tübingen 14 + 7 + 4 (automatisch, ohne je konfiguriert worden zu sein), Böllen 6 + 2.

## Stufe 1 — nichts zu tun (bereits live)

Jede der 1.103 BW-Gemeinden hat schon ein vorgeladenes Dashboard unter `/<slug>`
(z. B. `/tuebingen`, `/boellen`). Der Slug steht als 9. Feld in
`gui/public/bw-gemeinden.json`. Auffindbar über die Kommunen-Suche
im Hauptdashboard (`/dashboard.html`); Landkreise haben eine aggregierte
Kreissicht unter `/kreis-<slug>` (z. B. `/kreis-reutlingen`). Kennzeichnung: „inoffizielles Angebot aus offenen Daten",
Standard-Theme, Lücken-Hinweis. **Kein Schritt nötig.**

## Neue Gemeinde oder geänderter Zuschnitt

Nur wenn sich die Gemeindeliste/Geometrie ändert (selten):

```bash
python3 scripts/generate-bw-municipalities.py            # Quelle -> bw-gemeinden.json (Slugs, Feld 9)
python3 scripts/generate-bw-municipalities.py --grenzen  # nur bei Geometrieänderung -> bw-grenzen.json (PiP)
python3 scripts/generate-city-pages.py                   # SEO-Stubs gui/public/g/<slug>/index.html
npm --prefix gui run build                               # dist aktualisieren
```

`bw-grenzen.json` wird von Node-RED über `http://cockpit/bw-grenzen.json` in den
globalen Kontext geladen (Punkt-in-Polygon). Nach Grenzänderung Node-RED neu
starten.

## Stufe 2 — individualisieren (Branding + Theme)

Kostenlos gegen offizielle Verlinkung. Ein Aufruf schreibt `dashboards.json`:

```bash
python3 scripts/onboard-kommune.py <slug> --stage 2 --theme <name> \
    [--primary '#1e7a4f'] [--accent '#…'] [--logo-url …] [--official-url …] [--kontakt …]
npm --prefix gui run build
```

- `--theme`: eines der Katalog-Schemata (`wald`, `bordeaux`, `petrol`, `violett`,
  `bernstein`, `schiefer`) — je hell/dunkel kontrast- und CVD-geprüft.
- `--primary`/`--accent`: freie Farben werden gegen Weiß-Kontrast ≥ 3:1 validiert.
- Wirkung: „In Kooperation"-Kennzeichnung, gesetztes Standard-Theme (die Besucher-
  Auswahl über 🎨 bleibt möglich), Logo, offizieller Verweis.

Kuratierte Link-Kacheln (kommunale Angebote ohne offene API) setzt man mit:

```bash
python3 scripts/onboard-kommune.py <slug> \
    --link veranstaltungen=https://… --link maengelmelder=https://… \
    --link baeder=https://… --link abfall=https://…
```

Die Kacheln erscheinen in den Filtern »Service« (Mängel, Müll) bzw. »Freizeit« (Veranstaltungen, Bäder) und öffnen extern.

Theme-Auswahl ist auf **jedem** Dashboard vorhanden (Selektor 🎨 im Kopf); Stufe 2
setzt nur den kommunalen Standard über `branding.theme` in `dashboards.json`.

## Stufe 3 — überwiegend erledigt

**Seit dem 21.07.2026 ist der Großteil der Stufe-3-Bausteine Landesbasis.** Sie
waren nie technisch an eine Kommune gebunden — die Landeskonnektoren holten die
Daten ohnehin für ganz Baden-Württemberg, ausgewertet wurde aber nur ein
Ausschnitt. Für die folgenden Bausteine ist **nichts mehr zu tun**:

| Baustein | Status | Abdeckung |
|---|---|---|
| **Ladesäulen: Standorte + Livestatus** | Landesbasis `ladesaeulen-bw` | 11.409 Standorte in 856 Gemeinden, 4.916 mit Livestatus |
| **Carsharing** (stationsgebunden) | Landesbasis `carsharing-bw` | 308 Gemeinden, 58 Anbieter aus der GBFS-Landesliste |
| **Leihräder** (stationsgebunden) | Landesbasis `carsharing-bw` | eigene Kachel, nach `vehicle_types` von Autos getrennt |
| **Amtliche DWD-Station** | Landesbasis `wetter-dwd-station` | 183 Stationen; das Dashboard wählt die nächstgelegene und nennt die Entfernung |
| **Vorhersage** (2-h-Takt, gefühlt, UV, Sonnenzeiten) | Landesbasis `vorhersage-bw` | alle 1.103 Gemeinden |
| **Feinstaub-Einzelsensoren** | Landesbasis `feinstaub-bw` | 909 Sensoren in 346 Gemeinden |
| **ÖPNV-Abfahrten + Verspätung** | Abruf auf Anfrage `/abfahrten?ags=…` | alle Gemeinden mit Halt in `oepnv-halte.json` |

Zum ÖPNV eine Einordnung, weil sie die Architektur erklärt: Ein Dauerabruf für
1.103 Gemeinden im 5-Minuten-Takt wären 318.000 Anfragen am Tag gegen die
EFA-BW-Auskunft. Das ist ohne Vereinbarung mit dem NVBW nicht vertretbar (die
Klärung steht aus). Der Abruf erfolgt deshalb **erst beim Öffnen eines
Dashboards**; die Last skaliert mit tatsächlichen Aufrufen statt mit der Zahl
der Gemeinden, und die Anzeige ist dabei sekundenaktuell statt bis zu fünf
Minuten alt. Der Micro-Cache des Cockpit-nginx (60 s) fängt Andrang auf
denselben Halt ab. Der Dauerabruf besteht nur noch für die Städte in
`efa-abfahrten.enabledFor` — deren Verlaufsdaten speisen den Gemeinde-Puls.

### Was echte Kommunenarbeit bleibt

Diese Bausteine brauchen eine Datenquelle, die es nur lokal gibt — sie lassen
sich nicht landesweit ausrollen:

| Baustein | Schaltet frei | Was zu tun ist |
|---|---|---|
| **B+R Fahrradparken** (`br-…`) | B+R-Kachel + -Chart + Kartenebene | Datenquelle der Kommune (z. B. DB-/Kommunal-API); Block `br-hbf` als Vorlage |
| **Passantenfrequenz** (`hystreet`) | Passanten-Kachel + -Chart | AGS in `enabledFor`, Standort-Slug in `params`, Token in `.env` (`requiresSecret`) — proprietäre Quelle, Vertrag nötig |
| **Müllabfuhr-Termine** | Kachel »nächste Abfuhr« je Fraktion | iCal/JSON-Feed des Entsorgers (viele bieten `.ics` je Straße) → Konnektor `abfall-<kommune>`, Entität `WasteCollection:<slug>`. Ohne Feed: Link-Kachel (s. Stufe 2) |
| **Wartezeit Bürgerbüro** | Kachel »aktuelle Wartezeit / freie Termine« | Terminsystem der Kommune (tevis, netcall, Qmatic u. a.) bietet meist eine JSON-Statusabfrage — Zugang über die Kommune erfragen |
| **Bäderauslastung** | Kachel »Auslastung« + Verlauf | Betreiber-Sensorik (Drehkreuz-/Kassensystem) — Vertrag mit Stadtwerken/Bäderbetrieb |
| **Veranstaltungen als Daten** | Liste statt Link-Kachel | City-API/Kalender-Export (ics/JSON) der Kommune oder des Tourismusverbands |

Wichtig fürs Template: Stations-Entitäten (Laden, Carsharing, Sensoren …) müssen
den **Stadt-Slug als ID-Präfix** tragen (`urn:…:<slug>-…`) — darüber filtert die
Karte; Aggregat-Kacheln laufen über das `ags`-Attribut. Neue Bausteine, die es in
Reutlingen nicht gibt, folgen dem allgemeinen Schema:

1. **Registry-Eintrag** in `platform/config/connectors.json`:
   ```json
   {
     "id": "efa-abfahrten", "name": "ÖPNV-Abfahrten (EFA-BW)",
     "scope": "kommune", "enabledFor": ["08415061"],
     "params": { "stopId": { "08415061": "de:08415:22006" } },
     "intervalSeconds": 300, "sollMinutes": 5,
     "sampleEntity": "urn:ngsi-ld:PublicTransportStop:reutlingen-hbf",
     "provides": ["departures"], "attribution": "EFA-BW (naldo/bwegt)",
     "requiresSecret": null, "active": true, "nodePrefixes": ["udp-rt-o-"]
   }
   ```
2. **Pipeline-Block** in `scripts/generate-nodered-flows.py` mit passendem
   `nodePrefix` (inject → http_get → func → upsert). Bestehende Blöcke als Vorlage.
3. **Generieren & starten:**
   ```bash
   python3 scripts/generate-nodered-flows.py     # baut flows.json + connectors-status.json
   docker restart udp-node-red
   bash scripts/trigger-connector.sh <id>         # nur bei refireOnRestart:false
   bash scripts/healthcheck.sh                    # Frische-Ampel je Konnektor
   ```
   Quellen mit strengen Anbieter-Limits (Overpass u. a.) bekommen in der
   Registry `"refireOnRestart": false` — sie feuern dann nicht bei jedem
   Neustart, sondern nur nach Zeitplan bzw. auf Zuruf (s. `docs/betrieb.md`).
4. **Frontend** (nur bei neuem `provides`-Typ): Render-Pfad in `gui/public/stadt.html`
   ergänzen. `provides` steuert, welche Kachel erscheint; `sampleEntity` liefert den
   Wert. Für Klick-Detailtiefe einen Eintrag in die `DETAILS`-Registry setzen:
   - `kind:"chart"` — Zeitreihe (`SC.hist`), mit Zeitbereichs-Buttons
   - `kind:"bars"` — statische Balken (z. B. Jahreswerte)
   - `kind:"stations"` — Leaflet-Karte der Einzelstandorte + optional Balken

   Vorhandene `provides` und ihre Kacheln: `wetter`, `warnungen`, `baustellen`,
   `feinstaub`, `luft-uba`, `parken`, `sharing`, `laden`, `radverkehr`, `pv`,
   `departures`, `br`, `amtliche-station`, `laden-live`, `laden-detail`,
   `carsharing-detail`, `passanten`, `vorhersage`.
5. **Secrets:** `requiresSecret` (z. B. `HYSTREET_API_TOKEN`) in `platform/.env`;
   der Healthcheck meldet „WARTET" statt Fehler, bis das Secret gesetzt ist, und
   die Kachel erscheint automatisch, sobald der Konnektor liefert.

## Stufe 4 — eigene Plattform

Dedizierter NGSI-LD-Mandant bzw. eigene UDP-Instanz (Keycloak-Rollen, eigener
Open-Data-Katalog/CKAN, SLA, Datenhoheit) — Projektgeschäft, außerhalb dieses
Manifests. Anfragen an **info@idkev.de**.

## Prüfliste

- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:3700/<slug>` → 200
- [ ] Neue Konnektoren im Healthcheck „OK" (oder „WARTET" bei Secret)
- [ ] Neue Kachel/Chart-Karte/Kartenebene erscheint auf `/<slug>`, Klick öffnet die Detailansicht
- [ ] `npm --prefix gui run build` fehlerfrei
- [ ] Node-RED-Fehler 0 (`docker logs udp-node-red`)

Registry-Schema, Betriebsregeln und Micro-Cache: siehe
[`framework-dashboards.md`](framework-dashboards.md).
