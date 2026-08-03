#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Ermittelt je BW-Gemeinde den zentralen ÖPNV-Halt (EFA-BW-Haltestellensuche).

Das Ergebnis (gui/public/oepnv-halte.json) ist Eingangsdatum für den
Abfahrtsmonitor: Das Dashboard fragt Abfahrten auf Anfrage ab (siehe
Node-RED-Endpunkt /abfahrten), braucht dafür aber je Gemeinde eine Halte-ID.

Der Lauf ist einmalig und bewusst langsam (Standard 1,2 s Pause). Er ist
wiederaufnehmbar: Bereits ermittelte Gemeinden werden übersprungen, ein
Abbruch kostet also nichts.

    python3 scripts/efa-haltestellen.py            # fehlende ergänzen
    python3 scripts/efa-haltestellen.py --neu      # alles neu ermitteln
    python3 scripts/efa-haltestellen.py --pruefen  # Halte gegen den Abfahrtsmonitor testen
"""
import json
import pathlib
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

def suche(name: str) -> list:
    url = EFA + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "type_sf": "any",
        "name_sf": name, "anyMaxSizeHitList": "8",
    })
    with urllib.request.urlopen(url, timeout=30) as r:
        daten = json.load(r)
    return [l for l in (daten.get("locations") or []) if l.get("type") == "stop" and l.get("id")]


def suche_koordinate(lat: float, lon: float) -> list:
    """Halte im Umkreis einer Koordinate.

    Rückfallebene für Gemeinden, deren amtlicher Name nicht der EFA-Schreibweise
    entspricht: »Kirchheim unter Teck« heißt dort »Kirchheim (Teck)«, die
    Namenssuche liefert dann nur Sehenswürdigkeiten und keinen einzigen Halt.
    Über die Koordinate ist das eindeutig.
    """
    url = EFA_COORD + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON",
        "coord": f"{lon}:{lat}:WGS84[DD.DDDDD]",
        "inclFilter": "1", "type_1": "STOP", "radius_1": "4000", "max": "10",
    })
    with urllib.request.urlopen(url, timeout=30) as r:
        daten = json.load(r)
    return [l for l in (daten.get("locations") or []) if l.get("type") == "stop" and l.get("id")]


def halt_suchen(name: str, kreis: str, lat: float, lon: float) -> dict | None:
    """Zentraler Halt einer Gemeinde.

    Dreistufig, weil jeder Weg für sich danebengreift: Die Suche nach dem
    bloßen Ortsnamen liefert bei größeren Städten irgendeine Vorortstation
    (»Stuttgart« → Rohr). Hängt man »Bahnhof« an, trifft es dort genau, aber
    Orte ohne Bahnhof landen im falschen Bundesland (»Böllen Bahnhof« →
    Bösensell in Westfalen). Und wo die amtliche Schreibweise von der
    EFA-Schreibweise abweicht, findet die Namenssuche gar keinen Halt
    (»Kirchheim unter Teck« heißt dort »Kirchheim (Teck)«) — dann entscheidet
    die Koordinate.
    """
    # Die EFA-ID trägt den Gemeindeschlüssel (de:08415:…), das nutzen wir zur Prüfung.
    im_kreis = lambda h: str(h.get("id", "")).startswith("de:" + kreis)

    treffer = suche(name + " Bahnhof")
    if treffer and im_kreis(treffer[0]) and (treffer[0].get("matchQuality") or 0) >= 950:
        b = treffer[0]
        return {
            "stopId": b["id"],
            "stopName": b.get("disassembledName") or b.get("name") or name,
            "qualitaet": b.get("matchQuality"),
            "art": "bahnhof",
        }

    time.sleep(PAUSE)
    halte = suche(name)
    kandidaten = [h for h in halte if im_kreis(h)] or halte

    # Ortsmitte vor beliebiger Haltestelle: »Böllen, Böllen« ist der zentrale
    # Halt, »Böllen, Oberböllen« nicht.
    def rang(h):
        voll = (h.get("name") or "").lower()
        kurz = (h.get("disassembledName") or "").lower()
        punkte = 0
        if "busbahnhof" in voll or "zob" in kurz.split():
            punkte = 4
        elif "bahnhof" in voll:
            punkte = 3
        elif kurz and kurz == name.lower():
            punkte = 2
        elif "rathaus" in voll or "zentrum" in voll or "mitte" in voll:
            punkte = 1
        return (-punkte, -(h.get("matchQuality") or 0))

    if kandidaten:
        best = sorted(kandidaten, key=rang)[0]
        return {
            "stopId": best["id"],
            "stopName": best.get("disassembledName") or best.get("name") or name,
            "qualitaet": best.get("matchQuality"),
            "art": "ort",
        }

    # Dritte Stufe: über die Gemeindekoordinate. Greift dort, wo die amtliche
    # Schreibweise von der EFA-Schreibweise abweicht.
    time.sleep(PAUSE)
    alle = suche_koordinate(lat, lon)
    umkreis = [h for h in alle if im_kreis(h)] or alle
    if not umkreis:
        return None
    mitBahnhof = [h for h in umkreis if "bahnhof" in (h.get("name") or "").lower()]
    treffer2 = (mitBahnhof or umkreis)[0]          # EFA liefert nach Entfernung sortiert
    return {
        "stopId": treffer2["id"],
        "stopName": treffer2.get("disassembledName") or treffer2.get("name") or name,
        "qualitaet": None,
        "art": "koordinate",
    }


def liefert_abfahrten(stop_id: str) -> bool:
    """Prüft, ob der Abfahrtsmonitor diesen Halt kennt.

    Nötig, weil die Haltestellensuche IDs zurückgibt, für die XML_DM_REQUEST
    anschließend einen Fehler liefert — rund 8 % der gefundenen Halte, bei den
    über Koordinaten ermittelten sogar jeder fünfte. Ohne diese Prüfung hätten
    etwa 90 Dashboards eine dauerhaft leere Abfahrtstafel.
    """
    url = EFA_DM + "?" + urllib.parse.urlencode({
        "outputFormat": "rapidJSON", "type_dm": "any", "name_dm": stop_id,
        "mode": "direct", "useRealtime": "1", "limit": "3",
    })
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return isinstance(json.load(r).get("stopEvents"), list)
    except Exception:
        return False


def pruefen() -> int:
    """Jeden hinterlegten Halt testen und untaugliche ersetzen."""
    gemeinden = {g[0]: g for g in json.loads(GEMEINDEN.read_text())["gemeinden"]}
    daten = json.loads(ZIEL.read_text())
    bestand = daten["halte"]
    print(f"{len(bestand)} Halte werden gegen den Abfahrtsmonitor geprüft")
    ersetzt = verworfen = 0
    gesamt = len(bestand)
    for i, (ags, eintrag) in enumerate(sorted(bestand.items()), 1):
        if i % 100 == 0:
            print(f"  {i}/{gesamt} geprüft · {ersetzt} ersetzt · {verworfen} verworfen", flush=True)
        if liefert_abfahrten(eintrag["stopId"]):
            time.sleep(PAUSE)
            continue
        # Ersatz suchen: Umkreis der Gemeinde, nach Entfernung sortiert
        g = gemeinden.get(ags)
        gefunden = None
        if g:
            time.sleep(PAUSE)
            try:
                for kand in suche_koordinate(g[2], g[3]):
                    if kand["id"] == eintrag["stopId"]:
                        continue
                    time.sleep(PAUSE)
                    if liefert_abfahrten(kand["id"]):
                        gefunden = {
                            "stopId": kand["id"],
                            "stopName": kand.get("disassembledName") or kand.get("name") or g[1],
                            "qualitaet": None,
                            "art": "geprueft",
                        }
                        break
            except Exception as e:
                print(f"  {g[1]}: {e}", file=sys.stderr)
        if gefunden:
            bestand[ags] = gefunden
            ersetzt += 1
        else:
            del bestand[ags]
            verworfen += 1
            print(f"  {g[1] if g else ags}: kein brauchbarer Halt — Eintrag entfernt")
        if (ersetzt + verworfen) % 10 == 0:
            ZIEL.write_text(json.dumps(daten, ensure_ascii=False, indent=1) + "\n")
        time.sleep(PAUSE)
    ZIEL.write_text(json.dumps(daten, ensure_ascii=False, indent=1) + "\n")
    print(f"fertig: {len(bestand)} brauchbare Halte, {ersetzt} ersetzt, {verworfen} verworfen")
    return 0


def main() -> int:
    if "--pruefen" in sys.argv:
        return pruefen()
    neu = "--neu" in sys.argv
    gemeinden = json.loads(GEMEINDEN.read_text())["gemeinden"]
    bestand = {} if neu or not ZIEL.exists() else json.loads(ZIEL.read_text()).get("halte", {})

    offen = [g for g in gemeinden if g[0] not in bestand]
    print(f"{len(gemeinden)} Gemeinden, {len(bestand)} bereits bekannt, {len(offen)} offen")
    if not offen:
        return 0
    print(f"geschätzte Dauer: {len(offen) * PAUSE / 60:.0f} min")

    fehler = 0
    for i, g in enumerate(offen, 1):
        ags, name, kreis, lat, lon = g[0], g[1], g[4], g[2], g[3]
        try:
            treffer = halt_suchen(name, kreis, lat, lon)
            if treffer:
                bestand[ags] = treffer
            else:
                fehler += 1
        except Exception as e:                      # Netzfehler nicht den Lauf killen lassen
            fehler += 1
            print(f"  {name}: {e}", file=sys.stderr)
        if i % 50 == 0 or i == len(offen):
            ZIEL.write_text(json.dumps(
                {"_doc": "Zentraler ÖPNV-Halt je Gemeinde (EFA-BW-Haltestellensuche); "
                          "erzeugt von scripts/efa-haltestellen.py",
                 "halte": bestand}, ensure_ascii=False, indent=1) + "\n")
            print(f"  {i}/{len(offen)} · {len(bestand)} Halte · {fehler} ohne Treffer")
        time.sleep(PAUSE)

    from collections import Counter
    arten = Counter(h.get("art") for h in bestand.values())
    print(f"fertig: {len(bestand)} Halte {dict(arten)}, {fehler} ohne Treffer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
