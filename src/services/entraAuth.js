// Microsoft Entra ID sign-in in the browser (MSAL, authorization code + PKCE).
//
// MSAL handles the Microsoft side; the ReceiptFlow backend verifies the result
// (POST /auth/entra) and issues its own session. Redirects are used rather than
// popups so sign-in works the same on desktop, iPhone Safari and Android Chrome.
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-browser";
import { entraConfig, loginRequest, msalConfig } from "../config/authConfig";

export const msalInstance = entraConfig.enabled
  ? new PublicClientApplication(msalConfig)
  : null;

let redirectError = "";

// The app route to open after returning from Microsoft (kept in MSAL's `state`).
const safeRoute = (value) =>
  typeof value === "string" && /^\/[\w\-/]*$/.test(value) ? value : "/upload";

// Runs once before the app renders. Completes a sign-in redirect if the page is
// returning from Microsoft. MSAL's response arrives in the URL hash
// (#code=...), which the HashRouter would otherwise read as a route, so it is
// processed and replaced with the route the user started from.
export async function initializeEntra() {
  if (!msalInstance) return;
  // Read before MSAL clears the response from the URL.
  const returningFromMicrosoft = /[#&](code|error)=/.test(window.location.hash);
  try {
    await msalInstance.initialize();
    const result = await msalInstance.handleRedirectPromise({
      navigateToLoginRequestUrl: false,
    });
    if (result?.account) {
      msalInstance.setActiveAccount(result.account);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${safeRoute(result.state)}`,
      );
    }
  } catch (error) {
    redirectError =
      error?.errorCode === "user_cancelled" || error?.errorCode === "access_denied"
        ? "Microsoft sign-in was cancelled."
        : "Microsoft sign-in did not complete. Please try again.";
    if (returningFromMicrosoft) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#/profile`,
      );
    }
  }
  if (!msalInstance.getActiveAccount()) {
    const [account] = msalInstance.getAllAccounts();
    if (account) msalInstance.setActiveAccount(account);
  }
}

// A sign-in error from the last redirect, shown once.
export function takeRedirectError() {
  const message = redirectError;
  redirectError = "";
  return message;
}

export const hasMicrosoftAccount = () =>
  Boolean(msalInstance?.getActiveAccount());

// Sends the browser to Microsoft. Returns to `returnTo` (an app route) afterwards.
export async function signInWithMicrosoft(returnTo = "/upload") {
  if (!msalInstance) {
    throw new Error("Microsoft sign-in is not configured.");
  }
  await msalInstance.loginRedirect({
    ...loginRequest,
    prompt: "select_account",
    state: safeRoute(returnTo),
  });
}

// The ID token (identity, verified by the backend) and the Graph access token
// (User.Read, used by the backend to read the profile). null when there is no
// Microsoft account in this tab or it needs to sign in again.
export async function getMicrosoftTokens({ forceRefresh = false } = {}) {
  const account = msalInstance?.getActiveAccount();
  if (!account) return null;
  try {
    let result = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account,
      forceRefresh,
    });
    // The backend rejects expired ID tokens: renew one that is about to expire.
    const expiresAt = (result.idTokenClaims?.exp ?? 0) * 1000;
    if (!forceRefresh && expiresAt - Date.now() < 5 * 60 * 1000) {
      result = await msalInstance.acquireTokenSilent({
        ...loginRequest,
        account,
        forceRefresh: true,
      });
    }
    return { idToken: result.idToken, accessToken: result.accessToken };
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) return null;
    throw error;
  }
}

// Clears MSAL's tokens and account from this browser without leaving the app.
// (The Microsoft account itself stays signed in to Microsoft, as with other
// workplace apps; signing in again offers the account picker.)
export async function clearMicrosoftState() {
  if (!msalInstance) return;
  await msalInstance.clearCache();
  msalInstance.setActiveAccount(null);
}
