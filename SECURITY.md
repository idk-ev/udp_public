# Sicherheitshinweise melden

Bitte Schwachstellen **nicht** als öffentliches Issue melden, sondern per
E-Mail an **tk@idkev.de** (Betreff „UDP Security"). Wir bestätigen
den Eingang innerhalb von 5 Werktagen.

Relevanter Scope: dieser Quellcode, die Compose-/Kubernetes-Konfigurationen
und die ausgelieferten Dashboards. Nicht im Scope: die angebundenen
Fremd-APIs (DWD, UBA, MobiData BW …).

Kein Befund ist der anonyme, lesende Zugriff auf die Plattform-API: Alle
Daten sind öffentliche, offene Daten, die API ist bewusst ohne Anmeldung
lesbar. Das Sicherheitsmodell (nur lesend, ein Mandant, kein OIDC am Gateway)
beschreibt `docs/api.md`. Schreibende Zugriffe von außen, ein Zugriff auf
andere Mandanten als den Standardmandanten oder auf das Betriebsdashboard
ohne Anmeldung sind dagegen meldenswert.

Betriebsseitige Härtung ist in `docs/betrieb.md` dokumentiert (lesender
öffentlicher Pfad, Rate-Limits, Micro-Cache, Backups, Secrets in
`platform/.env`, Hinweise vor dem Einschalten der Anmeldung).
