// ReceiptFlow sessions.
//
// Primary sign-in: Microsoft Entra ID (services/entraAuth.js, POST /api/auth/entra).
// TEMPORARY fallback: one shared beta account (BETA_AUTH_USERNAME /
// BETA_AUTH_PASSWORD, server-side only). Remove it by deleting the BETA_* code
// marked "beta" here and in routes/auth.js once Entra sign-in is verified.
//
// A successful sign-in creates a server-side session and sets an HttpOnly cookie
// holding a random token. The same token is also returned to the page, which
// keeps it in memory only and sends it as "Authorization: Bearer" for browsers
// that block third-party cookies (Safari on iPhone). Logout deletes the session.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { isDatabaseConnected } from "../config/database.js";
import { Session } from "../models/Session.js";

export const SESSION_COOKIE = "rf_session";

const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest();

// Constant-time comparison of two strings of any length.
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));

export function betaCredentialsMatch(username, password) {
  if (!env.betaAuth.enabled) return false;
  // Evaluate both comparisons so timing does not reveal which part was wrong.
  const userOk = safeEqual(username, env.betaAuth.username);
  const passOk = safeEqual(password, env.betaAuth.password);
  return userOk && passOk;
}

export const BETA_USER = Object.freeze({
  id: "beta-user",
  name: "ReceiptFlow Beta User",
  get role() {
    return env.betaAuth.role;
  },
});

const DEV_USER = () => ({
  id: "dev-user",
  provider: "dev",
  name: "Local Developer",
  role: env.devAuthRole,
  email: "",
  department: "Development",
  jobTitle: "Developer",
  position: "Developer",
});

// Production: GitHub Pages and Railway are different sites, so the cookie must
// be SameSite=None; Secure. Partitioned (CHIPS) keeps it working in browsers
// that block unpartitioned third-party cookies. Local http development uses Lax.
function cookieAttributes(maxAgeSeconds) {
  const parts = [`Path=/api`, `Max-Age=${maxAgeSeconds}`, "HttpOnly"];
  if (env.isProduction) parts.push("Secure", "SameSite=None", "Partitioned");
  else parts.push("SameSite=Lax");
  return parts.join("; ");
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The session token from "Authorization: Bearer <token>" or the session cookie.
export function readSessionToken(req) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
  if (bearer) return bearer[1];
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=");
      return TOKEN_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

// Stores a session for `user` ({ id, name, role, provider, email, department,
// jobTitle }), sets the cookie and returns the token.
export async function createSession(res, user, hours) {
  const token = randomBytes(32).toString("base64url");
  const maxAge = hours * 3600;
  await Session.create({
    tokenHash: sha256(token).toString("hex"),
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      provider: user.provider,
      email: user.email || "",
      department: user.department || "",
      jobTitle: user.jobTitle || "",
    },
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieAttributes(maxAge)}`);
  return token;
}

export function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
}

export async function destroySession(req) {
  const token = readSessionToken(req);
  if (token && isDatabaseConnected()) await Session.deleteOne({ tokenHash: sha256(token).toString("hex") });
}

// The signed-in user for this request, or null.
//   - local development with DEV_AUTH_ENABLED (never in production): the dev user
//   - otherwise: a valid, unexpired Entra or beta session
// `position` mirrors the job title for the expense form.
export async function resolveUser(req) {
  if (env.devAuthEnabled) return DEV_USER();
  const token = readSessionToken(req);
  if (!token || !isDatabaseConnected()) return null;
  const session = await Session.findOne({ tokenHash: sha256(token).toString("hex"), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;
  const { id, name, role, provider = "beta", email = "", department = "", jobTitle = "" } = session.user;
  return { id, name, role, provider, email, department, jobTitle, position: jobTitle };
}
