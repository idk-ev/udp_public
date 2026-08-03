{{- /*
  Realm-Import des Charts. .tpl, weil rootUrl/redirectUris den ECHTEN
  öffentlichen Hostnamen tragen müssen: Keycloak weist jede Autorisierung mit
  "Invalid parameter: redirect_uri" ab, wenn die vom Cockpit gesendete
  redirect_uri nicht auf einen hier eingetragenen Wert passt.
  Die localhost-Variante für Docker Compose steht unverändert in
  platform/config/keycloak/udp-realm.json.
*/ -}}
{{- $public := include "udp.publicUrl" . -}}
{
  "realm": "udp",
  "displayName": "Urbane Datenplattform",
  "enabled": true,
  "registrationAllowed": false,
  "internationalizationEnabled": true,
  "supportedLocales": ["de", "en"],
  "defaultLocale": "de",
  "sslRequired": "external",
  "bruteForceProtected": true,
  "roles": {
    "realm": [
      { "name": "plattform-admin", "description": "Übergreifende Administration der Plattform (Kreisverwaltung)" },
      { "name": "mandant-admin",   "description": "Administration innerhalb eines Mandanten (Kommune/Fachbereich)" },
      { "name": "fachanwender",    "description": "Lesender und schreibender Zugriff auf Fachdaten des Mandanten" },
      { "name": "leitstelle",      "description": "Erweiterte Echtzeit-Sichten für Leitstellen und Einsatzkräfte" },
      { "name": "buerger",         "description": "Öffentlicher Basiszugang (Karten, offene Daten)" }
    ]
  },
  "groups": [
    {
      "name": "landkreis-reutlingen",
      "path": "/landkreis-reutlingen",
      "attributes": { "tenant": ["lkrt"] },
      "subGroups": [
        { "name": "reutlingen", "path": "/landkreis-reutlingen/reutlingen", "attributes": { "tenant": ["lkrt_reutlingen"] } },
        { "name": "pfullingen", "path": "/landkreis-reutlingen/pfullingen", "attributes": { "tenant": ["lkrt_pfullingen"] } }
      ]
    },
    {
      "name": "landkreis-tuebingen",
      "path": "/landkreis-tuebingen",
      "attributes": { "tenant": ["lktue"] },
      "subGroups": [
        { "name": "tuebingen",  "path": "/landkreis-tuebingen/tuebingen",  "attributes": { "tenant": ["lktue_tuebingen"] } },
        { "name": "rottenburg", "path": "/landkreis-tuebingen/rottenburg", "attributes": { "tenant": ["lktue_rottenburg"] } }
      ]
    }
  ],
  "clients": [
    {
      "clientId": "udp-cockpit",
      "name": "UDP-Cockpit (Web-GUI)",
      "protocol": "openid-connect",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "rootUrl": {{ $public | quote }},
      "redirectUris": [
        {{ printf "%s/*" $public | quote }}
        {{- range .Values.keycloakApp.extraRedirectUris }},
        {{ . | quote }}
        {{- end }}
      ],
      "webOrigins": ["+"],
      "attributes": { "pkce.code.challenge.method": "S256" },
      "protocolMappers": [
        {
          "name": "tenant-mapper",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "consentRequired": false,
          "config": {
            "user.attribute": "tenant",
            "claim.name": "tenant",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        }
      ]
    },
    {
      "clientId": "udp-gateway",
      "name": "APISIX API-Gateway",
      "protocol": "openid-connect",
      "publicClient": false,
      "bearerOnly": false,
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false,
      "secret": "udp-gateway-secret-change-me"
    }
  ],
  "users": [
    {
      "username": "plattform.admin",
      "email": "plattform.admin@example.org",
      "firstName": "Petra",
      "lastName": "Plattform",
      "enabled": true,
      "emailVerified": true,
      "credentials": [{ "type": "password", "value": "udp-Demo-2026!", "temporary": false }],
      "realmRoles": ["plattform-admin"],
      "attributes": { "tenant": ["lkrt"] }
    },
    {
      "username": "anna.fach",
      "email": "anna.fach@example.org",
      "firstName": "Anna",
      "lastName": "Fachanwenderin",
      "enabled": true,
      "emailVerified": true,
      "credentials": [{ "type": "password", "value": "udp-Demo-2026!", "temporary": false }],
      "realmRoles": ["fachanwender"],
      "groups": ["/landkreis-reutlingen/reutlingen"],
      "attributes": { "tenant": ["lkrt_reutlingen"] }
    },
    {
      "username": "lars.leitstelle",
      "email": "lars.leitstelle@example.org",
      "firstName": "Lars",
      "lastName": "Leitstelle",
      "enabled": true,
      "emailVerified": true,
      "credentials": [{ "type": "password", "value": "udp-Demo-2026!", "temporary": false }],
      "realmRoles": ["leitstelle"],
      "groups": ["/landkreis-tuebingen"],
      "attributes": { "tenant": ["lktue"] }
    }
  ]
}
