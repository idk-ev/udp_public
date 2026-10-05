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

# vorhandene Typen und Attribute
curl 'https://udp.example.org/gateway/ngsi-ld/v1/types'
curl 'https://udp.example.org/gateway/ngsi-ld/v1/attributes'
```

- `limit` höchstens 1000, Blättern über `offset`; `count=true` liefert die
  Gesamtzahl im Header `NGSILD-Results-Count`.
- Fast alle Typen tragen das Attribut `ags` (Amtlicher Gemeindeschlüssel,
  8-stellig) – der übliche Filter ist `q=ags=="<AGS>"`.
- Ohne `Link`-Header antwortet der Broker mit den kurzen Namen aus der
  Tabelle unten; ein eigener Kontext ist nicht nötig.
- Vertrag sind die Entitäts-Endpunkte (`/entities`, `/entities/{id}`) sowie
  `/types` und `/attributes`. Weitere Endpunkte des Brokers sind über den
  Pfad technisch erreichbar, gehören aber nicht zum Vertrag.

### Temporal-API

Die Zeitreihen liefert Mintaka. Der doppelte Pfadteil ist kein Tippfehler:
`/gateway/temporal/` ist die Gateway-Route (APISIX entfernt das Präfix),
`/temporal/entities/…` der Pfad der Temporal-API selbst.

```bash
curl 'https://udp.example.org/gateway/temporal/temporal/entities/urn:ngsi-ld:WeatherObserved:bw-dwd-04160?attrs=temperature&timerel=after&timeAt=2026-10-01T00:00:00Z&options=temporalValues'
```

Abgefragt wird je Entität (`/temporal/entities/{id}`). Wie weit die Historie
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
solange das Haltestellenverzeichnis noch nicht geladen oder der Dienst
ausgelastet ist. Alle Parameter außer `ags` werden ignoriert.

### `/warnungen.ics`

`GET /warnungen.ics?kreis=<5-stelliger Kreisschlüssel>` liefert die aktiven
Warnungen (DWD, BBK/NINA) eines Kreises als iCalendar-Abo. Ohne gültigen
Parameter `400`; solange der Broker nicht erreichbar ist `503`.

### Weitere Pfade

Unter `/gateway/` sind auch FROST (SensorThings), CKAN, GeoServer und – falls
eingeschaltet – das Masterportal lesend erreichbar. Das sind die
Standard-Schnittstellen der jeweiligen Komponenten; dieser Vertrag deckt sie
nicht ab.

## Zugriff und Sicherheitsmodell

So ist die Plattform **heute** ausgeliefert:

- **Anonym und nur lesend.** Öffentlich erreichbar ist die API nur über den
  Cockpit-nginx. Er lässt auf `/gateway/…`, `/abfahrten` und `/warnungen.ics`
  nur `GET`, `HEAD` und `OPTIONS` durch; alles andere endet mit `403`. Eine
  Anmeldung oder ein Token gibt es nicht.
- **Kein OIDC am Gateway.** Die APISIX-Routen werten keine Tokens aus; Keycloak
  ist deployt, wirkt aber auf die APIs nicht. Die Anmeldung im Cockpit ist im
  Helm-Chart standardmäßig aus (`cockpit.authEnabled: false`).
- **Ein Mandant.** Alle Daten liegen im **Standardmandanten** und sind
  öffentliche, offene Daten. Eine Mandantenwahl per `NGSILD-Tenant` ist am
  öffentlichen Pfad nicht vorgesehen. Getrennte, nicht öffentliche Mandanten
  setzen eine Durchsetzung am Gateway voraus, die noch fehlt – s.
  [`architektur.md`](architektur.md#mandantenmodell).
- **Schreiben nur intern.** Konnektordienst, Node-RED und IoT-Agent schreiben
  innerhalb der Plattform direkt in den Broker, nicht über den öffentlichen
  Pfad.
- **CORS.** Die Gateway-Pfade erlauben Aufrufe aus dem Browser von beliebigen
  Origins (nur `GET`/`OPTIONS`).
- **Betriebsdashboard.** `/dashboard.html` ist per HTTP Basic Auth geschützt
  ([`betrieb.md`](betrieb.md#hauptdashboard-nur-mit-anmeldung)).

Lokal unter Docker Compose ist das Gateway (`http://localhost:8780`) dagegen
direkt erreichbar, **einschließlich schreibender Methoden** – der Port ist
deshalb standardmäßig nur an `127.0.0.1` gebunden (`PROXY_BIND`).

## Rate-Limits

Je Client-Adresse; über dem Limit antwortet die Plattform mit `429`.

| Pfad | Limit | Einstellung |
|---|---|---|
| `/gateway/ngsi-ld/…`, `/gateway/temporal/…` | 30 Anfragen/s, Burst 150 | `apisix.rateLimit` (Helm); gezählt je APISIX-Replik |
| `/abfahrten` | 30 Anfragen/min, Burst 30 | `platform/config/nginx/cockpit.conf.template` |
| `/warnungen.ics` | 10 Anfragen/min, Burst 10 | `platform/config/nginx/cockpit.conf.template` |

Antworten aus dem Cache (s. unten) zählen nicht gegen das Gateway-Limit.
Für Massenabzüge bitte `limit`/`offset` und eine moderate Abfragefrequenz
nutzen; die Daten ändern sich ohnehin höchstens im Minutentakt.

## Caching

Der Cockpit-nginx hält einen Micro-Cache vor allen öffentlichen Pfaden. Ob
eine Antwort aus dem Cache kam, steht im Header `X-Cache`.

| Pfad | Gültigkeit |
|---|---|
| `/gateway/ngsi-ld/…` | 60 s; leere Liste (`[]`) und `404` 10 s |
| `/gateway/temporal/…` | 300 s |
| `/abfahrten` | 60 s; `404` 30 s |
| `/warnungen.ics` | 300 s |

Bei Störungen des Upstreams liefert der Cache die letzte gültige Antwort
weiter aus (`X-Cache: STALE`). Der Cache-Schlüssel enthält neben der URL die
Header `Accept` und `Link`.

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
- die Entitäten vom Typ `PlatformStatus` (Betriebsdaten der Plattform);
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
  Verknüpfung mit anderen Daten). Als `Link`-Header an die API geschickt,
  ändert er die Antwort nicht; der Broker muss ihn dafür allerdings selbst
  abrufen können.
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

Stand: 26 Entitätstypen, 119 Attributnamen.

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
| `PedestrianFlowObserved` | hystreet | `dailyTotal`, `dataProvider`, `dateObserved`, `location`, `name`, `pedestrianCount` |
| `PlatformStatus` | ops-host, troe-stats | `cpuCores`, `cpuLoad1`, `cpuLoad15`, `cpuLoadPct`, `dateObserved`, `dbSizeBytes`, `diskTotalGb`, `diskUsedPct`, `ingestByHour`, `memTotalMb`, `memUsedPct`, `name`, `rowsByType`, `rowsByTypeAsOf`, `troeEntities`, `troeRows`, `troeRows1h`, `troeRows24h`, `uptimeDays` |
| `PollenForecast` | pollen-bw | `arten`, `dataProvider`, `dateObserved`, `kreise`, `name` |
| `PublicAmenity` | poi-bw | `ags`, `amenities`, `counts`, `dataProvider`, `dateObserved`, `totalCount` |
| `PublicTransportStop` | efa-abfahrten | `ags`, `avgDelayMinutes`, `dataProvider`, `dateObserved`, `delayDataQuality`, `departureCount`, `departures`, `location`, `name`, `stopCode` |
| `RoadWork` | baustellen-bw | `activeCount`, `ags`, `dateObserved`, `endDate`, `gemeindeName`, `location`, `name` |
| `SharingSummary` | sharing-bw | `ags`, `availableVehicles`, `system`, `vehiclePositions`, `vehiclesByFormFactor` |
| `TouristDestination` | ausflug-bw | `ags`, `dataProvider`, `dateObserved`, `zielCount`, `ziele` |
| `TrafficFlowObserved` | eco-bw | `ags`, `dailyTotal`, `dateObserved`, `location`, `name`, `siteCount`, `vehicleType` |
| `WaterLevelObserved` | pegel-bw, pegel-lubw | `ags`, `dataProvider`, `dateObserved`, `discharge`, `floodLevels`, `gemeindeName`, `level`, `levelState`, `location`, `meanLevel`, `meanLowLevel`, `measuredAt`, `name`, `water` |
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

> **Wird ergänzt.** Die Daten stammen von Dritten und stehen unter deren
> eigenen Lizenzen; die Plattform-Lizenz (EUPL-1.2) gilt für den Programmcode,
> nicht für die Daten. Weiterverwendung nur mit der Namensnennung, die die
> jeweilige Quelle verlangt.

Bis dahin gelten:

- die Übersicht der Datenquellen und ihrer Lizenzen in
  [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) (Abschnitt 7.2);
- die Quellenangabe je Konnektor (`attribution` in
  `platform/config/connectors.json`), die auch die Dashboards in der Fußzeile
  zeigen;
- das Attribut `dataProvider`, das viele Entitäten mit ihrer Quelle tragen.
