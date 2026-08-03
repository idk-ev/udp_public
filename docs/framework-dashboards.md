# Framework „Smart City Dashboards as a Service" — Betrieb & Referenz

Umsetzung von Masterplan §5 (Etappen F1–F6). Eine Ingestion, eine Frontend-Basis,
1.103 vorgeladene Kommunen-Dashboards mit Stufenmodell und Theme-Katalog.

## Architektur

```
platform/config/connectors.json          gui/public/dashboards.json
   Registry: JEDER Konnektor                Kommunen-Abweichungen (Stufe/Branding)
   │                                        │
   ▼                                        ▼
scripts/generate-nodered-flows.py       scripts/generate-city-pages.py (SSG)
   liest Registry → flows.json             1.103 Stubs gui/public/g/<slug>/index.html
   exportiert connectors-status.json       │
   │                                       ▼
   ▼                                    stadt.html (Template) + smartcity-lib.js
Node-RED → Orion-LD/TRoE ◄──────────────── + smartcity-theme.css (Themes)
                                           nginx: try_files … /g$uri/index.html
```

## Konnektor-Registry (`platform/config/connectors.json`)

Deklariert jeden Konnektor; der Flow-Generator ist Interpreter. Felder je Eintrag:
`id`, `name`, `scope` (land|kreis|kommune|betrieb), `enabledFor` (AGS-Liste oder `"*"`),
`params` (je AGS, z. B. EFA-Stop-IDs), `intervalSeconds` **oder** `cron`,
`sollMinutes` (Monitoring-Ampel), `sampleEntity`, `provides` (steuert Frontend-Kacheln),
`attribution` (Fußzeile), `requiresSecret` (z. B. `HYSTREET_API_TOKEN` — Healthcheck
meldet „WARTET" statt Fehler), `active`, `nodePrefixes` (Zuordnung zu generierten Nodes).

Regeln:
- Neuer Konnektor = Registry-Eintrag + Pipeline im Generator mit passendem
  `nodePrefix`; Takt/Aktivierung kommen IMMER aus der Registry.
- `active: false` entfernt die Nodes beim Generieren.
- Vollständiges Entfernen eines Konnektors = Registry-Eintrag löschen **und** den
  hartkodierten Pipeline-Block (`udp-rt-<prefix>-*`) im Generator entfernen (der
  Generator baut Pipelines in Python, nicht aus der Registry — eine gelöschte
  Registry ohne Code-Löschung erzeugt sonst verwaiste Nodes). Anschließend die
  verwaisten Alt-Entitäten aus Orion-LD löschen (NGSI-LD DELETE). Die ehemaligen
  Reutlingen-Altkonnektoren wurden so auf die BW-Basis migriert und entfernt.
- Nach Änderung: `python3 scripts/generate-nodered-flows.py` → Syntax-Check läuft im
  Container (`node --check`) → Node-RED neu starten → `scripts/healthcheck.sh`.
- Kommune-spezifische Quellen (Stufe 3) sind normale Einträge mit `scope: kommune`
  und `enabledFor: ["<AGS>"]` — zentral verwaltet, gleiches Node-RED (Referenz:
  Reutlingen mit EFA-Abfahrten, B+R, Laden-live, DWD-Station).

## Eine-Basis-Prinzip (Betriebsregel)

Alle Daten werden landesweit ingestiert und per AGS zugeordnet
(Punkt-in-Polygon über `bw-grenzen.json`, Fallback Zentroid-Distanz).
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
- Hauptdashboard (`dashboard.html`) liest `connectors-status.json` — ein Pflegeort.
- nginx-Micro-Cache (`proxy_cache udpapi`): NGSI-LD 60 s, Temporal 300 s,
  `X-Cache: HIT/MISS`-Header als Nachweis. Schützt Orion bei öffentlichem Traffic
  (Lasttest 50 parallel: 0 Fehler).
- Orion-LD-Fallstricke (Apostroph-Sanitizer, 2-KB-Compound-Grenze, `asArray`)
  siehe docs/betrieb.md — gelten für jeden neuen Konnektor.

Städte hinzufügen/ausbauen: siehe Manifest [`staedte-hinzufuegen.md`](staedte-hinzufuegen.md).

## Bekannte Schulden / Folgepunkte

- `dashboard.html` trägt noch eigene
  Kopien der Basis-Styles/JS-Helfer (Verhalten identisch; Migration auf
  smartcity-lib/theme.css ist reine Aufräumarbeit). Theme-Selektor ist bewusst
  nur auf den Kommunen-Seiten (stadt.html) aktiv.
- Öffentliches Hosting/Domain (dashboard.example.de, CNAME je Kommune) ist ein
  separater Ops-Schritt; lokal ist alles unter :3700 lauffähig.
- Die Stufen 3/4 (kommunenspezifische Konnektoren, eigener Betrieb) sind
  organisatorisch offen — die Software selbst kennt keine Stufenbeschränkung.
