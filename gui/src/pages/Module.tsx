/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { config } from "../config";
import { IconExternal } from "../icons";

interface Mod {
  key: string;
  name: string;
  desc: string;
  tag: string;
  color: string;
  initials: string;
}

const modules: Mod[] = [
  { key: "hauptdashboard", name: "UDP-Hauptdashboard", desc: "Kommunen-Suche (Dashboard je Gemeinde und Landkreis) plus Betriebsübersicht: Schnittstellen-Health, Konnektoren, Datenbank, Ingestion und Serverlast.", tag: "Betrieb · Monitoring", color: "var(--series-6)", initials: "HD" },
  { key: "smartcity", name: "Smart City Reutlingen", desc: "Öffentliches Live-Dashboard: Wetter, Luftqualität, Parken, Sharing, Ladesäulen und ÖPNV aus offenen Datenquellen.", tag: "Visualisierung · Open Data", color: "var(--series-5)", initials: "SC" },
  { key: "masterportal", name: "Masterportal", desc: "Kommunales Geoportal (Geowerkstatt Hamburg) mit WMS/WFS-Themen der Plattform.", tag: "Visualisierung · GIS", color: "var(--series-2)", initials: "MP" },
  { key: "geoserver", name: "GeoServer", desc: "OGC-Dienste: WMS, WFS und WPS für Geodaten der Plattform.", tag: "Geodaten · OGC", color: "var(--series-4)", initials: "GS" },
  { key: "nodered", name: "Node-RED", desc: "Low-Code-Datenflüsse und ETL: Datenquellen anbinden, transformieren, in NGSI-LD überführen.", tag: "Datenmanagement", color: "var(--series-3)", initials: "NR" },
  { key: "ckan", name: "CKAN Open-Data-Portal", desc: "DCAT-AP.de-kompatibler Metadatenkatalog zur Veröffentlichung offener Verwaltungsdaten.", tag: "Open Data", color: "var(--series-1)", initials: "CK" },
  { key: "frost", name: "FROST-Server", desc: "OGC SensorThings API für standardisierten Zugriff auf Sensordaten.", tag: "IoT · OGC", color: "var(--series-5)", initials: "FS" },
  { key: "keycloakAdmin", name: "Keycloak", desc: "Mandantenfähiges Identitäts-, Rollen- und Rechtemanagement (OIDC/SAML).", tag: "Sicherheit", color: "var(--series-1)", initials: "KC" },
  { key: "uptimeKuma", name: "Uptime Kuma", desc: "Verfügbarkeits-Monitoring mit automatischer Alarmierung bei Störungen.", tag: "Betrieb", color: "var(--series-2)", initials: "UK" },
];

export default function Module() {
  return (
    <>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Alle Module sind Open-Source-Komponenten der Plattform und öffnen sich in einem neuen Tab.
        {config.authEnabled
          ? " Der Zugriff wird über das Rollen- und Rechtemanagement (Keycloak) gesteuert."
          : " In dieser Auslieferung sind nur die öffentlich veröffentlichten Module verlinkt; Betriebswerkzeuge bleiben plattformintern."}
      </p>
      <div className="grid grid-4">
        {/* Ohne aktive Anmeldung ist die Keycloak-Konsole nicht veröffentlicht —
            die Kachel entfällt ganz statt als toter Link stehen zu bleiben. */}
        {modules.filter((m) => m.key !== "keycloakAdmin" || config.authEnabled).map((m) => {
          const url = config.module[m.key];
          return (
            <a
              key={m.key}
              className="card module-card"
              href={url || "#"}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!url}
            >
              <div className="module-icon" style={{ background: m.color }}>{m.initials}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong>{m.name}</strong> <IconExternal />
              </div>
              <span style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{m.desc}</span>
              <span className="module-tag">{m.tag}</span>
            </a>
          );
        })}
      </div>
    </>
  );
}
