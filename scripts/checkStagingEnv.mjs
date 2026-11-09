// Stops `npm run build:staging` from producing a bundle that points at production.
// Production's values are read from the committed .env.pages, not repeated here.
import fs from "node:fs";
import path from "node:path";

/** Production's values from the file itself: unlike Vite's loadEnv, shell variables cannot change them. */
export function readProductionEnv(root = process.cwd()) {
  const values = {};
  for (const line of fs.readFileSync(path.join(root, ".env.pages"), "utf8").split(/\r?\n/)) {
    const match = /^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** @returns {string[]} what is wrong; empty when the staging build is safe */
export function stagingBuildProblems(staging, production) {
  const problems = [];
  const api = staging.VITE_API_BASE_URL ?? "";
  const redirect = staging.VITE_ENTRA_REDIRECT_URI ?? "";
  if (!/^https:\/\/[^/]+\/api\/?$/.test(api)) problems.push("VITE_API_BASE_URL must be the staging API, like https://<host>/api.");
  if (api && api === production.VITE_API_BASE_URL) problems.push("VITE_API_BASE_URL is the production API.");
  if (!staging.VITE_ENTRA_CLIENT_ID || !staging.VITE_ENTRA_TENANT_ID) problems.push("VITE_ENTRA_CLIENT_ID and VITE_ENTRA_TENANT_ID are required.");
  if (staging.VITE_ENTRA_CLIENT_ID && staging.VITE_ENTRA_CLIENT_ID === production.VITE_ENTRA_CLIENT_ID) problems.push("VITE_ENTRA_CLIENT_ID is production's app registration.");
  if (!/^https:\/\/[^/]+\/$/.test(redirect)) problems.push("VITE_ENTRA_REDIRECT_URI must be the staging address, like https://<host>/.");
  if (redirect && redirect === production.VITE_ENTRA_REDIRECT_URI) problems.push("VITE_ENTRA_REDIRECT_URI is the production address.");
  if (!/staging/i.test(staging.VITE_APP_NAME ?? "")) problems.push('VITE_APP_NAME must say staging, e.g. "ReceiptFlow STAGING", so nobody mistakes it for production.');
  return problems;
}
