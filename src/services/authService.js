// Session handling: GET /auth/session, POST /auth/entra, POST /auth/logout.
// The backend owns authentication (server-side session). The frontend asks who
// the current user is and, for Microsoft sign-in, hands the backend the
// Microsoft tokens to verify. Identity comes from the backend, never from here.
//
// Primary sign-in: Microsoft Entra ID (services/entraAuth.js).
// TEMPORARY fallback: beta sign-in (betaLogin below), to be removed after Entra
// is verified.
import { AUTH_ENDPOINTS } from "../config/api";
import { config } from "../config/appConfig";
import { asObject } from "../utils/values";
import {
  clearMicrosoftState,
  getMicrosoftTokens,
  hasMicrosoftAccount,
} from "./entraAuth";
import { ApiError, apiRequest, setSessionToken } from "./httpClient";
import { unwrapResponse } from "./normalizers";

// Shown before sign-in or when no backend is connected.
export const GUEST_USER = {
  id: "",
  name: config.accountName,
  email: config.accountEmail,
  role: "EMPLOYEE",
  department: "",
};

const ROLES = ["EMPLOYEE", "APPROVER", "FINANCE_ADMIN"];

let currentUser;
let sessionRequest;
// The user attached to expenses created in this tab (GUEST_USER until signed in).
let activeUser = GUEST_USER;

export const getActiveUser = () => activeUser;

export function setActiveUser(user) {
  activeUser = user;
}

// Resolves once any in-flight session check has finished; throws unless signed in.
export async function requireSession() {
  if (sessionRequest) {
    await sessionRequest;
  }
  if (!config.apiBase) {
    throw new Error(
      "Workspace service is not configured. Contact your administrator.",
    );
  }
  if (!currentUser) {
    throw new Error(
      "Sign in through your organization before accessing workspace records.",
    );
  }
  return currentUser;
}

// GET /auth/session. Concurrent callers share one request.
export function loadSession() {
  if (!sessionRequest) {
    sessionRequest = fetchSession().finally(() => {
      sessionRequest = undefined;
    });
  }
  return sessionRequest;
}

async function fetchSession() {
  currentUser = undefined;
  if (!config.apiBase) {
    return;
  }
  let payload;
  try {
    payload = unwrapResponse(await apiRequest(AUTH_ENDPOINTS.session));
  } catch (error) {
    // No ReceiptFlow session (or the cookie is blocked): if this tab is signed
    // in to Microsoft, get a new session from it without any prompt.
    if (error instanceof ApiError && error.status === 401 && hasMicrosoftAccount()) {
      return exchangeMicrosoftSession();
    }
    throw error;
  }
  return acceptUser(payload);
}

function acceptUser(payload) {
  const account = asObject(payload.user ?? payload);
  if (
    typeof account.id != "string" ||
    !account.id ||
    typeof account.name != "string" ||
    !account.name ||
    !ROLES.includes(String(account.role))
  ) {
    throw new Error(
      "Your account could not be verified. Contact your administrator.",
    );
  }
  const text = (value) => (typeof value == "string" ? value : "");
  currentUser = {
    id: account.id,
    name: account.name,
    role: account.role,
    // "entra" (verified Microsoft account), "beta" or "dev".
    provider: text(account.provider),
    email: text(account.email),
    department: text(account.department),
    position: text(account.position || account.jobTitle),
  };
  return currentUser;
}

// POST /auth/entra: the backend verifies the Microsoft ID token, reads the
// profile from Microsoft Graph itself and returns a ReceiptFlow session.
// Returns undefined (signed out) when Microsoft needs the user to sign in again.
async function exchangeMicrosoftSession() {
  let tokens = await getMicrosoftTokens();
  if (!tokens) return;
  let payload;
  try {
    payload = await apiRequest(AUTH_ENDPOINTS.entra, "POST", tokens);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    // Retry once with freshly issued tokens (e.g. an ID token that just expired).
    tokens = await getMicrosoftTokens({ forceRefresh: true });
    if (!tokens) return;
    try {
      payload = await apiRequest(AUTH_ENDPOINTS.entra, "POST", tokens);
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status === 401) {
        await clearMicrosoftState();
        throw new Error(
          "Your Microsoft account could not be verified for ReceiptFlow. Contact your administrator.",
        );
      }
      throw retryError;
    }
  }
  setSessionToken(payload?.sessionToken);
  return acceptUser(payload);
}

// Sends the browser to the organization sign-in page when one is configured.
export function signIn() {
  if (!config.signInUrl) {
    throw new Error("Organization sign-in is not configured.");
  }
  window.location.assign(config.signInUrl);
}

// POST /auth/login: TEMPORARY controlled-beta sign-in until Microsoft Entra ID.
// The server sets an HttpOnly session cookie; the password is not stored anywhere
// in the browser.
export async function betaLogin(username, password) {
  try {
    const payload = await apiRequest(AUTH_ENDPOINTS.login, "POST", {
      username,
      password,
    });
    setSessionToken(payload?.sessionToken);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new Error("Incorrect username or password.");
    }
    throw error;
  }
}

// POST /auth/logout, then clears the in-memory session token and this tab's
// Microsoft (MSAL) tokens.
export async function logout() {
  await requireSession();
  try {
    await apiRequest(AUTH_ENDPOINTS.logout, "POST", {});
  } finally {
    setSessionToken("");
    currentUser = undefined;
    await clearMicrosoftState();
  }
}
