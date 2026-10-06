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
  // How to read ambiguous numeric receipt dates such as 10/03/2026 (Philippines: day/month).
  RECEIPT_DATE_ORDER: z.enum(["DMY", "MDY"]).default("DMY"),
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
  trustProxy: raw.TRUST_PROXY,
  receiptDateOrder: raw.RECEIPT_DATE_ORDER,
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
};

// Values that must never appear in logs or responses.
export const SECRET_VALUES = [
  raw.MONGODB_URI,
  raw.VERYFI_CLIENT_ID,
  raw.VERYFI_CLIENT_SECRET,
  raw.VERYFI_API_KEY,
  raw.BETA_AUTH_PASSWORD,
].filter((value) => value && value.length >= 6);

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const secret of SECRET_VALUES) out = out.split(secret).join("[redacted]");
  return out
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://[redacted]")
    .replace(/apikey\s+[^\s"',}]+/gi, "apikey [redacted]");
}
