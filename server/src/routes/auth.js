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

export const authRouter = Router();

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
// TEMPORARY controlled-beta sign-in (BETA_AUTH_ENABLED) until Microsoft Entra ID.
authRouter.post("/login", loginLimiter, requireDatabase, validate({ body: loginSchema }), async (req, res) => {
  if (!env.betaAuth.enabled) {
    throw new HttpError(403, "LOGIN_DISABLED", "Beta sign-in is not enabled.");
  }
  if (!betaCredentialsMatch(req.body.username, req.body.password)) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect username or password.");
  }
  const user = { id: BETA_USER.id, name: BETA_USER.name, role: BETA_USER.role };
  await createSession(res, user);
  res.json({ user });
});

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
