# Mitwirken

Die UDP ist eine EUPL-1.2-Referenzimplementierung („Public Money – Public
Code"). Beiträge sind willkommen — von Doku-Korrekturen bis zu neuen
Konnektoren.

## Lizenz der Beiträge

Alle Beiträge werden **ausschließlich unter der EUPL-1.2** eingereicht (siehe
[`LICENSE`](LICENSE), deutsche Fassung: [`LICENSE.de`](LICENSE.de)). Wer einen
Beitrag einreicht, stellt ihn unter dieselbe Lizenz wie das übrige Werk.

Neue Abhängigkeiten müssen OSI-konform und mit der EUPL-1.2 vereinbar sein und
in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) aufgeführt werden. Kommt
eine Komponente unter Copyleft (GPL, AGPL, LGPL, MPL, EPL) hinzu, gehört in den
Pull Request eine kurze Begründung, warum daraus kein abgeleitetes Werk
entsteht — oder welche Folgen sich daraus ergeben.

## Developer Certificate of Origin (DCO)

Dieses Projekt verlangt das **Developer Certificate of Origin 1.1**
(<https://developercertificate.org/>) statt eines Contributor License
Agreements. Damit bestätigst du, dass du die Rechte an deinem Beitrag hast und
ihn unter der EUPL-1.2 beisteuern darfst.

Jeder Commit braucht deshalb eine `Signed-off-by`-Zeile mit deinem echten Namen
und einer erreichbaren E-Mail-Adresse:

```
Signed-off-by: Vorname Nachname <du@example.org>
```

Git erzeugt sie automatisch mit `-s`:

```bash
git commit -s -m "Konnektor für X ergänzt"
```

Einmalig einrichten:

```bash
git config user.name  "Vorname Nachname"
git config user.email "du@example.org"
```

Vergessene Signatur nachtragen:

```bash
git commit --amend -s --no-edit        # letzter Commit
git rebase --signoff main              # alle Commits des Branches
```

Pull Requests mit Commits ohne gültige `Signed-off-by`-Zeile werden nicht
zusammengeführt.

## Pull-Request-Workflow

1. **Repository forken** und einen Branch von `main` anlegen
   (`feature/…`, `fix/…`, `docs/…`).
2. **Änderung umsetzen.** Ein PR pro Thema — gemischte PRs werden zur
   Aufteilung zurückgegeben.
3. **Lokal prüfen**, bevor du pushst:
   ```bash
   node tests/run.js                 # statische Tests
   npm --prefix gui run lint         # Lint
   npm --prefix gui run build        # Build
   ```
   Die Pre-Commit-Hooks erledigen die ersten beiden automatisch, wenn du
   einmalig `git config core.hooksPath .githooks` gesetzt hast.
4. **Commits signieren** (`git commit -s`, siehe DCO).
5. **Pull Request öffnen** gegen `main`. Beschreibe: was, warum, wie geprüft.
   Bei sichtbaren Änderungen an den Dashboards hilft ein Screenshot.
6. **CI muss grün sein** (Lint, statische Tests, GUI-Build,
   Compose-Validierung, SSG-Generatoren).
7. **Review.** Rückfragen bitte im PR beantworten und nachbessern; der Branch
   bleibt dabei bestehen.

### Entscheidung über Merges

Über die Aufnahme von Beiträgen entscheidet der **Maintainer** des
Repositorys. Auch fachlich einwandfreie Beiträge können abgelehnt werden, wenn
sie nicht zur Ausrichtung des Projekts passen — die Ablehnung wird dann
begründet. Da die EUPL-1.2 das Forken ausdrücklich erlaubt, steht es jedem
frei, abgelehnte Änderungen in einem eigenen Fork weiterzuführen.

## Einstieg

1. Stack starten: `docker compose -f platform/docker-compose.yml up -d`
   (zuvor `platform/.env` aus `platform/.env.example` anlegen und **eigene**
   Zugangsdaten setzen; GUI auf :3700).
2. GUI bauen: `npm --prefix gui ci && npm --prefix gui run build`.
3. Tests: `node tests/run.js` (statisch) bzw. `npm --prefix gui run test:live`
   gegen den laufenden Stack.

## Regeln

- **Eine Basis für alle:** Dashboards sind Filter auf die landesweite
  Ingestion — kein Dashboard bringt eigene Datenbeschaffung mit
  (`docs/staedte-hinzufuegen.md`).
- **Konnektoren nur über die Registry** (`platform/config/connectors.json`
  + `scripts/generate-nodered-flows.py`); `flows.json` wird generiert, nie
  von Hand editiert.
- **Keine Zugangsdaten im Repository.** Secrets gehören in `platform/.env`
  (ist in `.gitignore`) oder in ein Secret-Management. `.env.example` enthält
  bewusst nur leere Schlüssel.
- **Neue Quellen brauchen eine Lizenzangabe** in der Registry
  (`attribution`) und in `THIRD-PARTY-NOTICES.md`.
- Jede Quelldatei trägt einen SPDX-Header
  (`SPDX-License-Identifier: EUPL-1.2`); `scripts/add-spdx-headers.py`
  ergänzt fehlende.

## Sicherheitslücken

Bitte **nicht** über einen öffentlichen Issue melden — siehe
[`SECURITY.md`](SECURITY.md).

## Doku-Landkarte

`docs/architektur.md` (Überblick) · `docs/framework-dashboards.md`
(Registry/Betrieb) · `docs/staedte-hinzufuegen.md` (Kommunen-Bauanleitung) ·
`docs/betrieb.md` (Betriebskonzept).
