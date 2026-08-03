/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// Laufzeit-Konfiguration (public/config.js) mit sicheren Defaults.

export interface Tenant {
  id: string;
  name: string;
}

export interface UdpConfig {
  gatewayUrl: string;
  // Anmeldung über Keycloak anbieten. In der öffentlichen Auslieferung schaltet
  // das Helm-Chart die Anmeldung ab (cockpit.authEnabled), weil die Plattform-
  // APIs noch kein Token auswerten. Lokal (Compose/vite) bleibt sie aktiv.
  authEnabled: boolean;
  keycloak: { url: string; realm: string; clientId: string };
  module: Record<string, string>;
  tenants: Tenant[];
}

declare global {
  interface Window {
    UDP_CONFIG?: Partial<UdpConfig>;
  }
}

const defaults: UdpConfig = {
  gatewayUrl: "/gateway",
  // Default true = lokale Entwicklung gegen den Compose-Keycloak funktioniert
  // unverändert; das Chart setzt den Wert per ConfigMap auf false.
  authEnabled: true,
  keycloak: { url: "http://localhost:8700", realm: "udp", clientId: "udp-cockpit" },
  module: {},
  tenants: [{ id: "", name: "Standard" }],
};

export const config: UdpConfig = {
  ...defaults,
  ...window.UDP_CONFIG,
  // Explizit statt nur über den Spread: ein vorhandener Schlüssel mit dem Wert
  // undefined würde den Default sonst überschreiben.
  authEnabled: window.UDP_CONFIG?.authEnabled ?? defaults.authEnabled,
  keycloak: { ...defaults.keycloak, ...window.UDP_CONFIG?.keycloak },
  module: { ...defaults.module, ...window.UDP_CONFIG?.module },
  tenants: window.UDP_CONFIG?.tenants ?? defaults.tenants,
};
