/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { config } from "./config";
import { setTenant } from "./api";
import { useAuth } from "./auth";
import {
  IconChart, IconDatabase, IconGrid, IconHome, IconMap, IconMoon,
  IconShield, IconSun, IconUser, IconUsers,
} from "./icons";
import Uebersicht from "./pages/Uebersicht";
import Datenexplorer from "./pages/Datenexplorer";
import Karte from "./pages/Karte";
import Zeitreihen from "./pages/Zeitreihen";
import Module from "./pages/Module";
import Verwaltung from "./pages/Verwaltung";

// Die Übersicht liegt unter /cockpit: die Startseite der Domain ist das
// öffentliche Mitmachen-Angebot (platform/config/nginx/cockpit.conf.template).
// "/" bleibt als Route bestehen – im Vite-Dev-Server liefert / die SPA aus.
const titles: Record<string, string> = {
  "/": "Übersicht",
  "/cockpit": "Übersicht",
  "/daten": "Datenexplorer",
  "/karte": "Karte",
  "/zeitreihen": "Zeitreihen",
  "/module": "Module & Dienste",
  "/verwaltung": "Benutzer & Mandanten",
};

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [tenant, setTenantState] = useState("");
  const auth = useAuth();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    setTenant(tenant);
  }, [tenant]);

  const title = titles[location.pathname] ?? "UDP-Cockpit";

  return (
    <div className="app">
      <a className="skip-link" href="#inhalt">Zum Inhalt springen</a>

      <aside className="sidebar" aria-label="Hauptnavigation">
        <div className="brand">
          <div className="brand-logo" aria-hidden>UD</div>
          <div>
            <div className="brand-name">UDP-Cockpit</div>
            <div className="brand-sub">Urbane Datenplattform</div>
          </div>
        </div>

        <nav className="nav">
          <div className="nav-group">Plattform</div>
          <NavLink to="/cockpit"><IconHome /> Übersicht</NavLink>
          <NavLink to="/daten"><IconDatabase /> Datenexplorer</NavLink>
          <NavLink to="/karte"><IconMap /> Karte</NavLink>
          <NavLink to="/zeitreihen"><IconChart /> Zeitreihen</NavLink>
          <div className="nav-group">Betrieb</div>
          <NavLink to="/module"><IconGrid /> Module &amp; Dienste</NavLink>
          <NavLink to="/verwaltung"><IconUsers /> Benutzer &amp; Mandanten</NavLink>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconShield /> EUPL-1.2 · FIWARE · DIN SPEC 91357
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>

          <label className="kbd-hint" htmlFor="tenant-select">Mandant</label>
          <select
            id="tenant-select"
            value={tenant}
            onChange={(e) => setTenantState(e.target.value)}
            aria-label="Mandant wählen"
          >
            {config.tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={theme === "dark" ? "Helles Design aktivieren" : "Dunkles Design aktivieren"}
            title={theme === "dark" ? "Helles Design" : "Dunkles Design"}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>

          {/* Ohne aktive Anmeldung (config.authEnabled=false) entfällt die
              Schaltfläche ganz — die Plattform ist dann rein öffentlich. */}
          {config.authEnabled &&
            (auth.authenticated ? (
              <>
                <span className="badge" title={auth.roles.join(", ")}>
                  <IconUser /> {auth.username}
                </span>
                <button onClick={auth.logout}>Abmelden</button>
              </>
            ) : (
              <button className="btn-primary" onClick={auth.login} disabled={!auth.ready}>
                Anmelden
              </button>
            ))}
        </header>

        <main id="inhalt" className="content">
          <Routes>
            <Route path="/" element={<Uebersicht />} />
            <Route path="/cockpit" element={<Uebersicht />} />
            <Route path="/daten" element={<Datenexplorer />} />
            <Route path="/karte" element={<Karte />} />
            <Route path="/zeitreihen" element={<Zeitreihen />} />
            <Route path="/module" element={<Module />} />
            <Route path="/verwaltung" element={<Verwaltung />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
