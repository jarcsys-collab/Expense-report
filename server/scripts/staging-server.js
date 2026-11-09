// Entry point for the STAGING service only (server/railway.staging.json). Production
// keeps using `npm start`, which never loads this file. It runs the normal application
// after checking that it cannot touch production:
//   - refuses to start on an unsafe configuration (stagingGuards.js)
//   - refuses a database user who can reach the production database
//   - removes the production frontend from the allowed origins
//   - STAGING_OCR_MODE=stub (default): no request reaches Google. Every scan "reads" as the
//     same synthetic receipt, and analytics show what a real scan WOULD have cost.
//     STAGING_OCR_MODE=real uses the configured Google credentials, and is billable.
import { generateKeyPairSync } from "node:crypto";
import { credentialScopeProblem, stagingProblems } from "./stagingGuards.js";

function refuse(problems) {
  console.error(`[staging] Refusing to start:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

const problems = stagingProblems(process.env);
if (problems.length) refuse(problems);
const scopeProblem = await credentialScopeProblem(process.env.MONGODB_URI);
if (scopeProblem) refuse([scopeProblem]);

const stubOcr = process.env.STAGING_OCR_MODE !== "real";
if (stubOcr) {
  // A throwaway key, so no real credential is needed or loaded in this mode.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  Object.assign(process.env, {
    OCR_PROVIDER: "google_document_ai",
    GOOGLE_DOCUMENT_AI_PROJECT_ID: "staging-stub",
    GOOGLE_DOCUMENT_AI_LOCATION: "us",
    GOOGLE_DOCUMENT_AI_PROCESSOR_ID: "stagingstub",
    GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON: JSON.stringify({
      type: "service_account",
      project_id: "staging-stub",
      private_key_id: "staging-stub-not-a-real-key",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      client_email: "staging-stub@staging-stub.iam.gserviceaccount.com",
    }),
    GOOGLE_APPLICATION_CREDENTIALS: "",
  });
}

const { env } = await import("../src/config/env.js");
env.allowedOrigins = env.allowedOrigins.filter((origin) => !origin.includes("jarcsys-collab.github.io"));

if (stubOcr) {
  const { __setTestHooks } = await import("../src/services/googleDocumentAiService.js");
  const { liveShapedSyntheticDocument } = await import("../test/fixtures/documentAi.js");
  __setTestHooks({
    factory: () => ({
      processDocument: async () => {
        console.info("[staging] stub OCR: no request sent to Google");
        return [{ document: liveShapedSyntheticDocument() }];
      },
    }),
  });
}
console.warn(`[staging] STAGING service. OCR: ${stubOcr ? "STUB (synthetic results, nothing sent to Google)" : "REAL (billable)"}. Database: ${env.mongoDbName}.`);

await import("../src/server.js");
