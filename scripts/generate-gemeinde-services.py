#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Amtliche Gemeinde-Website je AGS aus Wikidata (P856) -> gemeinde-services.json.

Hintergrund: Die kuratierten Link-Kacheln (Veranstaltungen, Mängelmelder, Bäder,
Müllabfuhr) in dashboards.json sind je Kommune von Hand gepflegt und decken nur
wenige ab. Eine flächendeckende, verlässliche Quelle für alle 1.103 Gemeinden
gibt es dafür nicht — wohl aber für die *amtliche Website* der Gemeinde: Wikidata
führt sie über P856, verknüpft mit dem Amtlichen Gemeindeschlüssel (P439), für
1.100 der 1.103 BW-Gemeinden. Von dort aus finden Bürger Abfallkalender,
Veranstaltungen, Mängelmelder und Bäder — das ist der ehrliche gemeinsame Nenner,
statt 4.400 einzelne Service-URLs zu erfinden, die zu großen Teilen tot wären.

Die kuratierten Einzel-Links bleiben unberührt und haben im Frontend Vorrang;
diese Datei füllt nur die Lücke für alle übrigen.

    python3 scripts/generate-gemeinde-services.py

Erneuter Lauf ist unkritisch (idempotent). Die Datei wird versioniert.
"""
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

WURZEL = pathlib.Path(__file__).resolve().parent.parent
GEMEINDEN = WURZEL / "gui" / "public" / "bw-gemeinden.json"
ZIEL = WURZEL / "gui" / "public" / "gemeinde-services.json"
SPARQL = "https://query.wikidata.org/sparql"
UA = "UDP-SmartCity/1.0 (Referenzimplementierung; offene Daten)"

QUERY = """
SELECT ?ags ?web WHERE {
  ?ort wdt:P439 ?ags . FILTER(STRSTARTS(?ags, "08"))
  ?ort wdt:P856 ?web .
}
"""


def hole_websites() -> dict:
    url = SPARQL + "?" + urllib.parse.urlencode({"query": QUERY, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    # WDQS drosselt bei Überlast hart (zeitweise 1 Anfrage/Minute). Es ist nur eine
    # einzige Abfrage — mit Geduld statt vieler Requests wiederholen.
    daten = None
    for versuch in range(6):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                daten = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and versuch < 5:
                print(f"  WDQS drosselt (429), warte 70 s … (Versuch {versuch + 1}/6)", file=sys.stderr)
                time.sleep(70)
                continue
            raise
    if daten is None:
        raise RuntimeError("WDQS nicht erreichbar")

    # Manche Gemeinden führen mehrere Websites — die beste wählen: HTTPS vor HTTP,
    # kürzere (Haupt-)Domain vor Unterseiten.
    def guete(u: str) -> tuple:
        return (0 if u.startswith("https") else 1, len(u))

    best: dict[str, str] = {}
    for b in daten["results"]["bindings"]:
        ags = b["ags"]["value"]
        web = b["web"]["value"]
        if len(ags) != 8:
            continue
        if ags not in best or guete(web) < guete(best[ags]):
            best[ags] = web
    return best


def main() -> int:
    gemeinden = json.loads(GEMEINDEN.read_text())["gemeinden"]
    namen = {r[0]: r[1] for r in gemeinden}

    websites = hole_websites()
    # Nur AGS behalten, die es auch in unserer Gemeindeliste gibt (Zuschnitt-Stand)
    dienste = {ags: {"website": url} for ags, url in websites.items() if ags in namen}

    fehlend = [namen[r[0]] for r in gemeinden if r[0] not in dienste]
    ZIEL.write_text(json.dumps(
        {"_doc": "Amtliche Gemeinde-Website je AGS (Wikidata P856, verknüpft über P439). "
                 "Erzeugt von scripts/generate-gemeinde-services.py. Kuratierte Einzel-Links "
                 "in dashboards.json haben im Dashboard Vorrang.",
         "dienste": dict(sorted(dienste.items()))},
        ensure_ascii=False, indent=1) + "\n")

    print(f"{len(dienste)} von {len(gemeinden)} Gemeinden mit amtlicher Website -> {ZIEL.name}")
    if fehlend:
        print(f"ohne Website ({len(fehlend)}): {', '.join(fehlend[:10])}"
              + (" …" if len(fehlend) > 10 else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
