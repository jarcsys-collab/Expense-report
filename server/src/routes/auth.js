import { Router } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";

export const authRouter = Router();

// GET /api/auth/session
// The frontend asks who is signed in before loading any data. Organization
// sign-in is not built yet, so this answers 401 unless the development-only
// stand-in user is enabled (DEV_AUTH_ENABLED=true, never in production).
authRouter.get("/session", (req, res) => {
  if (!env.devAuthEnabled) {
    throw new HttpError(401, "UNAUTHENTICATED", "Sign in through your organization.");
  }
  res.json({
    user: {
      id: "dev-user",
      name: "Local Developer",
      role: env.devAuthRole,
      email: "",
      department: "Development",
      position: "Developer",
    },
  });
});

// POST /api/auth/logout: nothing to clear until real sessions exist.
authRouter.post("/logout", (req, res) => {
  res.status(204).end();
});
