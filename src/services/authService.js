// Session handling for GET /auth/session and POST /auth/logout.
// The backend owns authentication (HttpOnly session cookie); the frontend
// only asks who the current user is.
import { AUTH_ENDPOINTS } from "../config/api";
import { config } from "../config/appConfig";
import { asObject } from "../utils/values";
import { apiRequest } from "./httpClient";
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
  const payload = unwrapResponse(await apiRequest(AUTH_ENDPOINTS.session));
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
  currentUser = {
    id: account.id,
    name: account.name,
    role: account.role,
    email: typeof account.email == "string" ? account.email : "",
    department: typeof account.department == "string" ? account.department : "",
    position: typeof account.position == "string" ? account.position : "",
  };
  return currentUser;
}

// Sends the browser to the organization sign-in page when one is configured.
export function signIn() {
  if (!config.signInUrl) {
    throw new Error("Organization sign-in is not configured.");
  }
  window.location.assign(config.signInUrl);
}

// POST /auth/logout
export async function logout() {
  await requireSession();
  await apiRequest(AUTH_ENDPOINTS.logout, "POST", {});
  currentUser = undefined;
}
