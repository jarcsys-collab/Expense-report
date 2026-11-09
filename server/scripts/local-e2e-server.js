// Runs the real ReceiptFlow API for local end-to-end testing, safely:
//   - a throwaway in-memory MongoDB (mongodb-memory-server), deleted on exit,
//     or LOCAL_MONGODB_URI if it is a local mongodb:// address (localOnly.js)
//   - no real credentials: Google, Veryfi, Entra and beta values from server/.env
//     are blanked; Google Document AI is replaced by a stub that returns the
//     synthetic receipt extraction, so no OCR request can leave this machine
//   - local developer sign-in (DEV_AUTH) as E2E_ROLE (default EMPLOYEE)
//
//   cd server
//   node scripts/local-e2e-server.js            # API on http://localhost:3000
//   (then, in the project root: npm run dev  → http://localhost:5173)
import { generateKeyPairSync } from "node:crypto";
import { assertLocalMongo } from "./localOnly.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const syntheticKey = JSON.stringify({
  type: "service_account",
  project_id: "local-e2e",
  private_key_id: "local-e2e-not-a-real-key",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "local-e2e@local-e2e.iam.gserviceaccount.com",
});

let memory;
let uri = process.env.LOCAL_MONGODB_URI;
const dbName = "receiptflow-local-e2e";
if (uri) {
  assertLocalMongo(uri, dbName);
} else {
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memory = await MongoMemoryServer.create();
  uri = memory.getUri();
}
assertLocalMongo(uri, dbName);

// Set before the app reads its configuration; dotenv never overrides these.
Object.assign(process.env, {
  NODE_ENV: "development",
  PORT: process.env.PORT || "3000",
  MONGODB_URI: uri,
  MONGODB_DB_NAME: dbName,
  FRONTEND_ORIGIN: process.env.E2E_FRONTEND_ORIGIN || "http://localhost:5173",
  DEV_AUTH_ENABLED: "true",
  DEV_AUTH_ROLE: process.env.E2E_ROLE || "EMPLOYEE",
  BETA_AUTH_ENABLED: "false",
  ENTRA_TENANT_ID: "",
  ENTRA_CLIENT_ID: "",
  APPROVAL_WORKFLOW_ENABLED: process.env.E2E_APPROVAL_WORKFLOW === "true" ? "true" : "false",
  // In-app notifications are safe here (throwaway database); email is the mock.
  NOTIFICATIONS_ENABLED: process.env.E2E_NOTIFICATIONS === "false" ? "false" : "true",
  NOTIFICATION_EMAIL_PROVIDER: "mock",
  NOTIFICATION_WORKER_INTERVAL_SECONDS: "5",
  OCR_PROVIDER: "google_document_ai",
  GOOGLE_DOCUMENT_AI_PROJECT_ID: "local-e2e",
  GOOGLE_DOCUMENT_AI_LOCATION: "us",
  GOOGLE_DOCUMENT_AI_PROCESSOR_ID: "localstub",
  GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON: syntheticKey,
  GOOGLE_APPLICATION_CREDENTIALS: "",
  VERYFI_CLIENT_ID: "",
  VERYFI_CLIENT_SECRET: "",
  VERYFI_USERNAME: "",
  VERYFI_API_KEY: "",
});

const { __setTestHooks } = await import("../src/services/googleDocumentAiService.js");
const { liveShapedSyntheticDocument } = await import("../test/fixtures/documentAi.js");
let stubCalls = 0;
// Stub client: never contacts Google. Every upload "reads" as the synthetic receipt.
__setTestHooks({
  factory: () => ({
    processDocument: async () => {
      stubCalls += 1;
      console.info(`[local-e2e] stub OCR call #${stubCalls} (no request sent to Google)`);
      await new Promise((resolve) => setTimeout(resolve, 800)); // show the loading state
      return [{ document: liveShapedSyntheticDocument() }];
    },
  }),
});

const { env } = await import("../src/config/env.js");
const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");
const { createApp } = await import("../src/app.js");
if (!(await connectDatabase())) throw new Error("Could not connect to the local database.");
// Synthetic people to choose as notification recipients. The developer sign-in is one
// of them, so it receives in-app notifications too.
const { User } = await import("../src/models/User.js");
const { startNotificationWorker } = await import("../src/services/notifications/outbox.js");
for (const person of [
  { name: "Local Developer", email: "developer@example.test", entraUserId: "dev-user", role: env.devAuthRole, department: "Development" },
  { name: "Fay Finance", email: "fay@example.test", entraUserId: "synthetic-finance", role: "FINANCE_ADMIN", department: "Finance" },
  { name: "Bob Employee", email: "bob@example.test", entraUserId: "synthetic-bob", role: "EMPLOYEE", department: "Service" },
]) {
  await User.updateOne({ entraUserId: person.entraUserId }, { $setOnInsert: person }, { upsert: true });
}
startNotificationWorker();
const server = createApp().listen(env.port, () => {
  console.info(
    `[local-e2e] API on http://localhost:${env.port}/api · throwaway database "${dbName}" · role ${env.devAuthRole} · approval routing ${env.approvalWorkflowEnabled ? "ON" : "OFF"} · Google stubbed`,
  );
});

async function shutdown() {
  server.close();
  await disconnectDatabase().catch(() => {});
  await memory?.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
