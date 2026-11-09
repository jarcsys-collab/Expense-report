import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Load server/.env regardless of the current working directory.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
  quiet: true,
});

const PAGES_ORIGIN = "https://jarcsys-collab.github.io";
const LOCAL_ORIGIN = "http://localhost:5173";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z
    .string()
    .trim()
    .refine((value) => value === "" || /^mongodb(\+srv)?:\/\//.test(value), {
      message: "must start with mongodb:// or mongodb+srv://",
    })
    .default(""),
  MONGODB_DB_NAME: z.string().trim().min(1).default("receiptflow"),
  FRONTEND_ORIGIN: z.string().default(LOCAL_ORIGIN),
  DEV_AUTH_ENABLED: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  DEV_AUTH_ROLE: z.enum(["EMPLOYEE", "APPROVER", "FINANCE_ADMIN"]).default("FINANCE_ADMIN"),
  // TEMPORARY controlled-beta sign-in (one shared account) until Microsoft Entra ID.
  // Values live only in Railway Variables / server/.env; never sent to the frontend.
  BETA_AUTH_ENABLED: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  BETA_AUTH_USERNAME: z.string().trim().default(""),
  BETA_AUTH_PASSWORD: z.string().default(""),
  BETA_AUTH_ROLE: z.enum(["EMPLOYEE", "APPROVER", "FINANCE_ADMIN"]).default("EMPLOYEE"),
  BETA_SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  // Microsoft Entra ID sign-in (primary). Public identifiers, not secrets: the
  // tenant (Directory) ID and the SPA's Application (client) ID. No client secret.
  ENTRA_TENANT_ID: z.union([z.literal(""), z.guid()]).default(""),
  ENTRA_CLIENT_ID: z.union([z.literal(""), z.guid()]).default(""),
  ENTRA_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  // Test-only endpoint overrides (signing keys and Microsoft Graph). Ignored in production.
  ENTRA_TEST_JWKS_URI: z.string().trim().default(""),
  ENTRA_TEST_GRAPH_BASE_URL: z.string().trim().default(""),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Veryfi OCR (backend only). All four credentials are required to enable OCR.
  VERYFI_CLIENT_ID: z.string().trim().default(""),
  VERYFI_CLIENT_SECRET: z.string().trim().default(""),
  VERYFI_USERNAME: z.string().trim().default(""),
  VERYFI_API_KEY: z.string().trim().default(""),
  VERYFI_BASE_URL: z
    .string()
    .trim()
    .default("https://api.veryfi.com")
    .refine((value) => /^https:\/\/[^\s/]+\/?$/.test(value), { message: "must be an https origin" }),
  VERYFI_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(300).default(90),
  // Which OCR provider reads receipts. Veryfi stays available for rollback.
  // "google" is accepted as a short form of "google_document_ai".
  OCR_PROVIDER: z
    .enum(["veryfi", "google", "google_document_ai"])
    .default("veryfi")
    .transform((value) => (value === "google" ? "google_document_ai" : value)),
  // Google Cloud Document AI (Expense Parser), backend only.
  GOOGLE_DOCUMENT_AI_PROJECT_ID: z
    .string()
    .trim()
    .refine((value) => value === "" || /^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$|^\d+$/.test(value), { message: "must be a Google Cloud project ID or number" })
    .default(""),
  GOOGLE_DOCUMENT_AI_LOCATION: z
    .string()
    .trim()
    .refine((value) => value === "" || /^[a-z]+(-[a-z]+\d*)?$/.test(value), { message: "must be a Document AI location such as us, eu or asia-southeast1" })
    .default(""),
  GOOGLE_DOCUMENT_AI_PROCESSOR_ID: z
    .string()
    .trim()
    .refine((value) => value === "" || /^[a-z0-9]+$/.test(value), { message: "must be the processor ID (lowercase letters and digits)" })
    .default(""),
  // Optional: pin a processor version; empty uses the processor's default version.
  GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION: z
    .string()
    .trim()
    .refine((value) => value === "" || /^[a-zA-Z0-9._-]+$/.test(value), { message: "must be a processor version ID" })
    .default(""),
  // Service-account key JSON (raw JSON, or the same JSON base64-encoded).
  // Production (Railway): a sealed variable. Takes precedence over the file below.
  GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON: z.string().trim().default(""),
  // Local development: path to the key file (Google's standard variable),
  // e.g. server/secrets/google-ocr-key.json. Relative paths resolve from server/.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().default(""),
  GOOGLE_DOCUMENT_AI_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  // When an employee changes the scanned receipt total, the change is flagged for
  // review unless it is within BOTH limits. Defaults 0 = every change is flagged.
  // Finance approves any non-zero tolerance.
  // Manager Approval / Finance routing on submit. Off: a checked request is saved
  // to My Requests as "Pending Workflow Setup" and routed nowhere. Server-only
  // (the browser cannot change it). Turning it on routes only requests submitted
  // afterwards; saved requests wait for the employee to submit them.
  APPROVAL_WORKFLOW_ENABLED: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  // Removal of ABANDONED receipt files (no expense uses them). Off by default;
  // when on, dry-run unless RECEIPT_CLEANUP_DRY_RUN=false.
  RECEIPT_CLEANUP_ENABLED: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  RECEIPT_CLEANUP_DRY_RUN: z
    .enum(["true", "false", ""])
    .default("true")
    .transform((value) => value !== "false"),
  RECEIPT_CLEANUP_ABANDONED_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  RECEIPT_CLEANUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  OCR_TOTAL_CORRECTION_TOLERANCE_AMOUNT: z.coerce.number().min(0).max(1e6).default(0),
  OCR_TOTAL_CORRECTION_TOLERANCE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  // How to read ambiguous numeric receipt dates such as 10/03/2026 (Philippines: day/month).
  RECEIPT_DATE_ORDER: z.enum(["DMY", "MDY"]).default("DMY"),
  // Anomaly notifications. Off by default: rules can be configured, but nothing is
  // queued or delivered until this is true. Separate from approval routing.
  NOTIFICATIONS_ENABLED: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  // Email delivery is not connected. "mock" only records (never in production).
  NOTIFICATION_EMAIL_PROVIDER: z.enum(["none", "mock"]).default("none"),
  NOTIFICATION_WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  // OCR cost ESTIMATES (dashboard only, never actual billing). Google Document AI
  // Expense Parser list price, confirmed 2026-11-09 on
  // https://cloud.google.com/products/document-ai/pricing: USD 0.10 per "count",
  // where 1 count = up to 10 pages of a document. Failed 4xx/5xx requests are not billed.
  OCR_COST_GOOGLE_USD_PER_UNIT: z.coerce.number().min(0).max(1000).default(0.1),
  OCR_COST_GOOGLE_PAGES_PER_UNIT: z.coerce.number().int().min(1).max(1000).default(10),
  // Veryfi price per document, from your own contract. 0 = no estimate is shown.
  OCR_COST_VERYFI_USD_PER_DOCUMENT: z.coerce.number().min(0).max(1000).default(0),
  // Estimated monthly spend that raises a dashboard alert. 0 = no alert.
  OCR_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(1e9).default(0),
  // An identical file from the SAME account within this many days reuses the
  // earlier reading instead of a new OCR request. 0 = only the short retry window.
  OCR_REUSE_PRIOR_SCAN_DAYS: z.coerce.number().int().min(0).max(365).default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Report only variable names and problems, never values.
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  console.error(`Invalid environment configuration:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === "production";

// Reads the Google service-account key without ever logging its contents.
// A bad key disables Google OCR (with a reason) instead of stopping the server,
// so OCR_PROVIDER=veryfi keeps working while the key is being fixed.
export function parseGoogleCredentials(value) {
  if (!value) return { credentials: null, error: null };
  let text = value;
  if (!text.startsWith("{")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8").trim();
    } catch {
      return { credentials: null, error: "is neither JSON nor base64-encoded JSON" };
    }
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { credentials: null, error: "is not valid JSON (paste the whole key file)" };
  }
  if (json?.type !== "service_account") return { credentials: null, error: 'is not a service-account key (expected "type": "service_account")' };
  if (typeof json.client_email !== "string" || !json.client_email.includes("@")) return { credentials: null, error: "has no client_email" };
  if (typeof json.private_key !== "string" || !json.private_key.includes("PRIVATE KEY")) return { credentials: null, error: "has no private_key" };
  return {
    credentials: {
      client_email: json.client_email,
      private_key: json.private_key,
      privateKeyId: typeof json.private_key_id === "string" ? json.private_key_id : "",
      projectId: typeof json.project_id === "string" ? json.project_id : "",
    },
    error: null,
  };
}

// Reads the key file named by GOOGLE_APPLICATION_CREDENTIALS (local development).
export function loadGoogleCredentialsFile(filePath, baseDir) {
  const resolved = path.resolve(baseDir, filePath);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8").trim();
  } catch {
    return { credentials: null, error: "points to a file that cannot be read" };
  }
  return parseGoogleCredentials(text);
}

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const googleSource = raw.GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON
  ? "GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON"
  : raw.GOOGLE_APPLICATION_CREDENTIALS
    ? "GOOGLE_APPLICATION_CREDENTIALS"
    : null;
const google =
  googleSource === "GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON"
    ? parseGoogleCredentials(raw.GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON)
    : googleSource
      ? loadGoogleCredentialsFile(raw.GOOGLE_APPLICATION_CREDENTIALS, SERVER_DIR)
      : { credentials: null, error: null };
if (google.error) console.error(`${googleSource} ${google.error}. Google Document AI OCR is disabled.`);

const configuredOrigins = raw.FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
if (configuredOrigins.includes("*")) {
  console.error("FRONTEND_ORIGIN must list exact origins; '*' is not allowed.");
  process.exit(1);
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction,
  port: raw.PORT,
  mongoUri: raw.MONGODB_URI,
  mongoDbName: raw.MONGODB_DB_NAME,
  allowedOrigins: [
    ...new Set([
      ...configuredOrigins.filter((origin) => !isProduction || origin !== LOCAL_ORIGIN),
      PAGES_ORIGIN,
      ...(isProduction ? [] : [LOCAL_ORIGIN]),
    ]),
  ],
  devAuthEnabled: raw.DEV_AUTH_ENABLED && !isProduction,
  devAuthRole: raw.DEV_AUTH_ROLE,
  betaAuth: {
    // Active only with a username and a password of at least 12 characters.
    enabled: raw.BETA_AUTH_ENABLED && Boolean(raw.BETA_AUTH_USERNAME) && raw.BETA_AUTH_PASSWORD.length >= 12,
    misconfigured: raw.BETA_AUTH_ENABLED && (!raw.BETA_AUTH_USERNAME || raw.BETA_AUTH_PASSWORD.length < 12),
    username: raw.BETA_AUTH_USERNAME,
    password: raw.BETA_AUTH_PASSWORD,
    role: raw.BETA_AUTH_ROLE,
    sessionHours: raw.BETA_SESSION_HOURS,
  },
  entra: {
    enabled: Boolean(raw.ENTRA_TENANT_ID && raw.ENTRA_CLIENT_ID),
    tenantId: raw.ENTRA_TENANT_ID,
    clientId: raw.ENTRA_CLIENT_ID,
    // v2.0 ID tokens for a single-tenant app carry exactly this issuer.
    issuer: `https://login.microsoftonline.com/${raw.ENTRA_TENANT_ID}/v2.0`,
    jwksUri:
      (!isProduction && raw.ENTRA_TEST_JWKS_URI) ||
      `https://login.microsoftonline.com/${raw.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
    graphBaseUrl: ((!isProduction && raw.ENTRA_TEST_GRAPH_BASE_URL) || "https://graph.microsoft.com").replace(/\/$/, ""),
    sessionHours: raw.ENTRA_SESSION_HOURS,
  },
  trustProxy: raw.TRUST_PROXY,
  receiptDateOrder: raw.RECEIPT_DATE_ORDER,
  approvalWorkflowEnabled: raw.APPROVAL_WORKFLOW_ENABLED,
  receiptCleanup: {
    enabled: raw.RECEIPT_CLEANUP_ENABLED,
    dryRun: raw.RECEIPT_CLEANUP_DRY_RUN,
    abandonedDays: raw.RECEIPT_CLEANUP_ABANDONED_DAYS,
    intervalHours: raw.RECEIPT_CLEANUP_INTERVAL_HOURS,
  },
  ocrTotalCorrectionTolerance: {
    amount: raw.OCR_TOTAL_CORRECTION_TOLERANCE_AMOUNT,
    percent: raw.OCR_TOTAL_CORRECTION_TOLERANCE_PERCENT,
  },
  veryfi: {
    clientId: raw.VERYFI_CLIENT_ID,
    clientSecret: raw.VERYFI_CLIENT_SECRET,
    username: raw.VERYFI_USERNAME,
    apiKey: raw.VERYFI_API_KEY,
    // The SDK appends "api/v8/..." directly, so the base URL needs a trailing slash.
    baseUrl: raw.VERYFI_BASE_URL.replace(/\/?$/, "/"),
    timeoutSeconds: raw.VERYFI_TIMEOUT_SECONDS,
    configured: Boolean(
      raw.VERYFI_CLIENT_ID && raw.VERYFI_CLIENT_SECRET && raw.VERYFI_USERNAME && raw.VERYFI_API_KEY,
    ),
  },
  ocrProvider: raw.OCR_PROVIDER,
  ocrCost: {
    googleUsdPerUnit: raw.OCR_COST_GOOGLE_USD_PER_UNIT,
    googlePagesPerUnit: raw.OCR_COST_GOOGLE_PAGES_PER_UNIT,
    veryfiUsdPerDocument: raw.OCR_COST_VERYFI_USD_PER_DOCUMENT,
    monthlyBudgetUsd: raw.OCR_MONTHLY_BUDGET_USD,
  },
  ocrReusePriorScanDays: raw.OCR_REUSE_PRIOR_SCAN_DAYS,
  notifications: {
    enabled: raw.NOTIFICATIONS_ENABLED,
    // The mock provider can never run in production, whatever the variable says.
    emailProvider: isProduction ? "none" : raw.NOTIFICATION_EMAIL_PROVIDER,
    workerIntervalSeconds: raw.NOTIFICATION_WORKER_INTERVAL_SECONDS,
  },
  googleDocumentAi: {
    projectId: raw.GOOGLE_DOCUMENT_AI_PROJECT_ID,
    location: raw.GOOGLE_DOCUMENT_AI_LOCATION,
    processorId: raw.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
    processorVersion: raw.GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION,
    credentials: google.credentials,
    credentialsError: google.error,
    credentialsSource: google.credentials ? googleSource : null,
    timeoutSeconds: raw.GOOGLE_DOCUMENT_AI_TIMEOUT_SECONDS,
    configured: Boolean(
      raw.GOOGLE_DOCUMENT_AI_PROJECT_ID && raw.GOOGLE_DOCUMENT_AI_LOCATION && raw.GOOGLE_DOCUMENT_AI_PROCESSOR_ID && google.credentials,
    ),
  },
};

// Values that must never appear in logs or responses.
export const SECRET_VALUES = [
  raw.MONGODB_URI,
  raw.VERYFI_CLIENT_ID,
  raw.VERYFI_CLIENT_SECRET,
  raw.VERYFI_API_KEY,
  raw.BETA_AUTH_PASSWORD,
  raw.GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON,
  google.credentials?.private_key,
  google.credentials?.privateKeyId,
].filter((value) => value && value.length >= 6);

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const secret of SECRET_VALUES) out = out.split(secret).join("[redacted]");
  return out
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://[redacted]")
    .replace(/apikey\s+[^\s"',}]+/gi, "apikey [redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/"private_key(_id)?"\s*:\s*"[^"]*"/g, '"private_key$1":"[redacted]"')
    .replace(/(Bearer|access_token["=:\s]+)\s*[A-Za-z0-9._~+/=-]{20,}/gi, "$1 [redacted]");
}
