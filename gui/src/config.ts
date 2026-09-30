/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// Laufzeit-Konfiguration (public/config.js) mit sicheren Defaults.

export interface Tenant {
  id: string;
  name: string;
}

// Footer links (Helm: cockpit.legal). Empty = no link.
export interface LegalConfig {
  impressumUrl: string;
  datenschutzUrl: string;
}

// Web-analytics snippet (Helm: cockpit.analytics). Inserted by public/site.js,
// not by React; typed here only so the runtime config is complete. In the
// cockpit it only runs with includeCockpit (admin sessions and tokens live here).
export interface AnalyticsConfig {
  headHtml: string;
  includeCockpit: boolean;
}

// Operator logo (Helm: cockpit.branding.logo); null = default badge.
export interface LogoConfig {
  src: string;
  alt: string;
  href: string;
}

export interface BrandingConfig {
  logo: LogoConfig | null;
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
  legal: LegalConfig;
  analytics: AnalyticsConfig;
  branding: BrandingConfig;
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
  legal: { impressumUrl: "", datenschutzUrl: "" },
  analytics: { headHtml: "", includeCockpit: false },
  branding: { logo: null },
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
  legal: { ...defaults.legal, ...window.UDP_CONFIG?.legal },
  analytics: { ...defaults.analytics, ...window.UDP_CONFIG?.analytics },
  branding: { logo: window.UDP_CONFIG?.branding?.logo ?? defaults.branding.logo },
};

// Same rule as public/site.js and the chart's render-time check: http(s) with a
// host, or a path starting with exactly one "/" ("//host" and "/\host" are
// protocol-relative in browsers); no whitespace, control or invisible format
// characters.
const SAFE_URL =
  /^(?:https?:\/\/[^/\\\s\p{Cc}\p{Cf}\p{Z}][^\s\p{Cc}\p{Cf}\p{Z}]*|\/(?:[^/\\\s\p{Cc}\p{Cf}\p{Z}][^\s\p{Cc}\p{Cf}\p{Z}]*)?)$/iu;

export function isSafeUrl(url: unknown): url is string {
  return typeof url === "string" && SAFE_URL.test(url);
}
