import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase, isDatabaseConfigured } from "./config/database.js";
import { createApp } from "./app.js";

const app = createApp();
const server = app.listen(env.port, () => {
  console.info(`ReceiptFlow API listening on port ${env.port} (${env.nodeEnv})`);
  console.info(`Allowed origins: ${env.allowedOrigins.join(", ")}`);
  if (env.devAuthEnabled) console.warn("DEV_AUTH_ENABLED: /api/auth/session returns a local development user.");
  if (env.betaAuth.enabled) console.info("Temporary beta sign-in is enabled (POST /api/auth/login).");
  if (env.betaAuth.misconfigured) {
    console.warn("BETA_AUTH_ENABLED is true but BETA_AUTH_USERNAME is empty or BETA_AUTH_PASSWORD is shorter than 12 characters: beta sign-in stays disabled.");
  }
});

// Connect after listening so /api/health answers even while MongoDB is unreachable.
// The first connection is retried; later drops are handled by the driver.
let retryTimer;
async function connectWithRetry() {
  if (await connectDatabase()) return;
  if (isDatabaseConfigured()) retryTimer = setTimeout(connectWithRetry, 15_000);
}
connectWithRetry();

async function shutdown(signal) {
  console.info(`${signal} received, shutting down`);
  clearTimeout(retryTimer);
  server.close();
  await disconnectDatabase().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
