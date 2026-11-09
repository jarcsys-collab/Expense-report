// Safety checks for the staging entry point (staging-server.js). They refuse to start on
// a configuration that could touch production. Messages name settings, never values.
import mongoose from "mongoose";

const PRODUCTION_DB_NAME = "receiptflow";
const PRODUCTION_FRONTEND_HOST = "jarcsys-collab.github.io";
// A public identifier, already in the committed .env.pages. Staging has its own app
// registration, so production's sign-in settings never need to change.
const PRODUCTION_ENTRA_CLIENT_ID = "92e8f33d-6e27-4763-b638-7d7959c2ddc9";
const MUST_STAY_OFF = ["NOTIFICATIONS_ENABLED", "APPROVAL_WORKFLOW_ENABLED", "RECEIPT_CLEANUP_ENABLED", "BETA_AUTH_ENABLED", "DEV_AUTH_ENABLED"];

/** @returns {string[]} what is wrong with this environment; empty when it is safe to start */
export function stagingProblems(env) {
  const problems = [];
  if (env.NODE_ENV !== "production") problems.push("NODE_ENV must be production.");
  if (!env.MONGODB_URI) problems.push("MONGODB_URI is required.");
  const dbName = env.MONGODB_DB_NAME ?? "";
  if (dbName === PRODUCTION_DB_NAME || !/staging/i.test(dbName)) problems.push('MONGODB_DB_NAME must be a staging database, such as "receiptflow-staging".');
  for (const name of MUST_STAY_OFF) {
    if (!["", "false", undefined].includes(env[name])) problems.push(`${name} must stay false on staging.`);
  }
  const origins = String(env.FRONTEND_ORIGIN ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) problems.push("FRONTEND_ORIGIN must be the staging frontend's address.");
  for (const origin of origins) {
    if (!/^https:\/\/[^/]+$/.test(origin)) problems.push("FRONTEND_ORIGIN must be an https origin, with no path.");
    if (origin.includes(PRODUCTION_FRONTEND_HOST)) problems.push("FRONTEND_ORIGIN must not be the production frontend.");
  }
  if (!env.ENTRA_TENANT_ID || !env.ENTRA_CLIENT_ID) problems.push("ENTRA_TENANT_ID and ENTRA_CLIENT_ID are required.");
  if (env.ENTRA_CLIENT_ID === PRODUCTION_ENTRA_CLIENT_ID) problems.push("ENTRA_CLIENT_ID must be the staging app registration, not production's.");
  if (!["", undefined, "stub", "real"].includes(env.STAGING_OCR_MODE)) problems.push("STAGING_OCR_MODE must be stub or real.");
  return problems;
}

/**
 * The staging database user must be limited to the staging database. Tries one read on
 * the production database's name: "not authorized" is the only acceptable answer. Any
 * other answer, including an empty result from an over-privileged user, refuses to start.
 * @returns {Promise<string|null>} the problem, or null
 */
export async function credentialScopeProblem(uri) {
  const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    await connection.asPromise();
    await connection.useDb(PRODUCTION_DB_NAME).collection("users").findOne({}, { projection: { _id: 1 } });
    return `The MongoDB user is able to read the "${PRODUCTION_DB_NAME}" database. Use a user limited to the staging database.`;
  } catch (error) {
    if (error?.code === 13 || error?.codeName === "Unauthorized") return null;
    return `Could not verify the MongoDB user's access (${error?.name ?? "error"}).`;
  } finally {
    await connection.close().catch(() => {});
  }
}
