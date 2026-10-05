# Öffentliche API und Datenvertrag

Die Plattform veröffentlicht ihre Daten als **offene Daten** über eine
lesende Schnittstelle. Dieses Dokument beschreibt, was davon öffentlich
erreichbar ist, was als **Vertrag** gilt (stabil, Änderungen nur mit
Ankündigung) und was intern ist.

Alle Beispiele nutzen den Platzhalter `https://udp.example.org` für die
öffentliche Adresse einer Instanz.

## Überblick

| Schnittstelle | Pfad | Inhalt |
|---|---|---|
| NGSI-LD Kontext-API (Orion-LD) | `GET /gateway/ngsi-ld/v1/…` | aktueller Zustand aller Entitäten |
| NGSI-LD Temporal-API (Mintaka) | `GET /gateway/temporal/temporal/entities/…` | Zeitreihen (TRoE) |
| ÖPNV-Abfahrten | `GET /abfahrten?ags=<AGS>` | Live-Abfahrten am zentralen Halt einer Gemeinde |
| Warnungen als Kalender | `GET /warnungen.ics?kreis=<Kreisschlüssel>` | amtliche Warnungen eines Kreises (iCalendar) |
| Vokabular (JSON-LD-Kontext) | `GET /ngsi-ld/udp-context.json` | eingefrorene Typ- und Attributnamen, s. [Vokabular](#vokabular) |

### Kontext-API

Die übliche NGSI-LD-API (ETSI GS CIM 009) des Brokers, nur lesend:

```bash
# alle Wetterbeobachtungen einer Gemeinde (AGS 08415061 = Reutlingen)
curl 'https://udp.example.org/gateway/ngsi-ld/v1/entities?type=WeatherObserved&q=ags==%2208415061%22&limit=100'

# eine Entität
curl 'https://udp.example.org/gateway/ngsi-ld/v1/entities/urn:ngsi-ld:Municipality:bw-08415061'

# vorhandene Typen
curl 'https://udp.example.org/gateway/ngsi-ld/v1/types'
```

- Öffentlich erreichbar sind genau drei Endpunkte: `/entities`,
  `/entities/{id}` und `/types`. Alle anderen Pfade des Brokers (u. a.
  `/attributes`, Subscriptions, Registrierungen, `/ex/v1/…`) antworten mit
  `404`.
- **Listenabfragen brauchen genau einen `type`-Parameter** mit einfachen
  Typnamen – ein Typ (`type=WeatherObserved`) oder eine kommagetrennte Liste
  (`type=ParkingSite,BikeParking`), nur Buchstaben, Ziffern, `_`, `.` und
  `-`, ohne leere Einträge. Abfragen ohne `type` (nur `q=…`, `idPattern=…`,
  `local=true`), mit zwei `type`-Parametern oder mit vollständigen URIs,
  Präfixen oder Typ-Ausdrücken (`|`, `;`, Klammern) beantwortet die
  Plattform mit `400`.
- **Erlaubte Parameter:** bei Listenabfragen `type`, `q`, `attrs`, `limit`,
  `offset`, `count`, `options`, `georel`, `geometry`, `coordinates`,
  `geoproperty` und `lang`; beim Einzelabruf und bei `/types` nur `attrs`,
  `options`, `lang` und `details`. Jeder Parameter als `name=wert`; andere
  Parameter (z. B. `jsonldContext`, `idPattern`, `local`) ergeben `400`.
- `limit` höchstens 1000, Blättern über `offset`; `count=true` liefert die
  Gesamtzahl im Header `NGSILD-Results-Count`.
- Fast alle Typen tragen das Attribut `ags` (Amtlicher Gemeindeschlüssel,
  8-stellig) – der übliche Filter ist `q=ags=="<AGS>"`.
- Der Broker antwortet mit den kurzen Namen aus der Tabelle unten; einen
  `Link`-Header (eigener `@context`) reicht der öffentliche Pfad nicht weiter.
- Buchstaben und Ziffern im Query-String nicht prozentkodieren (`%41` statt
  `A`): solche Anfragen weist die Plattform mit `403` ab.

### Temporal-API

Die Zeitreihen liefert Mintaka. Der doppelte Pfadteil ist kein Tippfehler:
`/gateway/temporal/` ist die Gateway-Route (APISIX entfernt das Präfix),
`/temporal/entities/…` der Pfad der Temporal-API selbst.

```bash
curl 'https://udp.example.org/gateway/temporal/temporal/entities/urn:ngsi-ld:WeatherObserved:bw-dwd-04160?attrs=temperature&timerel=after&timeAt=2026-10-01T00:00:00Z&options=temporalValues'
```

Abgefragt wird je Entität (`/temporal/entities/{id}`); Listenabfragen über
alle Entitäten (`/temporal/entities?…`) und die übrigen Mintaka-Pfade sind
öffentlich nicht erreichbar (`404`). Erlaubte Parameter: `attrs`,
`timerel`, `timeAt`, `endTimeAt`, `timeproperty`, `options`, `lastN`,
`aggrMethods`, `aggrPeriodDuration`; andere ergeben `400`. Wie weit die Historie
zurückreicht, legt der Betreiber über die Retention fest
([`betrieb.md`](betrieb.md), „Zeitreihen-Retention (TRoE)“); unveränderte
Wiederholungswerte können zusammengefasst sein.

### `/abfahrten`

`GET /abfahrten?ags=<8-stelliger AGS>` liefert die nächsten Abfahrten am
hinterlegten zentralen Halt der Gemeinde (Quelle: EFA-BW), abgerufen erst bei
Bedarf:

```json
{ "halt": "…", "stopId": "…", "stand": "2026-10-05T08:00:00.000Z",
  "medianVerspaetung": 1, "echtzeitAbfahrten": 12, "quelle": "…",
  "abfahrten": [ { "linie": "…", "ziel": "…", "zeit": "08:03", "verspaetung": 1 } ] }
```

Status: `200` (auch mit leerer Liste, wenn gerade nichts fährt), `404` für
eine Gemeinde ohne hinterlegten Halt, `502` bei gestörter Auskunft, `503`
solange das Haltestellenverzeichnis noch nicht geladen, der Dienst
ausgelastet oder das Tageskontingent der Auskunft aufgebraucht ist (mit
`Retry-After`). Alle Parameter außer `ags` werden ignoriert. Wird das
Tageskontingent knapp, bleiben Antworten bis zu 20 Minuten im Cache; ihr
Alter steht in `stand`.

### `/warnungen.ics`

`GET /warnungen.ics?kreis=<5-stelliger Kreisschlüssel>` liefert die aktiven
Warnungen (DWD, BBK/NINA) eines Kreises als iCalendar-Abo. Ohne gültigen
Parameter `400`; solange der Broker nicht erreichbar ist `503`.

### Weitere Pfade

Unter `/gateway/` sind auch FROST (SensorThings), CKAN, GeoServer und – falls
eingeschaltet – das Masterportal lesend erreichbar. Das sind die
Standard-Schnittstellen der jeweiligen Komponenten; dieser Vertrag deckt sie
nicht ab. Der IoT-Agent (Geräteverwaltung) ist öffentlich nicht erreichbar.

## Zugriff und Sicherheitsmodell

So ist die Plattform **heute** ausgeliefert:

- **Anonym und nur lesend.** Öffentlich erreichbar ist die API nur über den
  Cockpit-nginx. Er lässt auf `/gateway/…`, `/abfahrten` und `/warnungen.ics`
  nur `GET`, `HEAD` und `OPTIONS` durch; alles andere endet mit `403`. Eine
  Anmeldung oder ein Token gibt es nicht; einen `Authorization`-Header reicht
  der öffentliche Pfad nicht weiter.
- **Kein OIDC am Gateway.** Die APISIX-Routen werten keine Tokens aus; Keycloak
  ist deployt, wirkt aber auf die APIs nicht. Die Anmeldung im Cockpit ist im
  Helm-Chart standardmäßig aus (`cockpit.authEnabled: false`).
- **Ein Mandant.** Alle Daten liegen im **Standardmandanten** und sind
  öffentliche, offene Daten. Eine Mandantenwahl per `NGSILD-Tenant` ist am
  öffentlichen Pfad nicht vorgesehen. Getrennte, nicht öffentliche Mandanten
  setzen eine Durchsetzung am Gateway voraus, die noch fehlt – s.
  [`architektur.md`](architektur.md#mandantenmodell). Die Header
  `NGSILD-Tenant` und `Fiware-Service` verwirft der Cockpit-nginx.
- **Betriebsdaten nicht öffentlich.** Entitäten vom Typ `PlatformStatus`
  (Serverlast, Speicher, Datenbankkennzahlen) und ihre Historie liefert der
  öffentliche Pfad nicht aus (`403`), auch nicht als Teil einer anderen
  Abfrage.
- **Schreiben nur intern.** Konnektordienst, Node-RED und IoT-Agent schreiben
  innerhalb der Plattform direkt in den Broker, nicht über den öffentlichen
  Pfad.
- **CORS.** Die Gateway-Pfade erlauben Aufrufe aus dem Browser von beliebigen
  Origins (nur `GET`/`OPTIONS`).
- **Betriebsdashboard.** `/dashboard.html` und seine Daten unter `/ops/…`
  sind per HTTP Basic Auth geschützt
  ([`betrieb.md`](betrieb.md#hauptdashboard-nur-mit-anmeldung)).

Lokal unter Docker Compose ist das Gateway (`http://localhost:8780`) dagegen
direkt erreichbar, **einschließlich schreibender Methoden** – der Port ist
deshalb standardmäßig nur an `127.0.0.1` gebunden (`PROXY_BIND`).

## Rate-Limits

Je Client-Adresse; über dem Limit antwortet die Plattform mit `429`.

| Pfad | Limit | Einstellung |
|---|---|---|
| `/gateway/ngsi-ld/…`, `/gateway/temporal/…` | 30 Anfragen/s, Burst 150 | `apisix.rateLimit` (Helm); gezählt je APISIX-Replik |
| `/abfahrten` | 120 Anfragen/min, Burst 60 | `platform/config/nginx/cockpit.conf.template` |
| `/warnungen.ics` | 10 Anfragen/min, Burst 10 | `platform/config/nginx/cockpit.conf.template` |
| `/gateway/FROST-Server/…`, `/gateway/catalog/…`, `/gateway/geoserver/…`, `/gateway/portal/…` | 10 Anfragen/s, Burst 60, höchstens 10 gleichzeitige Verbindungen; FROST, CKAN und GeoServer zusätzlich wie oben | `platform/config/nginx/cockpit.conf.template`, `apisix.rateLimit` |

Antworten aus dem Cache (s. unten) zählen nicht gegen das Gateway-Limit.
Für Massenabzüge bitte `limit`/`offset` und eine moderate Abfragefrequenz
nutzen; die Daten ändern sich ohnehin höchstens im Minutentakt.

## Caching

Der Cockpit-nginx hält einen Micro-Cache vor allen öffentlichen Pfaden. Ob
eine Antwort aus dem Cache kam, steht im Header `X-Cache`.

| Pfad | Gültigkeit |
|---|---|
| `/gateway/ngsi-ld/…` | 60 s; leere Liste (`[]`) und `404` 10 s |
| `/gateway/temporal/…` | 60 s |
| `/abfahrten` | 60 s; `404` 30 s |
| `/warnungen.ics` | 300 s |

Bei Störungen des Upstreams liefert der Cache die letzte gültige Antwort
weiter aus (`X-Cache: STALE`). Der Cache-Schlüssel enthält neben der URL den
Header `Accept`. Zeitreihen-Abfragen mit einem auf die volle Minute
gerundeten `timeAt` teilen sich einen Cache-Eintrag.

## Stabilitätszusage

**Vertrag** – ändert sich nur abwärtskompatibel; eine inkompatible Änderung
wird im CHANGELOG angekündigt und nicht innerhalb einer Minor-Version
ausgeliefert:

- die Pfade aus dem [Überblick](#überblick) und ihre Parameter;
- das [Vokabular](#vokabular): Entitätstypen, Attributnamen und die URIs,
  unter denen sie gespeichert sind;
- die Antwortformate von `/abfahrten` (JSON-Feldnamen) und `/warnungen.ics`
  (iCalendar).

Zusammengesetzte Attributwerte (z. B. `departures`, `days`, `components`)
können um Felder ergänzt werden; Entfernen oder Umbenennen gilt als
inkompatibel. Neue Typen und Attribute kommen jederzeit hinzu.

**Kein Vertrag** – intern, kann sich mit jedem Release ändern:

- die statischen JSON-Dateien der Oberfläche, z. B. `oepnv-halte.json`,
  `gemeinde-services.json`, `dashboards.json`, `connectors-status.json`,
  `bw-gemeinden.json`;
- Aufbau und Inhalt der HTML-Seiten und Skripte (`smartcity-lib.js` u. a.);
- die Entitäten vom Typ `PlatformStatus` (Betriebsdaten der Plattform,
  öffentlich nicht abrufbar; ihre Namen stehen trotzdem im Vokabular);
- Typen, die Betreiber selbst über Node-RED oder den IoT-Agenten anlegen;
- Entitäts-IDs über das Präfix `urn:ngsi-ld:<Typ>:` hinaus. Sie sind aus den
  Schlüsseln der Quelle gebildet und bleiben stabil, solange die Quelle sie
  nicht ändert.

## Vokabular

Die Konnektoren schreiben ihre Entitäten nur mit dem **NGSI-LD-Core-Kontext
v1.6**. Jeder Name, den dieser Kontext nicht selbst definiert, wird über
dessen `@vocab` zu `https://uri.etsi.org/ngsi-ld/default-context/<Name>`
erweitert und so in MongoDB (Orion-LD) und in der Historie (TRoE)
gespeichert – im Index etwa als
`attrs.https://uri=etsi=org/ngsi-ld/default-context/ags.value`.

Diese Erweiterung ist eingefroren und als eigener JSON-LD-Kontext
veröffentlicht:

```
https://udp.example.org/ngsi-ld/udp-context.json
```

Er besteht aus dem Core-Kontext und einer **expliziten** Zuordnung jedes
Typ- und Attributnamens zu genau der URI, unter der er heute gespeichert ist.
Wer ihn verwendet, erhält also dieselbe Erweiterung wie der Broker.

- **Brauche ich ihn?** Für die API nicht: Antworten ohne `Link`-Header
  enthalten bereits die kurzen Namen. Der Kontext dient der Dokumentation und
  der Verarbeitung als JSON-LD beim Abnehmer (Expansion zu vollständigen URIs,
  Verknüpfung mit anderen Daten). Einen `Link`-Header reicht der öffentliche
  Pfad nicht an den Broker weiter.
- **Eingefroren.** Kein Name wird umbenannt, keine URI geändert, kein Eintrag
  entfernt – auch nicht, wenn ein Konnektor ein Attribut nicht mehr schreibt,
  denn die Historie steht weiter unter dieser URI. Neue Namen kommen hinzu.
- **Geprüft.** `tests/static/vocabulary-context.test.js` schlägt fehl, sobald
  ein Konnektor einen Typ oder ein Attribut schreibt, das weder im Kontext noch
  in diesem Dokument steht, oder eine Zuordnung von der gespeicherten Form
  abweicht.
- **Core-Begriffe.** `location` und `totalCount` definiert der Core-Kontext
  selbst; sie stehen deshalb nicht im eigenen Teil des Kontexts.

### Typen und Attribute

Stand: 26 Entitätstypen, 121 Attributnamen.

| Typ | Konnektor(en) | Attribute |
|---|---|---|
| `AirQualityObserved` | feinstaub-bw, uba-bw | `ags`, `airQualityIndex`, `co`, `dateObserved`, `location`, `name`, `no2`, `o3`, `pm10`, `pm25`, `sensorCount`, `so2`, `stationName` |
| `Alert` | warnungen-bw | `activeCount`, `ags`, `category`, `dateObserved`, `headlines`, `maxSeverity` |
| `BikeParking` | parken-bw | `ags`, `availableSpotNumber`, `dataProvider`, `dateObserved`, `location`, `name`, `originalUid`, `sourceId`, `totalSpotNumber` |
| `CarSharingStation` | carsharing-bw | `ags`, `availableVehicles`, `capacity`, `dataProvider`, `dateObserved`, `location`, `name`, `operator`, `vehicleType` |
| `ChargingSummary` | ladesaeulen-bw | `ags`, `availableEvse`, `chargingEvse`, `dateObserved`, `defectEvse`, `evseCount`, `liveEvse`, `locationCount` |
| `CityPulse` | puls-bw | `ags`, `components`, `dateObserved`, `pulseIndex` |
| `CivicStructure` | rathaus-bw | `ags`, `dataProvider`, `dateObserved`, `location`, `name`, `openingHours`, `telephone`, `url` |
| `EVChargingStation` | ladesaeulen-bw | `address`, `ags`, `availableEvse`, `chargingEvse`, `dataProvider`, `dateObserved`, `defectEvse`, `liveEvse`, `location`, `name`, `operator`, `socketNumber` |
| `EnergyMonitor` | mastr-bw | `additionsByYear`, `ags`, `complete`, `installedCapacityKw`, `plantCount` |
| `FleetStatus` | carsharing-bw | `ags`, `availableVehicles`, `dataProvider`, `dateObserved`, `operator`, `stationCount`, `totalVehicles`, `vehicleType` |
| `HeatHealthWarning` | hitze-bw | `dataProvider`, `dateObserved`, `forecastDay`, `location`, `maxRank`, `name`, `todayLevel`, `tomorrowLevel` |
| `Municipality` | stammdaten-bw | `ags`, `dashboardUrl`, `dateObserved`, `kreisCode`, `location`, `municipalityType`, `name`, `population` |
| `ParkingSite` | parken-bw | `ags`, `availableSpotNumber`, `category`, `dataProvider`, `dateObserved`, `location`, `name`, `originalUid`, `sourceId`, `totalSpotNumber` |
| `ParkingSummary` | parken-bw | `ags`, `dateObserved`, `realtimeFree`, `realtimeSites`, `siteCount`, `totalCapacity` |
| `PedestrianFlowObserved` | hystreet (abgeschaltet) | `dailyTotal`, `dataProvider`, `dateObserved`, `location`, `name`, `pedestrianCount` |
| `PlatformStatus` | ops-host, troe-stats | `cpuCores`, `cpuLoad1`, `cpuLoad15`, `cpuLoadPct`, `dateObserved`, `dbSizeBytes`, `diskTotalGb`, `diskUsedPct`, `efaOnDemandCallsToday`, `efaOnDemandDailyCap`, `ingestByHour`, `memTotalMb`, `memUsedPct`, `name`, `rowsByType`, `rowsByTypeAsOf`, `troeEntities`, `troeRows`, `troeRows1h`, `troeRows24h`, `uptimeDays` |
| `PollenForecast` | pollen-bw | `arten`, `dataProvider`, `dateObserved`, `kreise`, `name` |
| `PublicAmenity` | poi-bw | `ags`, `amenities`, `counts`, `dataProvider`, `dateObserved`, `totalCount` |
| `PublicTransportStop` | efa-abfahrten | `ags`, `avgDelayMinutes`, `dataProvider`, `dateObserved`, `delayDataQuality`, `departureCount`, `departures`, `location`, `name`, `stopCode` |
| `RoadWork` | baustellen-bw | `activeCount`, `ags`, `dateObserved`, `endDate`, `gemeindeName`, `location`, `name` |
| `SharingSummary` | sharing-bw | `ags`, `availableVehicles`, `system`, `vehiclePositions`, `vehiclesByFormFactor` |
| `TouristDestination` | ausflug-bw | `ags`, `dataProvider`, `dateObserved`, `zielCount`, `ziele` |
| `TrafficFlowObserved` | eco-bw | `ags`, `dailyTotal`, `dateObserved`, `location`, `name`, `siteCount`, `vehicleType` |
| `WaterLevelObserved` | pegel-bw (pegel-lubw abgeschaltet) | `ags`, `dataProvider`, `dateObserved`, `discharge`, `floodLevels`, `gemeindeName`, `level`, `levelState`, `location`, `meanLevel`, `meanLowLevel`, `measuredAt`, `name`, `water` |
| `WeatherForecast` | vorhersage-bw | `ags`, `apparentTemperature`, `dataProvider`, `dateObserved`, `days`, `sunrise`, `sunset`, `tomorrowPrecipitation`, `tomorrowTempMax`, `tomorrowTempMin`, `uvIndex` |
| `WeatherObserved` | wetter-bw, wetter-dwd-station | `ags`, `atmosphericPressure`, `dataProvider`, `dateObserved`, `dwdStationId`, `gemeindeName`, `location`, `precipitation`, `relativeHumidity`, `stationName`, `tempMax`, `tempMin`, `temperature`, `uvIndexMax`, `windDirection`, `windSpeed` |

Nicht jede Entität trägt jedes Attribut: Messwerte fehlen, wenn die Quelle
gerade keinen liefert. Messwerte tragen `observedAt` und, wo sinnvoll, einen
`unitCode` (UN/CEFACT). `dateObserved` ist der Zeitpunkt des Abrufs, als
`DateTime`-Wert.

### Bekannte Altlasten

Die Namen sind gewachsen und werden trotzdem **nicht** bereinigt – jede
Umbenennung wäre ein neues Attribut ohne Historie. Bekannt sind:

- **Deutsche bzw. gemischte Namen:** `ags` (Amtlicher Gemeindeschlüssel),
  `kreisCode`, `gemeindeName`, `zielCount`, `ziele`, `arten`, `kreise`.
- **`ags` beim Typ `Alert`** enthält den 5-stelligen Kreisschlüssel, nicht
  einen Gemeindeschlüssel.
- **`totalCount`** (`PublicAmenity`) ist zugleich ein Begriff des
  Core-Kontexts und wird deshalb als `https://uri.etsi.org/ngsi-ld/totalCount`
  gespeichert, nicht unter dem Default-Kontext.
- **Einheit im Namen** statt im `unitCode`: `installedCapacityKw`,
  `diskTotalGb`, `memTotalMb`, `dbSizeBytes`.
- **An Smart Data Models angelehnt, aber nicht deren URIs:** Typen wie
  `WeatherObserved`, `AirQualityObserved`, `ParkingSite` oder
  `EVChargingStation` tragen die Namen der FIWARE Smart Data Models, sind aber
  unter dem Default-Kontext gespeichert, nicht unter den Kontexten der Smart
  Data Models. Mehrere Typen sind eigene Aggregate ohne Entsprechung dort
  (`ParkingSummary`, `ChargingSummary`, `SharingSummary`, `FleetStatus`,
  `CityPulse`, `EnergyMonitor`, `PlatformStatus`).

### Mögliche spätere Migration auf Smart Data Models

Eine Umstellung auf die Kontexte der Smart Data Models ist denkbar, aber
nicht geplant. Sie wäre eine **inkompatible Änderung** und hieße:

- Die Konnektoren schreiben mit den Smart-Data-Models-Kontexten; Namen und
  Werte werden an deren Schemas angepasst (z. B. eigene Aggregate ersetzen).
- Für den Broker entstehen neue Attribute unter neuen URIs. Die **Historie in
  TRoE bleibt unter den alten URIs** – sie müsste in der Datenbank umgeschrieben
  oder für eine Übergangszeit parallel unter beiden Vokabularen abgefragt
  werden.
- Indizes, die auf der gespeicherten Form beruhen (z. B. der `ags`-Index in
  MongoDB), sowie Oberfläche und Abnehmer müssen den neuen Kontext verwenden.
- Der hier veröffentlichte Kontext bliebe für die alten Daten gültig; ein
  neuer Kontext käme unter einer eigenen Adresse hinzu.

## Lizenzen der Datenquellen

Die Daten stammen von Dritten und stehen unter deren eigenen Lizenzen; die
Plattform-Lizenz (EUPL-1.2) gilt für den Programmcode, nicht für die Daten.
Wer Daten über die API weiterverwendet, übernimmt die Namensnennung, die die
jeweilige Quelle verlangt (Spalte „Quellenvermerk“), und beachtet die
Hinweise.

Maschinenlesbar steht dasselbe im öffentlichen Statusexport
`/connectors-status.json`: je Konnektor `attribution` (Quellenvermerk),
`attributionLinks` (Linkziele im Vermerk), `license` und `licenseUrl`.
Gepflegt wird es an einer Stelle, in `platform/config/connectors.json`; die
Dashboards zeigen die Vermerke in der Fußzeile. Viele Entitäten tragen ihre
Quelle zusätzlich im Attribut `dataProvider`.

| Quelle | Konnektor → Typ | Lizenz | Quellenvermerk | Hinweise |
|---|---|---|---|---|
| Open-Meteo | wetter-bw, vorhersage-bw → `WeatherObserved` (`bw-<AGS>`), `WeatherForecast` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Wetterdaten: Open-Meteo.com (CC BY 4.0) | Link auf [open-meteo.com](https://open-meteo.com/). Freie API-Stufe nur nicht-kommerziell (THIRD-PARTY-NOTICES §8.3). |
| Deutscher Wetterdienst (DWD) | pollen-bw → `PollenForecast`, hitze-bw → `HeatHealthWarning` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Quelle: Deutscher Wetterdienst (CC BY 4.0) | |
| DWD über Bright Sky | wetter-dwd-station → `WeatherObserved` (`bw-dwd-<Station>`), warnungen-bw → `Alert` (`…-dwd`) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Datenbasis: Deutscher Wetterdienst, via Bright Sky | Warnungen nur unverändert weitergeben (siehe unten). |
| BBK / NINA (warnung.bund.de) | warnungen-bw → `Alert` (`…-nina`) | Nutzungsbedingungen des BBK | Warnungen: BBK/warnung.bund.de (unverändert) | Amtliche Warnungen nur unverändert weitergeben (siehe unten). |
| WSV / PEGELONLINE | pegel-bw → `WaterLevelObserved` (`bw-pegel-<Nr>`) | [DL-DE→Zero-2.0](https://www.govdata.de/dl-de/zero-2-0) | Pegel: WSV/PEGELONLINE (DL-DE→Zero-2.0) | Namensnennung nicht verlangt, aber gegeben. |
| LUBW Hochwasservorhersagezentrale | pegel-lubw (**abgeschaltet**) | — | — | Die HVZ bittet Dritte, aktuelle Mess- und Vorhersagedaten nicht weiterzuverbreiten. Die Dashboards verlinken stattdessen auf [hvz.lubw.baden-wuerttemberg.de](https://hvz.lubw.baden-wuerttemberg.de/). Ältere `WaterLevelObserved:bw-hvz-*` werden nicht mehr gezeigt und vom Betrieb gelöscht. |
| Umweltbundesamt | uba-bw → `AirQualityObserved` (`bw-uba-<Station>`) | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | Umweltbundesamt mit Daten der Messnetze der Länder und des Bundes (dl-de/by-2-0) | |
| sensor.community | feinstaub-bw → `AirQualityObserved` (`bw-sc-<AGS>`, `bw-sensor-<Id>`) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | Feinstaub: sensor.community (ODbL) | Abgeleitete Datenbank, siehe ODbL unten. |
| OpenStreetMap (Overpass) | poi-bw → `PublicAmenity`, ausflug-bw → `TouristDestination`, rathaus-bw → `CivicStructure` | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | © OpenStreetMap-Mitwirkende (ODbL) | Link auf [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright). Abgeleitete Datenbank, siehe ODbL unten. |
| MobiData BW (Datenpaket der NVBW) | parken-bw → `ParkingSite`, `BikeParking`, `ParkingSummary`; sharing-bw → `SharingSummary`; carsharing-bw → `CarSharingStation`, `FleetStatus`; eco-bw → `TrafficFlowObserved`; ladesaeulen-bw → `EVChargingStation`, `ChargingSummary` | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | Datenpaket: MobiData BW; NVBW (dl-de/by-2-0) | Parken zusätzlich: Stadt Karlsruhe (CC BY 4.0), Stadt Freiburg, Verband Region Stuttgart (dl-de/by-2-0). Ladepunkte zusätzlich: Bundesnetzagentur, EnBW AG (CC BY 4.0). GBFS-Systeme von Lime und Bird sind ausgeschlossen (siehe unten). |
| Verkehrsministerium BW (BEMaS) über MobiData BW | baustellen-bw → `RoadWork` | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | Verkehrsministerium BW (BEMaS) via MobiData BW (dl-de/by-2-0) | |
| EFA-BW der NVBW über MobiData BW | efa-abfahrten → `PublicTransportStop`, `/abfahrten` | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | Datenpaket: MobiData BW; NVBW – EFA-BW (dl-de/by-2-0) | |
| Marktstammdatenregister | mastr-bw → `EnergyMonitor` | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | Marktstammdatenregister – © Bundesnetzagentur (dl-de/by-2-0) | |
| BKG (Verwaltungsgrenzen) | stammdaten-bw → `Municipality`; Gemeindezuordnung (`ags`) aller Konnektoren | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0) | © GeoBasis-DE / BKG (2026) dl-de/by-2-0, Geometrien vereinfacht | Gemeinden und Grenzen über opendatasoft georef. |
| Wikidata | stammdaten-bw → `Municipality` (`population`) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Wikidata (CC0) | |
| hystreet.com | hystreet (**abgeschaltet**) → `PedestrianFlowObserved` | proprietär | — | Nur mit schriftlicher Zustimmung; bis dahin weder abgefragt noch gezeigt. |
| — (eigene Berechnung) | puls-bw → `CityPulse`; `PlatformStatus` | — | — | Aus den übrigen Daten berechnet bzw. Betriebsdaten der Plattform. |

**Kartengrundlage der Dashboards:** basemap.de, © GeoBasis-DE / BKG (2026),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Zeigt eine Karte
Marker aus OpenStreetMap-Daten, ergänzt sie „© OpenStreetMap-Mitwirkende
(ODbL)“ in ihrer Quellenzeile.

**ODbL.** Die Entitäten aus OpenStreetMap (`PublicAmenity`,
`TouristDestination`, `CivicStructure`) und aus sensor.community
(`AirQualityObserved` mit `bw-sc-` und `bw-sensor-`) sind abgeleitete
Datenbanken: Für sie gilt über die API die ODbL, einschließlich
Namensnennung und Share-alike, wenn daraus eine Datenbank öffentlich
weitergegeben wird. Die übrigen Daten liegen als getrennte Typen daneben; die
Plattform ist insoweit eine Sammlung (Collective Database), deren Teile ihre
eigene Lizenz behalten — die ODbL erstreckt sich nicht auf sie.

**Amtliche Warnungen** (`Alert`) dürfen nur unverändert weitergegeben werden.
`headlines` enthält die Überschrift der Warnung vollständig (höchstens drei
Einträge, `activeCount` nennt die tatsächliche Zahl); einzige technische
Anpassung ist der typografische Apostroph (’ statt '), ohne den Orion-LD die
Zeitreihe nicht schreibt. Warnungen von NINA tragen in `url` den Link auf die
Originalmeldung bei warnung.bund.de; der Kalender `/warnungen.ics` gibt ihn als
`URL` des Termins aus. Wer Warnungen kürzt oder umformuliert, darf sie nicht
als amtliche Warnung ausgeben.

**Ausgeschlossene Anbieter.** Die GBFS-Nutzungsbedingungen von Lime untersagen
das Speichern und den Aufbau eigener Datensätze, die von Bird sind ungeklärt.
Beide sind in der Registry (`excludeSystems` von sharing-bw und carsharing-bw,
mit Begründung) von der Ingestion ausgeschlossen.

**Noch offen:** eine Lizenzangabe je Entität (Attribut `license`). Bis dahin
gilt die Lizenz des Konnektors laut Tabelle und Statusexport.
