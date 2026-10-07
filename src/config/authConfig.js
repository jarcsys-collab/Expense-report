// Microsoft Entra ID (MSAL) configuration: the single place that reads the
// VITE_ENTRA_* variables.
//
// These are public identifiers, not secrets: they end up in the browser bundle
// by design. The app is a single-page application using the authorization code
// flow with PKCE, so there is no client secret anywhere in the frontend.
// Leaving VITE_ENTRA_CLIENT_ID or VITE_ENTRA_TENANT_ID empty turns Microsoft
// sign-in off (only the temporary beta sign-in is shown).
import { BrowserCacheLocation, LogLevel } from "@azure/msal-browser";

const env = import.meta.env;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clientId = (env.VITE_ENTRA_CLIENT_ID || "").trim();
const tenantId = (env.VITE_ENTRA_TENANT_ID || "").trim();

export const entraConfig = {
  enabled: GUID.test(clientId) && GUID.test(tenantId),
  clientId,
  tenantId,
  // Must exactly match a SPA redirect URI on the app registration.
  redirectUri:
    (env.VITE_ENTRA_REDIRECT_URI || "").trim() ||
    new URL(import.meta.env.BASE_URL, window.location.origin).href,
};

export const msalConfig = {
  auth: {
    clientId,
    // Single tenant: only accounts from this directory can sign in.
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: entraConfig.redirectUri,
    postLogoutRedirectUri: entraConfig.redirectUri,
  },
  cache: {
    // Cleared when the tab closes; nothing persists across browser sessions.
    cacheLocation: BrowserCacheLocation.SessionStorage,
  },
  system: {
    loggerOptions: {
      piiLoggingEnabled: false,
      logLevel: LogLevel.Warning,
      loggerCallback: (level, message, containsPii) => {
        if (!containsPii && level <= LogLevel.Error) console.error(message);
      },
    },
  },
};

// Delegated Microsoft Graph permission used to read the signed-in profile.
export const loginRequest = { scopes: ["User.Read"] };
