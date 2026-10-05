# Framework „Smart City Dashboards as a Service" — Betrieb & Referenz

Umsetzung von Masterplan §5 (Etappen F1–F6). Eine Ingestion, eine Frontend-Basis,
1.103 vorgeladene Kommunen-Dashboards mit Stufenmodell und Theme-Katalog.

## Architektur

```
platform/config/connectors.json          gui/public/dashboards.json
   Registry: JEDER Konnektor                Kommunen-Abweichungen (Stufe/Branding)
   │                                        │
   ▼                                        ▼
platform/connectors (Konnektordienst)   scripts/generate-city-pages.py (SSG)
   liest Registry, ein Modul je id         1.103 Stubs gui/public/g/<slug>/index.html
   │  scripts/export-connector-status.py   │
   │  → connectors-status.json             ▼
   ▼                                    stadt.html (Template) + smartcity-lib.js
Orion-LD/TRoE ◄─────────────────────────── + smartcity-theme.css (Themes)
                                           nginx: try_files … /g$uri/index.html
```

## Konnektor-Registry (`platform/config/connectors.json`)

Deklariert jeden Konnektor; der Konnektordienst führt jeden aktiven Eintrag mit
Modul aus. Felder je Eintrag:
`id`, `name`, `scope` (land|kreis|kommune|betrieb), `enabledFor` (AGS-Liste oder `"*"`),
`params` (je AGS, z. B. EFA-Stop-IDs), `intervalSeconds` (optional mit `intervalOffsetSeconds`: feste Uhrzeiten ab 00:00 UTC) **oder** `cron`,
`sollMinutes` (Monitoring-Ampel), `sampleEntity`, `provides` (steuert Frontend-Kacheln),
`attribution` (Quellenvermerk in der Fußzeile, Teile mit » · « getrennt),
`attributionLinks` (Textstelle → Link, z. B. Quelle und Lizenz), `license` und
`licenseUrl` (Lizenz der Quelle; Pflicht für jede aktive öffentliche Quelle,
docs/api.md „Lizenzen der Datenquellen“), `requiresSecret` (z. B. `HYSTREET_API_TOKEN` — Healthcheck
meldet „WARTET" statt Fehler), `active`, optional `refireOnRestart`, `healthUrl`,
`rowBudget24h`, `sensorDetailFor`, `pending`, `supersededBy`, `excludeSystems`
(nur GBFS: `[{ "pattern": "lime_*", "reason": "…" }]`, schließt Systeme der
Quelle mit Begründung von der Ingestion aus).

Regeln:
- Neuer Konnektor = Registry-Eintrag + Modul im Konnektordienst mit Test
  (`docs/staedte-hinzufuegen.md`, Stufe 3); Takt/Aktivierung kommen IMMER aus
  der Registry.
- `active: false` nimmt den Konnektor aus dem Zeitplan, aus den öffentlichen
  Seiten (keine Abfrage, kein Quellenvermerk) und aus dem Statusexport als
  aktive Quelle. Die Entitäten, die er schon geschrieben hat, bleiben im
  Broker — ein abgeschalteter Konnektor räumt nicht mehr selbst auf.
- **Abschalten aus Lizenzgründen** (Beispiel `pegel-lubw`): `active: false`,
  Seiten prüfen, ob sie die Entitäten noch direkt abfragen (der Pegel-Filter in
  `stadt.html` blendet `bw-hvz-*` aus), dann die Alt-Entitäten im Broker
  löschen — gezielt über ihr Id-Präfix, per NGSI-LD `DELETE` bzw.
  `POST /ngsi-ld/v1/entityOperations/delete` mit der Id-Liste aus
  `GET /ngsi-ld/v1/entities?type=<Typ>&idPattern=<Präfix>` (intern, am
  Broker, nicht über das öffentliche Gateway). Die TRoE-Historie bleibt davon
  unberührt und läuft mit der Retention aus (12 Monate). Für ausgeschlossene
  GBFS-Systeme (`excludeSystems`) braucht es das nicht: Ihre Entitäten
  veralten und der Prune des Konnektors löscht sie nach 24 h.
- Vollständiges Entfernen eines Konnektors = Registry-Eintrag, Modul samt Zeile
  in `src/connectors/index.ts` und Test löschen (`test/parity/registry.test.ts`
  hält beide Listen gleich). Anschließend die verwaisten Alt-Entitäten aus
  Orion-LD löschen (NGSI-LD DELETE). Die ehemaligen Reutlingen-Altkonnektoren
  wurden so auf die BW-Basis migriert und entfernt.
- Nach Änderung: `python3 scripts/export-connector-status.py` → Konnektordienst
  neu starten (Compose: `docker compose restart connectors`, bei Codeänderung
  mit `--build`) → `scripts/healthcheck.sh`.
- Kommune-spezifische Quellen (Stufe 3) sind normale Einträge mit `scope: kommune`
  und `enabledFor: ["<AGS>"]` — zentral verwaltet, derselbe Konnektordienst (Referenz:
  Reutlingen mit EFA-Abfahrten, B+R, Laden-live, DWD-Station).

## Eine-Basis-Prinzip (Betriebsregel)

Alle Daten werden landesweit ingestiert und per AGS zugeordnet
(strikt Punkt-in-Polygon über `bw-grenzen.json`, kein Zentroid-Fallback).
Kommunen-Dashboards sind AUSSCHLIESSLICH Filter auf diese Basis — keine
Parallel-Ingestion je Kommune. Reutlingen bezieht seine Basis-Kacheln aus
derselben Quelle wie Böllen; Stufe 3 ergänzt nur zusätzliche Quellen.

## Slugs & Seiten

- Slugs entstehen in `scripts/generate-bw-municipalities.py` (Feld 9 in
  `bw-gemeinden.json`): Transliteration, Kollisionen → Kreis-Suffix → volle AGS;
  reservierte Pfade in `RESERVED`.
- `scripts/generate-city-pages.py` erzeugt je Kommune einen SEO-Stub mit
  `window.STADT` und sequentiellem Bundle-Loader. Nach Slug-Änderungen neu laufen
  lassen, dann `npm --prefix gui run build`.
- nginx (`platform/config/nginx/cockpit.conf.template`):
  `try_files $uri $uri/ /g$uri/index.html /index.html;` → `/tuebingen` usw.

## Stufenmodell (`gui/public/dashboards.json`)

Konvention: **kein Eintrag = Stufe 1** (vorgeladen, Standard-Theme, Disclaimer).
Gepflegt werden nur Abweichungen — über `scripts/onboard-kommune.py`:

```
python3 scripts/onboard-kommune.py <slug> --stage 2 --theme wald \
    [--primary '#1e7a4f'] [--logo-url …] [--official-url …] [--kontakt …]
# danach: npm --prefix gui run build
```

Der Onboarder validiert freie Primärfarben auf Weiß-Kontrast ≥ 3:1; `--theme`
akzeptiert nur Katalog-Schemata. `stage` steuert im Template Disclaimer
(Stufe 1) vs. „In Kooperation" (ab 2), Branding-Variablen und Kuration;
Stufe-3-Kacheln erscheinen automatisch über `provides` der für die AGS
aktivierten Konnektoren.

## Theme-Katalog (F6)

- 7 Schemata: Standard (Münster-Blau), wald, bordeaux, petrol, violett,
  bernstein, schiefer — je hell/dunkel, Kachel-Kontrast ≥ 3:1 validiert
  (Protokoll als Kommentar in `smartcity-theme.css`).
- Layering: Themes ändern nur den **Brand-Layer** (`--accent`, `--tile`);
  der **Daten-Layer** (`--series-1..5`, Statusfarben) bleibt in allen Schemata
  die validierte Palette → Diagramme sind überall gleich lesbar.
- Hierarchie zur Laufzeit (`SC.themeSelector`): `?theme=` → localStorage je Pfad
  → `dashboards.json` `branding.theme` → Standard. Hell/Dunkel: Auto
  (prefers-color-scheme) oder erzwungen über `data-mode`.
- Neues Schema: Farbpaar mit dem dataviz-Validator prüfen, `[data-theme=…]`-Block
  in `smartcity-theme.css` ergänzen, Eintrag in `THEMES` (smartcity-lib.js) und
  in `THEMES` von `onboard-kommune.py`.

## Monitoring & Härtung

- `scripts/healthcheck.sh`: registry-getrieben, Frische je Konnektor gegen
  `sollMinutes` (OK/SPÄT/ROT/WARTET). Läuft standalone; Muster für Alarme.
- Hauptdashboard (`dashboard.html`, nur mit Anmeldung, s. `docs/betrieb.md`)
  liest `connectors-status.json` — ein Pflegeort.
- nginx-Micro-Cache (`proxy_cache udpapi`): NGSI-LD 60 s, Temporal 300 s,
  `X-Cache: HIT/MISS`-Header als Nachweis. Schützt Orion bei öffentlichem Traffic
  (Lasttest 50 parallel: 0 Fehler).
- Orion-LD-Fallstricke (Apostroph-Sanitizer, 2-KB-Compound-Grenze, `asArray`)
  siehe docs/betrieb.md — gelten für jeden neuen Konnektor.

Städte hinzufügen/ausbauen: siehe Manifest [`staedte-hinzufuegen.md`](staedte-hinzufuegen.md).

## Gemeinde-Puls

`puls-bw` verdichtet stündlich die Aggregate der übrigen Konnektoren zu einem
Index 0–100 je Gemeinde (`CityPulse:bw-<ags>`, gewichtetes Mittel):

| Komponente | Wert = 100 bei | Gewicht |
|---|---|---|
| Feinstaub (Bürgersensoren, nur Werte < 2 h) | PM2,5 = 0 | 0,3 |
| Luftindex (UBA) | Index 1 | 0,2 |
| ÖPNV (Median-Verspätung, < 2 h) | 0 min | 0,2 |
| Laden (freie Live-Ladepunkte) | alle frei | 0,15 |
| Baustellen (BEMaS via MobiData BW, landesweit) | keine Baustelle | 0,15 |
| Sharing (frei flottierende Fahrzeuge aller Arten je 1.000 Einwohner) | ≥ 5 | 0,1 |
| B+R (freie Plätze aller Konnektoren, < 6 h) | alle frei | 0,05 |
| Warnlage (Kreis) | keine Warnung | 0,2 |

Ein Puls entsteht nur mit mindestens drei Komponenten **ohne** die Warnlage –
die gibt es für jeden Kreis und zählt deshalb nicht mit. Baustellen gehen
überall ein, solange der Feed aktuell ist (keine Baustelle = 100). Sharing ist
auf die Einwohnerzahl normiert; die rohe Fahrzeugzahl benachteiligte kleine
Orte. Es zählen alle frei flottierenden Fahrzeuge (E-Scooter, Räder, Mopeds,
Autos), nicht die an Stationen angedockten Räder und Autos stationsgebundener
Anbieter. Fällt eine Gemeinde unter drei Komponenten, wird ihr Puls nach 24 h
gelöscht. Scheitert eine der Abfragen, entfällt der Lauf.

Offene Entscheidung: Fahrzeuge eines Anbieters ohne `vehicle_types` zählen als
„sonstige“ (`other`), passend zu „unbekannt“ in `carsharing-bw`. Laut GBFS
wären es Fahrräder; umgestellt würde das nur in beiden Konnektoren zugleich.

## Bekannte Schulden / Folgepunkte

- `dashboard.html` trägt noch eigene
  Kopien der Basis-Styles/JS-Helfer (Verhalten identisch; Migration auf
  smartcity-lib/theme.css ist reine Aufräumarbeit). Theme-Selektor ist bewusst
  nur auf den Kommunen-Seiten (stadt.html) aktiv.
- Öffentliches Hosting/Domain (dashboard.example.de, CNAME je Kommune) ist ein
  separater Ops-Schritt; lokal ist alles unter :3700 lauffähig.
- Die Stufen 3/4 (kommunenspezifische Konnektoren, eigener Betrieb) sind
  organisatorisch offen — die Software selbst kennt keine Stufenbeschränkung.
