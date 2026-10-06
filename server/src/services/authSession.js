// TEMPORARY controlled-beta sign-in, to be replaced by Microsoft Entra ID.
//
// One shared beta account (BETA_AUTH_USERNAME / BETA_AUTH_PASSWORD, server-side
// only). A successful login creates a server-side session and sets an HttpOnly
// cookie holding a random token. Logout deletes the session.
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
  name: "Local Developer",
  role: env.devAuthRole,
  email: "",
  department: "Development",
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

export function readSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export async function createSession(res, user) {
  const token = randomBytes(32).toString("base64url");
  const maxAge = env.betaAuth.sessionHours * 3600;
  await Session.create({
    tokenHash: sha256(token).toString("hex"),
    user: { id: user.id, name: user.name, role: user.role },
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieAttributes(maxAge)}`);
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
//   - otherwise: a valid, unexpired beta session
export async function resolveUser(req) {
  if (env.devAuthEnabled) return DEV_USER();
  const token = readSessionToken(req);
  if (!token || !isDatabaseConnected()) return null;
  const session = await Session.findOne({ tokenHash: sha256(token).toString("hex"), expiresAt: { $gt: new Date() } }).lean();
  return session ? { ...session.user, email: "", department: "", position: "" } : null;
}
