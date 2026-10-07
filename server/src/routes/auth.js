import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate } from "../middleware/validate.js";
import {
  BETA_USER,
  betaCredentialsMatch,
  clearSessionCookie,
  createSession,
  destroySession,
  resolveUser,
} from "../services/authSession.js";
import { resolveEntraProfile, upsertEntraUser, verifyEntraIdToken } from "../services/entraAuth.js";

export const authRouter = Router();

// ---------------------------------------------------------------------------
// Primary sign-in: Microsoft Entra ID
// ---------------------------------------------------------------------------

const entraLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Please wait and retry." }),
});

const jwt = z.string().max(16_000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, "must be a JWT");
const entraSchema = z.object({
  idToken: jwt,
  // Microsoft Graph token (User.Read). Opaque to this API: only Graph reads it.
  accessToken: z.string().max(16_000).optional(),
});

// POST /api/auth/entra  { idToken, accessToken }
// Exchanges a verified Microsoft sign-in for a ReceiptFlow session. Tokens are
// used for this request only and never stored or logged.
authRouter.post("/entra", entraLimiter, requireDatabase, validate({ body: entraSchema }), async (req, res) => {
  if (!env.entra.enabled) {
    throw new HttpError(503, "ENTRA_NOT_CONFIGURED", "Microsoft sign-in is not configured on the server.");
  }
  const claims = await verifyEntraIdToken(req.body.idToken);
  const profile = await resolveEntraProfile(claims, req.body.accessToken);
  const record = await upsertEntraUser(profile);
  // One identity per browser: replace any existing (e.g. beta) session.
  await destroySession(req);
  const user = {
    id: profile.entraUserId,
    name: profile.displayName,
    role: record.role,
    provider: "entra",
    email: profile.email,
    department: profile.department,
    jobTitle: profile.jobTitle,
  };
  const sessionToken = await createSession(res, user, env.entra.sessionHours);
  res.json({ user: { ...user, position: user.jobTitle }, profileSource: profile.profileSource, sessionToken });
});

// ---------------------------------------------------------------------------
// TEMPORARY fallback: controlled-beta sign-in (BETA_AUTH_ENABLED).
// Remove this block, BETA_* in config/env.js and the beta helpers in
// services/authSession.js once Microsoft sign-in is verified.
// ---------------------------------------------------------------------------

// Slows down password guessing: 10 attempts per 15 minutes per client IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Please wait 15 minutes and retry." }),
});

const loginSchema = z.object({
  username: z.string().max(200),
  password: z.string().max(500),
});

// POST /api/auth/login  { username, password }
authRouter.post("/login", loginLimiter, requireDatabase, validate({ body: loginSchema }), async (req, res) => {
  if (!env.betaAuth.enabled) {
    throw new HttpError(403, "LOGIN_DISABLED", "Beta sign-in is not enabled.");
  }
  if (!betaCredentialsMatch(req.body.username, req.body.password)) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect username or password.");
  }
  await destroySession(req);
  const user = { id: BETA_USER.id, name: BETA_USER.name, role: BETA_USER.role, provider: "beta" };
  const sessionToken = await createSession(res, user, env.betaAuth.sessionHours);
  res.json({ user, sessionToken });
});

// ---------------------------------------------------------------------------
// Shared session routes
// ---------------------------------------------------------------------------

// GET /api/auth/session: the signed-in user, or 401.
authRouter.get("/session", async (req, res) => {
  const user = await resolveUser(req);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  res.json({ user });
});

// POST /api/auth/logout: deletes the server-side session and clears the cookie.
authRouter.post("/logout", async (req, res) => {
  await destroySession(req);
  clearSessionCookie(res);
  res.status(204).end();
});
