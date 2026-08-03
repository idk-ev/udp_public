/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// Anmeldung über Keycloak (OIDC, PKCE). Fällt ohne erreichbaren Keycloak
// automatisch in den Demo-Modus zurück, damit die GUI immer nutzbar bleibt.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Keycloak from "keycloak-js";
import { config } from "./config";

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  username?: string;
  roles: string[];
  tenantClaim?: string;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  ready: false,
  authenticated: false,
  roles: [],
  login: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Ist die Anmeldung abgeschaltet (config.authEnabled=false, so liefert es das
  // Helm-Chart aus), wird gar kein Keycloak-Adapter erzeugt: kein check-sso-
  // Aufruf gegen eine /auth-Route, die am Ingress nicht mehr existiert, und
  // keine Konsolenfehler. Der Kontext bleibt dauerhaft "nicht angemeldet".
  const [kc] = useState(() =>
    config.authEnabled
      ? new Keycloak({
          url: config.keycloak.url,
          realm: config.keycloak.realm,
          clientId: config.keycloak.clientId,
        })
      : null,
  );
  const [ready, setReady] = useState(!config.authEnabled);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    if (!kc) return;
    let cancelled = false;
    kc.init({ onLoad: "check-sso", pkceMethod: "S256", checkLoginIframe: false })
      .then((auth) => {
        if (!cancelled) {
          setAuthenticated(auth);
          setReady(true);
        }
      })
      .catch(() => {
        // Keycloak nicht erreichbar → GUI im Demo-Modus weiter nutzbar
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kc]);

  const value = useMemo<AuthState>(() => {
    if (!kc) {
      return { ready: true, authenticated: false, roles: [], login: () => {}, logout: () => {} };
    }
    const parsed = kc.tokenParsed as
      | { preferred_username?: string; tenant?: string; realm_access?: { roles?: string[] } }
      | undefined;
    return {
      ready,
      authenticated,
      username: parsed?.preferred_username,
      tenantClaim: parsed?.tenant,
      roles: parsed?.realm_access?.roles?.filter((r) => !r.startsWith("default-")) ?? [],
      login: () => kc.login({ locale: "de" }),
      // Nach dem Abmelden zurück ins Cockpit – der Origin selbst liefert die
      // öffentliche Mitmachen-Seite aus, nicht die SPA.
      logout: () => kc.logout({ redirectUri: window.location.origin + "/cockpit" }),
    };
  }, [kc, ready, authenticated]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
