// Imported first by every test file: a fully synthetic configuration, so tests
// never read server/.env secrets, the real key file, Google or MongoDB.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const SYNTHETIC_KEY = {
  type: "service_account",
  project_id: "receiptflow-ocr",
  private_key_id: "synthetic-key-id-0000000000",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "test-only@receiptflow-ocr.iam.gserviceaccount.com",
};

Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: "",
  OCR_PROVIDER: "google_document_ai",
  GOOGLE_DOCUMENT_AI_PROJECT_ID: "receiptflow-ocr",
  GOOGLE_DOCUMENT_AI_LOCATION: "asia-southeast1",
  GOOGLE_DOCUMENT_AI_PROCESSOR_ID: "f4d7fd3749cd9873",
  GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION: "",
  GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON: JSON.stringify(SYNTHETIC_KEY),
  GOOGLE_APPLICATION_CREDENTIALS: "",
  GOOGLE_DOCUMENT_AI_TIMEOUT_SECONDS: "60",
  VERYFI_CLIENT_ID: "test-client-id",
  VERYFI_CLIENT_SECRET: "test-client-secret",
  VERYFI_USERNAME: "test",
  VERYFI_API_KEY: "test-api-key-000",
  RECEIPT_DATE_ORDER: "DMY",
  ENTRA_TENANT_ID: "",
  ENTRA_CLIENT_ID: "",
  BETA_AUTH_ENABLED: "false",
  DEV_AUTH_ENABLED: "false",
});
