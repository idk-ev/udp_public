#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Ermittelt je BW-Gemeinde den zentralen ÖPNV-Halt (EFA-BW).

Das Ergebnis (gui/public/oepnv-halte.json) ist Eingangsdatum für den
Abfahrtsmonitor: Das Dashboard fragt Abfahrten auf Anfrage ab (Endpunkt
/abfahrten des Konnektordienstes), braucht dafür aber je Gemeinde eine Halte-ID.

Von Hand gepflegte Halte gehen vor: Hat `efa-abfahrten` in
platform/config/connectors.json für eine Gemeinde `params.stopId`, ist das
ihr Halt (art »kuratiert«), nur die EFA-Koordinate wird nachgeschlagen.

Alle übrigen (siehe rangliste): Kandidaten aus der Umkreissuche um die
Ortsmitte und aus der Namenssuche, nur mit EFA-Koordinate. Gültig ist ein Halt
nur, wenn seine ID den eigenen Kreis trägt (de:08<kreis>:…) und er höchstens
RADIUS_EIGEN_M von der Ortsmitte liegt; nur wenn es keinen solchen gibt, ein
Halt in einem anderen BW-Kreis binnen RADIUS_NACHBAR_M. Unter den gültigen
gewinnt die höchste Punktzahl (Bahnhof, ZOB, Rathaus, Mitte, eigene Gemeinde
und ihr Hauptort, Nähe), nicht der erste Treffer. Eine Gemeinde ohne gültigen
Halt fehlt in der Datei — lieber keine Abfahrtstafel als eine falsche;
gemeindefreie Gebiete (Typ F) bekommen keinen.

Ortsmitte: die Wikidata-Koordinate der Gemeinde (P625, über den AGS P439),
gespeichert in scripts/ortsmitten.json (`--ortsmitten` lädt sie neu). Der
Mittelpunkt in bw-gemeinden.json ist der Flächenschwerpunkt und liegt bei
großen Gemeinden im Wald (Sachsenheim: 6 km vom Bahnhof). Fehlt eine
Ortsmitte oder liegt sie über ORTSMITTE_MAX_M vom Schwerpunkt, gilt der
Schwerpunkt.

Bewusst langsam (1,2 s vor jeder Anfrage, rund drei je Gemeinde) und
wiederaufnehmbar: Einträge mit Koordinate werden übersprungen.

    py -3 scripts/efa-haltestellen.py                 # fehlende ergänzen
    py -3 scripts/efa-haltestellen.py --neu           # alles neu ermitteln
    py -3 scripts/efa-haltestellen.py --nur 08226096,08237040
    py -3 scripts/efa-haltestellen.py --pruefen       # Halte gegen den Abfahrtsmonitor testen
    py -3 scripts/efa-haltestellen.py --neu --cache efa-cache.json   # Suchen zwischenspeichern
    py -3 scripts/efa-haltestellen.py --alle --cache efa-cache.json  # neu bewerten
    py -3 scripts/efa-haltestellen.py --ortsmitten    # Ortsmitten aus Wikidata neu laden
"""
import json
import math
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

WURZEL = pathlib.Path(__file__).resolve().parent.parent
GEMEINDEN = WURZEL / "gui" / "public" / "bw-gemeinden.json"
ZIEL = WURZEL / "gui" / "public" / "oepnv-halte.json"
REGISTRY = WURZEL / "platform" / "config" / "connectors.json"
ORTSMITTEN = WURZEL / "scripts" / "ortsmitten.json"
SPARQL = "https://query.wikidata.org/sparql"
EFA = "https://www.efa-bw.de/nvbw/XML_STOPFINDER_REQUEST"
EFA_COORD = "https://www.efa-bw.de/nvbw/XML_COORD_REQUEST"
EFA_DM = "https://www.efa-bw.de/nvbw/XML_DM_REQUEST"
PAUSE = 1.2
KOORD_FORMAT = "WGS84[dd.ddddd]"

# Von der Ortsmitte (siehe oben): Die mittlere BW-Gemeinde hat rund 30 km²
# (Radius eines flächengleichen Kreises ~3 km); Bahnhof oder Rathaus des
# Hauptorts liegen binnen 5 km. Weiter draußen liegt ein anderer Ort.
# Kuratierte Halte sind davon ausgenommen.
RADIUS_EIGEN_M = 5000
# Eine Ortsmitte weiter vom Flächenschwerpunkt ist eher ein Datenfehler.
ORTSMITTE_MAX_M = 10000
# Halt in einem anderen BW-Kreis: nur, wenn der eigene Kreis keinen gültigen
# hat, und nur direkt jenseits der Grenze.
RADIUS_NACHBAR_M = 2000
# Dieselben Grenzen prüft tests/static/data-integrity.test.js.

# EFA-Produktklassen: 0 Zug, 1 S-Bahn, 13 Regionalzug, 14 Fernzug, 15 ICE,
# 16 Sonderzug; 2 U-Bahn, 3 Stadtbahn, 4 Straßenbahn.
SCHIENE = {0, 1, 13, 14, 15, 16}
STADTBAHN = {2, 3, 4}

# Punkte für den Haltnamen (nur das höchste Merkmal zählt). `ortsteil`: Steht
# davor ein anderer Name als der der Gemeinde (»Wollmatingen Bahnhof«,
# »Baumgarten Ortsmitte«), ist es der Bahnhof bzw. die Mitte eines Ortsteils —
# dann zählt das Merkmal nur halb. Dritte Spalte: wo ein solcher Name steht
# (»beide« Seiten; beim ZOB nur »davor«, dahinter folgt meist sein Platz:
# »ZOB Lindenplatz«).
NAMEN = [
    (re.compile(r"\b(hauptbahnhof|hbf)\b"), 25, "beide"),
    (re.compile(r"\b(stadtbahnhof|bahnhof|bf|bhf)\b"), 20, "beide"),
    (re.compile(r"\b(zob|busbahnhof|omnibusbahnhof)\b"), 18, "davor"),
    # Nicht »SBK-Markt« (ein Laden).
    (re.compile(r"(?<![\w-])(rathaus(platz)?|markt(platz)?)\b"), 12, None),
    # Nicht »Schulzentrum«.
    (re.compile(r"(?<![\w-])((orts|stadt|dorf)?mitte|(orts|stadt)?zentrum)\b"), 12, "beide"),
]
# Wörter, die vor dem Merkmal keinen Ortsteil anzeigen: »Am Bahnhof«, »ZOB Am Bahnhof«.
FUELLWOERTER = {"am", "an", "an der", "beim", "bei", "zum", "zur", "vor", "vorm", "hinterm", "zob", "stadt",
                "alte", "alter", "altes", "neue", "neuer", "neues"}
# Steht dahinter ein Name, ist es der Bahnhof eines Ortsteils: »Bahnhof Manzell«.
# Klammern und Alternativen nach »/« zählen nicht: »Bahnhof (Bus)«, »Bahnhof/ZOB«.
# Platzhalter aus der EFA-Datenpflege (»Bahnhof XXX«): keine Namenspunkte, als
# Name gilt dann der des Abfahrtsmonitors.
PLATZHALTER = re.compile(r"x{3,}")
# Ein Gewerbegebiet am Bahnhof ist kein Bahnhof: »Industriegebiet Bahnhof«.
GEWERBE = re.compile(r"(industrie|gewerbe)(gebiet|park|ring)|\bgewerbe\b|\bindustrie\b")
ERSATZ = re.compile(r"\bersatz|\bsev\b")        # Ersatzhalt, »(Ersatz)«, »Ersatz-Hst.«, SEV
PUNKTE_ORTSNAME = 10          # »Böllen, Böllen«: der Halt heißt wie die Gemeinde
PUNKTE_EIGENE_GEMEINDE = 30   # EFA ordnet den Halt der Gemeinde selbst zu
PUNKTE_HAUPTORT = 10          # … und ihrem Hauptort, nicht einem Ortsteil
PUNKTE_SCHIENE = 10
PUNKTE_STADTBAHN = 5
PUNKTE_JE_KM = -5             # Nähe zum Gemeindemittelpunkt
PUNKTE_GEWERBE = -10
PUNKTE_ERSATZHALT = -40
MAX_DM_VERSUCHE = 3           # so viele der besten Kandidaten gegen den Abfahrtsmonitor
KEINE_ABFAHRTEN = {-4050, -4030}   # EFA: Halt aufgelöst, derzeit keine Abfahrt


# --cache DATEI: Such-Antworten (nicht den Abfahrtsmonitor) zwischenspeichern,
# damit ein zweiter Lauf mit geänderter Bewertung EFA kaum belastet.
CACHE: dict | None = None


def _get(url: str, versuche: int = 2, cachebar: bool = False) -> dict:
    if cachebar and CACHE is not None and url in CACHE:
        return CACHE[url]
    antwort = _laden(url, versuche)
    if cachebar and CACHE is not None:
        CACHE[url] = antwort
    return antwort


def _laden(url: str, versuche: int) -> dict:
    time.sleep(PAUSE)                               # Takt: vor jeder echten Anfrage
    req = urllib.request.Request(url, headers={"User-Agent": "udp-efa-haltestellen/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            # EFA liefert vereinzelt kaputtes UTF-8 (Main-Tauber-Kreis): ersetzen statt abbrechen.
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except (OSError, ValueError):
        if versuche <= 1:
            raise
        time.sleep(5 * PAUSE)                       # einmal nachfassen, gedrosselt
        return _laden(url, versuche - 1)


def _halte(daten: dict) -> list:
    return [l for l in (daten.get("locations") or []) if l.get("type") == "stop" and l.get("id")]


def suche(name: str) -> list:
    return _halte(_get(EFA + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "type_sf": "any", "coordOutputFormat": KOORD_FORMAT,
        "name_sf": name, "anyMaxSizeHitList": "8",
    }), cachebar=True))


def suche_koordinate(lat: float, lon: float) -> list:
    """Halte im Umkreis des Gemeindemittelpunkts (die 100 nächsten).

    Fängt auch Gemeinden, deren amtlicher Name nicht der EFA-Schreibweise
    entspricht (»Kirchheim unter Teck« heißt dort »Kirchheim (Teck)«).
    """
    return _halte(_get(EFA_COORD + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "coordOutputFormat": KOORD_FORMAT,
        "coord": f"{lon}:{lat}:WGS84[DD.DDDDD]",
        "inclFilter": "1", "type_1": "STOP", "radius_1": str(RADIUS_EIGEN_M), "max": "100",
    }), cachebar=True))


def entfernung_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6371000.0 * math.asin(math.sqrt(a))


def gemeinde_von(halt: dict) -> str | None:
    """AGS der Gemeinde, der EFA den Halt zuordnet (parent »placeID:8226096:999«)."""
    m = re.match(r"placeID:(\d{7,8}):", str((halt.get("parent") or {}).get("id") or ""))
    return m.group(1).zfill(8) if m else None


def kern(name: str) -> str:
    """»Kirchheim unter Teck« → »kirchheim«, »Walldorf (Baden)« → »walldorf«."""
    return re.split(r"\s*[(,]|\s+(?:am|an der|an den|im|in|bei|ob|unter)\s+", name.lower())[0].strip()


def _woerter(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def _fremder_name(teil: str, name: str) -> bool:
    """Ob `teil` (vor oder hinter dem Merkmal) einen anderen Ort nennt."""
    teil = _woerter(teil)
    # »Karlsdorf-Neuthard Bahnhof«: der Gemeindename selbst, auch mit Bindestrich.
    if not teil or teil.startswith(_woerter(kern(name))) or teil in FUELLWOERTER:
        return False
    if all(w in FUELLWOERTER for w in teil.split()):
        return False
    # Kürzel wie das Kfz-Zeichen: »FN-Stadtbahnhof«.
    return len(teil.replace(" ", "")) > 3


def _fremd(m: re.Match, seite: str | None, text: str, name: str) -> bool:
    """Nennt der Name vor (oder, bei »beide«, hinter) dem Merkmal einen anderen Ort?"""
    if seite is None:
        return False
    dahinter = re.sub(r"\([^)]*\)", " ", text[m.end():]).split("/")[0]
    return _fremder_name(text[:m.start()], name) or (seite == "beide" and _fremder_name(dahinter, name))


def ortsteil_halt(text: str, name: str) -> bool:
    """Bahnhof, ZOB oder Mitte eines anderen Orts: »Bahnhof Niederbiegen«."""
    for rx, _, seite in NAMEN:
        m = rx.search(text)
        if m and _fremd(m, seite, text, name):
            return True
    return False


def namens_punkte(text: str, name: str) -> int:
    """Punkte des Haltnamens `text` (klein) in der Gemeinde `name`."""
    if GEWERBE.search(text) or PLATZHALTER.search(text):
        return 0
    beste = 0
    for rx, punkte, seite in NAMEN:
        m = rx.search(text)
        if not m:
            continue
        if _fremd(m, seite, text, name):
            punkte //= 2
        beste = max(beste, punkte)
    if text and text in (name.lower(), kern(name)):
        beste += PUNKTE_ORTSNAME
    return beste


def kandidat(halt: dict, ags: str, name: str, kreis: str, lat: float, lon: float) -> dict | None:
    """Bewerteter Kandidat, oder None: ohne Koordinate, außerhalb BW, zu weit weg."""
    koord = halt.get("coord")
    hid = str(halt.get("id"))
    if not (isinstance(koord, list) and len(koord) == 2 and hid.startswith("de:08")):
        return None
    hlat, hlon = float(koord[0]), float(koord[1])
    dist = entfernung_m(lat, lon, hlat, hlon)
    eigener_kreis = hid.startswith(f"de:{kreis}:")
    if dist > (RADIUS_EIGEN_M if eigener_kreis else RADIUS_NACHBAR_M):
        return None

    # Namenssuche: »Ort, Halt« → disassembledName; Umkreissuche: name ist schon kurz.
    kurz = (halt.get("disassembledName") or halt.get("name") or "").strip()
    text = kurz.lower()
    ort = str((halt.get("parent") or {}).get("name") or "")
    np = namens_punkte(text, name)
    # EFA nennt den Hauptort wie die Gemeinde (»Walldorf (Baden)«), Ortsteile anders.
    # Nennt der Haltname einen Ortsteil, gilt der Halt nicht als Hauptort, auch
    # wenn EFA ihn ihm zuordnet, und sein Gleis zählt nur halb.
    ortsteil = ortsteil_halt(text, name)
    hauptort = bool(ort) and ort.lower().startswith(kern(name)) and not ortsteil
    klassen = set(halt.get("productClasses") or [])
    schiene = bool(klassen & SCHIENE)
    eigene_gemeinde = gemeinde_von(halt) == ags

    punkte = np
    punkte += PUNKTE_EIGENE_GEMEINDE if eigene_gemeinde else 0
    punkte += PUNKTE_HAUPTORT if eigene_gemeinde and hauptort else 0
    schiene_punkte = PUNKTE_SCHIENE // 2 if ortsteil else PUNKTE_SCHIENE
    punkte += schiene_punkte if schiene else PUNKTE_STADTBAHN if klassen & STADTBAHN else 0
    punkte += min(len(klassen), 6)        # Knoten mit vielen Verkehrsmitteln
    punkte += PUNKTE_GEWERBE if GEWERBE.search(text) else 0
    punkte += PUNKTE_ERSATZHALT if ERSATZ.search(text) else 0
    punkte += PUNKTE_JE_KM * dist / 1000

    if not eigener_kreis:
        art = "nachbarkreis"
    elif schiene and np >= 20:
        art = "bahnhof"
    elif np >= PUNKTE_ORTSNAME:
        art = "zentral"
    else:
        art = "naechster"
    # Außerhalb der eigenen Gemeinde den Ort nennen, sonst ist »Bahnhof« irreführend.
    anzeige = kurz if eigene_gemeinde or not ort or ort.lower() in text else f"{ort}, {kurz}"
    return {
        "stopId": hid,
        "stopName": anzeige or name,
        "lat": round(hlat, 6),
        "lon": round(hlon, 6),
        "entfernungM": int(round(dist)),
        "art": art,
        "_punkte": round(punkte, 2),
        "_eigenerKreis": eigener_kreis,
    }


def rangliste(halte: list, ags: str, name: str, kreis: str, lat: float, lon: float) -> list:
    """Gültige Kandidaten, beste zuerst; Nachbarkreis nur, wenn der eigene Kreis keinen hat."""
    beste: dict[str, dict] = {}
    for h in halte:
        k = kandidat(h, ags, name, kreis, lat, lon)
        if k and (k["stopId"] not in beste or k["_punkte"] > beste[k["stopId"]]["_punkte"]):
            beste[k["stopId"]] = k
    eigene = [k for k in beste.values() if k["_eigenerKreis"]]
    wahl = eigene or list(beste.values())
    return sorted(wahl, key=lambda k: (-k["_punkte"], k["entfernungM"], k["stopId"]))


def liefert_abfahrten(stop_id: str) -> dict | None:
    """Der Halt, wie ihn der Abfahrtsmonitor aufgelöst hat, oder None.

    Die Suche liefert auch IDs, die XML_DM_REQUEST nicht auflöst. Ein
    aufgelöster Halt ohne Abfahrten zählt als gültig: -4050 »no serving lines«
    und -4030 »no matching departure« (wie isEmptyDepartureMonitor im
    Konnektordienst) — sonst hinge das Ergebnis von der Uhrzeit des Laufs ab.
    """
    # Netzfehler steigen auf: ein EFA-Ausfall ist kein »ungültiger Halt«.
    d = _get(EFA_DM + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "type_dm": "any", "name_dm": stop_id,
        "mode": "direct", "useRealtime": "1", "limit": "3",
    }))
    # Eine unbekannte ID löst EFA unscharf auf (irgendein POI) und liefert
    # dann die Abfahrten eines anderen Halts — Abfahrten allein beweisen nichts.
    ort = next((l for l in d.get("locations") or []
                if isinstance(l, dict) and l.get("type") == "stop" and l.get("isBest") is True
                and (l.get("id") == stop_id or str(l.get("id", "")).startswith(stop_id + ":"))), None)
    if ort is None or not isinstance(d.get("version"), str):
        return None
    if isinstance(d.get("stopEvents"), list):
        return ort
    if "stopEvents" in d or any(
            isinstance(m, dict) and m.get("type") == "error" and m.get("code") not in KEINE_ABFAHRTEN
            for m in d.get("systemMessages") or []):
        return None
    return ort


def halt_suchen(ags: str, name: str, kreis: str, lat: float, lon: float) -> dict | None:
    """Zentraler Halt einer Gemeinde um die Ortsmitte (lat, lon), oder None."""
    # Die 100 nächsten Halte decken die Ortsmitte ab; die Namenssuche ergänzt den
    # Bahnhof, der bei großen Städten weiter draußen liegen kann.
    halte = suche_koordinate(lat, lon) + suche(name + " Bahnhof")
    for k in rangliste(halte, ags, name, kreis, lat, lon)[:MAX_DM_VERSUCHE]:
        ort = liefert_abfahrten(k["stopId"])
        if ort is None:
            continue
        eintrag = {f: v for f, v in k.items() if not f.startswith("_")}
        if PLATZHALTER.search(eintrag["stopName"].lower()):
            dm_name = (ort.get("disassembledName") or str(ort.get("name") or "").split(",")[-1]).strip()
            if not dm_name or PLATZHALTER.search(dm_name.lower()):
                continue
            eintrag["stopName"] = dm_name
        return eintrag
    return None


def ortsmitten_laden() -> int:
    """Wikidata P625 je AGS (P439) nach scripts/ortsmitten.json — eine Abfrage."""
    query = """SELECT ?ags ?coord WHERE {
  ?ort wdt:P439 ?ags . FILTER(STRSTARTS(?ags, "08"))
  ?ort wdt:P625 ?coord .
}"""
    url = SPARQL + "?" + urllib.parse.urlencode({"query": query, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": "udp-efa-haltestellen/1.0",
                                               "Accept": "application/sparql-results+json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        daten = json.load(r)
    gemeinden = {g[0]: g for g in json.loads(GEMEINDEN.read_text(encoding="utf-8"))["gemeinden"]}
    mitten: dict[str, list] = {}
    for b in daten["results"]["bindings"]:
        ags, wert = b["ags"]["value"], b["coord"]["value"]      # »Point(lon lat)«
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", wert)
        g = gemeinden.get(ags)
        if not m or not g:
            continue
        punkt = [round(float(m.group(2)), 6), round(float(m.group(1)), 6)]
        # Mehrere Koordinaten: die nächste am Schwerpunkt.
        alt = mitten.get(ags)
        if alt is None or entfernung_m(g[2], g[3], *punkt) < entfernung_m(g[2], g[3], *alt):
            mitten[ags] = punkt
    ORTSMITTEN.write_text(json.dumps(
        {"_doc": "Ortsmitte je AGS: Wikidata P625 (über P439), [lat, lon]; "
                 "erzeugt von scripts/efa-haltestellen.py --ortsmitten",
         "ortsmitten": dict(sorted(mitten.items()))}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(mitten)} Ortsmitten für {len(gemeinden)} Gemeinden gespeichert")
    return 0


def ortsmitte(g: list, mitten: dict) -> tuple[float, float]:
    """Bezugspunkt einer Gemeinde: Ortsmitte, sonst Flächenschwerpunkt."""
    punkt = mitten.get(g[0])
    if punkt and entfernung_m(g[2], g[3], punkt[0], punkt[1]) <= ORTSMITTE_MAX_M:
        return float(punkt[0]), float(punkt[1])
    return g[2], g[3]


def kuratierte_halte() -> dict:
    """AGS → (stopId, stopName) der von Hand gepflegten Halte von `efa-abfahrten`."""
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    eintrag = next(c for c in registry["connectors"] if c["id"] == "efa-abfahrten")
    params = eintrag.get("params") or {}
    namen = params.get("stopName") or {}
    return {ags: (sid, namen.get(ags)) for ags, sid in (params.get("stopId") or {}).items() if sid}


def kuratierter_halt(stop_id: str, registry_name: str | None, name: str, lat: float, lon: float) -> dict:
    """Der Halt aus der Registry, mit EFA-Koordinate. Wirft, wenn EFA ihn nicht kennt."""
    for h in suche(stop_id):
        koord = h.get("coord")
        if h.get("id") == stop_id and isinstance(koord, list) and len(koord) == 2:
            hlat, hlon = float(koord[0]), float(koord[1])
            return {
                "stopId": stop_id,
                # Der gepflegte Name ohne Ortsvorsatz: »Baden-Baden, Bahnhof« → »Bahnhof«.
                "stopName": (registry_name or h.get("disassembledName") or name).split(",")[-1].strip(),
                "lat": round(hlat, 6),
                "lon": round(hlon, 6),
                "entfernungM": int(round(entfernung_m(lat, lon, hlat, hlon))),
                "art": "kuratiert",
            }
    raise RuntimeError(f"kuratierter Halt {stop_id} bei EFA nicht gefunden")


def speichern(bestand: dict) -> None:
    # Erst vollständig schreiben, dann ersetzen: ein Abbruch hinterlässt keine halbe Datei.
    tmp = ZIEL.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(
        {"_doc": "Zentraler ÖPNV-Halt je Gemeinde (EFA-BW); erzeugt von scripts/efa-haltestellen.py. "
                 "Gemeinden ohne gültigen Halt fehlen.",
         "halte": dict(sorted(bestand.items()))}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, ZIEL)


def pruefen() -> int:
    """Jeden hinterlegten Halt testen; untaugliche neu ermitteln oder entfernen."""
    gemeinden = {g[0]: g for g in json.loads(GEMEINDEN.read_text(encoding="utf-8"))["gemeinden"]}
    mitten = json.loads(ORTSMITTEN.read_text(encoding="utf-8")).get("ortsmitten", {}) \
        if ORTSMITTEN.exists() else {}
    bestand = json.loads(ZIEL.read_text(encoding="utf-8"))["halte"]
    print(f"{len(bestand)} Halte werden gegen den Abfahrtsmonitor geprüft")
    ersetzt = verworfen = 0
    for i, (ags, eintrag) in enumerate(sorted(bestand.items()), 1):
        if i % 100 == 0:
            print(f"  {i}/{len(bestand)} geprüft · {ersetzt} ersetzt · {verworfen} verworfen", flush=True)
        if eintrag.get("art") == "kuratiert":
            continue                                # gepflegt, nicht hier ersetzen
        g = gemeinden.get(ags)
        try:
            if liefert_abfahrten(eintrag["stopId"]) is not None:
                continue
            neu = halt_suchen(ags, g[1], g[4], *ortsmitte(g, mitten)) if g else None
        except Exception as e:                      # Netzfehler: Eintrag behalten
            print(f"  {g[1] if g else ags}: {e} — Eintrag bleibt", file=sys.stderr)
            continue
        if neu:
            bestand[ags] = neu
            ersetzt += 1
        else:
            del bestand[ags]
            verworfen += 1
            print(f"  {g[1] if g else ags}: kein brauchbarer Halt — Eintrag entfernt")
    speichern(bestand)
    print(f"fertig: {len(bestand)} brauchbare Halte, {ersetzt} ersetzt, {verworfen} verworfen")
    return 0


def main() -> int:
    global CACHE
    if "--cache" in sys.argv and sys.argv.index("--cache") + 1 < len(sys.argv):
        cache_datei = pathlib.Path(sys.argv[sys.argv.index("--cache") + 1])
        CACHE = json.loads(cache_datei.read_text(encoding="utf-8")) if cache_datei.exists() else {}
    else:
        cache_datei = None
    if "--ortsmitten" in sys.argv:
        return ortsmitten_laden()
    if "--pruefen" in sys.argv:
        return pruefen()
    # Gemeindefreie Gebiete (Typ F, Truppenübungsplätze, Staatsforste) haben keinen Halt.
    gemeinden = [g for g in json.loads(GEMEINDEN.read_text(encoding="utf-8"))["gemeinden"] if g[5] != "F"]
    mitten = json.loads(ORTSMITTEN.read_text(encoding="utf-8")).get("ortsmitten", {}) \
        if ORTSMITTEN.exists() else {}
    bestand = {} if "--neu" in sys.argv or not ZIEL.exists() else \
        json.loads(ZIEL.read_text(encoding="utf-8")).get("halte", {})
    erlaubt = {g[0] for g in gemeinden}
    for ags in [a for a in bestand if a not in erlaubt]:
        del bestand[ags]
    kuratiert = kuratierte_halte()
    if "--nur" in sys.argv:
        i = sys.argv.index("--nur")
        if i + 1 >= len(sys.argv):
            print("--nur braucht AGS, z. B. --nur 08226096,08237040", file=sys.stderr)
            return 2
        nur = set(sys.argv[i + 1].split(","))
        offen = [g for g in gemeinden if g[0] in nur]
    elif "--alle" in sys.argv:
        offen = list(gemeinden)
    else:
        # Ohne Koordinate: aus dem alten, rein namensbasierten Lauf. Kuratierte
        # Halte, die nicht (mehr) zur Registry passen, werden nachgezogen.
        offen = [g for g in gemeinden if "lat" not in bestand.get(g[0], {})
                 or (g[0] in kuratiert and bestand[g[0]].get("stopId") != kuratiert[g[0]][0])]
    print(f"{len(gemeinden)} Gemeinden, {len(bestand)} Einträge ({len(kuratiert)} kuratiert), "
          f"{len(offen)} zu ermitteln")
    if not offen:
        return 0
    print(f"geschätzte Dauer ohne Cache: {len(offen) * 3.5 * PAUSE / 60:.0f} min", flush=True)

    fehler = 0
    for i, g in enumerate(offen, 1):
        ags, name, kreis = g[0], g[1], g[4]
        lat, lon = ortsmitte(g, mitten)
        try:
            if ags in kuratiert:
                treffer = kuratierter_halt(kuratiert[ags][0], kuratiert[ags][1], name, lat, lon)
            else:
                treffer = halt_suchen(ags, name, kreis, lat, lon)
            if treffer:
                bestand[ags] = treffer
            else:
                bestand.pop(ags, None)
                fehler += 1
                print(f"  {name} ({ags}): kein gültiger Halt — ausgelassen", flush=True)
        except Exception as e:                      # Netzfehler: Eintrag bleibt unverändert
            fehler += 1
            print(f"  {name} ({ags}): {e}", file=sys.stderr, flush=True)
        if i % 25 == 0 or i == len(offen):
            speichern(bestand)
            if cache_datei is not None:
                tmp = cache_datei.with_suffix(cache_datei.suffix + ".tmp")
                tmp.write_text(json.dumps(CACHE, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, cache_datei)
            print(f"  {i}/{len(offen)} · {len(bestand)} Halte · {fehler} ohne Treffer", flush=True)

    from collections import Counter
    arten = Counter(h.get("art") for h in bestand.values())
    print(f"fertig: {len(bestand)} Halte {dict(arten)}, {fehler} ohne Treffer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
