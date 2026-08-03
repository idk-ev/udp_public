# Sicherheitshinweise melden

Bitte Schwachstellen **nicht** als öffentliches Issue melden, sondern per
E-Mail an **tk@idkev.de** (Betreff „UDP Security"). Wir bestätigen
den Eingang innerhalb von 5 Werktagen.

Relevanter Scope: dieser Quellcode, die Compose-/Kubernetes-Konfigurationen
und die ausgelieferten Dashboards. Nicht im Scope: die angebundenen
Fremd-APIs (DWD, UBA, MobiData BW …).

Betriebsseitige Härtung ist in `docs/betrieb.md` dokumentiert (Gateway-
Zugriffskontrolle, Micro-Cache, Backups, Secrets in `platform/.env`).
