/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { config } from "../config";
import { useAuth } from "../auth";
import { IconExternal } from "../icons";

const roles = [
  { name: "plattform-admin", desc: "Übergreifende Administration der Plattform (Kreisverwaltungen): Mandanten, Module, Freischaltungen." },
  { name: "mandant-admin", desc: "Administration innerhalb eines Mandanten (Kommune/Fachbereich): Benutzer, Datenquellen, Dashboards." },
  { name: "fachanwender", desc: "Lesender und schreibender Zugriff auf die Fachdaten des eigenen Mandanten." },
  { name: "leitstelle", desc: "Erweiterte Echtzeit-Sichten und Alarmfunktionen für Leitstellen und Einsatzkräfte." },
  { name: "buerger", desc: "Öffentlicher Basiszugang: Karten, offene Daten, Informationsangebote." },
];

export default function Verwaltung() {
  const auth = useAuth();

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <h2>Rollen- und Rechtemodell</h2>
        <p className="sub">
          {config.authEnabled ? (
            <>
              Mandantenfähige Benutzerverwaltung über Keycloak (OpenID Connect). Mandanten werden als
              Gruppenbaum abgebildet (Kreis → Kommune) und über den NGSILD-Tenant-Header bis in den
              Context Broker durchgesetzt.
            </>
          ) : (
            <>
              Vorgesehenes Rollen- und Rechtemodell für die Benutzerverwaltung über Keycloak
              (OpenID Connect); Mandanten werden als Gruppenbaum abgebildet (Kreis → Kommune).
              In dieser Auslieferung ist die Anmeldung deaktiviert — das Cockpit zeigt
              ausschließlich öffentliche Sichten.
            </>
          )}
        </p>
        <table className="data">
          <thead><tr><th>Rolle</th><th>Beschreibung</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.name}>
                <td><code>{r.name}</code></td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Der Link führt in die Keycloak-Admin-Konsole. Ohne aktive Anmeldung
            ist sie nicht veröffentlicht (keine /auth-Route am Ingress) — dann
            entfällt auch die Schaltfläche. */}
        {config.authEnabled && config.module.keycloakAdmin && (
          <p style={{ marginTop: 14 }}>
            <a className="btn btn-primary" href={config.module.keycloakAdmin} target="_blank" rel="noreferrer"
               style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
              Benutzerverwaltung öffnen <IconExternal />
            </a>
          </p>
        )}
      </div>

      {config.authEnabled && (
      <div className="card">
        <h2>Meine Sitzung</h2>
        <p className="sub">Aktueller Anmeldestatus dieses Cockpits</p>
        {auth.authenticated ? (
          <table className="data">
            <tbody>
              <tr><td style={{ fontWeight: 600 }}>Benutzer</td><td>{auth.username}</td></tr>
              <tr><td style={{ fontWeight: 600 }}>Rollen</td><td>{auth.roles.join(", ") || "–"}</td></tr>
              <tr><td style={{ fontWeight: 600 }}>Mandant (Token-Claim)</td><td><code>{auth.tenantClaim ?? "–"}</code></td></tr>
            </tbody>
          </table>
        ) : (
          <>
            <p style={{ color: "var(--text-secondary)" }}>
              Sie sind nicht angemeldet. Ohne Anmeldung stehen nur öffentliche Sichten
              (Rolle <code>buerger</code>) zur Verfügung.
            </p>
            <button className="btn-primary" onClick={auth.login} disabled={!auth.ready}>
              Jetzt anmelden
            </button>
          </>
        )}
      </div>
      )}
    </div>
  );
}
