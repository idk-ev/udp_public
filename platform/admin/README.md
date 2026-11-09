# UDP-Verwaltungsoberfläche

SvelteKit-Anwendung (Node 24, `adapter-node`) mit Anmeldung für die Verwaltung der
Plattform. Betrieb, Host und Konten: [`docs/betrieb.md`](../../docs/betrieb.md#verwaltungsoberfläche).

## Aufbau

```
src/
├── hooks.server.ts          Start (Migrationen) und Anfrage-Wächter
├── cli/index.ts             Konten: user add|reset-password|disable|enable|list, throttle clear
├── lib/design/tokens.css    alle Designwerte, an genau einer Stelle
├── lib/design/base.css      Element-Vorgaben
├── lib/components/          gemeinsame Bausteine
├── lib/server/              nur serverseitig (Kit verhindert den Import im Browser)
│   ├── auth/                Passwörter, Sitzungen, Bremse, Rollen, Konten
│   ├── db/                  Verbindung, Zeilen-Prüfung, nummerierte SQL-Migrationen
│   ├── http/                Wächter, Routenliste, Sicherheits-Header, Formulare
│   └── audit.ts             Protokoll (nur anhängen)
└── routes/                  dünn: Formulare lesen, Dienst aufrufen, Ergebnis zeigen
```

## Regeln, die Werkzeuge durchsetzen

- **Typen:** Härtung wie im Konnektordienst. Kein `any`, kein `as` (außer `as const`),
  kein `!`, keine `eslint-disable`-Kommentare. Fremddaten (Umgebung, Formulare,
  Datenbankzeilen) kommen als `unknown` herein und werden geprüft, nicht behauptet.
  Beweis: `tests/static/admin-type-discipline.test.js`.
- **Design:** Farben, Abstände, Radien und Schrift nur als Variablen aus `tokens.css`,
  keine `style`-Attribute. Prüfung: `tests/static/admin-design.test.js`.
- **Zugriff:** Eine Route ist nur erreichbar, wenn sie in `lib/server/http/routes.ts`
  steht. Ein Test schlägt fehl, wenn eine Route dort fehlt. Neue Rechte stehen in
  `lib/server/auth/permissions.ts`.
- **Konten:** Die Oberfläche legt keine Konten an und ändert keine fremden. Das geht
  nur über `lib/server/auth/operator.ts`, und das benutzt nur die Kommandozeile.

## Entwicklung

```bash
npm ci
npm run lint && npm run check   # läuft auch mit Node 22
npm test                        # braucht Node 24 (Argon2), Datenbank: PGlite im Prozess
npm run build                   # build/ und build-cli/
npm run test:integration        # echtes PostgreSQL und gebauter Server, s. vitest.integration.config.ts
```
