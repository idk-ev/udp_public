#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Ermittelt je BW-Gemeinde den zentralen ÖPNV-Halt (EFA-BW).

Das Ergebnis (gui/public/oepnv-halte.json) ist Eingangsdatum für den
Abfahrtsmonitor: Das Dashboard fragt Abfahrten auf Anfrage ab (Endpunkt
/abfahrten des Konnektordienstes), braucht dafür aber je Gemeinde eine Halte-ID.

Auswahl (siehe rangliste): Kandidaten aus der Umkreissuche um den
Gemeindemittelpunkt und aus der Namenssuche, nur mit EFA-Koordinate. Gültig
ist ein Halt nur, wenn seine ID den eigenen Kreis trägt (de:08<kreis>:…) und
er höchstens RADIUS_EIGEN_M vom Mittelpunkt liegt; nur wenn es keinen solchen
gibt, ein Halt in einem anderen BW-Kreis binnen RADIUS_NACHBAR_M. Unter den
gültigen gewinnt die höchste Punktzahl (Bahnhof, ZOB, Rathaus, Mitte, eigene
Gemeinde und ihr Hauptort, Nähe), nicht der erste Treffer. Eine Gemeinde ohne
gültigen Halt fehlt in der Datei — lieber keine Abfahrtstafel als eine falsche.

Bewusst langsam (1,2 s Pause, rund drei Anfragen je Gemeinde) und
wiederaufnehmbar: Einträge mit Koordinate werden übersprungen.

    py -3 scripts/efa-haltestellen.py                 # fehlende ergänzen
    py -3 scripts/efa-haltestellen.py --neu           # alles neu ermitteln
    py -3 scripts/efa-haltestellen.py --nur 08226096,08237040
    py -3 scripts/efa-haltestellen.py --pruefen       # Halte gegen den Abfahrtsmonitor testen
    py -3 scripts/efa-haltestellen.py --neu --cache efa-cache.json   # Suchen zwischenspeichern
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
EFA = "https://www.efa-bw.de/nvbw/XML_STOPFINDER_REQUEST"
EFA_COORD = "https://www.efa-bw.de/nvbw/XML_COORD_REQUEST"
EFA_DM = "https://www.efa-bw.de/nvbw/XML_DM_REQUEST"
PAUSE = 1.2
KOORD_FORMAT = "WGS84[dd.ddddd]"

# Der Gemeindemittelpunkt (bw-gemeinden.json) ist mal der Ortskern, mal der
# Flächenschwerpunkt. Die mittlere BW-Gemeinde hat rund 30 km² (Radius eines
# flächengleichen Kreises ~3 km); auch flächengroße Gemeinden haben ihren
# Hauptort binnen 5 km vom Mittelpunkt. Weiter draußen liegt ein anderer Ort.
RADIUS_EIGEN_M = 5000
# Halt in einem anderen BW-Kreis: nur, wenn der eigene Kreis keinen gültigen
# hat, und nur direkt jenseits der Grenze.
RADIUS_NACHBAR_M = 2000
# Dieselben Grenzen prüft tests/static/data-integrity.test.js.

# EFA-Produktklassen: 0 Zug, 1 S-Bahn, 13 Regionalzug, 14 Fernzug, 15 ICE,
# 16 Sonderzug; 2 U-Bahn, 3 Stadtbahn, 4 Straßenbahn.
SCHIENE = {0, 1, 13, 14, 15, 16}
STADTBAHN = {2, 3, 4}

# Punkte für den Haltnamen (nur das höchste Merkmal zählt).
NAMEN = [
    (re.compile(r"\b(hauptbahnhof|hbf)\b"), 25),
    (re.compile(r"\b(bahnhof|bf|bhf)\b"), 20),
    (re.compile(r"\b(zob|busbahnhof|omnibusbahnhof)\b"), 18),
    # Nicht »SBK-Markt« (ein Laden) oder »Schulzentrum«.
    (re.compile(r"(?<![\w-])(rathaus(platz)?|markt(platz)?|(orts|stadt|dorf)?mitte|(orts|stadt)?zentrum)\b"), 12),
]
ERSATZ = re.compile(r"\bersatz|\bsev\b")        # Ersatzhalt, »(Ersatz)«, »Ersatz-Hst.«, SEV
PUNKTE_ORTSNAME = 10          # »Böllen, Böllen«: der Halt heißt wie die Gemeinde
PUNKTE_EIGENE_GEMEINDE = 30   # EFA ordnet den Halt der Gemeinde selbst zu
PUNKTE_HAUPTORT = 10          # … und ihrem Hauptort, nicht einem Ortsteil
PUNKTE_SCHIENE = 10
PUNKTE_STADTBAHN = 5
PUNKTE_JE_KM = -5             # Nähe zum Gemeindemittelpunkt
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
    namens_punkte = max((p for rx, p in NAMEN if rx.search(text)), default=0)
    if text and text in (name.lower(), kern(name)):
        namens_punkte += PUNKTE_ORTSNAME
    # EFA nennt den Hauptort wie die Gemeinde (»Walldorf (Baden)«), Ortsteile anders.
    hauptort = bool(ort) and ort.lower().startswith(kern(name))
    klassen = set(halt.get("productClasses") or [])
    schiene = bool(klassen & SCHIENE)
    eigene_gemeinde = gemeinde_von(halt) == ags

    punkte = namens_punkte
    punkte += PUNKTE_EIGENE_GEMEINDE if eigene_gemeinde else 0
    punkte += PUNKTE_HAUPTORT if eigene_gemeinde and hauptort else 0
    punkte += PUNKTE_SCHIENE if schiene else PUNKTE_STADTBAHN if klassen & STADTBAHN else 0
    punkte += min(len(klassen), 6)        # Knoten mit vielen Verkehrsmitteln
    punkte += PUNKTE_ERSATZHALT if ERSATZ.search(text) else 0
    punkte += PUNKTE_JE_KM * dist / 1000

    if not eigener_kreis:
        art = "nachbarkreis"
    elif schiene and namens_punkte >= 20:
        art = "bahnhof"
    elif namens_punkte >= PUNKTE_ORTSNAME:
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


def liefert_abfahrten(stop_id: str) -> bool:
    """Kennt der Abfahrtsmonitor diesen Halt?

    Die Suche liefert auch IDs, die XML_DM_REQUEST nicht auflöst. Ein
    aufgelöster Halt ohne Abfahrten zählt als gültig: -4050 »no serving lines«
    (wie isEmptyDepartureMonitor im Konnektordienst) und -4030 »no matching
    departure« (abends auf dem Land) — sonst hinge das Ergebnis von der Uhrzeit
    des Laufs ab.
    """
    # Netzfehler steigen auf: ein EFA-Ausfall ist kein »ungültiger Halt«.
    d = _get(EFA_DM + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "type_dm": "any", "name_dm": stop_id,
        "mode": "direct", "useRealtime": "1", "limit": "3",
    }))
    # Eine unbekannte ID löst EFA unscharf auf (irgendein POI) und liefert
    # dann die Abfahrten eines anderen Halts — Abfahrten allein beweisen nichts.
    aufgeloest = any(isinstance(l, dict) and l.get("type") == "stop" and l.get("isBest") is True
                     and (l.get("id") == stop_id or str(l.get("id", "")).startswith(stop_id + ":"))
                     for l in d.get("locations") or [])
    if not aufgeloest or not isinstance(d.get("version"), str):
        return False
    if isinstance(d.get("stopEvents"), list):
        return True
    return "stopEvents" not in d and not any(
        isinstance(m, dict) and m.get("type") == "error" and m.get("code") not in KEINE_ABFAHRTEN
        for m in d.get("systemMessages") or [])


def halt_suchen(ags: str, name: str, kreis: str, lat: float, lon: float) -> dict | None:
    """Zentraler Halt einer Gemeinde, oder None ohne gültigen Kandidaten."""
    # Die 100 nächsten Halte decken die Ortsmitte ab; die Namenssuche ergänzt den
    # Bahnhof, der bei großen Städten weiter draußen liegen kann.
    halte = suche_koordinate(lat, lon)
    time.sleep(PAUSE)
    halte += suche(name + " Bahnhof")
    for k in rangliste(halte, ags, name, kreis, lat, lon)[:MAX_DM_VERSUCHE]:
        time.sleep(PAUSE)
        if liefert_abfahrten(k["stopId"]):
            return {f: v for f, v in k.items() if not f.startswith("_")}
    return None


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
    bestand = json.loads(ZIEL.read_text(encoding="utf-8"))["halte"]
    print(f"{len(bestand)} Halte werden gegen den Abfahrtsmonitor geprüft")
    ersetzt = verworfen = 0
    for i, (ags, eintrag) in enumerate(sorted(bestand.items()), 1):
        if i % 100 == 0:
            print(f"  {i}/{len(bestand)} geprüft · {ersetzt} ersetzt · {verworfen} verworfen", flush=True)
        time.sleep(PAUSE)
        g = gemeinden.get(ags)
        try:
            if liefert_abfahrten(eintrag["stopId"]):
                continue
            neu = halt_suchen(ags, g[1], g[4], g[2], g[3]) if g else None
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
    if "--pruefen" in sys.argv:
        return pruefen()
    gemeinden = json.loads(GEMEINDEN.read_text(encoding="utf-8"))["gemeinden"]
    bestand = {} if "--neu" in sys.argv or not ZIEL.exists() else \
        json.loads(ZIEL.read_text(encoding="utf-8")).get("halte", {})
    if "--nur" in sys.argv:
        i = sys.argv.index("--nur")
        if i + 1 >= len(sys.argv):
            print("--nur braucht AGS, z. B. --nur 08226096,08237040", file=sys.stderr)
            return 2
        nur = set(sys.argv[i + 1].split(","))
        offen = [g for g in gemeinden if g[0] in nur]
    else:
        # Einträge ohne Koordinate stammen aus dem alten, rein namensbasierten Lauf.
        offen = [g for g in gemeinden if "lat" not in bestand.get(g[0], {})]
    print(f"{len(gemeinden)} Gemeinden, {len(bestand)} Einträge, {len(offen)} zu ermitteln")
    if not offen:
        return 0
    global CACHE
    cache_datei = None
    if "--cache" in sys.argv and sys.argv.index("--cache") + 1 < len(sys.argv):
        cache_datei = pathlib.Path(sys.argv[sys.argv.index("--cache") + 1])
        CACHE = json.loads(cache_datei.read_text(encoding="utf-8")) if cache_datei.exists() else {}
    print(f"geschätzte Dauer: {len(offen) * 3.5 * PAUSE / 60:.0f} min", flush=True)

    fehler = 0
    for i, g in enumerate(offen, 1):
        ags, name, lat, lon, kreis = g[0], g[1], g[2], g[3], g[4]
        try:
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
                cache_datei.write_text(json.dumps(CACHE, ensure_ascii=False), encoding="utf-8")
            print(f"  {i}/{len(offen)} · {len(bestand)} Halte · {fehler} ohne Treffer", flush=True)
        time.sleep(PAUSE)

    from collections import Counter
    arten = Counter(h.get("art") for h in bestand.values())
    print(f"fertig: {len(bestand)} Halte {dict(arten)}, {fehler} ohne Treffer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
