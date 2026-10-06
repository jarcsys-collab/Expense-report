import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { authRouter } from "./routes/auth.js";
import { categoriesRouter } from "./routes/categories.js";
import { expensesRouter } from "./routes/expenses.js";
import { healthRouter } from "./routes/health.js";
import { receiptsRouter } from "./routes/receipts.js";
import { violationsRouter } from "./routes/violations.js";

const limitReached = (req, res) =>
  res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Please wait and retry." });

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env.trustProxy > 0) app.set("trust proxy", env.trustProxy);

  app.use(helmet());

  // Exact-origin allow list; the frontend sends credentials, so no wildcard.
  // Requests without an Origin header (curl, server-to-server) are not CORS requests.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || env.allowedOrigins.includes(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );
  // Preflights from origins not on the list end here, without CORS headers.
  app.use((req, res, next) => (req.method === "OPTIONS" ? res.status(204).end() : next()));

  app.use(
    "/api",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, handler: limitReached }),
  );
  app.use(
    "/api/receipts/upload",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, handler: limitReached }),
  );

  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  // Everything except health and auth requires a signed-in session.
  app.use("/api/expenses", requireAuth, expensesRouter);
  app.use("/api/categories", requireAuth, categoriesRouter);
  app.use("/api/receipts", requireAuth, receiptsRouter);
  app.use("/api/violations", requireAuth, violationsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
