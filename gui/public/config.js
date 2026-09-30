/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// Laufzeit-Konfiguration des UDP-Cockpits (ohne Neubau austauschbar).
// Im Container-Betrieb laufen alle Aufrufe über den Reverse-Proxy /gateway.
// Host-Ports gemäß zentralem Port-Schema ~/projects/PORTS.md (Projekt-Index 7):
// UI 3700 · Workflow 4900 · DB 5439 · App/Keycloak 8700 · Proxy/Gateway 8780.
window.UDP_CONFIG = {
  gatewayUrl: "/gateway",
  keycloak: {
    url: "http://localhost:8700",
    realm: "udp",
    clientId: "udp-cockpit",
  },
  module: {
    hauptdashboard: "/dashboard.html",
    smartcity: "/reutlingen",
    nodered: "http://localhost:4900",
    ckan: "http://localhost:8780/catalog",
    geoserver: "http://localhost:8780/geoserver",
    frost: "http://localhost:8780/FROST-Server/v1.1",
    // Eigenständiges Deployment (monitoring/) – leer lassen, wenn es nicht
    // läuft; die Modul-Kachel wird dann als deaktiviert dargestellt.
    uptimeKuma: "http://localhost:3701",
    keycloakAdmin: "http://localhost:8700/admin/udp/console/",
    masterportal: "http://localhost:8780/portal",
  },
  // Vordefinierte Mandanten (NGSILD-Tenant); leer = Standardmandant.
  // Demo-Mandanten für den Mandantenfähigkeits-Nachweis (BW-Beispiele, ohne Daten).
  tenants: [
    { id: "", name: "Standard (kreisübergreifend)" },
    { id: "lkrt", name: "Landkreis Reutlingen" },
    { id: "lktue", name: "Landkreis Tübingen" },
  ],
  // Footer links on every page (docs/betrieb.md). Accepted: https://…,
  // http://… or a site-relative path like /impressum; empty = no link.
  legal: {
    impressumUrl: "",
    datenschutzUrl: "",
  },
  // Web-analytics snippet of any vendor, inserted verbatim into <head> of
  // every public page by /site.js. Trusted operator input; empty = no
  // analytics. includeCockpit: also in the cockpit SPA (admin sessions).
  analytics: {
    headHtml: "",
    includeCockpit: false,
  },
  // Operator logo in the page headers and the cockpit sidebar (null = none).
  // Compose: put the file into gui/public/branding/ before the build, e.g.
  //   logo: { src: "/branding/logo.png", alt: "Musterstadt", href: "" },
  // The favicon needs no entry: nginx serves gui/public/branding/favicon.png
  // (or .svg/.ico) under /favicon when the file exists.
  branding: {
    logo: null,
  },
};
